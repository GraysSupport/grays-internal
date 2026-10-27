// lib/featureFlags.js — server-side on/off switches.
//
// FEATURE_PODIUM (28 Oct 2026): the owner is moving off Podium (likely to Coax) and asked
// for every Podium feature to be hidden for ALL users — not deleted — so it can be recalled
// later. Default OFF: unset, empty or anything but 'true' means Podium is hidden.
//
// TO BRING PODIUM BACK: set FEATURE_PODIUM=true AND REACT_APP_FEATURE_PODIUM=true on Vercel
// (the client one is baked in at build time, so redeploy after setting it).
//
// Gated at the ENTRY POINTS (routers, webhook, the two SMS side-effects), not inside the
// lib/podium* modules, so their unit smokes keep exercising the real code unchanged.

export function isPodiumEnabled(env = process.env) {
  return String(env?.FEATURE_PODIUM ?? '').trim().toLowerCase() === 'true';
}

/** The one response every hidden Podium endpoint gives. */
export function podiumDisabled(res) {
  return res.status(404).json({ error: 'The Podium integration is turned off', code: 'PODIUM_DISABLED' });
}

/** Wrap a Podium-only handler so it answers PODIUM_DISABLED while the switch is off. */
export function withPodium(handler) {
  return (req, res, ...rest) => (isPodiumEnabled() ? handler(req, res, ...rest) : podiumDisabled(res));
}
