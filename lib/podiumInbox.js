// lib/podiumInbox.js — live-proxy glue for the in-portal Inbox (feature F3).
//
// F3 renders the Podium inbox *live* on the rep's own token and stores NOTHING
// (execution-plan.md §F3, P1 — Podium is the system of record). The HTTP endpoints
// (api/podium/conversations.js, messages.js, poll.js) are thin proxies over the
// verified §15.4 helpers in lib/podium.js; this module holds only the two pieces of
// logic worth centralising + unit-testing offline:
//
//   1. resolveSelfPodiumUid — the "My conversations" default view (F3 step / F1b
//      increment 3) filters GET /v4/conversations by assignee = the logged-in rep's
//      Podium member uid. This turns the rep's portal id into that uid, reusing the
//      F1b resolver (fast path: stored users.podium_user_id; fallback: GET /v4/users
//      email match, persisted so we never re-resolve).
//   2. filterUpdatedSince — a pure helper the 5–10 s poll uses to keep only the
//      conversations touched since the client's last cursor timestamp.
//
// Mock-first (Golden Rule 6): every Podium hop routes through lib/podium.mock.js while
// PODIUM_MOCK=true, so the whole inbox is reviewable on the Preview without creds.
//
// P1 note: nothing here reads or writes message BODIES; the message-body passthrough
// lives only in the request/response of messages.js and is never persisted.

import { resolvePodiumUserId } from './podiumAssign.js';

/**
 * Resolve the logged-in rep's own Podium member uid (users.podium_user_id), so the
 * inbox can default to "My conversations". Loads the rep's row for the email, then
 * defers to the shared F1b resolver (returns the stored id immediately, else looks it
 * up via GET /v4/users AS the rep and persists it).
 *
 * @param {object} client   pg client (caller owns the connection)
 * @param {{id:string, email?:string}} auth  the acting rep (from getAuthUser)
 * @returns {Promise<string|null>} the rep's Podium member uid, or null if unresolved
 *   (rep hasn't linked / no email match) — the caller returns an empty "mine" view.
 */
export async function resolveSelfPodiumUid(client, auth) {
  if (!auth?.id) return null;
  const r = await client.query(
    'SELECT id, email, podium_user_id FROM users WHERE id = $1 LIMIT 1',
    [auth.id]
  );
  if (!r.rowCount) return null;
  const row = r.rows[0];
  // Prefer the freshest email we have (JWT) but keep the stored id fast-path.
  const target = { id: row.id, email: row.email || auth.email, podium_user_id: row.podium_user_id };
  return resolvePodiumUserId(client, auth.id, target);
}

/**
 * Keep only conversations whose last activity is strictly newer than `sinceIso`.
 * Pure + defensive: an unparseable/absent `since` returns the list unchanged (the
 * client's first poll has no cursor); a conversation with no/!parseable timestamp is
 * treated as updated (surfaced rather than dropped). Compares on `lastMessageAt`
 * (falls back to `updatedAt`).
 *
 * @param {Array<object>} conversations  the §15 conversation objects
 * @param {string|number|Date|null} sinceIso  client's last-seen timestamp
 * @returns {Array<object>} the subset updated since `sinceIso`
 */
export function filterUpdatedSince(conversations, sinceIso) {
  const list = Array.isArray(conversations) ? conversations : [];
  const since = toMs(sinceIso);
  if (since == null) return list.slice();
  return list.filter((c) => {
    const t = toMs(c?.lastMessageAt ?? c?.updatedAt);
    return t == null ? true : t > since;
  });
}

function toMs(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

/** Clamp a caller-supplied page size into Podium's 1–100 window (§15.5). */
export function clampLimit(raw, fallback = 30) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, 1), 100);
}

/**
 * Normalise the F11 conversation bucket. Accepts the new `bucket` param
 * (mine|unassigned|all) and the legacy F3 `scope` alias (mine|all). Anything else
 * falls back to 'mine' — preserving the F1b increment-3 default ("My conversations").
 */
export function normalizeBucket(raw) {
  const v = String(raw ?? '').toLowerCase();
  if (v === 'all') return 'all';
  if (v === 'unassigned') return 'unassigned';
  return 'mine';
}

/**
 * Normalise the Open/Closed status filter. 'open'|'closed' narrow the list; anything
 * else (incl. 'all' or absent) returns null = no status filter. Podium-like default is
 * chosen by the caller (the route defaults to 'open').
 */
export function normalizeStatus(raw) {
  const v = String(raw ?? '').toLowerCase();
  return v === 'open' || v === 'closed' ? v : null;
}

export default {
  resolveSelfPodiumUid, filterUpdatedSince, clampLimit, normalizeBucket, normalizeStatus,
};
