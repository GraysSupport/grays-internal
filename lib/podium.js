// lib/podium.js — Per-user Podium API v4 service module (feature F1).
//
// One place for every Podium call the portal makes. Built AGAINST the verified
// reference in execution-plan.md §15 and mock-first per Golden Rule 6: while
// PODIUM_MOCK=true (no live developer credentials yet) every request is served by
// lib/podium.mock.js, so Previews work without secrets or network. Swapping to
// live is a config change (set PODIUM_MOCK=false + the PODIUM_* creds) — no code
// change here.
//
// Design (execution-plan.md F1, step 4):
//   • Per-user OAuth (P4): each `sales` rep links their own account; calls run on
//     that rep's token. `tokenForUser(userId)` reads podium_oauth and auto-refreshes
//     within ~5 min of the 10h expiry or on a 401.
//   • `request()` adds the Bearer token + the PINNED dated version header (omitting
//     it defaults to Podium's latest = breaking changes, §15.1) and retries on
//     429/5xx with backoff.
//   • Cursor pagination helper (§15.5): `{ data, metadata:{ nextCursor } }`.
//   • Helpers map 1:1 to the §15.4 endpoints used by F1b/F2/F3/F8.
//
// P1 GUARD: this module returns live message data to callers but performs NO
// database writes of message content. Callers must never persist `data.body`
// (Podium is the system of record). The only DB this module touches is the
// podium_oauth token store.

import { getClientWithTimezone } from './db.js';
import * as mock from './podium.mock.js';

// ---- Constants -------------------------------------------------------------

export const API_BASE = 'https://api.podium.com/v4';
export const OAUTH_AUTHORIZE_URL = 'https://api.podium.com/oauth/authorize';
export const OAUTH_TOKEN_URL = 'https://api.podium.com/oauth/token';

// Least-privilege scopes this integration needs (§15.3). No `webhooks` scope
// exists — a webhook for an event type needs that event's own scope.
export const DEFAULT_SCOPES = [
  'read_messages', 'write_messages',
  'read_contacts', 'write_contacts',
  'read_users',
  'read_reviews', 'write_reviews',
  'read_locations', 'read_organizations',
];

// Podium's dated API-version request header. VERIFY the exact header name against
// docs.podium.com when wiring live creds; the value comes from PODIUM_API_VERSION
// and MUST be pinned (§15.1). Kept in one place so the live swap is trivial.
const VERSION_HEADER = 'Podium-Version';

// Refresh a token this long before its hard 10h expiry.
const REFRESH_SKEW_MS = 5 * 60 * 1000;
// Retry policy for transient upstream failures.
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 300;

// ---- Pure config helpers (env read at call-time, so tests can flip flags) ---

export function isMock() {
  const v = String(process.env.PODIUM_MOCK ?? '').toLowerCase();
  // Default to mock unless explicitly disabled OR client creds are present.
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return !process.env.PODIUM_CLIENT_ID; // no creds ⇒ mock
}

export function apiVersion() {
  return process.env.PODIUM_API_VERSION || '';
}

export function scopes() {
  const fromEnv = (process.env.PODIUM_OAUTH_SCOPES || '').trim();
  return fromEnv ? fromEnv.split(/\s+/) : DEFAULT_SCOPES.slice();
}

export function redirectUri() {
  return process.env.PODIUM_REDIRECT_URI || '';
}

