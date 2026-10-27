// src/utils/featureFlags.js — client-side on/off switches (mirror of lib/featureFlags.js).
//
// REACT_APP_FEATURE_PODIUM (28 Oct 2026): every Podium screen (Inbox, Lead Funnel, Awaiting
// Workorder, Integrations, the Settings "Podium Integration" card, the customer
// Conversations tab) is hidden unless this is exactly 'true'. CRA inlines REACT_APP_* at
// BUILD time — set it on Vercel and redeploy. The server switch (FEATURE_PODIUM) is the
// real control; this one only hides the screens.
//
// Kept JSX-free so scripts/*-smoke.mjs can import it in plain node (nav.js does).

export function isPodiumEnabled(env) {
  // Read `process.env.REACT_APP_FEATURE_PODIUM` literally so CRA's build-time replacement
  // finds it; `env` lets the smoke pass its own values.
  const raw = env ? env.REACT_APP_FEATURE_PODIUM : process.env.REACT_APP_FEATURE_PODIUM;
  return String(raw ?? '').trim().toLowerCase() === 'true';
}
