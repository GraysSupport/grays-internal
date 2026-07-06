// api/podium/oauth/start.js — begin the per-user Podium OAuth connect (feature F1, increment 2).
//
// The sales rep's browser (authenticated to the portal) calls this to obtain the
// Podium authorize URL, then navigates to it. We identify the rep server-side from
// the login JWT (getAuthUser — never trust a client-supplied id) and sign their id
// into the OAuth `state` so the callback can trust who is connecting (§15.2, §9).
//
// Mock-first (Golden Rule 6): while PODIUM_MOCK=true there are no live Podium creds,
// so instead of sending the rep to real Podium we return a loopback URL straight to
// our own callback with a synthetic code. That makes the whole connect flow — token
// upsert into podium_oauth on the Neon dev branch — reviewable on the Preview with
// no credentials. The live swap (set PODIUM_MOCK=false + PODIUM_CLIENT_ID/…) needs no
// code change here.

import { getAuthUser, hasAnyRole } from '../rbac.js';
import { buildAuthorizeUrl, isMock } from '../podium.js';
import { signState, computeRedirectUri } from '../podiumOAuth.js';

// P11: linking an individual Podium account is a `sales` action. superadmin is allowed
// too so an admin can connect/test. Authorize on the server, not just in the UI (F9).
const ALLOWED_ROLES = ['sales', 'superadmin'];

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const auth = getAuthUser(req);
  if (!auth) return res.status(401).json({ error: 'Not authenticated' });
  if (!hasAnyRole(auth.roles, ALLOWED_ROLES)) {
    return res.status(403).json({ error: 'Requires the sales role to connect a Podium account' });
  }

  let state;
  try {
    state = signState(auth.id);
  } catch (err) {
    console.error('podium oauth start: cannot sign state:', err.message);
    return res.status(500).json({ error: 'Server not configured for OAuth' });
  }

  const redirectUri = computeRedirectUri(req);
  let authorizeUrl;

  if (isMock()) {
    // Loopback: no real Podium hop. Bounce back to our callback with a mock code so
    // the connect flow is exercisable end-to-end on the Preview without credentials.
    const u = new URL(redirectUri);
    u.searchParams.set('code', `mock_code_${auth.id}`);
    u.searchParams.set('state', state);
    authorizeUrl = u.toString();
  } else {
    authorizeUrl = buildAuthorizeUrl(auth.id, { state, redirectUri });
  }

  return res.status(200).json({ authorizeUrl, mock: isMock() });
}