/** Is a token (expiry as ms epoch or ISO/Date) due for refresh? */
export function needsRefresh(expiresAt, now = Date.now(), skewMs = REFRESH_SKEW_MS) {
  if (expiresAt == null) return true;
  const exp = expiresAt instanceof Date ? expiresAt.getTime()
    : typeof expiresAt === 'number' ? expiresAt
      : Date.parse(expiresAt);
  if (!Number.isFinite(exp)) return true;
  return now >= exp - skewMs;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- OAuth 2 (per-user) ----------------------------------------------------

/**
 * Build the browser authorize URL (§15.2). `state` carries the portal user id so
 * the callback can key the token to the right rep. Scopes are space-separated and
 * %20-encoded by URLSearchParams.
 */
export function buildAuthorizeUrl(userId, opts = {}) {
  // Build the query by hand: scopes must be %20-encoded (§15.2), but
  // URLSearchParams emits `+` for spaces. encodeURIComponent gives %20.
  const params = {
    client_id: process.env.PODIUM_CLIENT_ID || '',
    redirect_uri: opts.redirectUri || redirectUri(),
    scope: (opts.scopes || scopes()).join(' '),
    response_type: 'code',
    state: opts.state || String(userId ?? ''),
  };
  const qs = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return `${OAUTH_AUTHORIZE_URL}?${qs}`;
}

/** Exchange an authorization code for tokens (§15.2). Mock-first. */
export async function exchangeCode(code, opts = {}) {
  if (isMock()) return mock.oauthExchange(code);
  return postToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: opts.redirectUri || redirectUri(),
    client_id: process.env.PODIUM_CLIENT_ID,
    client_secret: process.env.PODIUM_CLIENT_SECRET,
  });
}

/** Refresh an access token (§15.2). Mock-first. */
export async function refreshAccessToken(refreshToken) {
  if (isMock()) return mock.oauthRefresh(refreshToken);
  return postToken({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: process.env.PODIUM_CLIENT_ID,
    client_secret: process.env.PODIUM_CLIENT_SECRET,
  });
}

