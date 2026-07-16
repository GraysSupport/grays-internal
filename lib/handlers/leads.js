// lib/handlers/leads.js — Lead funnel API (feature F5).
//
// The sales pipeline over the `leads` + `lead_stage_log` tables shipped in F0's
// migration 0001 (§4.3). Stages: New → Contacted → Quoted → Won / Lost ('Payment
// Received' was merged into 'Won' per Nick, 8 Jul — migration 0002). Every stage
// change appends an append-only `lead_stage_log` row (the same audit pattern as
// workorder_logs); a move to Lost requires a structured `lost_reason_category` (so
// losses are quantifiable) plus an optional note (required when category = 'Other').
//
// Routed through the api/[...path].js catch-all as a `leads` case (Hobby-cap
// discipline: NO new file under api/). The catch-all passes the path segments AFTER
// "leads", so:
//   GET  /api/leads                → list the board (optional ?stage= / ?assigned_to=)
//   POST /api/leads                → create a lead (+ NULL→<stage> log)
//   GET  /api/leads/:id            → one lead
//   GET  /api/leads/:id/history    → the lead's stage history (lead_stage_log, ASC)
//   PUT  /api/leads/:id/stage      → transition stage (+ from→to log; Lost needs a reason)
//   POST /api/leads/:id/quote      → F7a raise Quote/Invoice: record the MYOB invoice
//                                    number (+ optional order total) and move → Quoted
//
// Gated to sales/superadmin via the login JWT (getAuthUser + hasAnyRole) — the server
// is the real authority (F9 formalises nav). Acting rep's 2-char id is the log user_id
// and the default assignee. No message bodies are touched (P1 is not in scope here —
// leads carry CRM metadata only).

import { getClientWithTimezone } from '../db.js';
import { getAuthUser, hasAnyRole } from '../rbac.js';
import { isMyobEnabled, createInvoice } from '../myob.js';

const ALLOWED_ROLES = ['sales', 'superadmin'];
export const STAGES = ['New', 'Contacted', 'Quoted', 'Won', 'Lost'];

// Structured Lost-reason categories (quantifiable). 'Other' requires a free-text note.
// Keep in sync with the dropdown in src/pages/leads.js.
export const LOST_REASONS = [
  'Price / too expensive',
  'Went with a competitor',
  'Lead time / stock too long',
  'Changed mind / no longer needed',
  'No response (went cold)',
  'Budget / finance',
  'Other',
];

// The joined shape the Kanban board renders (customer + assignee names).
const LEAD_SELECT = `
  SELECT l.lead_id, l.stage, l.source, l.source_channel, l.customer_id,
         l.podium_conversation_id, l.value_est, l.product_interest,
         l.quote_invoice_id, l.order_total, l.assigned_to, l.lost_reason, l.lost_reason_category, l.notes,
         l.last_contact_at, l.created_at, l.updated_at,
         c.name  AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
         u.name  AS assigned_name
    FROM leads l
    LEFT JOIN customers c ON c.id = l.customer_id
    LEFT JOIN users     u ON u.id = l.assigned_to
`;

/** Clamp a value to varchar(2) (matches twoCharId in the workorder handler). */
function twoCharId(x) {
  const s = (x == null ? '' : String(x)).trim().toUpperCase();
  return (s || 'NA').slice(0, 2);
}

function toNumberOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchLeadRow(client, id) {
  const r = await client.query(`${LEAD_SELECT} WHERE l.lead_id = $1`, [id]);
  return r.rowCount ? r.rows[0] : null;
}

