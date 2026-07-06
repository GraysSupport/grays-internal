// api/podium/assign.js — native conversation assignment, PORTAL → PODIUM (feature F1b).
//
// Keeps Podium's native "assigned to" identical to the portal owner, driven by the
// logged-in rep (execution-plan.md §F1b step 2, P4). Standalone serverless function
// (NOT the api/[...path].js catch-all), gated to sales/superadmin via the login JWT.
//
//   GET  /api/podium/assign?conversationId=<uid>
//        → read the conversation's current Podium assignee.
//   POST /api/podium/assign  { conversationId, userId? }
//        → assign the conversation. Omit userId to CLAIM it for yourself. The call to
//          Podium runs on the ACTING rep's token; the assignee is the TARGET user's
//          Podium member uid. The owner is also mirrored onto the matching lead.
//
// Mock-first (Golden Rule 6): with PODIUM_MOCK=true the Podium hop is served by
// lib/podium.mock.js, so the flow is reviewable on the Preview without live creds.
// The Podium → portal direction (assignment webhook → leads.assigned_to) lands with
// F2's webhook receiver and reuses mirrorAssignmentToLead() from lib/podiumAssign.js.
//
// P1: no message bodies are read or written here — only CRM metadata (the assignee).

import { getAuthUser, hasAnyRole } from '../../lib/rbac.js';
import { assignConversation, getAssignee, isMock } from '../../lib/podium.js';
import { resolvePodiumUserId, mirrorAssignmentToLead } from '../../lib/podiumAssign.js';
import { getClientWithTimezone } from '../../lib/db.js';

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
  try {
    const a = await getAssignee(auth.id, String(conversationId));
    return res.status(200).json({
      conversationId: String(conversationId),
      assignedPodiumUserId: a?.assignedUser?.uid || null,
      mock: isMock(),
    });
  } catch (err) {
    return respondUpstreamError(res, err, 'read the conversation assignee');
  }
}

async function handlePost(req, res, auth) {
  const { conversationId, userId } = req.body || {};
  if (!conversationId) return res.status(400).json({ error: 'conversationId is required' });

  // Default action = claim: assign the conversation to the acting rep.
  const targetPortalId = userId ? String(userId) : auth.id;

  const client = await getClientWithTimezone();
  try {
    const ur = await client.query(
      'SELECT id, email, podium_user_id FROM users WHERE id = $1 LIMIT 1',
      [targetPortalId]
    );
    if (!ur.rowCount) return res.status(404).json({ error: `Target user ${targetPortalId} not found` });
    const targetUser = ur.rows[0];

    // Turn the target portal user into their Podium member uid (lazily resolving via
    // GET /v4/users if it wasn't captured at connect). Runs on the ACTING rep's token.
    const podiumUserId = await resolvePodiumUserId(client, auth.id, targetUser);
    if (!podiumUserId) {
      return res.status(409).json({
        error: `${targetPortalId === auth.id ? 'You have' : `User ${targetPortalId} has`} not linked a Podium account`,
        code: 'TARGET_NOT_LINKED',
      });
    }

    // Drive Podium's native assignment AS the acting rep (their OAuth token).
    await assignConversation(auth.id, String(conversationId), podiumUserId);

    // Mirror the owner onto the lead (durable portal side). 0 rows until F2/F5 create
    // leads — the seam is wired now; the same helper serves F2's inbound webhook.
    const leadsUpdated = await mirrorAssignmentToLead(client, String(conversationId), targetPortalId);

    return res.status(200).json({
      conversationId: String(conversationId),
      assignedTo: targetPortalId,
      assignedPodiumUserId: podiumUserId,
      claimed: targetPortalId === auth.id,
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
