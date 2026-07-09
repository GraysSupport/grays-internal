// lib/podiumAssign.js — native conversation-assignment glue (feature F1b).
//
// F1b keeps Podium's native "assigned to" and the portal's owner in lockstep, driven
// by the logged-in rep (execution-plan.md §F1b, P4). This module is the shared,
// direction-agnostic glue used by:
//   • the PORTAL → PODIUM direction (api/podium/assign.js, this increment): a rep
//     claims/assigns a conversation → PUT /v4/conversations/{uid}/assignees AS that
//     rep → mirror the owner onto the matching lead.
//   • the PODIUM → PORTAL direction (F2's webhook receiver, later): the
//     conversation-assignment webhook resolves `data.conversation.assignedUser.uid`
//     → maps it back to a portal user → calls mirrorAssignmentToLead() with the same
//     helper, so both directions write the lead the same way.
//
// Two concerns live here so both directions stay consistent:
//   1. resolvePodiumUserId — turn a portal user into their Podium member uid
//      (users.podium_user_id), lazily resolving + persisting via GET /v4/users
//      (email match) when it wasn't captured at connect time.
//   2. mirrorAssignmentToLead — set leads.assigned_to for the conversation. Defensive
//      against a DB without the leads table (42P01) and a no-op (0 rows) until F2/F5
//      create leads — the seam is wired now, the rows arrive later.
//
// P1 note: nothing here reads or writes message bodies. Only CRM metadata
// (users.podium_user_id, leads.assigned_to) is touched (execution-plan P1/P3).

import { getUsers } from './podium.js';

/**
 * Resolve a set of Podium member uids into display-ready assignees for the inbox
 * (F13 multi-assignee). For each uid: match it to a portal user (users.podium_user_id)
 * for the portal id + name; if unmatched, fall back to the Podium member's name (via
 * GET /v4/users AS the acting rep) so a Podium-only member still shows a name, not a uid.
 *
 * @param {object} client        pg client (caller owns the connection)
 * @param {string} actingUserId  portal id whose token lists Podium members (for the name fallback)
 * @param {string[]} podiumUids  the conversation's assignee uids
 * @returns {Promise<Array<{podiumUserId:string, portalId:string|null, name:string|null, linked:boolean}>>}
 */
export async function resolveAssignees(client, actingUserId, podiumUids) {
  const uids = [...new Set((podiumUids || []).filter(Boolean).map(String))];
  if (uids.length === 0) return [];

  // Portal users linked to these Podium members.
  let portalRows = [];
  try {
    const r = await client.query(
      'SELECT id, name, podium_user_id FROM users WHERE podium_user_id = ANY($1)',
      [uids]
    );
    portalRows = r.rows || [];
  } catch (err) {
    if (err?.code !== '42P01') throw err; // users table always exists; be defensive anyway
  }
  const byPodiumUid = new Map(portalRows.map((u) => [u.podium_user_id, u]));

  // Names for any uid without a matched portal user (Podium-only members).
  const unresolved = uids.filter((u) => !byPodiumUid.has(u));
  const memberName = new Map();
  if (unresolved.length) {
    try {
      const resp = await getUsers(actingUserId, { limit: 100, client });
      for (const m of (Array.isArray(resp?.data) ? resp.data : [])) {
        if (m?.uid) memberName.set(m.uid, m.name || null);
      }
    } catch {
      /* name fallback is best-effort — a uid with no name still returns below */
    }
  }

  return uids.map((uid) => {
    const u = byPodiumUid.get(uid);
    return u
      ? { podiumUserId: uid, portalId: u.id, name: u.name || null, linked: true }
      : { podiumUserId: uid, portalId: null, name: memberName.get(uid) || null, linked: false };
  });
}

/**
 * Resolve a portal user's Podium member uid (users.podium_user_id).
 *
 * Fast path: return the stored id if the user already linked their account
 * (callback.js captures it at connect time). Fallback: call GET /v4/users AS the
 * acting rep and match the target's email, then persist it so we never re-resolve.
 *
 * @param {object} client        pg client (caller owns the connection/txn)
 * @param {string} actingUserId  portal id whose Podium token makes the API call
 * @param {{id:string,email?:string,podium_user_id?:string}} targetUser  the user being assigned
 * @returns {Promise<string|null>} the Podium member uid, or null if it can't be resolved
 */
export async function resolvePodiumUserId(client, actingUserId, targetUser) {
  if (!targetUser) return null;
  if (targetUser.podium_user_id) return targetUser.podium_user_id;

  const email = String(targetUser.email || '').toLowerCase().trim();
  if (!email) return null;

  try {
    const resp = await getUsers(actingUserId, { limit: 100, client });
    const list = Array.isArray(resp?.data) ? resp.data : [];
    const match = list.find((u) => String(u.email || '').toLowerCase() === email);
    if (match?.uid) {
      // Persist so subsequent assignments skip the lookup. Only fill when empty so we
      // never clobber a deliberately-set id.
      await client.query(
        `UPDATE users SET podium_user_id = $1
           WHERE id = $2 AND (podium_user_id IS NULL OR podium_user_id = '')`,
        [match.uid, targetUser.id]
      );
      return match.uid;
    }
  } catch (err) {
    // Best-effort: a resolution failure must not break assignment; the caller decides
    // how to respond (this increment returns a 409 "not linked").
    console.error('resolvePodiumUserId failed:', err.message);
  }
  return null;
}

/**
 * Mirror a conversation's owner onto its lead: set leads.assigned_to for every lead
 * bound to `conversationUid`. Returns the number of lead rows updated.
 *
 * Both F1b directions call this so the lead is written identically whether the change
 * originated in the portal (this increment) or in Podium (F2 webhook). It is:
 *   • idempotent — re-running with the same owner is a harmless no-op;
 *   • forward-compatible — returns 0 (not an error) until F2/F5 create leads;
 *   • defensive — returns 0 if the leads table isn't migrated yet (42P01), so a DB
 *     without the F0 migration (e.g. Production pre-release) still serves the request.
 *
 * @param {object} client          pg client
 * @param {string} conversationUid  Podium conversation uid (leads.podium_conversation_id)
 * @param {string|null} portalUserId  the new owner's portal id (null clears the owner)
 * @returns {Promise<number>} rows updated
 */
export async function mirrorAssignmentToLead(client, conversationUid, portalUserId) {
  if (!conversationUid) return 0;
  try {
    const r = await client.query(
      `UPDATE leads
          SET assigned_to = $1, updated_at = NOW()
        WHERE podium_conversation_id = $2`,
      [portalUserId || null, conversationUid]
    );
    return r.rowCount || 0;
  } catch (err) {
    if (err?.code === '42P01') return 0; // leads not migrated on this DB yet
    throw err;
  }
}

export default { resolvePodiumUserId, mirrorAssignmentToLead, resolveAssignees };
