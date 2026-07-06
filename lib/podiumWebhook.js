// lib/podiumWebhook.js — inbound Podium webhook processing (feature F2).
//
// The receiver (api/podium/webhook.js) is deliberately thin — it captures the RAW
// body, verifies the signature, and hands a parsed envelope to this module, which
// owns all the CRM logic. Keeping the logic here (pure helpers + DB steps that take
// an injected pg client) makes it unit-testable offline without a live Podium or a
// running server (see scripts/podium-webhook-smoke.mjs).
//
// Contract (execution-plan.md §F2, §10, §15.6):
//   1. Signature — HMAC-SHA256 over "{Podium-Timestamp}.{raw_body}" keyed by
//      PODIUM_WEBHOOK_SECRET, constant-time-compared to the `Podium-Signature`
//      header. Stale timestamps are rejected (replay guard).
//   2. Dedupe — `integration_sync_log` unique (source, reference_id) on
//      `metadata.eventUid`. Podium retries for ~10 days, so every handler is
//      idempotent and a duplicate event is a no-op ack.
//   3. Route by `metadata.eventType` (§10):
//        • message.received → P12: auto-create a `New` lead for the conversation
//          (assigned to the conversation's assignee, else unassigned) if none is
//          open, else touch `last_contact_at`. Completes the funnel's first touch.
//        • conversation-assignment → resolve `assignedUser.uid` → portal user →
//          mirrorAssignmentToLead(). This is F1b's Podium → portal direction.
//        • message.sent → reconcile (log only for now).
//        • message.failed → record status='failed' (surfaced by the inbox/F10).
//        • contact / lead / review events → logged; richer handling lands with
//          F4/F5/F8 which own those tables.
//
// P1 GUARD (execution-plan.md P1): NOTHING here reads or persists `data.body`.
// parseEnvelope() copies only stable identifiers/metadata; the sync-log payload is
// an envelope, never message text. Podium remains the system of record for chat.

import crypto from 'crypto';
import { mirrorAssignmentToLead } from './podiumAssign.js';

// Replay window: reject events whose signed timestamp is more than this far from
// now (in either direction). Podium retries within ~10 days, but each retry is
// re-signed with a fresh timestamp, so a tight window here is safe.
const DEFAULT_TOLERANCE_SEC = 300;

// ---- Signature verification (§15.6) ---------------------------------------

/**
 * Parse the `Podium-Timestamp` header to epoch milliseconds. Podium's exact
 * encoding isn't pinned in our verified reference, so accept the common forms:
 * epoch seconds (10 digits), epoch millis (13 digits), or an ISO-8601 string.
 * VERIFY the concrete format against docs.podium.com when wiring live creds.
 * @returns {number|null} epoch ms, or null if unparseable
 */
export function parseTimestampMs(ts) {
  if (ts == null) return null;
  const s = String(ts).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    // 13+ digits ⇒ already milliseconds; 10-ish digits ⇒ seconds.
    return s.length >= 13 ? n : n * 1000;
  }
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Constant-time string compare that never throws on length mismatch. */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Compute the expected signature for a raw body + timestamp.
 * signed_payload = "{timestamp}.{raw_body}", HMAC-SHA256, hex.
 */
export function computeSignature(rawBody, timestamp, secret) {
  const raw = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody ?? '');
  return crypto.createHmac('sha256', String(secret))
    .update(`${timestamp}.${raw}`, 'utf8')
    .digest('hex');
}

/**
 * Verify a Podium webhook request.
 * @param {{rawBody:(Buffer|string), signature?:string, timestamp?:string,
 *          secret?:string, toleranceSec?:number, now?:number}} args
 * @returns {{ok:boolean, reason?:string}}
 *   reasons: 'no_secret' | 'missing_headers' | 'stale_timestamp' | 'bad_signature'
 */
