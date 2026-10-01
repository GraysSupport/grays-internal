// lib/lotJourney.js — G11 (Nick, 1 Oct 2026): the Lot Tracker.
//
// "When I am logged in to the admin portal I can scan/search for a lot number and it will
//  tell me where the item came from (extraction details) and eventually where it is assigned
//  to, when it went to the workshop, who done it, the details (serial number) as well as when
//  it was delivered by who."
//
//   GET /api/lots?resource=journey&lot_number=L00042   one lot's full journey
//   GET /api/lots?resource=journey-search&q=treadmill  find lots by number / serial / product
//
// Routed from lib/handlers/lots.js (no new serverless function). ADMIN + SUPERADMIN ONLY,
// by login token — this is the logged-in counterpart of the PUBLIC /scan lookup
// (GET /api/lots?lot_number=), which deliberately returns no cost or customer data and is
// left exactly as it is. Everything here is a SELECT: the tracker reads the trail the
// portal already keeps (collections → product_lots → workorder_items → workorder_logs →
// delivery); it records nothing.
//
// Cost (`unit_cost`) is superadmin-only, like the portal's other cost fields.

import { requireRoles, hasAnyRole } from './rbac.js';

// Mirrors LOT_TRACKER_ROLES in src/utils/lotTracker.js (pinned by the smoke).
export const LOT_TRACKER_ROLES = ['admin', 'superadmin'];
export const LOT_SEARCH_LIMIT = 25;

// One row: the lot, its product, where it came from, and the workorder item it is on.
const LOT_SELECT = `
  SELECT pl.lot_id, pl.lot_number, pl.product_sku, pl.status, pl.serial_number, pl.unit_cost,
         pl.collection_id, pl.workorder_items_id, pl.created_by, pl.created_at, pl.updated_at,
         cu.name AS created_by_name,
         p.name AS product_name, p.brand AS product_brand,
         c.name AS collection_name, c.suburb AS collection_suburb, c.state AS collection_state,
         c.description AS collection_description, c.notes AS collection_notes,
         to_char(c.collection_date, 'YYYY-MM-DD') AS collection_date, c.status AS collection_status,
         cr.name AS collection_carrier,
         wi.workorder_id, wi.status AS item_status, wi.condition AS item_condition,
         wi.technician_id, tu.name AS technician_name, wi.in_workshop, wi.item_sn,
         w.invoice_id, w.status AS workorder_status, w.date_created AS workorder_created,
         w.salesperson, w.delivery_suburb, w.delivery_state,
         w.customer_id, cust.name AS customer_name
    FROM product_lots pl
    LEFT JOIN product p          ON p.sku = pl.product_sku
    LEFT JOIN users cu           ON cu.id = pl.created_by
    LEFT JOIN collections c      ON c.id = pl.collection_id
    LEFT JOIN removalist cr      ON cr.id = c.removalist_id
    LEFT JOIN workorder_items wi ON wi.workorder_items_id = pl.workorder_items_id
    LEFT JOIN users tu           ON tu.id = wi.technician_id
    LEFT JOIN workorder w        ON w.workorder_id = wi.workorder_id
    LEFT JOIN customers cust     ON cust.id = w.customer_id
   WHERE pl.lot_number = $1
`;

// The item's own events, plus the workorder-level events that move it (created, completed,
// delivery order / booked / dispatched). Payment, note and flag events are not part of an
// item's journey and note text is not shown here.
const LOG_SELECT = `
  SELECT l.id, l.event_type, l.item_status, l.user_id, l.created_at, u.name AS user_name
    FROM workorder_logs l
    LEFT JOIN users u ON u.id = l.user_id
   WHERE l.workorder_id = $1
     AND (
           l.workorder_items_id = $2
        OR (l.workorder_items_id IS NULL AND l.event_type IN (
             'WORKORDER_CREATED', 'WORKORDER_COMPLETED', 'WORKORDER_REOPENED',
             'DELIVERY_ORDER_CREATED', 'DELIVERY_BOOKED', 'ORDER_DISPATCHED'))
         )
   ORDER BY l.created_at ASC, l.id ASC
`;

const DELIVERY_SELECT = `
  SELECT d.delivery_id, to_char(d.delivery_date, 'YYYY-MM-DD') AS delivery_date, d.delivery_status,
         d.delivery_type, d.delivery_suburb, d.delivery_state, d.date_created, r.name AS carrier
    FROM delivery d
    LEFT JOIN removalist r ON r.id = d.removalist_id
   WHERE d.workorder_id = $1
   ORDER BY d.date_created ASC, d.delivery_id ASC
`;