async function postToken(bodyObj) {
  const resp = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(bodyObj),
  });
  const text = await resp.text();
  if (!resp.ok) {
    const err = new Error(`Podium OAuth ${resp.status}: ${text.slice(0, 300)}`);
    err.status = resp.status;
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

// ---- Token store (podium_oauth) --------------------------------------------
// Only DB the service touches. A NULL user_id row is the location/webhook
// registration (scope_level='location', §4.2). Uses the repo pg + timezone helper.

async function withClient(injected, fn) {
  if (injected) return fn(injected);
  const client = await getClientWithTimezone();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/** Read the stored token row for a rep (or null). */
export async function getStoredToken(userId, opts = {}) {
  return withClient(opts.client, async (client) => {
    const r = await client.query(
      `SELECT id, user_id, access_token, refresh_token, scopes, expires_at,
              podium_user_id, org_uid, location_uid, scope_level
         FROM podium_oauth
        WHERE user_id = $1
        LIMIT 1`,
      [userId]
    );
    return r.rowCount ? r.rows[0] : null;
  });
}

/**
 * Upsert a rep's token set (from exchange or refresh). `expiresInSeconds`
 * defaults to the 10h Podium TTL. Keyed by user_id (uq_podium_oauth_user).
 */
export async function saveUserToken(userId, tokenSet, meta = {}, opts = {}) {
  const expiresInSeconds = Number(tokenSet.expires_in) || 10 * 60 * 60;
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
  const scopeStr = Array.isArray(tokenSet.scope) ? tokenSet.scope.join(' ')
    : (tokenSet.scope || meta.scopes || scopes().join(' '));
  return withClient(opts.client, async (client) => {
    const r = await client.query(
      `INSERT INTO podium_oauth
         (user_id, scope_level, org_uid, location_uid, podium_user_id,
          access_token, refresh_token, scopes, expires_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW())
       ON CONFLICT (user_id) WHERE user_id IS NOT NULL
       DO UPDATE SET access_token = EXCLUDED.access_token,
                     refresh_token = EXCLUDED.refresh_token,
                     scopes        = EXCLUDED.scopes,
                     expires_at    = EXCLUDED.expires_at,
                     podium_user_id = COALESCE(EXCLUDED.podium_user_id, podium_oauth.podium_user_id),
                     updated_at    = NOW()
       RETURNING id`,
      [
        userId,
        meta.scopeLevel || 'user',
        meta.orgUid || null,
        meta.locationUid || null,
        tokenSet.podium_user_id || meta.podiumUserId || null,
        tokenSet.access_token,
        tokenSet.refresh_token,
        scopeStr,
        expiresAt,
      ]
    );
    return r.rows[0]?.id ?? null;
  });
}

/**
 * Return a valid access token for a rep, refreshing + persisting if it's within
 * the skew of its 10h expiry. In mock mode returns a synthetic token (no DB).
 * Throws PodiumNotConnectedError if the rep has never linked their account.
 */
export async function tokenForUser(userId, opts = {}) {
  if (isMock()) return `mock_at_${userId}`;
  return withClient(opts.client, async (client) => {
    const row = await getStoredToken(userId, { client });
    if (!row) {
      const err = new Error(`Podium account not connected for user ${userId}`);
      err.code = 'PODIUM_NOT_CONNECTED';
      throw err;
    }
    if (!needsRefresh(row.expires_at)) return row.access_token;
    const refreshed = await refreshAccessToken(row.refresh_token);
    await saveUserToken(userId, refreshed, { scopeLevel: row.scope_level }, { client });
    return refreshed.access_token;
  });
}

// ---- Core request wrapper --------------------------------------------------

function buildUrl(path, query) {
  const clean = String(path).replace(/^\//, '');
  const url = new URL(`${API_BASE}/${clean.replace(/^v4\//, '')}`);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  return url.toString();
}

function isRetryable(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/**
 * Make an authenticated Podium request AS `userId`. Mock-first (no token/DB in
 * mock mode). Adds the pinned version header, retries transient failures with
 * backoff, and refreshes once on a 401.
 */
export async function request(userId, method, path, opts = {}) {
  if (isMock()) return mock.handle(method, path, opts);

  const doFetch = async (token) => {
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      [VERSION_HEADER]: apiVersion(),
    };
    const init = { method: String(method || 'GET').toUpperCase(), headers };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return fetch(buildUrl(path, opts.query), init);
  };

  let token = await tokenForUser(userId, { client: opts.client });
  let attempt = 0;
  let refreshedOn401 = false;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let resp;
    try {
      resp = await doFetch(token);
    } catch (netErr) {
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BASE_MS * 2 ** attempt);
        attempt += 1;
        continue;
      }
      throw netErr;
    }

    // One forced refresh + retry on 401 (token may have been revoked upstream).
    if (resp.status === 401 && !refreshedOn401 && !opts.client) {
      refreshedOn401 = true;
      const row = await getStoredToken(userId);
      if (row) {
        const refreshed = await refreshAccessToken(row.refresh_token);
        await saveUserToken(userId, refreshed, { scopeLevel: row.scope_level });
        token = refreshed.access_token;
        continue;
      }
    }

    if (isRetryable(resp.status) && attempt < MAX_RETRIES) {
      const retryAfter = Number(resp.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : RETRY_BASE_MS * 2 ** attempt;
      await sleep(wait);
      attempt += 1;
      continue;
    }

    const text = await resp.text();
    if (!resp.ok) {
      const err = new Error(`Podium ${init_method(method)} ${path} → ${resp.status}: ${text.slice(0, 300)}`);
      err.status = resp.status;
      throw err;
    }
    return text ? JSON.parse(text) : {};
  }
}

function init_method(m) {
  return String(m || 'GET').toUpperCase();
}

/**
 * Walk a cursor-paginated list endpoint (§15.5), returning the concatenated
 * `data`. `max` caps total items pulled (safety against runaway pagination).
 */
export async function paginate(userId, path, opts = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 100);
  const max = Number(opts.max) || 1000;
  const out = [];
  let cursor = opts.cursor || undefined;
  do {
    const query = { ...(opts.query || {}), limit };
    if (cursor) query.cursor = cursor;
    const res = await request(userId, 'GET', path, { query, client: opts.client });
    const batch = Array.isArray(res?.data) ? res.data : [];
    out.push(...batch);
    cursor = res?.metadata?.nextCursor || null;
  } while (cursor && out.length < max);
  return out.slice(0, max);
}