// sub = the path segments AFTER "leads" (e.g. ['5','stage'] for /api/leads/5/stage).
// deps.getClient lets the offline smoke inject a fake pg client (default = real pool).
export default async function handler(req, res, sub = [], deps = {}) {
  const auth = getAuthUser(req);
  if (!auth) return res.status(401).json({ error: 'Not authenticated' });
  if (!hasAnyRole(auth.roles, ALLOWED_ROLES)) {
    return res.status(403).json({ error: 'Requires the sales role to use the lead funnel' });
  }

  const [idSeg, action] = Array.isArray(sub) ? sub : [];
  const { method } = req;

  const getClient = deps.getClient || getClientWithTimezone;
  const client = await getClient();
  try {
    if (method === 'GET' && !idSeg) return listLeads(req, res, client);
    if (method === 'POST' && !idSeg) return createLead(req, res, client, auth);
    if (method === 'GET' && idSeg && !action) return getLead(res, client, idSeg);
    if (method === 'GET' && idSeg && action === 'history') return leadHistory(res, client, idSeg);
    if (method === 'PUT' && idSeg && action === 'stage') return transitionStage(req, res, client, auth, idSeg);
    if (method === 'POST' && idSeg && action === 'quote') return raiseQuote(req, res, client, auth, idSeg);

    res.setHeader('Allow', ['GET', 'POST', 'PUT']);
    return res.status(405).json({ error: 'Method not allowed for this leads route' });
  } catch (err) {
    console.error('Leads API error:', err);
    if (err?.code === '23503') return res.status(400).json({ error: 'Unknown customer or user reference' });
    return res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
}

// GET /api/leads — the whole board (optionally filtered).
async function listLeads(req, res, client) {
  const { stage, assigned_to } = req.query || {};
  const where = [];
  const params = [];
  if (stage && STAGES.includes(String(stage))) { params.push(String(stage)); where.push(`l.stage = $${params.length}::lead_stage`); }
  if (assigned_to) { params.push(twoCharId(assigned_to)); where.push(`l.assigned_to = $${params.length}`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const r = await client.query(`${LEAD_SELECT} ${whereSql} ORDER BY l.updated_at DESC`, params);
  return res.status(200).json(r.rows);
}

// GET /api/leads/:id
async function getLead(res, client, id) {
  const row = await fetchLeadRow(client, id);
  if (!row) return res.status(404).json({ error: 'Lead not found' });
  return res.status(200).json(row);
}

// GET /api/leads/:id/history — the funnel timeline (lead_stage_log, oldest → newest,
// with the acting user's name). Powers the "funnel history" view in the inbox panel.
async function leadHistory(res, client, id) {
  const r = await client.query(
    `SELECT g.id, g.from_stage, g.to_stage, g.user_id, g.notes_log, g.created_at,
            u.name AS user_name
       FROM lead_stage_log g
       LEFT JOIN users u ON u.id = g.user_id
      WHERE g.lead_id = $1
      ORDER BY g.created_at ASC, g.id ASC`,
    [id]
  );
  return res.status(200).json({ lead_id: Number(id), history: r.rows });
}

// POST /api/leads — create a lead (+ NULL→<stage> stage log).
// Accepts an optional conversation link (podium_conversation_id) so the inbox can add
// a conversation to the funnel, an optional workorder link (converted_workorder_id +
// quote_invoice_id), and an optional initial `stage` (defaults 'New'). One open lead
// per conversation: if the conversation already has an open lead, that lead is returned
// unchanged (idempotent — the inbox's "Add to funnel" is safe to click twice).
async function createLead(req, res, client, auth) {
  const b = req.body || {};
  const productInterest = (b.product_interest ?? '').toString().trim();
  const customerId = toNumberOrNull(b.customer_id);
  const conversationId = b.podium_conversation_id ? String(b.podium_conversation_id) : null;
  if (!productInterest && !customerId && !conversationId) {
    return res.status(400).json({ error: 'A product interest, customer, or conversation is required' });
  }

  // Dedupe: one lead per conversation (any stage). The inbox only offers "Add to
  // funnel" when there's no lead at all, so this is a backstop that also keeps a
  // closed (Won/Lost) conversation from spawning a duplicate.
  if (conversationId) {
    const dup = await client.query(
      `SELECT lead_id FROM leads
        WHERE podium_conversation_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [conversationId]
    );
    if (dup.rowCount) {
      const existing = await fetchLeadRow(client, dup.rows[0].lead_id);
      return res.status(200).json(existing); // already in the funnel
    }
  }

  const sourceChannel = b.source_channel ? String(b.source_channel).slice(0, 20) : null;
  const valueEst = toNumberOrNull(b.value_est);
  const notes = b.notes ? String(b.notes) : null;
  const assignedTo = b.assigned_to ? twoCharId(b.assigned_to) : twoCharId(auth.id);
  const actor = twoCharId(auth.id);
  const convertedWo = toNumberOrNull(b.converted_workorder_id);
  const quoteInvoice = b.quote_invoice_id ? String(b.quote_invoice_id) : null;
  const stage = b.stage && STAGES.includes(String(b.stage)) ? String(b.stage) : 'New';
  const source = conversationId ? 'podium' : 'manual';

  await client.query('BEGIN');
  try {
    const ins = await client.query(
      `INSERT INTO leads
         (source, source_channel, podium_conversation_id, customer_id, product_interest,
          value_est, assigned_to, notes, quote_invoice_id, converted_workorder_id, stage)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::lead_stage)
       RETURNING lead_id`,
      [source, sourceChannel, conversationId, customerId, productInterest || null,
        valueEst, assignedTo, notes, quoteInvoice, convertedWo, stage]
    );
    const leadId = ins.rows[0].lead_id;
    await client.query(
      `INSERT INTO lead_stage_log (lead_id, from_stage, to_stage, user_id, notes_log)
       VALUES ($1, NULL, $2::lead_stage, $3, $4)`,
      [leadId, stage, actor, conversationId ? 'Added to funnel from inbox' : 'Lead created']
    );
    await client.query('COMMIT');
    const row = await fetchLeadRow(client, leadId);
    return res.status(201).json(row);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

// PUT /api/leads/:id/stage — transition + append-only log. A move to Lost requires a
// structured lost_reason_category (from LOST_REASONS); category 'Other' also needs a
// free-text note (lost_reason). The category is stored for quantification; lost_reason
// keeps the note/detail.
async function transitionStage(req, res, client, auth, id) {
  const b = req.body || {};
  const toStage = (b.to_stage ?? b.stage ?? '').toString();
  if (!STAGES.includes(toStage)) {
    return res.status(400).json({ error: `Invalid stage. One of: ${STAGES.join(', ')}` });
  }

  const note = (b.lost_reason ?? b.note ?? '').toString().trim();
  let lostCategory = null;
  if (toStage === 'Lost') {
    lostCategory = (b.lost_reason_category ?? '').toString().trim();
    if (!lostCategory) {
      return res.status(400).json({ error: 'A lost_reason_category is required to mark a lead Lost', code: 'LOST_REASON_REQUIRED' });
    }
    if (!LOST_REASONS.includes(lostCategory)) {
      return res.status(400).json({ error: `Invalid lost reason. One of: ${LOST_REASONS.join(', ')}` });
    }
    if (lostCategory === 'Other' && !note) {
      return res.status(400).json({ error: 'A note is required when the lost reason is "Other"', code: 'LOST_NOTE_REQUIRED' });
    }
  }
  const actor = twoCharId(auth.id);
  // Log line: the category + note for a loss, else any provided note.
  const noteLog = toStage === 'Lost'
    ? [lostCategory, note].filter(Boolean).join(' — ')
    : (note || null);

  await client.query('BEGIN');
  try {
    const cur = await client.query('SELECT stage FROM leads WHERE lead_id = $1 FOR UPDATE', [id]);
    if (!cur.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Lead not found' });
    }
    const fromStage = cur.rows[0].stage;
    if (fromStage === toStage) {
      // No-op transition — don't write a spurious log row.
      await client.query('COMMIT');
      const same = await fetchLeadRow(client, id);
      return res.status(200).json(same);
    }
    await client.query(
      `UPDATE leads
          SET stage = $1::lead_stage,
              lost_reason = CASE WHEN $1 = 'Lost' THEN $2 ELSE lost_reason END,
              lost_reason_category = CASE WHEN $1 = 'Lost' THEN $3 ELSE lost_reason_category END,
              last_contact_at = NOW(),
              updated_at = NOW()
        WHERE lead_id = $4`,
      [toStage, note || null, lostCategory, id]
    );
    await client.query(
      `INSERT INTO lead_stage_log (lead_id, from_stage, to_stage, user_id, notes_log)
       VALUES ($1, $2::lead_stage, $3::lead_stage, $4, $5)`,
      [id, fromStage, toStage, actor, noteLog]
    );
    await client.query('COMMIT');
    const row = await fetchLeadRow(client, id);
    return res.status(200).json(row);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

// POST /api/leads/:id/quote — F7a: the salesperson raises a Quote/Invoice (§1c step 3).
//
// Records the MYOB `quote_invoice_id` (which becomes `workorder.invoice_id` at convert,
// F7c) plus an optional `order_total`, and moves the lead → 'Quoted'. The MYOB call is a
// seam (lib/myob.js): with FEATURE_MYOB on, `createInvoice()` returns the number
// automatically; with it off (now), the rep supplies the number they raised by hand.
// A first move to Quoted appends a from→Quoted stage-log row; re-quoting a lead that is
// already Quoted just updates the invoice number (no spurious log row — same philosophy
// as the no-op stage transition). A closed lead (Won/Lost) can't be quoted (409).
async function raiseQuote(req, res, client, auth, id) {
  const b = req.body || {};
  let invoiceId = (b.quote_invoice_id ?? '').toString().trim();
  const orderTotal = toNumberOrNull(b.order_total);
  const valueEst = toNumberOrNull(b.value_est);
  const note = (b.notes ?? '').toString().trim();

  // MYOB seam: when enabled and the rep didn't pass a number, create the invoice in MYOB
  // and use the returned number. When disabled, createInvoice throws MYOB_DISABLED and we
  // fall through to requiring the manually-entered number.
  if (!invoiceId && isMyobEnabled()) {
    try {
      const inv = await createInvoice({ orderTotal, valueEst });
      invoiceId = (inv?.invoiceId ?? '').toString().trim();
    } catch (err) {
      if (err?.code !== 'MYOB_DISABLED') {
        console.error('MYOB createInvoice failed:', err);
        return res.status(502).json({ error: 'Could not raise the invoice in MYOB', code: 'MYOB_ERROR' });
      }
    }
  }
  if (!invoiceId) {
    return res.status(400).json({ error: 'A MYOB invoice number is required to raise a quote', code: 'INVOICE_REQUIRED' });
  }

  const actor = twoCharId(auth.id);
  await client.query('BEGIN');
  try {
    const cur = await client.query('SELECT stage FROM leads WHERE lead_id = $1 FOR UPDATE', [id]);
    if (!cur.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Lead not found' });
    }
    const fromStage = cur.rows[0].stage;
    if (fromStage === 'Won' || fromStage === 'Lost') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Cannot raise a quote on a ${fromStage} lead`, code: 'LEAD_CLOSED' });
    }
    // Record the invoice + total; only advance the stage forward to Quoted (COALESCE keeps
    // an existing order_total when the caller omits one).
    await client.query(
      `UPDATE leads
          SET quote_invoice_id = $1,
              order_total = COALESCE($2, order_total),
              value_est = COALESCE($3, value_est),
              stage = 'Quoted'::lead_stage,
              last_contact_at = NOW(),
              updated_at = NOW()
        WHERE lead_id = $4`,
      [invoiceId, orderTotal, valueEst, id]
    );
    if (fromStage !== 'Quoted') {
      const logNote = [`Quote raised — MYOB invoice ${invoiceId}`, note].filter(Boolean).join(' — ');
      await client.query(
        `INSERT INTO lead_stage_log (lead_id, from_stage, to_stage, user_id, notes_log)
         VALUES ($1, $2::lead_stage, 'Quoted'::lead_stage, $3, $4)`,
        [id, fromStage, actor, logNote]
      );
    }
    await client.query('COMMIT');
    const row = await fetchLeadRow(client, id);
    return res.status(200).json(row);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}
