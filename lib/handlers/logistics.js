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

// sub = the path segments AFTER "logistics" (e.g. ['awaiting-workorder']).
// deps.getClient lets the offline smoke inject a fake pg client (default = real pool).
export default async function handler(req, res, sub = [], deps = {}) {
  const auth = getAuthUser(req);
  if (!auth) return res.status(401).json({ error: 'Not authenticated' });
  if (!hasAnyRole(auth.roles, ALLOWED_ROLES)) {
    return res.status(403).json({ error: 'Requires the logistics role to use the logistics queues' });
  }

  // Resolve the resource from the path segment OR ?resource= (query form is the safe one).
  const seg = Array.isArray(sub) ? sub[0] : undefined;
  const resource = (seg || req.query?.resource || '').toString();

  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed for this logistics route' });
  }
  if (resource !== 'awaiting-workorder') {
    return res.status(404).json({ error: 'Unknown logistics resource' });
  }

  const getClient = deps.getClient || getClientWithTimezone;
  const client = await getClient();
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
