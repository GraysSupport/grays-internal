// lib/podiumOAuth.js — web glue for the per-user Podium OAuth flow (feature F1, increment 2).
//
// Two concerns shared by the OAuth HTTP endpoints (api/podium/oauth/start.js and
// callback.js):
//   1. A signed, short-lived `state` value. §15.2 passes the portal user id as the
//      OAuth `state`, but a raw id would let anyone forge a callback for another rep.
//      We sign it as a JWT (same JWT_SECRET as login) so the callback can trust the
//      user id it recovers, and the value can't be replayed after it expires. This is
//      also the CSRF guard for the redirect (§9 security checklist).
//   2. Deriving the exact `redirect_uri`. It must be identical on the authorize URL
//      and the token exchange (§15.2, HTTPS enforced). Prefer the pinned env value
//      (which must match what's registered with Podium for the live app); fall back to
//      the request host so mock/preview flows work before PODIUM_REDIRECT_URI is set.

import jwt from 'jsonwebtoken';

const STATE_PURPOSE = 'podium_oauth_state';
const STATE_TTL = '10m'; // a connect round-trip is seconds; 10 min is generous.

/** Sign the portal user id into a short-lived OAuth `state` JWT. */
export function signState(userId, extra = {}) {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not configured');
  return jwt.sign(
    { uid: String(userId ?? ''), purpose: STATE_PURPOSE, ...extra },
    process.env.JWT_SECRET,
    { expiresIn: STATE_TTL }
  );
}

/**
 * Verify an OAuth `state` JWT. Returns `{ uid }` on success, or null if the token is
 * missing/expired/tampered or isn't one of ours (wrong purpose). Never throws.
 */
export function verifyState(state) {
  if (!state || !process.env.JWT_SECRET) return null;
  try {
    const p = jwt.verify(String(state), process.env.JWT_SECRET);
    if (p.purpose !== STATE_PURPOSE) return null;
    return { uid: p.uid };
  } catch {
    return null;
  }
}

/**
 * The OAuth redirect_uri for this deployment. Uses PODIUM_REDIRECT_URI when set (it
 * MUST exactly match the value registered with Podium for live), else derives it from
 * the incoming request host so the mock/preview loopback works without config.
 */
export function computeRedirectUri(req) {
  if (process.env.PODIUM_REDIRECT_URI) return process.env.PODIUM_REDIRECT_URI;
  const headers = req?.headers || {};
  const host = headers['x-forwarded-host'] || headers.host || 'localhost:3000';
  const proto = headers['x-forwarded-proto'] || (String(host).startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}/api/podium/oauth/callback`;
}
