// src/utils/compose.js — F20 increment 2: pure helpers behind the inbox compose modal.
//
// Kept out of the component (and free of JSX/React) so scripts/podium-compose-smoke.mjs
// can import it directly in node — the same arrangement as src/utils/lotLabels.js.
//
// ⚠️ PARITY: classifyComposeTarget MIRRORS lib/podiumCompose.js classifyTarget. The server
// stays authoritative — this only exists so a typo is caught before a round-trip — but the
// two must agree on what is valid, or the rep is either blocked from sending something the
// server would accept, or shown an opaque 400. The smoke runs a shared corpus through BOTH
// and fails on any divergence; if you change one, change the other.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PHONE_DIGITS = 6;

// Classify a recipient as a phone or an email. Returns { kind, value } or null — it never
// throws, because it runs on every keystroke in render.
export function classifyComposeTarget(to) {
  const value = String(to ?? '').trim();
  if (!value) return null;
  if (EMAIL_RE.test(value)) return { kind: 'email', value };
  const digits = value.replace(/\D/g, '');
  if (digits.length >= MIN_PHONE_DIGITS) return { kind: 'phone', value };
  return null;
}

export function isValidComposeTarget(to) {
  return classifyComposeTarget(to) !== null;
}

// What the rep is told after composing. This toast is the ONLY signal that dedupe did its
// job: after reusing an existing thread, "Conversation started" would read as a duplicate.
export function composeResultMessage(result) {
  if (result?.reused && result?.reopened) return 'Reopened and continued the existing conversation';
  if (result?.reused) return 'Continued the existing conversation';
  return 'Conversation started';
}
