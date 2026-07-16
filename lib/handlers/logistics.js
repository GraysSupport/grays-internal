// lib/handlers/logistics.js — Logistics work queues + payment gate (features F7b, F7c).
//
// The logistics side of the funnel seam (execution-plan §F7). F7a (the salesperson)
// raises a MYOB quote/invoice on a lead → stage 'Quoted' + `quote_invoice_id`. This
// handler surfaces those quoted-but-not-yet-converted leads as a daily worklist for the
// LOGISTICS person to work through, then lets them confirm payment and create the
// workorder in one action:
//
//   GET  /api/logistics?resource=awaiting-workorder   (F7b) — the daily worklist
//   POST /api/logistics?resource=confirm-payment      (F7c) — confirm payment → workorder
//
// Routed through the api/[...path].js catch-all as a `logistics` case, which passes the
// path segments AFTER "logistics". To stay on the app's proven-safe routing convention
// (Vercel platform-404s multi-segment paths into the catch-all — F6 hit this and moved
// to the query form), the front-end calls the QUERY form and this handler resolves the
// resource from EITHER the path segment OR ?resource=.
//
// F7c (confirm-payment): the LOGISTICS person confirms the customer has paid (50% deposit
// is the normal trigger; exceptions are allowed with a recorded note — P8) and creates the
// workorder. This creates a workorder SHELL (invoice_id + customer + delivery details +
// outstanding_balance, no items) that the EXISTING workorder handler/UI then manages —
// items are added during the workshop flow. In ONE transaction it: INSERTs the workorder
// + a WORKORDER_CREATED log (the existing workorder_logs audit pattern), advances the lead
// to 'Won' (payment/paid_at/paid_confirmed_by/workorder_created_by/converted_workorder_id),
// and appends a Quoted→Won lead_stage_log row — so lead + workorder + logs are atomic.
//
// MYOB seam: while FEATURE_MYOB=false the payment confirmation is MANUAL (logistics ticks
// the payment type). The auto payment-status check lives in lib/myob.js (F7a, PR #64);
// when F7a merges alongside this, wire the confirm to myob.getPaymentStatus(invoice)
// behind the flag — the manual path here IS the flag-off behaviour, so no rebuild.
//
// Gated to logistics/superadmin via the login JWT (getAuthUser + hasAnyRole) — the server
// is the real authority (F9 formalises nav). No message bodies are touched (P1 not in
// scope — leads carry CRM metadata only).

import { getClientWithTimezone } from '../db.js';
import { getAuthUser, hasAnyRole } from '../rbac.js';

const ALLOWED_ROLES = ['logistics', 'superadmin'];

// Payment types the gate accepts (mirror the payment_type enum, minus 'none').
// deposit_50 = the usual 50% deposit; paid_full = paid in full; exception = anything else
// (partial/waived), which requires a recorded note (P8: overridable but recorded).
const PAYMENTS = ['deposit_50', 'paid_full', 'exception'];
// Workorder enums (verified on the Neon dev branch) the create form maps onto.
const DELIVERY_STATES = ['VIC', 'NSW', 'QLD', 'ACT', 'WA', 'SA', 'TAS', 'Customer Collect', 'NT'];
const LEAD_TIMES = ['1 Week', '2 Weeks', '3 Weeks', '4 Weeks', '5 Weeks'];

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

/** Clamp to varchar(2) (matches twoCharId in the workorder/leads handlers). */
function twoCharId(x) {
  const s = (x == null ? '' : String(x)).trim().toUpperCase();
  return (s || 'NA').slice(0, 2);
}

function toNumberOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Round money to 2dp. */
function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/** '2 Weeks' → 2 (drives estimated_completion, like the workorder handler's parseWeeks). */
function weeksFromLeadTime(label) {
  const m = String(label || '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

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

  const KNOWN = { 'awaiting-workorder': 'GET', 'confirm-payment': 'POST' };
  if (!(resource in KNOWN)) {
    return res.status(404).json({ error: 'Unknown logistics resource' });
  }

  const getClient = deps.getClient || getClientWithTimezone;
  const client = await getClient();
  try {
    if (resource === 'awaiting-workorder' && req.method === 'GET') {
      const r = await client.query(AWAITING_SELECT);
      return res.status(200).json(r.rows);
    }
    if (resource === 'confirm-payment' && req.method === 'POST') {
      return await confirmPayment(req, res, client, auth);
    }
    res.setHeader('Allow', [KNOWN[resource]]);
    return res.status(405).json({ error: 'Method not allowed for this logistics route' });
  } catch (err) {
    console.error('Logistics API error:', err);
    // leads/lead_stage_log may be absent on a bare DB (pre-release prod) — degrade the
    // read-only queue to empty; a write hitting a missing table is a genuine 500.
    if (err?.code === '42P01' && req.method === 'GET') return res.status(200).json([]);
    if (err?.code === '23503') return res.status(400).json({ error: 'Unknown customer or user reference' });
    return res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
}

// POST /api/logistics?resource=confirm-payment
// Body: { lead_id, payment, payment_note?, outstanding_balance?, delivery_state, lead_time,
//         delivery_suburb?, delivery_charged?, notes? }
async function confirmPayment(req, res, client, auth) {
  const b = req.body || {};

  // --- Validate the request body BEFORE opening a transaction. --------------------
  const leadId = toNumberOrNull(b.lead_id);
  if (leadId === null) {
    return res.status(400).json({ error: 'A lead_id is required', code: 'LEAD_ID_REQUIRED' });
  }
  const payment = (b.payment ?? '').toString();
  if (!PAYMENTS.includes(payment)) {
    return res.status(400).json({ error: `Invalid payment. One of: ${PAYMENTS.join(', ')}`, code: 'INVALID_PAYMENT' });
  }
  const paymentNote = (b.payment_note ?? '').toString().trim();
  if (payment === 'exception' && !paymentNote) {
    return res.status(400).json({ error: 'A note is required for an exception payment', code: 'PAYMENT_NOTE_REQUIRED' });
  }
  const deliveryState = (b.delivery_state ?? '').toString();
  if (!DELIVERY_STATES.includes(deliveryState)) {
    return res.status(400).json({ error: `Invalid delivery_state. One of: ${DELIVERY_STATES.join(', ')}`, code: 'INVALID_DELIVERY_STATE' });
  }
  const leadTime = (b.lead_time ?? '').toString();
  if (!LEAD_TIMES.includes(leadTime)) {
    return res.status(400).json({ error: `Invalid lead_time. One of: ${LEAD_TIMES.join(', ')}`, code: 'INVALID_LEAD_TIME' });
  }

  const actor = twoCharId(auth.id);
  const deliverySuburb = (b.delivery_suburb ?? '').toString().trim() || null;
  const deliveryCharged = toNumberOrNull(b.delivery_charged);
  const woNotes = (b.notes ?? '').toString().trim() || null;
  const explicitOutstanding = toNumberOrNull(b.outstanding_balance);
  // Customer Collect state ⇒ the workorder's delivery service type is Customer Collect too.
  const deliveryType = deliveryState === 'Customer Collect' ? 'Customer Collect' : 'Standard';
  const weeks = weeksFromLeadTime(leadTime);

  await client.query('BEGIN');
  try {
    // Lock the lead so two logistics people can't both convert it.
    const cur = await client.query(
      `SELECT lead_id, stage, customer_id, assigned_to, quote_invoice_id, order_total,
              converted_workorder_id
         FROM leads WHERE lead_id = $1 FOR UPDATE`,
      [leadId]
    );
    if (!cur.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Lead not found', code: 'LEAD_NOT_FOUND' });
    }
    const lead = cur.rows[0];

    // Idempotency: never create a second workorder for the same lead.
    if (lead.converted_workorder_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `This lead already has workorder #${lead.converted_workorder_id}`,
        code: 'WORKORDER_EXISTS',
        workorder_id: lead.converted_workorder_id,
      });
    }
    if (lead.stage !== 'Quoted') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Only a Quoted lead can be converted (this one is ${lead.stage})`, code: 'LEAD_NOT_QUOTED' });
    }
    const invoiceId = (lead.quote_invoice_id ?? '').toString().trim();
    if (!invoiceId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'The lead has no MYOB invoice number to carry onto the workorder', code: 'INVOICE_REQUIRED' });
    }
    if (!lead.customer_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'The lead has no linked customer — a workorder needs a customer', code: 'CUSTOMER_REQUIRED' });
    }

    // --- Outstanding balance (stage math). Explicit value wins; else derive. -------
    const orderTotal = toNumberOrNull(lead.order_total);
    let outstanding;
    if (explicitOutstanding !== null && explicitOutstanding >= 0) {
      outstanding = round2(explicitOutstanding);
    } else if (payment === 'paid_full') {
      outstanding = 0;
    } else if (payment === 'deposit_50') {
      if (orderTotal === null) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'The lead has no order total, so a 50% balance cannot be computed — enter the outstanding balance', code: 'ORDER_TOTAL_REQUIRED' });
      }
      outstanding = round2(orderTotal * 0.5);
    } else {
      // exception without an explicit outstanding balance
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Enter the outstanding balance for an exception payment', code: 'OUTSTANDING_REQUIRED' });
    }

    const salesperson = twoCharId(lead.assigned_to || actor);

    // Create the workorder shell (no items — the workshop adds them). estimated_completion
    // is derived from the lead time inline: NOW() + weeks*7 days.
    const woRes = await client.query(
      `INSERT INTO workorder (
         invoice_id, customer_id, salesperson, delivery_suburb, delivery_state,
         delivery_charged, lead_time, estimated_completion, notes, status,
         outstanding_balance, delivery_type
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, (NOW()::date + ($8::int * 7) * INTERVAL '1 day')::date, $9, $10,
         $11, $12
       ) RETURNING workorder_id`,
      [invoiceId, lead.customer_id, salesperson, deliverySuburb, deliveryState,
       deliveryCharged, leadTime, weeks, woNotes, 'Work Ordered',
       outstanding, deliveryType]
    );
    const workorderId = woRes.rows[0].workorder_id;

    // WORKORDER_CREATED audit row (matches the workorder handler's logEvent shape).
    await client.query(
      `INSERT INTO workorder_logs
         (workorder_id, workorder_items_id, event_type, user_id, item_status, notes_log)
       VALUES ($1, NULL, $2, $3, NULL, $4)`,
      [workorderId, 'WORKORDER_CREATED', actor, `Created from lead #${leadId} at the payment gate`]
    );

    // Advance the lead to Won, recording who confirmed payment + created the workorder.
    await client.query(
      `UPDATE leads
          SET stage = 'Won'::lead_stage,
              payment = $1::payment_type,
              payment_note = $2,
              paid_at = NOW(),
              paid_confirmed_by = $3,
              workorder_created_by = $3,
              converted_workorder_id = $4,
              updated_at = NOW()
        WHERE lead_id = $5`,
      [payment, paymentNote || null, actor, workorderId, leadId]
    );

    // Append the Quoted→Won stage-history row (mirrors lead_stage_log usage elsewhere).
    const paymentLabel = payment === 'deposit_50' ? '50% deposit' : payment === 'paid_full' ? 'paid in full' : 'exception';
    const stageNote = `Payment confirmed (${paymentLabel}); workorder #${workorderId} created`
      + (paymentNote ? ` — ${paymentNote}` : '');
    await client.query(
      `INSERT INTO lead_stage_log (lead_id, from_stage, to_stage, user_id, notes_log)
       VALUES ($1, 'Quoted'::lead_stage, 'Won'::lead_stage, $2, $3)`,
      [leadId, actor, stageNote]
    );

    await client.query('COMMIT');
    return res.status(201).json({
      workorder_id: workorderId,
      lead_id: leadId,
      stage: 'Won',
      outstanding_balance: outstanding,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}