const SEARCH_SELECT = `
  SELECT pl.lot_number, pl.status, pl.product_sku, pl.serial_number, p.name AS product_name,
         w.invoice_id
    FROM product_lots pl
    LEFT JOIN product p          ON p.sku = pl.product_sku
    LEFT JOIN workorder_items wi ON wi.workorder_items_id = pl.workorder_items_id
    LEFT JOIN workorder w        ON w.workorder_id = wi.workorder_id
   WHERE pl.lot_number ILIKE $1
      OR pl.serial_number ILIKE $1
      OR wi.item_sn ILIKE $1
      OR pl.product_sku ILIKE $1
      OR p.name ILIKE $1
      OR w.invoice_id ILIKE $1
   ORDER BY pl.lot_number DESC
   LIMIT ${LOT_SEARCH_LIMIT}
`;

// ORDER_DISPATCHED is written by lib/handlers/delivery.js at the moment a delivery is marked
// "Delivery Completed" — so in an item's journey it IS the delivery-completed record: the only
// place the portal keeps WHEN a delivery was completed and WHO marked it. (delivery.delivery_date
// is the booked date, and can be empty for a Customer Collect.)
const LOG_TITLES = {
  WORKORDER_CREATED: 'Workorder created',
  WORKORDER_COMPLETED: 'Workorder completed',
  WORKORDER_REOPENED: 'Workorder reopened',
  DELIVERY_ORDER_CREATED: 'Delivery order created',
  DELIVERY_BOOKED: 'Delivery booked',
  ORDER_DISPATCHED: 'Delivery completed',
  ITEM_ADDED: 'Item added to the workorder',
  ITEM_REMOVED: 'Item removed from the workorder',
  ITEM_IN_WORKSHOP: 'Went into the workshop',
  ITEM_COMPLETED: 'Workshop completed',
};
function logTitle(l) {
  if (l.event_type === 'ITEM_STATUS_CHANGED') {
    if (l.item_status === 'In Workshop') return 'Went into the workshop';
    if (l.item_status === 'Completed') return 'Workshop completed';
    return `Item status changed${l.item_status ? ` to ${l.item_status}` : ''}`;
  }
  return LOG_TITLES[l.event_type] || l.event_type;
}

