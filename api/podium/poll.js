// api/podium/poll.js — lightweight change poll for the Inbox (feature F3).
//
//   GET /api/podium/poll?since=<ISO>&scope=mine|all&cursor=<c>&limit=<1..100>
//     → GET /v4/conversations (page 1 by default), keep only conversations whose last
//       activity is newer than `since`. Drives the inbox's 5–10 s poll so new inbound
//       messages surface within ~10 s (§F3 acceptance) without a websocket.
//
// Returns { data:[updated conversations], serverTime, metadata, scope }. The client
// sends back `serverTime` as the next `since`. First poll (no `since`) returns the
// current page so the list paints immediately.
//
// Standalone serverless function, gated to sales/superadmin. Mock-first. Runs on the
// rep's own token (P4); scope=mine filters by the rep's Podium member uid.
//
// P1: envelopes only, nothing persisted.

import { getAuthUser, hasAnyRole } from '../../lib/rbac.js';
import { listConversations, isMock } from '../../lib/podium.js';
import { resolveSelfPodiumUid, filterUpdatedSince, clampLimit } from '../../lib/podiumInbox.js';
import { getClientWithTimezone } from '../../lib/db.js';

const ALLOWED_ROLES = ['sales', 'superadmin'];

export default async function handler(req, res) {
  const auth = getAuthUser(req);
  if (!auth) return res.status(401).json({ error: 'Not authenticated' });
  if (!hasAnyRole(auth.roles, ALLOWED_ROLES)) {
    return res.status(403).json({ error: 'Requires the sales role to use the inbox' });
  }
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const scope = req.query?.scope === 'all' ? 'all' : 'mine';
  const since = req.query?.since ? String(req.query.since) : null;
  const cursor = req.query?.cursor ? String(req.query.cursor) : undefined;
  const limit = clampLimit(req.query?.limit, 50);
  // Server clock in Melbourne ISO — the client echoes this back as the next `since`.
  const serverTime = new Date().toISOString();

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
    const all = Array.isArray(resp?.data) ? resp.data : [];
    const updated = filterUpdatedSince(all, since);
    return res.status(200).json({
      data: updated,
      serverTime,
      metadata: resp?.metadata || { nextCursor: null, previousCursor: null },
      scope,
      mock: isMock(),
    });
  } catch (err) {
    if (err?.code === 'PODIUM_NOT_CONNECTED') {
      return res.status(409).json({ error: 'You have not linked a Podium account', code: 'NOT_CONNECTED' });
    }
    console.error('podium poll: could not poll conversations:', err);
    return res.status(502).json({ error: 'Could not poll conversations' });
  } finally {
    client.release();
  }
}
