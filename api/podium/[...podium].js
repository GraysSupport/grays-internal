// api/podium/[...podium].js — single catch-all router for the Podium endpoints.
//
// Consolidates what used to be five standalone serverless functions
// (status, assign, inbox, oauth/start, oauth/callback) into ONE, so the whole Podium
// surface costs a single Serverless-Function slot instead of five. The Vercel project
// is on the Hobby plan (max 12 functions/deployment); this keeps us well under it and
// leaves room for F4–F10. Same public URLs — /api/podium/status, /api/podium/assign,
// /api/podium/inbox, /api/podium/oauth/start, /api/podium/oauth/callback — so no
// front-end change; Vercel routes each to this catch-all.
//
// NOTE: api/podium/webhook.js stays its OWN function on purpose — it needs
// `bodyParser:false` to read the raw signed body for HMAC verification, and Podium
// posts to it externally. A more-specific route (webhook.js) wins over this catch-all,
// so /api/podium/webhook is unaffected.
//
// Each handler owns its own auth gating (getAuthUser / signed state) and reads
// req.method/req.query/req.body exactly as before — routing through the catch-all is
// behaviourally identical to the old standalone entrypoints. The handler bodies live
// under lib/podiumRoutes/ (outside /api, so they are not themselves functions).

import statusHandler from '../../lib/podiumRoutes/status.js';
import assignHandler from '../../lib/podiumRoutes/assign.js';
import inboxHandler from '../../lib/podiumRoutes/inbox.js';
import contactHandler from '../../lib/podiumRoutes/contact.js';
import oauthStartHandler from '../../lib/podiumRoutes/oauthStart.js';
import oauthCallbackHandler from '../../lib/podiumRoutes/oauthCallback.js';

/** Path segments after /api/podium/ (works on Vercel + the ?podium=… fallback). */
function podiumSegs(req) {
  try {
    const pathOnly = (req.url || '').split('?')[0] || '';
    const after = pathOnly.replace(/^\/?api\/podium\/?/, '');
    const parts = after.split('/').filter(Boolean);
    if (parts.length) return parts;
  } catch (_) {}
  const raw = req.query?.podium ?? req.query?.path;
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

export default async function handler(req, res) {
  const [root, sub] = podiumSegs(req);
  switch (root) {
    case 'status':
      return statusHandler(req, res);
    case 'assign':
      return assignHandler(req, res);
    case 'inbox':
      return inboxHandler(req, res);
    case 'contact':
      return contactHandler(req, res);
    case 'oauth':
      if (sub === 'start') return oauthStartHandler(req, res);
      if (sub === 'callback') return oauthCallbackHandler(req, res);
      return res.status(404).json({ error: 'Unknown Podium OAuth route' });
    default:
      return res.status(404).json({ error: 'Unknown Podium route', route: root || null });
  }
}
