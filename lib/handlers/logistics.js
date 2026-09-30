// lib/handlers/logistics.js — Logistics work queues (feature F7b).
//
// The logistics side of the funnel seam (execution-plan §F7). F7a (the salesperson)
// raises a MYOB quote/invoice on a lead → stage 'Quoted' + `quote_invoice_id`. This
// handler surfaces those quoted-but-not-yet-converted leads as a daily worklist for the
// LOGISTICS person to work through: confirm the customer has paid (cross-checking MYOB),
// then create the workorder (that action is F7c). F7b itself is a read-only queue.
//
// Routed through the api/[...path].js catch-all as a `logistics` case, which passes the
// path segments AFTER "logistics". To stay on the app's proven-safe routing convention
// (Vercel platform-404s multi-segment paths into the catch-all — F6 hit this and moved
// to the query form), the front-end calls the QUERY form and this handler resolves the
// resource from EITHER the path segment OR ?resource=:
//   GET /api/logistics?resource=awaiting-workorder   ← the front-end uses this
//   GET /api/logistics/awaiting-workorder            ← same result, if it ever routes
//
// Gated to logistics/superadmin via the login JWT (getAuthUser + hasAnyRole) — the server
// is the real authority (F9 formalises nav). No message bodies are touched (P1 not in
// scope — leads carry CRM metadata only).

import { getClientWithTimezone } from '../db.js';
import { getAuthUser, hasAnyRole } from '../rbac.js';

const ALLOWED_ROLES = ['logistics', 'superadmin'];
// G8 temp-run planner (read-only). Wider than the queues: `admin` added 1 Oct 2026 (Nick) —
// prod has no `logistics` users; the people who run deliveries log in as admin. Mirrors
// TEMP_RUN_ROLES in src/utils/tempRun.js. Awaiting-Workorder stays on ALLOWED_ROLES.
const TEMP_RUN_ROLES = ['logistics', 'admin', 'superadmin'];

// The joined shape the Awaiting-Workorder worklist renders. Mirrors the leads handler's
// LEAD_SELECT (customer + assignee names) but scoped to what logistics needs: the raised
// invoice, the order value, the channel, and a handle back to the customer/conversation.
// Order OLDEST-first (updated_at ASC) so the longest-waiting quote is worked first (FIFO).
// updated_at is the best available proxy for "quoted at" — F7a stamps it when it moves the
// lead to Quoted (no dedicated quoted_at column; noted as a known limitation).
const AWAITING_SELECT = `
  SELECT l.lead_id, l.stage, l.source, l.source_channel, l.customer_id,
         l.podium_conversation_id, l.value_est, l.order_total, l.quote_invoice_id,
         l.product_interest, l.assigned_to, l.created_at, l.updated_at,
         c.name  AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
         u.name  AS assigned_name
    FROM leads l
    LEFT JOIN customers c ON c.id = l.customer_id
    LEFT JOIN users     u ON u.id = l.assigned_to
   WHERE l.stage = 'Quoted'::lead_stage
     AND l.quote_invoice_id IS NOT NULL
     AND btrim(l.quote_invoice_id) <> ''
   ORDER BY l.updated_at ASC, l.lead_id ASC
`;

// G8 (Nick, 28 Sep 2026) — candidates for a TEMPORARY delivery run. The planner page
// groups and orders these in the browser only; it never books anything. So this resource
// is READ-ONLY by construction: three SELECTs (deliveries, workorders, carriers), no
// logEvent, no status change. The run sheet
// needs what the list endpoints don't return (customer phone + address), which is why this
// is its own gated read rather than a reuse of GET /api/delivery (whose list is also
// reachable without a token — widening that would leak phone numbers).
//
// items_text mirrors lib/handlers/delivery.js (qty × name (condition), cancelled items
// excluded). No price/cost column is selected.
const RUN_ITEMS_CTE = `
  WITH wo_items AS (
    SELECT wi.workorder_id,
           string_agg(
             wi.quantity::text || ' × ' ||
             COALESCE(wi.custom_description, p.name, wi.product_id) ||
             CASE WHEN wi.condition IS NOT NULL THEN ' (' || wi.condition::text || ')' ELSE '' END,
             ', ' ORDER BY wi.workorder_items_id
           ) FILTER (WHERE wi.status <> 'Canceled') AS items_text
      FROM workorder_items wi
      LEFT JOIN product p ON p.sku = wi.product_id
     GROUP BY wi.workorder_id
  )
`;

