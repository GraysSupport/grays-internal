// api/podium/inbox.js — live-proxy backend for the in-portal Inbox (feature F3).
//
// A SINGLE serverless function that dispatches on `?resource=` to the three F3 inbox
// operations. It's one file (not three) deliberately: the Vercel project is on the
// Hobby plan, capped at 12 Serverless Functions per deployment — three separate files
// would blow the cap (10 existing + 3). Still a dedicated file under api/podium/ (NOT
// the api/[...path].js catch-all), per repo convention.
//
//   GET  /api/podium/inbox?resource=conversations&scope=mine|all&cursor=&limit=
//        → GET /v4/conversations. Default scope=mine ("My conversations") filters by
//          the rep's Podium member uid (the F1b increment-3 seam).
//   GET  /api/podium/inbox?resource=messages&conversationId=<uid>&cursor=&limit=
//        → GET /v4/conversations/{uid}/messages. Live thread; bodies pass through,
//          NEVER persisted (P1).
//   POST /api/podium/inbox?resource=messages  { conversationId, body }
//        → POST /v4/messages, sent AS the logged-in rep (correct sender, P4).
//   GET  /api/podium/inbox?resource=poll&since=<ISO>&scope=mine|all&cursor=
//        → GET /v4/conversations, kept to those touched since the client's cursor
//          (drives the 5–10s inbox poll).
//
// Every call runs on the rep's own token (P4). Mock-first: with PODIUM_MOCK=true the
// Podium hop is served by lib/podium.mock.js so the inbox is reviewable on the Preview
// without live creds. Gated to sales/superadmin via the login JWT (server is the real
// gate; F9 formalises nav).
//
// P1 GUARD: envelopes + live message bodies flow through request/response only — this
// endpoint writes NO chat content to the database. Podium is the system of record.

import { getAuthUser, hasAnyRole } from '../rbac.js';
import { listConversations, listMessages, sendMessage, isMock } from '../podium.js';
import { resolveSelfPodiumUid, filterUpdatedSince, clampLimit } from '../podiumInbox.js';
import { getClientWithTimezone } from '../db.js';

const ALLOWED_ROLES = ['sales', 'superadmin'];

export default async function handler(req, res) {
  const auth = getAuthUser(req);
  if (!auth) return res.status(401).json({ error: 'Not authenticated' });
  if (!hasAnyRole(auth.roles, ALLOWED_ROLES)) {
    return res.status(403).json({ error: 'Requires the sales role to use the inbox' });
  }

  const resource = String(req.query?.resource || '').toLowerCase();
  const method = req.method;

  if (resource === 'conversations') {
    if (method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    return listConversationsRoute(req, res, auth);
  }
  if (resource === 'messages') {
    if (method === 'GET') return readThreadRoute(req, res, auth);
    if (method === 'POST') return sendMessageRoute(req, res, auth);
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (resource === 'poll') {
    if (method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    return pollRoute(req, res, auth);
  }
  return res.status(400).json({ error: 'Unknown inbox resource', resource: resource || null });
}

// GET ?resource=conversations — list the rep's conversations (default "mine").
async function listConversationsRoute(req, res, auth) {
  const scope = req.query?.scope === 'all' ? 'all' : 'mine';
  const cursor = req.query?.cursor ? String(req.query.cursor) : undefined;
  const limit = clampLimit(req.query?.limit, 30);

  const client = await getClientWithTimezone();
  try {
    let assigneeUid;
    if (scope === 'mine') {
      assigneeUid = await resolveSelfPodiumUid(client, auth);
      if (!assigneeUid) {
        // Rep hasn't linked their Podium account (or no member match) — there is no
        // "mine" set. Empty page + a hint so the UI can prompt to connect, rather than
        // silently falling back to everyone's conversations.
        return res.status(200).json({
          data: [], metadata: { nextCursor: null, previousCursor: null },
          scope, notLinked: true, mock: isMock(),
        });
      }
    }
    const resp = await listConversations(auth.id, { cursor, limit, assigneeUid, client });
    return res.status(200).json({
      data: Array.isArray(resp?.data) ? resp.data : [],
      metadata: resp?.metadata || { nextCursor: null, previousCursor: null },
      scope, notLinked: false, mock: isMock(),
    });
  } catch (err) {
    return respondUpstreamError(res, err, 'list conversations');
  } finally {
    client.release();
  }
}

// GET ?resource=messages — read a conversation's live thread (no DB touched).
async function readThreadRoute(req, res, auth) {
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

// POST ?resource=messages — send a reply AS the rep (no DB touched).
async function sendMessageRoute(req, res, auth) {
  const { conversationId, body } = req.body || {};
  if (!conversationId) return res.status(400).json({ error: 'conversationId is required' });
  if (!body || !String(body).trim()) return res.status(400).json({ error: 'body is required' });
  try {
    const sent = await sendMessage(auth.id, { conversationUid: String(conversationId), body: String(body) });
    return res.status(201).json({ conversationId: String(conversationId), sent, mock: isMock() });
  } catch (err) {
    return respondUpstreamError(res, err, 'send the message');
  }
}

// GET ?resource=poll — conversations touched since the client's last cursor.
async function pollRoute(req, res, auth) {
  const scope = req.query?.scope === 'all' ? 'all' : 'mine';
  const since = req.query?.since ? String(req.query.since) : null;
  const cursor = req.query?.cursor ? String(req.query.cursor) : undefined;
  const limit = clampLimit(req.query?.limit, 50);
  const serverTime = new Date().toISOString(); // client echoes this back as the next `since`

  const client = await getClientWithTimezone();
  try {
    let assigneeUid;
    if (scope === 'mine') {
      assigneeUid = await resolveSelfPodiumUid(client, auth);
      if (!assigneeUid) {
        return res.status(200).json({ data: [], serverTime, scope, notLinked: true, mock: isMock() });
      }
    }
    const resp = await listConversations(auth.id, { cursor, limit, assigneeUid, client });
    const updated = filterUpdatedSince(Array.isArray(resp?.data) ? resp.data : [], since);
    return res.status(200).json({
      data: updated, serverTime,
      metadata: resp?.metadata || { nextCursor: null, previousCursor: null },
      scope, mock: isMock(),
    });
  } catch (err) {
    return respondUpstreamError(res, err, 'poll conversations');
  } finally {
    client.release();
  }
}

function respondUpstreamError(res, err, action) {
  if (err?.code === 'PODIUM_NOT_CONNECTED') {
    return res.status(409).json({ error: 'You have not linked a Podium account', code: 'NOT_CONNECTED' });
  }
  if (err?.status === 404) return res.status(404).json({ error: 'Not found in Podium' });
  console.error(`podium inbox: could not ${action}:`, err);
  return res.status(502).json({ error: `Could not ${action}` });
}