// ---- Endpoint helpers (§15.4) ----------------------------------------------

/**
 * Normalise a LIVE §15 conversation object to the shape the rest of the stack
 * (inbox routes, F4 bridge, React UI) expects — which is the mock fixture shape.
 * VERIFIED 14 Jul 2026 against docs.podium.com/reference/the-conversation-object:
 * live rows carry `closed` (bool), `assignedUserUid`, `assigneeUids[]`, `lastItemAt`
 * — not the `status` / `assignedUser{uid}` / `assignees[{uid}]` / `lastMessageAt`
 * fields everything downstream reads. Mock rows pass through unchanged; original
 * live fields are kept alongside the derived ones.
 */
export function normalizeConversation(conv) {
  if (!conv || typeof conv !== 'object') return conv;
  const out = { ...conv };
  if (out.status !== 'open' && out.status !== 'closed') {
    out.status = out.closed === true ? 'closed' : 'open';
  }
  if (!Array.isArray(out.assignees)) {
    const uids = Array.isArray(out.assigneeUids) && out.assigneeUids.length
      ? out.assigneeUids
      : (out.assignedUserUid ? [out.assignedUserUid] : []);
    out.assignees = uids.filter(Boolean).map((uid) => ({ uid }));
  }
  if (!out.assignedUser) {
    const primary = out.assignees[0]?.uid || null;
    out.assignedUser = primary ? { uid: primary } : null;
  }
  if (!out.lastMessageAt) out.lastMessageAt = out.lastItemAt || out.updatedAt || null;
  return out;
}

/**
 * Does a (normalised) conversation fall inside the requested F11 bucket + status?
 * Pure; used for the LIVE path where Podium cannot filter server-side.
 */
export function conversationMatchesFilters(conv, opts = {}) {
  const assignees = Array.isArray(conv?.assignees) ? conv.assignees : [];
  if (opts.unassigned && assignees.length) return false;
  if (opts.assigneeUid && !assignees.some((a) => a?.uid === opts.assigneeUid)) return false;
  if ((opts.status === 'open' || opts.status === 'closed') && conv?.status !== opts.status) return false;
  return true;
}

/**
 * GET /v4/conversations (cursor+limit). Filters map to the F11 inbox buckets:
 *   • assigneeUid — "Assigned to You" / a specific rep (scope=mine)
 *   • unassigned  — the "Unassigned" bucket (no assignee)
 *   • status      — 'open' | 'closed' (the Open/Closed split within each bucket)
 * VERIFIED at live wiring (14 Jul 2026, docs + a live 400 invalid_request_values):
 * the live endpoint accepts ONLY `cursor` / `limit` / `locationUid` — no filter
 * params exist. So live requests send just those, and the bucket/status filters are
 * applied HERE over a wider page (up to 100 rows, the established F14 scan window),
 * then sliced back to the requested limit. The mock still filters server-side, so
 * Preview behaviour and the existing smoke contracts are unchanged.
 */
export async function listConversations(userId, opts = {}) {
  const query = { ...(opts.query || {}) };
  if (opts.limit) query.limit = opts.limit;
  if (opts.cursor) query.cursor = opts.cursor;
  if (isMock()) {
    if (opts.assigneeUid) query.assigneeUid = opts.assigneeUid;
    if (opts.unassigned) query.unassigned = 'true';
    if (opts.status) query.status = opts.status;
    return request(userId, 'GET', 'conversations', { query, client: opts.client });
  }
  const filtering = !!(opts.assigneeUid || opts.unassigned || opts.status === 'open' || opts.status === 'closed');
  if (filtering) query.limit = 100; // scan window; sliced back below
  const resp = await request(userId, 'GET', 'conversations', { query, client: opts.client });
  let data = (Array.isArray(resp?.data) ? resp.data : []).map(normalizeConversation);
  if (filtering) {
    data = data.filter((c) => conversationMatchesFilters(c, opts));
    if (opts.limit) data = data.slice(0, opts.limit);
  }
  return { ...resp, data };
}

