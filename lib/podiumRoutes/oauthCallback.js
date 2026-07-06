// api/podium/oauth/callback.js — finish the per-user Podium OAuth connect (F1, increment 2).
//
// Podium (or, in mock mode, our own start.js loopback) redirects the browser here with
// `?code=&state=`. This is a top-level navigation, NOT an XHR, so there is no login
// Bearer header — we recover the portal user id from the signed `state` (verifyState),
// which is why state is signed in podiumOAuth.js. Then:
//   1. exchange the code for tokens (§15.2; mock-first via lib/podium.js)
//   2. upsert the rep's row in podium_oauth (10h expiry) — the ONLY DB this touches
//   3. resolve + store the rep's Podium member uid in users.podium_user_id (drives
//      native assignment in F1b). Mock provides it directly; live resolves via
//      GET /v4/users matching the rep's email.
// Renders a small self-contained HTML page (success/error) so it works regardless of
// which SPA routes exist yet (the Settings UI lands in increment 3).

import { exchangeCode, saveUserToken, getUsers, isMock } from '../podium.js';
import { verifyState, computeRedirectUri } from '../podiumOAuth.js';
import { getClientWithTimezone } from '../db.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(405).send(page('Method not allowed', 'This endpoint only accepts GET.', false));
  }

  const { code, state, error: oauthError, error_description: oauthErrorDesc } = req.query || {};

  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (oauthError) {
    return res.status(400).send(page('Podium connection failed', `Podium returned: ${oauthErrorDesc || oauthError}`, false));
  }
  const st = verifyState(state ? String(state) : '');
  if (!st) {
    return res.status(400).send(page('Link expired', 'This connection link is invalid or has expired. Please start again from Settings.', false));
  }
  if (!code) {
    return res.status(400).send(page('Missing code', 'No authorization code was returned. Please try connecting again.', false));
  }

  const portalUserId = st.uid;
  const client = await getClientWithTimezone();
  try {
    const redirectUri = computeRedirectUri(req);
    const tokenSet = await exchangeCode(String(code), { redirectUri });

    // Look up the rep (for the greeting + live podium_user_id resolution by email).
    const ur = await client.query('SELECT id, name, email FROM users WHERE id = $1 LIMIT 1', [portalUserId]);
    if (!ur.rowCount) {
      return res.status(400).send(page('Unknown user', 'The portal account for this link no longer exists.', false));
    }
    const portalUser = ur.rows[0];

    let podiumUserId = tokenSet.podium_user_id || null;

    // Persist the token first so any follow-up API call can read it via tokenForUser.
    await saveUserToken(portalUserId, tokenSet, { scopeLevel: 'user', podiumUserId }, { client });

    // Live: if the token exchange didn't hand us the member uid, resolve it from the
    // Users API by matching the rep's email (§F1 step 2). Best-effort — a failure here
    // must not break the connection; F1b can re-resolve later.
    if (!podiumUserId && !isMock()) {
      try {
        const resp = await getUsers(portalUserId, { limit: 100 });
        const list = Array.isArray(resp?.data) ? resp.data : [];
        const target = String(portalUser.email || '').toLowerCase();
        const match = target && list.find((u) => String(u.email || '').toLowerCase() === target);
        if (match?.uid) podiumUserId = match.uid;
      } catch (e) {
        console.error('podium oauth callback: getUsers resolution failed:', e.message);
      }
    }

    if (podiumUserId) {
      await client.query('UPDATE users SET podium_user_id = $1 WHERE id = $2', [podiumUserId, portalUserId]);
      await client.query('UPDATE podium_oauth SET podium_user_id = $1 WHERE user_id = $2', [podiumUserId, portalUserId]);
    }

    const who = portalUser.name || portalUser.id;
    const detail = podiumUserId
      ? `Signed in as ${who}. Linked Podium member <code>${escapeHtml(podiumUserId)}</code>.`
      : `Signed in as ${who}. Token stored; the Podium member id will be resolved on first use.`;
    return res.status(200).send(page('✅ Podium account connected', `${detail} You can close this tab and return to the portal.`, true));
  } catch (err) {
    console.error('podium oauth callback error:', err);
    return res.status(500).send(page('Connection error', 'We could not complete the Podium connection. Please try again.', false));
  } finally {
    client.release();
  }
}

// ---- Minimal self-contained result page (no SPA route dependency) --------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function page(title, message, ok) {
  const accent = ok ? '#16a34a' : '#dc2626';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f8fafc;color:#0f172a;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
  .card{background:#fff;max-width:28rem;padding:2rem;border-radius:14px;box-shadow:0 10px 30px rgba(2,6,23,.08)}
  h1{font-size:1.25rem;margin:0 0 .5rem;color:${accent}}
  p{line-height:1.55;color:#334155;margin:.25rem 0 1.25rem}
  code{background:#f1f5f9;padding:.1rem .35rem;border-radius:6px;font-size:.85em}
  a{display:inline-block;background:${accent};color:#fff;text-decoration:none;padding:.55rem 1rem;border-radius:8px;font-weight:600}
</style></head>
<body><div class="card"><h1>${escapeHtml(title)}</h1><p>${message}</p><a href="/">Return to portal</a></div></body></html>`;
}