const iso = (v) => (v instanceof Date ? v.toISOString() : v || null);
// Sort key in MELBOURNE local time, so a date-only step (a Melbourne calendar date) and a
// timestamped step compare on the same clock. sv-SE formats as 'YYYY-MM-DD HH:mm:ss'.
const MELB = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
function sortKey(e) {
  if (!e.at) return e.kind === 'origin' ? '0000' : '9999'; // an undated collection still came first
  if (e.date_only) return String(e.at).slice(0, 10);
  const d = new Date(e.at);
  return Number.isNaN(d.getTime()) ? '9999' : MELB.format(d);
}
const place = (...parts) => parts.filter(Boolean).join(', ');
const escapeLike = (s) => s.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/** Build the journey for one lot. Returns null when the lot does not exist. Three SELECTs at most. */
export async function buildLotJourney(client, lotNumber, { includeCost = false } = {}) {
  const found = await client.query(LOT_SELECT, [lotNumber]);
  if (!found.rows.length) return null;
  const r = found.rows[0];

  const assigned = r.workorder_items_id != null && r.workorder_id != null;
  const logs = assigned ? (await client.query(LOG_SELECT, [r.workorder_id, r.workorder_items_id])).rows : [];
  const deliveries = assigned ? (await client.query(DELIVERY_SELECT, [r.workorder_id])).rows : [];

  const timeline = [];
  if (r.collection_id != null) {
    timeline.push({
      kind: 'origin',
      at: r.collection_date, date_only: true,
      // Lots are issued when a collection is completed, but don't claim "collected" if it isn't.
      title: r.collection_status === 'Completed' ? 'Collected (extraction)' : `Collection ${String(r.collection_status || 'recorded').toLowerCase()} (extraction)`,
      detail: place(r.collection_name, place(r.collection_suburb, r.collection_state)),
      by_name: r.collection_carrier || null,
    });
  }
  timeline.push({
    kind: 'lot', at: iso(r.created_at), title: 'Lot number issued',
    detail: `${r.lot_number} · ${r.product_name || r.product_sku}`,
    by: r.created_by || null, by_name: r.created_by_name || null,
  });
  for (const l of logs) {
    const itemEvent = l.event_type.startsWith('ITEM_');
    timeline.push({
      kind: itemEvent ? 'workshop' : (/DELIVERY|DISPATCH/.test(l.event_type) ? 'delivery' : 'workorder'),
      at: iso(l.created_at), title: logTitle(l),
      detail: itemEvent ? null : `Workorder ${r.workorder_id}${r.invoice_id ? ` · invoice ${r.invoice_id}` : ''}`,
      by: l.user_id || null, by_name: l.user_name || null,
    });
  }
  // Oldest first (stable for ties).
  timeline.sort((a, b) => { const x = sortKey(a); const y = sortKey(b); return x < y ? -1 : x > y ? 1 : 0; });

  // When the delivery was completed and who marked it = the last completion log (see LOG_TITLES).
  const completionLog = [...logs].reverse().find((l) => l.event_type === 'ORDER_DISPATCHED') || null;
  const anyCompleted = deliveries.some((d) => d.delivery_status === 'Delivery Completed');
  // One serial number everywhere: the lot's own, else the one recorded on the workorder item.
  const serial = r.serial_number || r.item_sn || null;

  const lot = {
    lot_number: r.lot_number, status: r.status,
    serial_number: serial,
    created_at: iso(r.created_at), created_by: r.created_by || null, created_by_name: r.created_by_name || null,
  };
  if (includeCost) lot.unit_cost = r.unit_cost == null ? null : Number(r.unit_cost);

  return {
    lot,
    product: { sku: r.product_sku, name: r.product_name || null, brand: r.product_brand || null },
    origin: r.collection_id == null ? null : {
      collection_id: r.collection_id, name: r.collection_name || null,
      suburb: r.collection_suburb || null, state: r.collection_state || null,
      description: r.collection_description || null, notes: r.collection_notes || null,
      collection_date: r.collection_date || null, status: r.collection_status || null,
      carrier: r.collection_carrier || null,
    },
    assignment: !assigned ? null : {
      workorder_id: r.workorder_id, workorder_items_id: r.workorder_items_id,
      invoice_id: r.invoice_id || null, workorder_status: r.workorder_status || null,
      workorder_created: iso(r.workorder_created),
      customer_id: r.customer_id ?? null, customer_name: r.customer_name || null,
      delivery_suburb: r.delivery_suburb || null, delivery_state: r.delivery_state || null,
      salesperson: r.salesperson || null,
    },
    workshop: !assigned ? null : {
      item_status: r.item_status || null, condition: r.item_condition || null,
      in_workshop: iso(r.in_workshop),
      technician_id: r.technician_id || null, technician_name: r.technician_name || null,
      serial_number: serial,
    },
    deliveries: deliveries.map((d) => ({
      delivery_id: d.delivery_id, delivery_date: d.delivery_date || null,
      delivery_status: d.delivery_status, delivery_type: d.delivery_type || null,
      suburb: d.delivery_suburb || null, state: d.delivery_state || null, carrier: d.carrier || null,
    })),
    // Deliveries belong to the WORKORDER — the portal does not record which item went on which
    // delivery — so `completed` is only reported when a delivery on it is actually completed.
    delivered: !(anyCompleted && completionLog) ? null : {
      completed_at: iso(completionLog.created_at),
      completed_by: completionLog.user_id || null,
      completed_by_name: completionLog.user_name || null,
    },
    timeline,
  };
}

/** Handles ?resource=journey and ?resource=journey-search. Read-only; admin + superadmin. */
export async function handleLotJourney(req, res, client) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed for the lot tracker' });
  }
  const gate = requireRoles(req, LOT_TRACKER_ROLES);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  if (String(req.query?.resource) === 'journey-search') {
    const q = String(req.query?.q ?? '').trim();
    if (q.length < 2) return res.status(400).json({ error: 'Type at least 2 characters to search' });
    if (q.length > 60) return res.status(400).json({ error: 'Search text is too long' });
    const r = await client.query(SEARCH_SELECT, [`%${escapeLike(q)}%`]);
    return res.status(200).json({ results: r.rows, limit: LOT_SEARCH_LIMIT });
  }

  const lotNumber = String(req.query?.lot_number ?? '').trim().toUpperCase();
  if (!lotNumber) return res.status(400).json({ error: 'Provide a lot number' });
  if (lotNumber.length > 12) return res.status(400).json({ error: 'That is not a lot number' });

  const journey = await buildLotJourney(client, lotNumber, {
    includeCost: hasAnyRole(gate.auth.roles, ['superadmin']),
  });
  if (!journey) return res.status(404).json({ error: `No lot found for ${lotNumber}` });
  return res.status(200).json(journey);
}
