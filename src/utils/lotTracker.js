// G11 (Nick, 1 Oct 2026) — shared bits of the Lot Tracker. Pure and JSX-free (nav.js imports
// it, and scripts/podium-nav-smoke.mjs loads nav.js in node).

// Who may use the tracker. Mirrors LOT_TRACKER_ROLES in lib/lotJourney.js; the server is the
// real authority.
export const LOT_TRACKER_ROLES = ['admin', 'superadmin'];

// A lot sticker reads "L00042". Anything else typed into the box is treated as a search.
export function looksLikeLotNumber(text) {
  return /^L\d{3,11}$/i.test(String(text || '').trim());
}

const DAY = new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
const DAY_TIME = new Intl.DateTimeFormat('en-AU', {
  timeZone: 'Australia/Melbourne', day: 'numeric', month: 'short', year: 'numeric',
  hour: 'numeric', minute: '2-digit', hour12: true,
});

/** "10 Jul 2026" for a date-only value; "18 Aug 2026, 2:54 pm" (Melbourne) for a timestamp. */
export function formatWhen(at, dateOnly = false) {
  if (!at) return '—';
  if (dateOnly || /^\d{4}-\d{2}-\d{2}$/.test(String(at))) {
    const d = new Date(`${String(at).slice(0, 10)}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? '—' : DAY.format(d);
  }
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '—' : DAY_TIME.format(d);
}
