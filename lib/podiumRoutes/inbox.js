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
// F12 rich messaging adds:
//   GET  /api/podium/inbox?resource=templates
//        → GET /v4/message_templates. Canned responses the rep inserts in the composer.
//   POST /api/podium/inbox?resource=note  { conversationId, body }
//        → POST /v4/conversations/{uid}/notes. A team-only INTERNAL note (not sent to
//          the customer). And POST ?resource=messages may carry image/video/file
//          `attachments` (metadata only) + the `templateId` the body came from.
//
// Every call runs on the rep's own token (P4). Mock-first: with PODIUM_MOCK=true the
// Podium hop is served by lib/podium.mock.js so the inbox is reviewable on the Preview
// without live creds. Gated to sales/superadmin via the login JWT (server is the real
// gate; F9 formalises nav).
//
// P1 GUARD: envelopes + live message bodies flow through request/response only — this
// endpoint writes NO chat content to the database. Podium is the system of record.

import { getAuthUser, hasAnyRole } from '../rbac.js';
import {
  listConversations, getConversation, listMessages, sendMessage, setConversationStatus,
  listMessageTemplates, postInternalNote, isMock,
} from '../podium.js';
import {
  resolveSelfPodiumUid, filterUpdatedSince, clampLimit, normalizeBucket, normalizeStatus,
} from '../podiumInbox.js';
import { buildConversationIdentity, identityMatchesSearch } from '../podiumContact.js';
import { composeConversation } from '../podiumCompose.js';
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
  if (resource === 'templates') {
    if (method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    return templatesRoute(req, res, auth);
  }
  if (resource === 'note') {
    if (method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    return noteRoute(req, res, auth);
  }
  if (resource === 'poll') {
    if (method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    return pollRoute(req, res, auth);
  }
  if (resource === 'status') {
    if (method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    return setStatusRoute(req, res, auth);
  }
  if (resource === 'conversation') {
    if (method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    return getConversationRoute(req, res, auth);
  }
  if (resource === 'reps') {
    if (method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    return repsRoute(req, res, auth);
  }
  if (resource === 'compose') {
    if (method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    return composeRoute(req, res, auth);
  }
  return res.status(400).json({ error: 'Unknown inbox resource', resource: resource || null });
}

// GET ?resource=reps — assignable salespeople for the F13 assignment picker: portal users
// holding the `sales` or `superadmin` role (via F0b's user_roles, falling back to
// users.access). `linked` = has a Podium member uid, so the UI can flag reps who must
// connect their Podium account before they can be assigned. No message data (P1).
async function repsRoute(req, res, auth) {
  const client = await getClientWithTimezone();
  try {
    let rows;
    try {
      const r = await client.query(
        `SELECT DISTINCT u.id, u.name, u.podium_user_id
           FROM users u
           LEFT JOIN user_roles ur ON ur.user_id = u.id
          WHERE ur.role IN ('sales', 'superadmin')
             OR u.access::text IN ('sales', 'superadmin')
          ORDER BY u.name`
      );
      rows = r.rows;
    } catch (err) {
      if (err?.code !== '42P01') throw err; // user_roles absent (pre-F0 DB) → access only
      const r = await client.query(
        `SELECT id, name, podium_user_id FROM users
          WHERE access::text IN ('sales', 'superadmin') ORDER BY name`
      );
      rows = r.rows;
    }
    const reps = (rows || []).map((u) => ({
      id: u.id,
      name: u.name || u.id,
      podiumUserId: u.podium_user_id || null,
      linked: !!u.podium_user_id,
    }));
    return res.status(200).json({ reps, mock: isMock() });
  } catch (err) {
    return respondUpstreamError(res, err, 'list assignable reps');
  } finally {
    client.release();
  }
}

// GET ?resource=conversation&conversationId=<uid> — fetch a single conversation so the
// funnel can deep-link straight into its chat (the target may not be in the current
// bucket/status filter). No DB touched; runs on the rep's token (P4).
async function getConversationRoute(req, res, auth) {
  const conversationId = req.query?.conversationId;
  if (!conversationId) return res.status(400).json({ error: 'conversationId is required' });
  try {
    const conversation = await getConversation(auth.id, String(conversationId));
    return res.status(200).json({ conversation, mock: isMock() });
  } catch (err) {
    return respondUpstreamError(res, err, 'load the conversation');
  }
}

// POST ?resource=status { conversationId, status:'open'|'closed' } — a salesperson
// opens/closes a conversation (drives the F11 Open/Closed buckets). Runs on the rep's
// token (P4); no DB touched. Live Podium endpoint/field is a VERIFY at wiring.
async function setStatusRoute(req, res, auth) {
  const { conversationId, status } = req.body || {};
  if (!conversationId) return res.status(400).json({ error: 'conversationId is required' });
  if (status !== 'open' && status !== 'closed') {
    return res.status(400).json({ error: "status must be 'open' or 'closed'" });
  }
  try {
    const conversation = await setConversationStatus(auth.id, String(conversationId), status);
    return res.status(200).json({ conversationId: String(conversationId), status, conversation, mock: isMock() });
  } catch (err) {
    return respondUpstreamError(res, err, 'update the conversation status');
  }
}

// GET ?resource=conversations — list conversations for an F11 bucket + status.
//   bucket = mine (default) | unassigned | all   (legacy `scope` alias still honoured)
//   status = open (default) | closed | all
//   search = free text (F14) — filter the list by the customer NAME / PHONE / EMAIL
//            behind each conversation, resolved via the F4 contact↔customer bridge.
async function listConversationsRoute(req, res, auth) {
  const bucket = normalizeBucket(req.query?.bucket ?? req.query?.scope);
  const status = normalizeStatus(req.query?.status ?? 'open');
  const cursor = req.query?.cursor ? String(req.query.cursor) : undefined;
  const limit = clampLimit(req.query?.limit, 30);
  const search = req.query?.search != null ? String(req.query.search).trim() : '';

  const client = await getClientWithTimezone();
  try {
    // F14: our §15 Podium reference has no native conversation-search param, so search is
    // done here — scan a wider single page from the TOP of the bucket (up to 100) and
    // filter by the resolved contact/customer identity. Without a search, page normally.
    // (VERIFY at live wiring whether Podium later exposes a server-side search param.)
    const filters = {
      cursor: search ? undefined : cursor,
      limit: search ? 100 : limit,
      status: status || undefined,
      client,
    };
    if (bucket === 'mine') {
      const assigneeUid = await resolveSelfPodiumUid(client, auth);
      if (!assigneeUid) {
        // Rep hasn't linked their Podium account (or no member match) — there is no
        // "mine" set. Empty page + a hint so the UI can prompt to connect (or switch to
        // the Unassigned / All buckets), rather than silently showing everyone's.
        return res.status(200).json({
          data: [], metadata: { nextCursor: null, previousCursor: null },
          bucket, scope: bucket, status, notLinked: true,
          search: search || null, searchTruncated: false, mock: isMock(),
        });
      }
      filters.assigneeUid = assigneeUid;
    } else if (bucket === 'unassigned') {
      filters.unassigned = true;
    }
    const resp = await listConversations(auth.id, filters);
    let data = Array.isArray(resp?.data) ? resp.data : [];
    let metadata = resp?.metadata || { nextCursor: null, previousCursor: null };
    let searchTruncated = false;

    if (search) {
      const matched = [];
      for (const conv of data) {
        // Enrich via the F4 bridge (contact + matched customer) then filter. The `identity`
        // rides back on each row so the UI can show a real name in the result list.
        const identity = await buildConversationIdentity(client, auth.id, conv);
        if (identityMatchesSearch(identity, conv, search)) matched.push({ ...conv, identity });
      }
      // The scan only covers the first page (≤100) of the bucket; flag if more exist so a
      // very large inbox can warn the results may be incomplete.
      searchTruncated = !!metadata.nextCursor;
      data = matched;
      metadata = { nextCursor: null, previousCursor: null };
    }

    return res.status(200).json({
      data,
      metadata,
      bucket, scope: bucket, status, notLinked: false,
      search: search || null, searchTruncated, mock: isMock(),
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

// POST ?resource=messages — send a reply AS the rep (no DB touched). F12: may carry
// image/video/file `attachments` (METADATA only — never raw bytes; real media upload is
// a live-wiring swap over Podium's media API) and the `templateId` the body came from.
// A message needs at least a body OR one attachment.
async function sendMessageRoute(req, res, auth) {
  const { conversationId, body, attachments, templateId } = req.body || {};
  if (!conversationId) return res.status(400).json({ error: 'conversationId is required' });
  const text = body == null ? '' : String(body).trim();
  const cleanAttachments = sanitizeAttachments(attachments);
  if (!text && cleanAttachments.length === 0) {
    return res.status(400).json({ error: 'a message body or an attachment is required' });
  }
  try {
    const sent = await sendMessage(auth.id, {
      conversationUid: String(conversationId),
      body: text,
      attachments: cleanAttachments.length ? cleanAttachments : undefined,
      templateId: templateId ? String(templateId) : undefined,
    });
    return res.status(201).json({ conversationId: String(conversationId), sent, mock: isMock() });
  } catch (err) {
    return respondUpstreamError(res, err, 'send the message');
  }
}

// Keep only safe attachment METADATA (filename, mimeType, kind, size) — never raw file
// bytes. Under live Podium the client uploads media to Podium and passes back a media
// reference; here we forward descriptive metadata only, so nothing binary is stored (P1).
function sanitizeAttachments(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 10).map((a) => {
    const kind = ['image', 'video', 'file'].includes(a?.kind) ? a.kind : 'file';
    const out = { kind };
    if (a?.filename) out.filename = String(a.filename).slice(0, 200);
    if (a?.mimeType) out.mimeType = String(a.mimeType).slice(0, 100);
    if (Number.isFinite(Number(a?.size))) out.size = Number(a.size);
    if (a?.mediaUid) out.mediaUid = String(a.mediaUid).slice(0, 255); // live Podium media ref
    return out;
  });
}

// GET ?resource=templates — Podium message templates (canned responses) for the
// composer (F12). Runs on the rep's token (P4); no DB touched.
async function templatesRoute(req, res, auth) {
  try {
    const resp = await listMessageTemplates(auth.id, { limit: 50 });
    return res.status(200).json({
      data: Array.isArray(resp?.data) ? resp.data : [],
      metadata: resp?.metadata || { nextCursor: null, previousCursor: null },
      mock: isMock(),
    });
  } catch (err) {
    return respondUpstreamError(res, err, 'load message templates');
  }
}

// POST ?resource=note { conversationId, body } — add a team-only INTERNAL NOTE to the
// conversation (F12). Team-visible, NEVER sent to the customer. Sent to Podium (system
// of record); no DB touched, no chat/note body persisted in the portal (P1).
async function noteRoute(req, res, auth) {
  const { conversationId, body } = req.body || {};
  if (!conversationId) return res.status(400).json({ error: 'conversationId is required' });
  if (!body || !String(body).trim()) return res.status(400).json({ error: 'a note body is required' });
  try {
    const note = await postInternalNote(auth.id, {
      conversationUid: String(conversationId),
      body: String(body).trim(),
      author: auth.id,
    });
    return res.status(201).json({ conversationId: String(conversationId), note, mock: isMock() });
  } catch (err) {
    return respondUpstreamError(res, err, 'add the internal note');
  }
}

// GET ?resource=poll — conversations touched since the client's last cursor, within
// the current bucket + status (so a poll never surfaces rows from a different tab).
async function pollRoute(req, res, auth) {
  const bucket = normalizeBucket(req.query?.bucket ?? req.query?.scope);
  const status = normalizeStatus(req.query?.status ?? 'open');
  const since = req.query?.since ? String(req.query.since) : null;
  const cursor = req.query?.cursor ? String(req.query.cursor) : undefined;
  const limit = clampLimit(req.query?.limit, 50);
  const serverTime = new Date().toISOString(); // client echoes this back as the next `since`

  const client = await getClientWithTimezone();
  try {
    const filters = { cursor, limit, status: status || undefined, client };
    if (bucket === 'mine') {
      const assigneeUid = await resolveSelfPodiumUid(client, auth);
      if (!assigneeUid) {
        return res.status(200).json({ data: [], serverTime, bucket, scope: bucket, status, notLinked: true, mock: isMock() });
      }
      filters.assigneeUid = assigneeUid;
    } else if (bucket === 'unassigned') {
      filters.unassigned = true;
    }
    const resp = await listConversations(auth.id, filters);
    const updated = filterUpdatedSince(Array.isArray(resp?.data) ? resp.data : [], since);
    return res.status(200).json({
      data: updated, serverTime,
      metadata: resp?.metadata || { nextCursor: null, previousCursor: null },
      bucket, scope: bucket, status, mock: isMock(),
    });
  } catch (err) {
    return respondUpstreamError(res, err, 'poll conversations');
  } finally {
    client.release();
  }
}

// POST ?resource=compose { to, channel, body } — F20: start a new conversation to a
// phone/email. Dedupes first — an existing conversation for that number/address is reopened
// (if closed) and continued instead of duplicated; otherwise a Podium contact is created and
// a new thread opened. Runs on the rep's token (P4); no chat body persisted (P1). 201 for a
// freshly created thread, 200 when an existing one was reused.
async function composeRoute(req, res, auth) {
  const { to, channel, body } = req.body || {};
  try {
    const result = await composeConversation(auth.id, { to, channel, body });
    return res.status(result.reused ? 200 : 201).json({ ...result, mock: isMock() });
  } catch (err) {
    if (err?.code === 'INVALID_COMPOSE_TARGET' || err?.code === 'COMPOSE_BODY_REQUIRED') {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    return respondUpstreamError(res, err, 'start the conversation');
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
