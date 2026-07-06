// api/podium/messages.js — live message thread + send, for the Inbox (feature F3).
//
//   GET  /api/podium/messages?conversationId=<uid>&cursor=<c>&limit=<1..100>
//        → GET /v4/conversations/{uid}/messages (cursor pagination). Returns the thread
//          LIVE for rendering and stores nothing (P1).
//   POST /api/podium/messages  { conversationId, body }
//        → POST /v4/messages, sent AS the logged-in rep (P4) so Podium shows the correct
//          sender. Returns the upstream send result (uid/status).
//
// Standalone serverless function (NOT the api/[...path].js catch-all), gated to
// sales/superadmin via the login JWT. Mock-first (PODIUM_MOCK=true → lib/podium.mock.js).
//
// P1 GUARD: message BODIES flow through this request/response only — they are NEVER
// written to the database. Podium is the system of record for chat content.

import { getAuthUser, hasAnyRole } from '../../lib/rbac.js';
import { listMessages, sendMessage, isMock } from '../../lib/podium.js';
import { clampLimit } from '../../lib/podiumInbox.js';

const ALLOWED_ROLES = ['sales', 'superadmin'];

export default async function handler(req, res) {
  const auth = getAuthUser(req);
  if (!auth) return res.status(401).json({ error: 'Not authenticated' });
  if (!hasAnyRole(auth.roles, ALLOWED_ROLES)) {
    return res.status(403).json({ error: 'Requires the sales role to use the inbox' });
  }
  if (req.method === 'GET') return handleGet(req, res, auth);
  if (req.method === 'POST') return handlePost(req, res, auth);
  return res.status(405).json({ error: 'Method not allowed' });
}

async function handleGet(req, res, auth) {
  const conversationId = req.query?.conversationId;
  if (!conversationId) return res.status(400).json({ error: 'conversationId is required' });
  const cursor = req.query?.cursor ? String(req.query.cursor) : undefined;
  const limit = clampLimit(req.query?.limit, 50);
  try {
    const resp = await listMessages(auth.id, String(conversationId), { cursor, limit });
    return res.status(200).json({
      conversationId: String(conversationId),
      data: Array.isArray(resp?.data) ? resp.data : [],
      metadata: resp?.metadata || { nextCursor: null, previousCursor: null },
      mock: isMock(),
    });
  } catch (err) {
    return respondUpstreamError(res, err, 'read the message thread');
  }
}

async function handlePost(req, res, auth) {
  const { conversationId, body } = req.body || {};
  if (!conversationId) return res.status(400).json({ error: 'conversationId is required' });
  if (!body || !String(body).trim()) return res.status(400).json({ error: 'body is required' });
  try {
    const sent = await sendMessage(auth.id, { conversationUid: String(conversationId), body: String(body) });
    return res.status(201).json({
      conversationId: String(conversationId),
      sent,
      mock: isMock(),
    });
  } catch (err) {
    return respondUpstreamError(res, err, 'send the message');
  }
}

function respondUpstreamError(res, err, action) {
  if (err?.code === 'PODIUM_NOT_CONNECTED') {
    return res.status(409).json({ error: 'You have not linked a Podium account', code: 'NOT_CONNECTED' });
  }
  if (err?.status === 404) return res.status(404).json({ error: 'Conversation not found in Podium' });
  console.error(`podium messages: could not ${action}:`, err);
  return res.status(502).json({ error: `Could not ${action}` });
}