/** GET /v4/conversations/{uid} */
export async function getConversation(userId, conversationUid, opts = {}) {
  const conv = await request(userId, 'GET', `conversations/${conversationUid}`, { client: opts.client });
  return isMock() ? conv : normalizeConversation(conv);
}

/** PATCH /v4/conversations/{uid} — update conversation fields. */
export function updateConversation(userId, conversationUid, patch, opts = {}) {
  return request(userId, 'PATCH', `conversations/${conversationUid}`, { body: patch, client: opts.client });
}

/**
 * Open or close a conversation. VERIFY the live Podium endpoint/field for this at
 * wiring — our reference doesn't pin it; the mock accepts a `status` patch.
 */
export function setConversationStatus(userId, conversationUid, status, opts = {}) {
  return updateConversation(userId, conversationUid, { status }, opts);
}

/** GET /v4/conversations/{uid}/messages (cursor+limit). Bodies are live-only (P1). */
export function listMessages(userId, conversationUid, opts = {}) {
  const query = {};
  if (opts.limit) query.limit = opts.limit;
  if (opts.cursor) query.cursor = opts.cursor;
  return request(userId, 'GET', `conversations/${conversationUid}/messages`, { query, client: opts.client });
}

/**
 * POST /v4/messages — send AS the logged-in rep. F12 rich messaging: `attachments`
 * carries image/video/file references (metadata only — never raw bytes here; real
 * media upload is a live-wiring swap over Podium's media API, a VERIFY at wiring) and
 * `templateId` records the message template the body came from.
 */
export function sendMessage(userId, { conversationUid, body, channel, to, type = 'text', locationUid, attachments, templateId } = {}) {
  const payload = {
    conversationUid,
    body,
    type,
    locationUid: locationUid || process.env.PODIUM_LOCATION_UID || undefined,
  };
  if (channel) payload.channel = channel;
  if (to) payload.to = to;
  if (Array.isArray(attachments) && attachments.length) payload.attachments = attachments;
  if (templateId) payload.templateId = templateId;
  return request(userId, 'POST', 'messages', { body: payload });
}

/**
 * GET /v4/message_templates — Podium's saved message templates (canned responses) a
 * rep inserts into the composer (F12). Cursor-paginated like other list endpoints.
 * VERIFY the live Podium endpoint/field names at wiring.
 */
export function listMessageTemplates(userId, opts = {}) {
  const query = {};
  if (opts.limit) query.limit = opts.limit;
  if (opts.cursor) query.cursor = opts.cursor;
  return request(userId, 'GET', 'message_templates', { query, client: opts.client });
}

/**
 * POST /v4/conversations/{uid}/notes — add a team-only INTERNAL NOTE to a conversation
 * (F12). Team-visible, NEVER sent to the customer. Sent to Podium (the system of record)
 * so nothing is persisted in the portal DB (P1). VERIFY the live endpoint at wiring.
 */
export function postInternalNote(userId, { conversationUid, body, author } = {}) {
  return request(userId, 'POST', `conversations/${conversationUid}/notes`, {
    body: { body, author },
  });
}

/**
 * GET /v4/conversations/{uid}/assignees — the conversation's assignee(s). Returns
 * `{ conversationUid, assignees:[{uid}], assignedUser }` (F13 multi-assignee; the
 * endpoint is plural). `assignedUser` is the primary (first) assignee.
 */
export function getAssignee(userId, conversationUid, opts = {}) {
  return request(userId, 'GET', `conversations/${conversationUid}/assignees`, { client: opts.client });
}
export { getAssignee as getAssignees };

