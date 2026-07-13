// lib/customerJourney.js — Customer-360 unified journey (feature F6).
//
// Merges a customer's front-half funnel and back-half fulfilment history into ONE
// chronological timeline that reads
//   Lead → Contacted → Quoted → Payment → Workorder → In Workshop → Completed → Booked → Delivered
// by UNION-ing three append-only / record sources:
//   1. lead_stage_log  — the F5 funnel (the NULL→New row IS "lead created", so we don't
//      synthesize a separate created event).
//   2. workorder + workorder_logs — the existing back-half audit trail. The WORKORDER_CREATED
//      log row is excluded and re-synthesized from the workorder row so every workorder
//      anchors exactly once with its invoice/status; the delivery lifecycle
//      (DELIVERY_ORDER_CREATED / DELIVERY_BOOKED / ORDER_DISPATCHED) already lives here.
//   3. delivery — the concrete booking record (scheduled date / suburb / status).
//
// Read-only. Touches no chat message bodies (P1 is not in scope — these are internal
// CRM/ops logs only). Consumed by the `journey` sub-resource of the customers route in
// api/[...path].js (Hobby-cap discipline: NO new serverless function).

import { getClientWithTimezone } from './db.js';

// One query, common shape, oldest → newest. `to_val` carries the meaningful state for the
// row (lead stage / item status / workorder status / delivery status); `note` carries the
// free-text / structured detail. `actor` is the acting user's 2-char id, joined to a name.
const JOURNEY_SQL = `
WITH ev AS (
  -- 1. Lead funnel (lead_stage_log; NULL→stage = created)
  SELECT lsl.created_at            AS event_time,
         'lead'::text              AS category,
         CASE WHEN lsl.from_stage IS NULL THEN 'LEAD_CREATED' ELSE 'LEAD_STAGE' END AS code,
         lsl.from_stage::text      AS from_val,
         lsl.to_stage::text        AS to_val,
         lsl.notes_log             AS note,
         lsl.user_id               AS actor,
         'lead'::text              AS ref_type,
         lsl.lead_id               AS ref_id
    FROM lead_stage_log lsl
    JOIN leads l ON l.lead_id = lsl.lead_id
   WHERE l.customer_id = $1

  UNION ALL
  -- 2a. Workorder created (synthesized from the row; matching log row excluded below)
  SELECT w.date_created, 'workorder',
         'WORKORDER_CREATED', NULL, w.status::text,
         CONCAT_WS(' · ', 'Invoice ' || w.invoice_id, NULLIF(w.delivery_suburb, '')),
         w.salesperson, 'workorder', w.workorder_id
    FROM workorder w
   WHERE w.customer_id = $1

  UNION ALL
  -- 2b. Workorder + delivery lifecycle log (append-only), minus the created row
  SELECT wl.created_at, 'workorder',
         wl.event_type::text, NULL, wl.item_status::text,
         wl.notes_log, wl.user_id, 'workorder', wl.workorder_id
    FROM workorder_logs wl
    JOIN workorder w2 ON w2.workorder_id = wl.workorder_id
   WHERE w2.customer_id = $1
     AND wl.event_type <> 'WORKORDER_CREATED'

  UNION ALL
  -- 3. Delivery record (concrete booking: scheduled date / suburb / current status)
  SELECT d.date_created, 'delivery',
         'DELIVERY_RECORD', NULL, d.delivery_status::text,
         CONCAT_WS(' · ',
           CASE WHEN d.delivery_date IS NOT NULL
                THEN 'Booked ' || to_char(d.delivery_date, 'DD Mon YYYY') END,
           NULLIF(d.delivery_suburb, '')),
         NULL, 'delivery', d.delivery_id
    FROM delivery d
   WHERE d.customer_id = $1
)
SELECT ev.event_time, ev.category, ev.code, ev.from_val, ev.to_val, ev.note,
       ev.actor, ev.ref_type, ev.ref_id, u.name AS actor_name
  FROM ev
  LEFT JOIN users u ON u.id = ev.actor
 ORDER BY ev.event_time ASC NULLS LAST, ev.ref_type, ev.ref_id;
`;

// Human-readable titles for the back-half workorder_log_event codes.
const WO_EVENT_LABELS = {
  WORKORDER_CREATED: 'Workorder created',
  WORKORDER_STATUS_CHANGED: 'Workorder status changed',
  ITEM_IN_WORKSHOP: 'Item moved to workshop',
  ITEM_STATUS_CHANGED: 'Item status changed',
  ITEM_COMPLETED: 'Item completed',
  WORKORDER_COMPLETED: 'Workorder completed',
  DELIVERY_ORDER_CREATED: 'Delivery order created',
  DELIVERY_BOOKED: 'Delivery booked',
  ORDER_DISPATCHED: 'Order dispatched',
  PAYMENT_UPDATED: 'Payment updated',
  NOTE_ADDED: 'Note added',
  ITEM_ADDED: 'Item added',
  ITEM_REMOVED: 'Item removed',
  WORKORDER_FLAG_CHANGED: 'Flag changed',
  WORKORDER_REOPENED: 'Workorder reopened',
};

/**
 * Turn a raw union row into a normalized timeline event {title, detail, ...}.
 * Pure — no I/O — so it is unit-testable offline (scripts/podium-journey-smoke.mjs).
 */
export function labelEvent(row) {
  const { category, code, from_val: fromVal, to_val: toVal, note } = row;
  const detailParts = [];
  let title;

  if (category === 'lead') {
    if (code === 'LEAD_CREATED') {
      title = `Lead created — ${toVal || 'New'}`;
    } else {
      title = `${fromVal || '—'} → ${toVal || '—'}`;
    }
    if (note) detailParts.push(note);
  } else if (category === 'delivery') {
    title = `Delivery — ${toVal || 'record'}`;
    if (note) detailParts.push(note);
  } else {
    // workorder
    title = WO_EVENT_LABELS[code] || code;
    if (code === 'WORKORDER_CREATED') {
      if (toVal) detailParts.push(`Status: ${toVal}`);
    } else if (toVal) {
      detailParts.push(toVal); // item status for item-level events
    }
    if (note) detailParts.push(note);
  }

  return {
    event_time: row.event_time,
    category,
    code,
    ref_type: row.ref_type,
    ref_id: row.ref_id,
    title,
    detail: detailParts.filter(Boolean).join(' · ') || null,
    actor: row.actor || null,
    actor_name: row.actor_name || null,
  };
}

/**
 * Build the Customer-360 journey for a customer.
 * @returns {Promise<null | { customer, events }>}  null when the customer doesn't exist.
 * `deps.getClient` lets the offline smoke inject a fake pg client (default = real pool).
 */
export async function buildJourney(customerId, deps = {}) {
  const getClient = deps.getClient || getClientWithTimezone;
  const client = await getClient();
  try {
    const c = await client.query(
      `SELECT id, name, email, phone, address, customer_type, podium_contact_id
         FROM customers WHERE id = $1`,
      [customerId]
    );
    if (!c.rowCount) return null;
    const r = await client.query(JOURNEY_SQL, [customerId]);
    return { customer: c.rows[0], events: (r.rows || []).map(labelEvent) };
  } finally {
    client.release();
  }
}

// Exported for the offline smoke to assert the SQL shape without hitting a DB.
export const __JOURNEY_SQL = JOURNEY_SQL;
