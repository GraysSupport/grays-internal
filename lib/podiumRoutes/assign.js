// api/podium/assign.js — native conversation assignment, PORTAL → PODIUM (feature F1b).
//
// Keeps Podium's native "assigned to" identical to the portal owner, driven by the
// logged-in rep (execution-plan.md §F1b step 2, P4). Standalone serverless function
// (NOT the api/[...path].js catch-all), gated to sales/superadmin via the login JWT.
//
//   GET  /api/podium/assign?conversationId=<uid>
//        → read the conversation's current Podium assignee(s), resolved to portal reps.
//   POST /api/podium/assign  { conversationId, userIds?[], userId? }
//        → set the conversation's assignee SET (F13 one-or-more). `userIds` is the whole
//          new set of portal ids; `userId` (single) and omitting both (CLAIM = just you)
//          are still honoured. The call to Podium runs on the ACTING rep's token; each
//          target is resolved to its Podium member uid. The PRIMARY (first) owner is
//          mirrored onto the matching lead (leads.assigned_to is a single column).
//
// Mock-first (Golden Rule 6): with PODIUM_MOCK=true the Podium hop is served by
// lib/podium.mock.js, so the flow is reviewable on the Preview without live creds.
// The Podium → portal direction (assignment webhook → leads.assigned_to) lands with
// F2's webhook receiver and reuses mirrorAssignmentToLead() from lib/podiumAssign.js.
//
// P1: no message bodies are read or written here — only CRM metadata (the assignees).

import { getAuthUser, hasAnyRole } from '../rbac.js';
import { assignConversation, getAssignee, isMock } from '../podium.js';
import { resolvePodiumUserId, mirrorAssignmentToLead, resolveAssignees } from '../podiumAssign.js';
import { getClientWithTimezone } from '../db.js';

// P11: working the inbox / owning conversations is a `sales` action; superadmin may
// also act (support/admin). Server is the real gate (F9), never the client role list.
const ALLOWED_ROLES = ['sales', 'superadmin'];

export default async function handler(req, res) {
  const auth = getAuthUser(req);
  if (!auth) return res.status(401).json({ error: 'Not authenticated' });
  if (!hasAnyRole(auth.roles, ALLOWED_ROLES)) {
    return res.status(403).json({ error: 'Requires the sales role to assign conversations' });
  }

  if (req.method === 'GET') return handleGet(req, res, auth);
  if (req.method === 'POST') return handlePost(req, res, auth);
  return res.status(405).json({ error: 'Method not allowed' });
}

async function handleGet(req, res, auth) {
  const conversationId = req.query?.conversationId;
  if (!conversationId) return res.status(400).json({ error: 'conversationId is required' });
  const client = await getClientWithTimezone();
  try {
    const a = await getAssignee(auth.id, String(conversationId));
    const podiumUids = (
      Array.isArray(a?.assignees) && a.assignees.length
        ? a.assignees.map((x) => x?.uid)
        : (a?.assignedUser?.uid ? [a.assignedUser.uid] : [])
    ).filter(Boolean);
    // Resolve to portal reps (with a Podium-member name fallback) for the inbox chips.
    const assignees = await resolveAssignees(client, auth.id, podiumUids);
    return res.status(200).json({
      conversationId: String(conversationId),
      assignees,
      assignedPodiumUserId: a?.assignedUser?.uid || podiumUids[0] || null,
      mock: isMock(),
    });
  } catch (err) {
    return respondUpstreamError(res, err, 'read the conversation assignees');
  } finally {
    client.release();
  }
}

async function handlePost(req, res, auth) {
  const { conversationId, userId, userIds } = req.body || {};
  if (!conversationId) return res.status(400).json({ error: 'conversationId is required' });

  // Determine the target portal-id SET (F13 one-or-more):
  //   • userIds (array) — the whole new assignee set (may be [] to clear all)
  //   • userId (single)  — set to just that rep
  //   • neither          — CLAIM: assign to the acting rep
  let targetIds;
  let claim = false;
  if (Array.isArray(userIds)) {
    targetIds = [...new Set(userIds.map((x) => String(x)).filter(Boolean))];
  } else if (userId) {
    targetIds = [String(userId)];
  } else {
    targetIds = [auth.id];
    claim = true;
  }

  const client = await getClientWithTimezone();
  try {
    // Resolve each target portal user to their Podium member uid. Fail closed if any
    // hasn't linked a Podium account (assignment must reflect a real Podium member).
    const podiumUids = [];
    const resolvedPortalIds = [];
    for (const pid of targetIds) {
      const ur = await client.query(
        'SELECT id, email, podium_user_id FROM users WHERE id = $1 LIMIT 1',
        [pid]
      );
      if (!ur.rowCount) return res.status(404).json({ error: `Target user ${pid} not found` });
      const podiumUserId = await resolvePodiumUserId(client, auth.id, ur.rows[0]);
      if (!podiumUserId) {
        return res.status(409).json({
          error: `${pid === auth.id ? 'You have' : `User ${pid} has`} not linked a Podium account`,
          code: 'TARGET_NOT_LINKED',
          userId: pid,
        });
      }
      podiumUids.push(podiumUserId);
      resolvedPortalIds.push(pid);
    }

    // Drive Podium's native assignment AS the acting rep (their OAuth token). An empty
    // set clears all assignees.
    await assignConversation(auth.id, String(conversationId), podiumUids);

    // Mirror the PRIMARY (first) owner onto the lead — leads.assigned_to is single-owner;
    // the full multi-assignee set lives in Podium (system of record). 0 rows until
    // F2/F5 create leads. (A durable lead_assignees mirror is a possible follow-up.)
    const primary = resolvedPortalIds[0] || null;
    const leadsUpdated = await mirrorAssignmentToLead(client, String(conversationId), primary);

    return res.status(200).json({
      conversationId: String(conversationId),
      assignedTo: resolvedPortalIds,
      primaryAssignedTo: primary,
      assignedPodiumUserIds: podiumUids,
      claimed: claim,
      leadsUpdated,
      mock: isMock(),
    });
  } catch (err) {
    if (err?.code === 'PODIUM_NOT_CONNECTED') {
      return res.status(409).json({ error: 'You have not linked a Podium account', code: 'NOT_CONNECTED' });
    }
    return respondUpstreamError(res, err, 'assign the conversation');
  } finally {
    client.release();
  }
}

function respondUpstreamError(res, err, action) {
  // A 404 from Podium (unknown conversation) is a client error; surface it as 404.
  if (err?.status === 404) return res.status(404).json({ error: 'Conversation not found in Podium' });
  console.error(`podium assign: could not ${action}:`, err);
  return res.status(502).json({ error: `Could not ${action}` });
}