export function verifySignature({ rawBody, signature, timestamp, secret, toleranceSec = DEFAULT_TOLERANCE_SEC, now = Date.now() }) {
  if (!secret) return { ok: false, reason: 'no_secret' };
  if (!signature || !timestamp) return { ok: false, reason: 'missing_headers' };

  const tsMs = parseTimestampMs(timestamp);
  if (tsMs == null) return { ok: false, reason: 'missing_headers' };
  if (Math.abs(now - tsMs) > toleranceSec * 1000) return { ok: false, reason: 'stale_timestamp' };

  // Podium sends a hex HMAC; tolerate an optional "sha256=" prefix defensively.
  const provided = String(signature).replace(/^sha256=/i, '');
  const expected = computeSignature(rawBody, timestamp, secret);
  return safeEqual(provided, expected) ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

// ---- Envelope parsing (P1: identifiers/metadata only, never body) ----------

/**
 * Pull ONLY the durable, non-sensitive fields we're allowed to keep out of a raw
 * Podium event. Never returns `data.body`. The deprecated `data.contact`/`sender`
 * hints (§15.6) are read only as a best-effort id fallback; durable identity is the
 * stable `conversation.uid` + the Users/Contacts APIs (resolved later, F4).
 * @returns {{eventUid:?string, eventType:?string, version:?string,
 *   conversationUid:?string, channelType:?string, channelIdentifier:?string,
 *   assignedUserUid:?string, contactUid:?string, locationUid:?string,
 *   orgUid:?string, occurredAt:?string, failureReason:?string}}
 */
export function parseEnvelope(payload) {
  const p = payload || {};
  const meta = p.metadata || {};
  const data = p.data || {};
  const conv = data.conversation || {};
  const channel = conv.channel || {};
  const loc = data.location || {};
  // deprecated hint — id only, used solely as a fallback for contact linking
  const contactHint = data.contact || {};

  return {
    eventUid: meta.eventUid ?? null,
    eventType: meta.eventType ?? null,
    version: meta.version ?? null,
    conversationUid: conv.uid ?? null,
    channelType: channel.type ?? null,
    channelIdentifier: channel.identifier ?? null,
    assignedUserUid: conv.assignedUser?.uid ?? null,
    contactUid: contactHint.uid ?? null,
    locationUid: loc.uid ?? null,
    orgUid: loc.organizationUid ?? null,
    occurredAt: meta.occurredAt ?? data.createdAt ?? null,
    failureReason: data.failureReason ?? null,
  };
}

/** Minimal, P1-safe JSON stored in integration_sync_log.payload (no message text). */
export function buildSyncPayload(env) {
  return {
    conversationUid: env.conversationUid,
    channel: env.channelType,
    channelIdentifier: env.channelIdentifier,
    assignedUserUid: env.assignedUserUid,
    contactUid: env.contactUid,
    locationUid: env.locationUid,
    orgUid: env.orgUid,
    occurredAt: env.occurredAt,
    version: env.version,
    ...(env.failureReason ? { failureReason: env.failureReason } : {}),
  };
}

// ---- Event classification --------------------------------------------------

/**
 * Map a raw `metadata.eventType` to a normalized action. Kept liberal on the
 * assignment match because the exact conversation-assignment event name isn't in
 * our verified reference yet (VERIFY against docs.podium.com at live-wiring).
 */
export function classifyEvent(eventType) {
  const t = String(eventType || '').toLowerCase();
  if (t === 'message.received') return 'message.received';
  if (t === 'message.sent') return 'message.sent';
  if (t === 'message.failed') return 'message.failed';
  if (t.includes('assign')) return 'assignment';
  if (t.startsWith('contact')) return 'contact';
  if (t.startsWith('lead')) return 'lead';
  if (t.startsWith('review')) return 'review';
  return 'unknown';
}

// ---- DB steps (injected pg client; caller owns the connection) -------------

/**
 * Idempotency gate: insert the envelope into integration_sync_log, deduping on the
 * partial unique index uq_sync_ref (source, reference_id) WHERE reference_id NOT NULL.
 * @returns {Promise<{id:?number, isNew:boolean}>} isNew=false ⇒ already processed.
 */
export async function insertSyncLog(client, env, { status = 'received' } = {}) {
  const r = await client.query(
    `INSERT INTO integration_sync_log (source, direction, event_type, reference_id, status, payload)
     VALUES ('podium', 'inbound', $1, $2, $3, $4)
     ON CONFLICT (source, reference_id) WHERE reference_id IS NOT NULL
     DO NOTHING
     RETURNING id`,
    [env.eventType || 'unknown', env.eventUid || null, status, JSON.stringify(buildSyncPayload(env))]
  );
  return { id: r.rows[0]?.id ?? null, isNew: r.rowCount > 0 };
}

/** Update a sync-log row's final status/error. No-op if id is null. */
export async function markSyncLog(client, id, status, error = null) {
  if (id == null) return;
  await client.query(
    `UPDATE integration_sync_log SET status = $1, error = $2 WHERE id = $3`,
    [status, error, id]
  );
}

/** Resolve a Podium member uid → portal user id via users.podium_user_id. */
export async function portalUserForPodiumUid(client, podiumUserUid) {
  if (!podiumUserUid) return null;
  try {
    const r = await client.query(
      `SELECT id FROM users WHERE podium_user_id = $1 LIMIT 1`,
      [podiumUserUid]
    );
    return r.rows[0]?.id ?? null;
  } catch (err) {
    if (err?.code === '42703') return null; // column absent on a pre-F0 DB
    throw err;
  }
}

/**
 * P12 — auto-create a lead on the first inbound with no open lead for the
 * conversation, else touch last_contact_at. Idempotent per conversation: a
 * just-created lead is open, so subsequent inbounds only touch it.
 * @returns {Promise<{action:string, leadId:?number}>}
 */
export async function handleMessageReceived(client, env) {
  const convUid = env.conversationUid;
  if (!convUid) return { action: 'skipped_no_conversation', leadId: null };

  // Open lead already tracking this conversation? (open = not Won/Lost)
  const existing = await client.query(
    `SELECT lead_id FROM leads
      WHERE podium_conversation_id = $1 AND stage NOT IN ('Won','Lost')
      ORDER BY created_at DESC LIMIT 1`,
    [convUid]
  );
  if (existing.rowCount > 0) {
    const leadId = existing.rows[0].lead_id;
    await client.query(
      `UPDATE leads SET last_contact_at = NOW(), updated_at = NOW() WHERE lead_id = $1`,
      [leadId]
    );
    return { action: 'touched_lead', leadId };
  }

  // Assign to the conversation's Podium assignee if we can map them (else unassigned).
  const assignedTo = await portalUserForPodiumUid(client, env.assignedUserUid);

  // Best-effort customer link off the (deprecated) contact hint — no API call, id only.
  // Full contact↔customer bridging is F4; until then customer_id may stay NULL.
  let customerId = null;
  if (env.contactUid) {
    try {
      const cr = await client.query(
        `SELECT id FROM customers WHERE podium_contact_id = $1 LIMIT 1`,
        [env.contactUid]
      );
      customerId = cr.rows[0]?.id ?? null;
    } catch (err) {
      if (err?.code !== '42703' && err?.code !== '42P01') throw err;
    }
  }

  const ins = await client.query(
    `INSERT INTO leads
       (source, source_channel, podium_conversation_id, podium_contact_id,
        customer_id, stage, assigned_to, last_contact_at)
     VALUES ('podium', $1, $2, $3, $4, 'New', $5, NOW())
     RETURNING lead_id`,
    [env.channelType || null, convUid, env.contactUid || null, customerId, assignedTo]
  );
  const leadId = ins.rows[0].lead_id;

  // Append-only stage history (mirrors workorder_logs).
  await client.query(
    `INSERT INTO lead_stage_log (lead_id, from_stage, to_stage, user_id, notes_log)
     VALUES ($1, NULL, 'New', $2, 'Auto-created from inbound Podium message (P12)')`,
    [leadId, assignedTo]
  );

  return { action: 'created_lead', leadId };
}

/**
 * Podium → portal assignment (F1b inbound half): resolve the conversation's
 * Podium assignee → portal user → mirror onto the lead. A null assignee clears
 * the owner. Returns rows updated (0 until a lead exists — the seam is wired).
 */
export async function handleAssignment(client, env) {
  const portalUserId = await portalUserForPodiumUid(client, env.assignedUserUid);
  const rows = await mirrorAssignmentToLead(client, env.conversationUid, portalUserId);
  return { action: 'mirrored_assignment', portalUserId, leadsUpdated: rows };
}

/**
 * Route a verified, non-duplicate event. Returns a small result describing the
 * action and the final sync-log status to record.
 */
export async function routeEvent(client, env) {
  const kind = classifyEvent(env.eventType);
  switch (kind) {
    case 'message.received': {
      const r = await handleMessageReceived(client, env);
      return { kind, status: 'processed', ...r };
    }
    case 'assignment': {
      const r = await handleAssignment(client, env);
      return { kind, status: 'processed', ...r };
    }
    case 'message.failed':
      // §10: record the failure; the inbox/F10 surface it. No lead mutation.
      return { kind, status: 'failed', action: 'recorded_failure' };
    case 'message.sent':
      return { kind, status: 'processed', action: 'reconciled_send' };
    default:
      // contact/lead/review/unknown — logged now; owned by F4/F5/F8 later.
      return { kind, status: 'processed', action: 'logged' };
  }
}

/**
 * Full processing for one verified event, wrapped in a single transaction so it is
 * idempotent and safe against Podium's ~10-day retry queue:
 *   • The dedupe-insert + routing + final status commit atomically. If routing
 *     throws, ROLLBACK discards BOTH the dedupe row and any partial lead write, so
 *     Podium's retry reprocesses cleanly (handlers are individually idempotent too).
 *   • A duplicate eventUid short-circuits (the partial unique index yields isNew=false).
 *   • Concurrent deliveries of the same event serialize on the uncommitted unique
 *     key: the second INSERT ... ON CONFLICT DO NOTHING blocks until the first
 *     commits, then sees the row and dedupes.
 * @returns {Promise<{deduped:boolean, kind?:string, action?:string, leadId?:?number, syncLogId:?number}>}
 */
export async function processEvent(client, env) {
  await client.query('BEGIN');
  try {
    const { id, isNew } = await insertSyncLog(client, env);
    if (!isNew) {
      await client.query('COMMIT');
      return { deduped: true, syncLogId: null };
    }
    const result = await routeEvent(client, env);
    await markSyncLog(client, id, result.status);
    await client.query('COMMIT');
    return { deduped: false, syncLogId: id, ...result };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

export default {
  parseTimestampMs, safeEqual, computeSignature, verifySignature,
  parseEnvelope, buildSyncPayload, classifyEvent,
  insertSyncLog, markSyncLog, portalUserForPodiumUid,
  handleMessageReceived, handleAssignment, routeEvent, processEvent,
  DEFAULT_TOLERANCE_SEC,
};
