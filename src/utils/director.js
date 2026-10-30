// G22 Director's View (owner, 29 Oct 2026) — pure helpers: period presets (Australian
// financial year by default), money, percentages, change vs the previous period. Dates are
// Melbourne calendar dates; the server (lib/director.js) re-validates every range.

const MELB = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' });
const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

/** Today's Melbourne date as { y, m, d } (m = 1–12). */
function melbourneToday(now) {
  const [y, m, d] = MELB.format(now).split('-').map(Number);
  return { y, m, d };
}

/**
 * The presets for the period picker; the first (current FY to date) is the default.
 * Periods still running end TODAY, so a comparison is like-for-like. `compare` = how the server
 * picks the comparison: 'year' = the same dates a year earlier (FY / calendar year to date),
 * '1' = the same-length period immediately before.
 */
export function periodPresets(now = new Date()) {
  const { y, m, d } = melbourneToday(now);
  const today = ymd(y, m, d);
  const fyStart = m >= 7 ? y : y - 1; // FY2027 = 1 Jul 2026 – 30 Jun 2027
  const last12 = new Date(Date.UTC(y - 1, m - 1, d + 1));
  return [
    { key: 'fy', label: `This financial year to date (FY${fyStart + 1})`, from: ymd(fyStart, 7, 1), to: today, compare: 'year' },
    { key: 'prev-fy', label: `Last financial year (FY${fyStart})`, from: ymd(fyStart - 1, 7, 1), to: ymd(fyStart, 6, 30), compare: 'year' },
    { key: 'calendar', label: `Calendar year ${y} to date`, from: ymd(y, 1, 1), to: today, compare: 'year' },
    { key: 'last12', label: 'Last 12 months', from: last12.toISOString().slice(0, 10), to: today, compare: '1' },
    { key: 'month', label: 'This month to date', from: ymd(y, m, 1), to: today, compare: '1' },
  ];
}

/** AUD rounded to the dollar: "$890,031", "−$400". */
export function formatDollars(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
  const n = Math.round(Number(v));
  const s = `$${Math.abs(n).toLocaleString('en-AU')}`;
  return n < 0 ? `−${s}` : s;
}

/** 0.75 → "75%". */
export function formatPct(r) {
  if (r === null || r === undefined || !Number.isFinite(Number(r))) return '—';
  return `${Math.round(Number(r) * 100)}%`;
}

/** ▲ / ▼ change of `cur` vs `prev`; null when there is nothing to compare with. */
export function changeBadge(cur, prev) {
  if (prev === null || prev === undefined || cur === null || cur === undefined) return null;
  if (prev === 0) return cur > 0 ? { dir: 'up', text: 'new' } : { dir: 'flat', text: '— 0%' };
  const pct = Math.round(((cur - prev) / Math.abs(prev)) * 100);
  if (pct > 0) return { dir: 'up', text: `▲ ${pct}%` };
  if (pct < 0) return { dir: 'down', text: `▼ ${Math.abs(pct)}%` };
  return { dir: 'flat', text: '— 0%' };
}

/** ['2025-11', '2025-12', …] covering from..to. */
export function monthsBetween(from, to) {
  let [y, m] = String(from).split('-').map(Number);
  const [ty, tm] = String(to).split('-').map(Number);
  const out = [];
  while ((y < ty || (y === ty && m <= tm)) && out.length < 120) {
    out.push(`${y}-${pad(m)}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** '2026-02' → 'Feb 2026'. */
// Workorder item condition codes → the names used on the website (owner, 30 Oct 2026).
const CONDITION_NAMES = { CS: 'Clean and Serviced', CCG: 'Check, Clean and Go', AT: 'As Traded', Reco: 'Fully Reconditioned' };
export function conditionLabel(code) {
  const name = CONDITION_NAMES[code];
  return name ? `${name} (${code})` : code;
}

export function monthLabel(ym) {
  const [y, m] = String(ym).split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}
