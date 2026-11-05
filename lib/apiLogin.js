// lib/apiLogin.js — P7 (owner approved 5 Nov 2026): the workorder / delivery / customer /
// waitlist / lots APIs need a valid login.
//
// Before P7 these endpoints read no token: a caller with no identity was unrestricted, and one
// claiming another user's X-User-Id was treated as that user (found during G17, 19 Oct 2026).
//
//   - The router (api/[...path].js) calls apiLoginGate() before it routes, so a request without a
//     valid login is refused with 401 before any database work.
//   - The signed login id becomes the acting user: X-User-Id and body.user_id are overwritten, so
//     every workorder log ("who did it") and every G17 workshop restriction now follows the
//     login, not a claim.
//   - The PUBLIC /scan lot lookup (GET /api/lots?lot_number=, decision D7: no cost, no customer
//     data) stays open — it is on the login page.
//   - Logins: 1 h, renewed while someone is working (POST /api/auth/refresh, see refreshLogin).
//     The WK workshop kiosk (owner default, 5 Nov 2026 — may be overridden) gets one shift: 12 h,
//     not renewable, then a fresh sign-in. It stays G17-restricted (lib/workshopAccess.js).

import jwt from 'jsonwebtoken';
import { getAuthUser, getRolesForUser } from './rbac.js';
import { WORKSHOP_ACCOUNT_ID } from './workshopAccess.js';

export const LOGIN_REQUIRED_ROOTS = ['workorder', 'delivery', 'customers', 'customer', 'waitlist', 'waitlists', 'lots', 'lot'];
export const LOGIN_LIFETIME = '1h';
export const KIOSK_LOGIN_LIFETIME = '12h';

const isKiosk = (id) => String(id || '').toUpperCase() === WORKSHOP_ACCOUNT_ID;

/** The public /scan lookup: GET /api/lots?lot_number=… with no other resource (D7). */
export function isPublicApiRequest(root, req) {
  if (root !== 'lots' && root !== 'lot') return false;
  if (String(req?.method || '').toUpperCase() !== 'GET') return false;
  const q = req?.query || {};
  return Boolean(q.lot_number) && !q.resource;
}

/**
 * Gate one request. { ok: true, auth? } or { ok: false, status: 401, error }.
 * On a valid login, stamps the signed id as the acting user (header + body).
 */
export function apiLoginGate(root, req) {
  if (!LOGIN_REQUIRED_ROOTS.includes(root)) return { ok: true };
  if (isPublicApiRequest(root, req)) return { ok: true };
  const auth = getAuthUser(req);
  if (!auth || !auth.id) return { ok: false, status: 401, error: 'Please sign in again' };
  req.headers = req.headers || {};
  req.headers['x-user-id'] = auth.id;
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body) && 'user_id' in req.body) {
    req.body.user_id = auth.id;
  }
  return { ok: true, auth };
}

export function loginLifetimeFor(id) {
  return isKiosk(id) ? KIOSK_LOGIN_LIFETIME : LOGIN_LIFETIME;
}

// Renewal stops this long after the person actually signed in (auth_time), so a copied login
// cannot be kept alive for ever by renewing it. 12 h covers the longest working day.
export const MAX_LOGIN_AGE_SECONDS = 12 * 3600;

export function signLoginToken({ id, email, roles }, authTime = Math.floor(Date.now() / 1000)) {
  return jwt.sign({ id, email, roles, auth_time: authTime }, process.env.JWT_SECRET, { expiresIn: loginLifetimeFor(id) });
}

/**
 * POST /api/auth/refresh — renew a still-valid login (sliding session for active staff). Re-reads
 * the user and their roles, so a deleted user or a removed role takes effect at the next renewal.
 * The WK kiosk does not renew (one shift). Returns { status, body }.
 */
export async function refreshLogin(req, client) {
  const auth = getAuthUser(req);
  if (!auth || !auth.id) return { status: 401, body: { error: 'Please sign in again' } };
  if (isKiosk(auth.id)) return { status: 403, body: { error: 'The workshop kiosk signs in once per shift' } };
  // getAuthUser verified the signature; read the sign-in time from the same token.
  const claims = jwt.decode(String(req.headers?.authorization || '').slice(7)) || {};
  const authTime = Number.isInteger(claims.auth_time) ? claims.auth_time : claims.iat; // pre-P7 tokens: issue time
  if (!Number.isInteger(authTime) || Math.floor(Date.now() / 1000) - authTime > MAX_LOGIN_AGE_SECONDS) {
    return { status: 401, body: { error: 'Please sign in again' } };
  }
  const r = await client.query('SELECT id, email, access FROM users WHERE id = $1', [auth.id]);
  if (!r.rows.length) return { status: 401, body: { error: 'Please sign in again' } };
  const user = r.rows[0];
  const roles = await getRolesForUser(client, user.id, user.access);
  return { status: 200, body: { token: signLoginToken({ id: user.id, email: user.email, roles }, authTime), roles } };
}
