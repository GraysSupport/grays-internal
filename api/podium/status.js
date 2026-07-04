// api/podium/status.js — per-user Podium connection status (feature F1, increment 2).
//
// The Settings UI (increment 3) polls this to show whether the logged-in rep has
// linked their Podium account. Authenticated via the login JWT (getAuthUser); returns
// only NON-secret fields from podium_oauth — never the access/refresh tokens.

import { getAuthUser } from '../../lib/rbac.js';
import { getStoredToken, isMock, needsRefresh } from '../../lib/podium.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const auth = getAuthUser(req);
  if (!auth) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const row = await getStoredToken(auth.id);
    if (!row) {
      return res.status(200).json({ connected: false, mock: isMock() });
    }
    return res.status(200).json({
      connected: true,
      mock: isMock(),
      podiumUserId: row.podium_user_id || null,
      scopeLevel: row.scope_level,
      scopes: row.scopes ? String(row.scopes).split(/\s+/).filter(Boolean) : [],
      expiresAt: row.expires_at,
      needsRefresh: needsRefresh(row.expires_at),
    });
  } catch (err) {
    // podium_oauth missing (e.g. a DB without the F0 migration) → report not-connected
    // rather than 500 so the Settings page still renders.
    if (err?.code === '42P01') return res.status(200).json({ connected: false, mock: isMock() });
    console.error('podium status error:', err);
    return res.status(500).json({ error: 'Could not read Podium status' });
  }
}
