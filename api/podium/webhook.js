// api/podium/webhook.js — inbound Podium webhook receiver (feature F2).
//
// Location/org-registered endpoint (P4) that Podium POSTs every subscribed event to.
// Standalone serverless function (NOT the api/[...path].js catch-all). It stays
// deliberately minimal so it acks well inside Podium's <5 s timeout (§F2, risk in
// §11): capture the RAW body, verify the HMAC-SHA256 signature, dedupe, route, ack.
//
// Raw body: Podium signs the exact bytes, so we MUST verify before any JSON parse.
// Vercel's Node runtime parses JSON into req.body by default, which would destroy the
// exact bytes — so we disable the body parser (config below) and read the stream
// ourselves (no extra dependency).
//
// All CRM logic lives in lib/podiumWebhook.js (unit-tested offline). This file is the
// HTTP shell: method + signature gate, then processEvent().
//
// P1: only envelope metadata is persisted (lib/podiumWebhook.buildSyncPayload) —
// never `data.body`. Podium is the system of record for chat.

import { getClientWithTimezone } from '../../lib/db.js';
import { verifySignature, parseEnvelope, processEvent } from '../../lib/podiumWebhook.js';

// Disable Vercel's automatic body parsing so we can read the exact signed bytes.
export const config = { api: { bodyParser: false } };

const SIGNATURE_HEADER = 'podium-signature';   // req.headers keys are lower-cased
const TIMESTAMP_HEADER = 'podium-timestamp';

/** Read the raw request body as a Buffer without relying on the platform parser. */
async function readRawBody(req) {
  // Defensive: if something upstream already buffered it, honour that.
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body, 'utf8');
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = process.env.PODIUM_WEBHOOK_SECRET;
  if (!secret) {
    // No shared secret configured ⇒ we cannot verify any event. Fail closed.
    // (Set PODIUM_WEBHOOK_SECRET when the location webhook is registered — F2 live.)
    return res.status(503).json({ error: 'Webhook secret not configured' });
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    console.error('podium webhook: failed to read body:', err.message);
    return res.status(400).json({ error: 'Could not read request body' });
  }

  const signature = req.headers[SIGNATURE_HEADER];
  const timestamp = req.headers[TIMESTAMP_HEADER];
  const verdict = verifySignature({ rawBody, signature, timestamp, secret });
  if (!verdict.ok) {
    // 401 for every signature failure (missing/stale/mismatch): reject, don't process.
    return res.status(401).json({ error: 'Invalid signature', reason: verdict.reason });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8') || '{}');
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const env = parseEnvelope(payload);

  const client = await getClientWithTimezone();
  try {
    const result = await processEvent(client, env);
    // Ack fast. 200 on both fresh-processed and deduped (idempotent replay).
    return res.status(200).json({
      ok: true,
      deduped: !!result.deduped,
      eventType: env.eventType,
      action: result.action || null,
    });
  } catch (err) {
    // Processing failed AFTER a valid signature: 500 so Podium retries. The dedupe
    // gate + idempotent handlers make the retry safe (the sync-log row is marked
    // 'error' and its reference_id lets a retry re-run cleanly).
    console.error(`podium webhook: processing failed for ${env.eventType} (${env.eventUid}):`, err.message);
    return res.status(500).json({ error: 'Processing failed' });
  } finally {
    client.release();
  }
}