const RUN_DELIVERIES_SELECT = `${RUN_ITEMS_CTE}
  SELECT d.delivery_id, d.workorder_id, d.invoice_id, d.customer_id,
         d.delivery_suburb, d.delivery_state, d.delivery_type, d.notes,
         to_char(d.delivery_date, 'YYYY-MM-DD') AS delivery_date,
         r.name AS removalist_name,
         c.name AS customer_name, c.phone AS customer_phone, c.address AS customer_address,
         COALESCE(i.items_text, '—') AS items_text
    FROM delivery d
    JOIN customers c ON c.id = d.customer_id
    LEFT JOIN removalist r ON r.id = d.removalist_id
    LEFT JOIN wo_items   i ON i.workorder_id = d.workorder_id
   WHERE d.delivery_status = 'To Be Booked'
     -- A Customer Collect is a pickup at the warehouse, not a stop on a driver's run. It is
     -- marked either by type (0004) or, on older rows, by the "Customer Collect" carrier.
     AND d.delivery_type IS DISTINCT FROM 'Customer Collect'
     AND COALESCE(lower(r.name), '') <> 'customer collect'
   ORDER BY d.delivery_state, d.delivery_suburb, d.delivery_id
`;

// Current (not-yet-completed) workorders. One that already has a live delivery row is left
// out — it is either in the To-Be-Booked list above or already booked, and listing it twice
// would put the same customer on a run sheet twice.
const RUN_WORKORDERS_SELECT = `${RUN_ITEMS_CTE}
  SELECT wo.workorder_id, wo.invoice_id, wo.customer_id,
         wo.delivery_suburb, wo.delivery_state, wo.notes,
         to_char(wo.estimated_completion, 'YYYY-MM-DD') AS estimated_completion,
         c.name AS customer_name, c.phone AS customer_phone, c.address AS customer_address,
         COALESCE(i.items_text, '—') AS items_text
    FROM workorder wo
    JOIN customers c ON c.id = wo.customer_id
    LEFT JOIN wo_items i ON i.workorder_id = wo.workorder_id
   WHERE wo.status = 'Work Ordered'
     AND NOT EXISTS (
           SELECT 1 FROM delivery d
            WHERE d.workorder_id = wo.workorder_id
              AND d.delivery_status IN ('To Be Booked', 'Booked for Delivery')
         )
   ORDER BY wo.delivery_state, wo.delivery_suburb, wo.workorder_id
`;

// Carriers for the run's carrier picker. id + name only — no carrier contact details.
const RUN_CARRIERS_SELECT = `SELECT id, name FROM removalist ORDER BY name ASC`;

// sub = the path segments AFTER "logistics" (e.g. ['awaiting-workorder']).
// deps.getClient lets the offline smoke inject a fake pg client (default = real pool).
export default async function handler(req, res, sub = [], deps = {}) {
  const auth = getAuthUser(req);
  if (!auth) return res.status(401).json({ error: 'Not authenticated' });

  // Resolve the resource from the path segment OR ?resource= (query form is the safe one).
  const seg = Array.isArray(sub) ? sub[0] : undefined;
  const resource = (seg || req.query?.resource || '').toString();

  const roles = resource === 'run-candidates' ? TEMP_RUN_ROLES : ALLOWED_ROLES;
  if (!hasAnyRole(auth.roles, roles)) {
    return res.status(403).json({ error: 'Requires the logistics role to use the logistics queues' });
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed for this logistics route' });
  }
  if (resource !== 'awaiting-workorder' && resource !== 'run-candidates') {
    return res.status(404).json({ error: 'Unknown logistics resource' });
  }

  const getClient = deps.getClient || getClientWithTimezone;
  const client = await getClient();

  if (resource === 'run-candidates') {
    try {
      const deliveries = await client.query(RUN_DELIVERIES_SELECT);
      const workorders = await client.query(RUN_WORKORDERS_SELECT);
      const removalists = await client.query(RUN_CARRIERS_SELECT);
      return res.status(200).json({
        deliveries: deliveries.rows,
        workorders: workorders.rows,
        removalists: removalists.rows,
      });
    } catch (err) {
      console.error('Logistics run-candidates error:', err);
      return res.status(500).json({ error: 'Server error' });
    } finally {
      client.release();
    }
  }

  try {
    const r = await client.query(AWAITING_SELECT);
    return res.status(200).json(r.rows);
  } catch (err) {
    console.error('Logistics API error:', err);
    // leads/lead_stage_log may be absent on a bare DB (pre-release prod) — degrade to empty.
    if (err?.code === '42P01') return res.status(200).json([]);
    return res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
}
