// lib/deliveryRunOrder.js — G9 (Nick, 28 Sep 2026): drag-to-reorder booked deliveries so
// drivers get their stops in the best route order.
//
//   GET /api/delivery?resource=run-order   no token — same as every other read on the tab
//   PUT /api/delivery?resource=run-order   { removalist_id, delivery_date, delivery_ids }
//                                          logistics / admin / superadmin (token)
//
// Routed from lib/handlers/delivery.js (no new serverless function).
//
// THE RULE: a run is one carrier on one day. `delivery_ids` is the complete stop order for
// that run, and the save is refused unless EVERY id is a booked delivery with exactly that
// carrier and that date — enforced here, in SQL, not just by the page. The check and the
// write are one statement: either every stop gets its number or none does.
//
// STALE NUMBERS HEAL THEMSELVES. A stop number only means something inside the run it was
// set for, so the save also stamps `run_order_key` (carrier|day). When a delivery is later
// re-booked to another carrier or day — by the legacy PUT, which knows nothing about run
// order — its key no longer matches and the read below simply stops returning its number.
// (This also covers a re-book racing a save.) Nothing in the booking code had to change.
//
// It writes `run_order` + `run_order_key` and nothing else: no status change, no
// workorder_logs row (stop order is planning metadata, not an event in the item's history).
//
// The columns arrive with migration 0008, applied to the Neon DEV branch only until Nick
// migrates prod — so a missing column (42703) is an expected state: reads say
// `available: false` (the page hides the reorder controls) and saves get a plain 503.
//
// FUTURE HOOK (G10, not built): an "Auto-optimise run" button would compute an order for a
// carrier+day and send it through this same PUT — nothing here needs to change for it.

import { requireRoles } from './rbac.js';

// `admin` because prod has no `logistics` users (see PR #107). Mirrors RUN_ORDER_ROLES in
// src/utils/runOrder.js (pinned by scripts/ops-run-order-smoke.mjs).
export const RUN_ORDER_ROLES = ['logistics', 'admin', 'superadmin'];
export const RUN_ORDER_MAX_STOPS = 200;

// The run a delivery is in RIGHT NOW, as text: '<carrier id or none>|YYYY-MM-DD'.
const RUN_KEY = (alias) => `COALESCE(${alias}.removalist_id::text, 'none') || '|' || to_char(${alias}.delivery_date, 'YYYY-MM-DD')`;

const ORDER_SELECT = `
  SELECT d.delivery_id, d.run_order
    FROM delivery d
   WHERE d.run_order IS NOT NULL
     AND d.delivery_status = 'Booked for Delivery'
     AND d.run_order_key = ${RUN_KEY('d')}
`;

// $1 int[] stop order · $2 carrier (NULL = no carrier yet) · $3 day.
// `ok.all_match` is true only if every id is a booked delivery of that carrier on that day;
// when it is false the UPDATE matches nothing, so the save is all-or-nothing.
const ORDER_UPDATE = `
  WITH v AS (
    SELECT t.id, t.pos FROM unnest($1::int[]) WITH ORDINALITY AS t(id, pos)
  ), ok AS (
    SELECT count(*) = cardinality($1::int[]) AS all_match
      FROM delivery d
      JOIN v ON v.id = d.delivery_id
     WHERE d.removalist_id IS NOT DISTINCT FROM $2::int
       AND d.delivery_date::date = $3::date
       AND d.delivery_status = 'Booked for Delivery'
  )
  UPDATE delivery d
     SET run_order = v.pos,
         run_order_key = ${RUN_KEY('d')}
    FROM v, ok
   WHERE d.delivery_id = v.id
     AND ok.all_match
  RETURNING d.delivery_id, d.run_order
`;

const toMap = (rows) => Object.fromEntries(rows.map((r) => [r.delivery_id, Number(r.run_order)]));
const isId = (n) => Number.isInteger(n) && n > 0 && n <= 2147483647;
// A real calendar day: 2026-02-30 parses in JS (it rolls over to March) but Postgres rejects it.
function isRealDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const t = Date.parse(`${day}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === day;
}

export async function handleRunOrder(req, res, client) {
  const { method } = req;
  if (method !== 'GET' && method !== 'PUT') {
    res.setHeader('Allow', ['GET', 'PUT']);
    return res.status(405).json({ error: 'Method not allowed for run-order' });
  }

  if (method === 'GET') {
    try {
      const r = await client.query(ORDER_SELECT);
      return res.status(200).json({ available: true, order: toMap(r.rows) });
    } catch (err) {
      if (err?.code !== '42703') throw err; // only "column not migrated yet" is expected
      return res.status(200).json({ available: false, order: {} });
    }
  }

  const gate = requireRoles(req, RUN_ORDER_ROLES);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const { removalist_id: carrier = null, delivery_date: day, delivery_ids: ids } = req.body || {};
  if (carrier !== null && !isId(carrier)) {
    return res.status(400).json({ error: 'removalist_id must be a carrier id or null' });
  }
  if (!isRealDay(day)) {
    return res.status(400).json({ error: 'delivery_date must be a date (YYYY-MM-DD) — unscheduled deliveries have no run to order' });
  }
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > RUN_ORDER_MAX_STOPS || !ids.every(isId)) {
    return res.status(400).json({ error: `delivery_ids must be 1–${RUN_ORDER_MAX_STOPS} delivery ids` });
  }
  if (new Set(ids).size !== ids.length) {
    return res.status(400).json({ error: 'delivery_ids contains the same delivery twice' });
  }

  try {
    const r = await client.query(ORDER_UPDATE, [ids, carrier, day]);
    if (r.rows.length !== ids.length) {
      return res.status(409).json({
        error: 'Those deliveries are no longer all on the same carrier and day — refresh the schedule and try again',
      });
    }
    return res.status(200).json({ available: true, order: toMap(r.rows) });
  } catch (err) {
    if (err?.code !== '42703') throw err;
    return res.status(503).json({ error: 'Run ordering is not set up on this database yet' });
  }
}
