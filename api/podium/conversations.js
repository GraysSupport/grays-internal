// api/podium/conversations.js — live conversation list for the Inbox (feature F3).
//
//   GET /api/podium/conversations?scope=mine|all&cursor=<c>&limit=<1..100>
//     → GET /v4/conversations (cursor pagination, §15.4/§15.5), run on the logged-in
//       rep's own Podium token (P4). scope=mine (the default "My conversations" view,
//       F3 / F1b increment 3) filters by assignee = the rep's Podium member uid.
//
// Standalone serverless function (NOT the api/[...path].js catch-all), gated to
// sales/superadmin via the login JWT (F9 formalises nav gating; the server is the real
// gate). Mock-first: with PODIUM_MOCK=true the Podium hop is served by lib/podium.mock.js
// so the inbox is reviewable on the Preview without live creds.
//
// P1: this endpoint returns conversation ENVELOPES only (uid, channel, assignee,
// timestamps) and persists nothing — Podium is the system of record.

import { getAuthUser, hasAnyRole } from '../../lib/rbac.js';
import { listConversations, isMock } from '../../lib/podium.js';
import { resolveSelfPodiumUid, clampLimit } from '../../lib/podiumInbox.js';
import { getClientWithTimezone } from '../../lib/db.js';

const ALLOWED_ROLES = ['sales', 'superadmin'];

export default async function handler(req, res) {
  const auth = getAuthUser(req);
  if (!auth) return res.status(401).json({ error: 'Not authenticated' });
  if (!hasAnyRole(auth.roles, ALLOWED_ROLES)) {
    return res.status(403).json({ error: 'Requires the sales role to view conversations' });
  }
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const scope = req.query?.scope === 'all' ? 'all' : 'mine'; // default to My conversations
  const cursor = req.query?.cursor ? String(req.query.cursor) : undefined;
  const limit = clampLimit(req.query?.limit, 30);

  const client = await getClientWithTimezone();
  try {
    let assigneeUid;
    let notLinked = false;
    if (scope === 'mine') {
      assigneeUid = await resolveSelfPodiumUid(client, auth);
      if (!assigneeUid) {
        // Rep hasn't linked their Podium account (or no member match) — there is no
        // "mine" set to show. Return an empty page with a hint so the UI can prompt to
        // connect, rather than silently falling back to everyone's conversations.
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
      scope,
      notLinked,
      mock: isMock(),
    });
  } catch (err) {
    return respondUpstreamError(res, err, 'list conversations');
  } finally {
    client.release();
  }
}

function respondUpstreamError(res, err, action) {
  if (err?.code === 'PODIUM_NOT_CONNECTED') {
    return res.status(409).json({ error: 'You have not linked a Podium account', code: 'NOT_CONNECTED' });
  }
  if (err?.status === 404) return res.status(404).json({ error: 'Not found in Podium' });
  console.error(`podium conversations: could not ${action}:`, err);
  return res.status(502).json({ error: `Could not ${action}` });
}