/**
 * PUT /v4/conversations/{uid}/assignees — set the conversation's assignee(s). Drives
 * native assignment (F1b single owner, F13 one-or-more). Accepts a single Podium member
 * uid (string) or an array of uids; an empty array clears all assignees. Sends the array
 * as `userUids` plus `userUid`=the primary for single-owner backward-compat.
 * VERIFY the exact live Podium request body shape for multiple assignees at wiring.
 */
export function assignConversation(userId, conversationUid, assignees) {
  const uids = (Array.isArray(assignees) ? assignees : [assignees])
    .filter(Boolean)
    .map(String);
  return request(userId, 'PUT', `conversations/${conversationUid}/assignees`, {
    body: { userUids: uids, userUid: uids[0] || null },
  });
}

/** GET /v4/users (+ pagination via paginate()) or GET /v4/users/{uid}. */
export function getUsers(userId, opts = {}) {
  if (opts.uid) return request(userId, 'GET', `users/${opts.uid}`, { client: opts.client });
  return request(userId, 'GET', 'users', {
    query: { ...(opts.limit ? { limit: opts.limit } : {}), ...(opts.cursor ? { cursor: opts.cursor } : {}) },
    client: opts.client,
  });
}

/** GET /v4/contacts/{uid} */
export function getContact(userId, contactUid, opts = {}) {
  return request(userId, 'GET', `contacts/${contactUid}`, { client: opts.client });
}

/** POST /v4/reviews/invites (F8c). */
export function requestReview(userId, { contactUid, locationUid, channel } = {}) {
  return request(userId, 'POST', 'reviews/invites', {
    body: {
      contactUid,
      channel,
      locationUid: locationUid || process.env.PODIUM_LOCATION_UID || undefined,
    },
  });
}

// ---- Webhooks CRUD (§15.6, drives F2 registration) -------------------------
// Subscriptions are per location/org (NOT per-user) and are created with an admin
// location-scoped token (F1 step 3). `secret` is the HMAC key the receiver verifies
// against (PODIUM_WEBHOOK_SECRET). Runs `AS adminUserId` (their OAuth token).

/** POST /v4/webhooks — create the location/org subscription. */
export function createWebhook(adminUserId, { url, secret, eventTypes, locationUid, organizationUid } = {}) {
  const body = { url, secret };
  if (eventTypes) body.eventTypes = Array.isArray(eventTypes) ? eventTypes : [eventTypes];
  if (locationUid || process.env.PODIUM_LOCATION_UID) body.locationUid = locationUid || process.env.PODIUM_LOCATION_UID;
  if (organizationUid || process.env.PODIUM_ORG_UID) body.organizationUid = organizationUid || process.env.PODIUM_ORG_UID;
  return request(adminUserId, 'POST', 'webhooks', { body });
}

/** GET /v4/webhooks — list existing subscriptions. */
export function listWebhooks(adminUserId, opts = {}) {
  return request(adminUserId, 'GET', 'webhooks', {
    query: { ...(opts.limit ? { limit: opts.limit } : {}), ...(opts.cursor ? { cursor: opts.cursor } : {}) },
    client: opts.client,
  });
}

/** DELETE /v4/webhooks/{uid} — remove a subscription. */
export function deleteWebhook(adminUserId, webhookUid) {
  return request(adminUserId, 'DELETE', `webhooks/${webhookUid}`);
}

export default {
  isMock, apiVersion, scopes, redirectUri, needsRefresh,
  buildAuthorizeUrl, exchangeCode, refreshAccessToken,
  getStoredToken, saveUserToken, tokenForUser,
  request, paginate,
  listConversations, getConversation, updateConversation, setConversationStatus,
  normalizeConversation, conversationMatchesFilters,
  listMessages, sendMessage, listMessageTemplates, postInternalNote,
  getAssignee, assignConversation, getUsers, getContact, requestReview,
  createWebhook, listWebhooks, deleteWebhook,
};
