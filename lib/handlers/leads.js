// lib/handlers/leads.js — Lead funnel API (feature F5).
//
// The sales pipeline over the `leads` + `lead_stage_log` tables shipped in F0's
// migration 0001 (§4.3). Stages: New → Contacted → Quoted → Payment Received →
// Won / Lost. Every stage change appends an append-only `lead_stage_log` row (the
// same audit pattern as workorder_logs), and a move to Lost requires a `lost_reason`.
//
// Routed through the api/[...path].js catch-all as a `leads` case (Hobby-cap
// discipline: NO new file under api/). The catch-all passes the path segments AFTER
// "leads", so:
//   GET  /api/leads                → list the board (optional ?stage= / ?assigned_to=)
//   POST /api/leads                → create a New lead (+ NULL→New log)
//   GET  /api/leads/:id            → one lead
//   PUT  /api/leads/:id/stage      → transition stage (+ from→to log; Lost needs a reason)
//
// Gated to sales/superadmin via the login JWT (getAuthUser + hasAnyRole) — the server
// is the real authority (F9 formalises nav). Acting rep's 2-char id is the log user_id
// and the default assignee. No message bodies are touched (P1 is not in scope here —
// leads carry CRM metadata only).

import { getClientWithTimezone } from '../db.js';
import { getAuthUser, hasAnyRole } from '../rbac.js';

const ALLOWED_ROLES = ['sales', 'superadmin'];
export const STAGES = ['New', 'Contacted', 'Quoted', 'Payment Received', 'Won', 'Lost'];

// The joined shape the Kanban board renders (customer + assignee names).
const LEAD_SELECT = `
  SELECT l.lead_id, l.stage, l.source, l.source_channel, l.customer_id,
         l.podium_conversation_id, l.value_est, l.product_interest,
         l.quote_invoice_id, l.assigned_to, l.lost_reason, l.notes,
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
    if (method === 'PUT' && idSeg && action === 'stage') return transitionStage(req, res, client, auth, idSeg);

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

// POST /api/leads — create a New lead (+ NULL→New stage log).
async function createLead(req, res, client, auth) {
  const b = req.body || {};
  const productInterest = (b.product_interest ?? '').toString().trim();
  const customerId = toNumberOrNull(b.customer_id);
  if (!productInterest && !customerId) {
    return res.status(400).json({ error: 'A product interest or a customer is required' });
  }
  const sourceChannel = b.source_channel ? String(b.source_channel).slice(0, 20) : null;
  const valueEst = toNumberOrNull(b.value_est);
  const notes = b.notes ? String(b.notes) : null;
  const assignedTo = b.assigned_to ? twoCharId(b.assigned_to) : twoCharId(auth.id);
  const actor = twoCharId(auth.id);

  await client.query('BEGIN');
  try {
    const ins = await client.query(
      `INSERT INTO leads (source, source_channel, customer_id, product_interest, value_est, assigned_to, notes, stage)
       VALUES ('manual', $1, $2, $3, $4, $5, $6, 'New')
       RETURNING lead_id`,
      [sourceChannel, customerId, productInterest || null, valueEst, assignedTo, notes]
    );
    const leadId = ins.rows[0].lead_id;
    await client.query(
      `INSERT INTO lead_stage_log (lead_id, from_stage, to_stage, user_id, notes_log)
       VALUES ($1, NULL, 'New', $2, $3)`,
      [leadId, actor, 'Lead created']
    );
    await client.query('COMMIT');
    const row = await fetchLeadRow(client, leadId);
    return res.status(201).json(row);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

// PUT /api/leads/:id/stage — transition + append-only log. Lost requires a reason.
async function transitionStage(req, res, client, auth, id) {
  const b = req.body || {};
  const toStage = (b.to_stage ?? b.stage ?? '').toString();
  if (!STAGES.includes(toStage)) {
    return res.status(400).json({ error: `Invalid stage. One of: ${STAGES.join(', ')}` });
  }
  const lostReason = (b.lost_reason ?? '').toString().trim();
  if (toStage === 'Lost' && !lostReason) {
    return res.status(400).json({ error: 'A lost_reason is required to mark a lead Lost', code: 'LOST_REASON_REQUIRED' });
  }
  const actor = twoCharId(auth.id);
  const noteLog = b.notes ? String(b.notes) : (toStage === 'Lost' ? lostReason : null);

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
              last_contact_at = NOW(),
              updated_at = NOW()
        WHERE lead_id = $3`,
      [toStage, lostReason || null, id]
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
