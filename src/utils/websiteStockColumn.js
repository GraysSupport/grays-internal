// src/utils/websiteStockColumn.js — G25c: the Products page "Website stock" cell and the drift
// report labels. Data comes from GET /api/website-stock (read-only; lib/websiteStockView.js).

/** One product's website stock → { text, tone: 'ok' | 'warn' | 'muted' } */
export function websiteStockCell(item) {
  if (!item) return { text: '—', tone: 'muted' };
  const n = item.website;
  switch (item.state) {
    case 'match': return { text: String(n), tone: 'ok' };
    case 'mismatch': return { text: String(n), tone: 'warn' };
    case 'not_on_website': return { text: 'not on website', tone: 'muted' };
    case 'not_tracked': return { text: 'stock not tracked', tone: 'muted' };
    case 'skipped': return { text: n == null ? 'not synced' : `${n} (not synced)`, tone: 'muted' };
    case 'unknown': return { text: "couldn't read", tone: 'warn' };
    default: return { text: '—', tone: 'muted' };
  }
}

export const DRIFT_STATE_LABEL = {
  mismatch: 'Different',
  not_on_website: 'Not on website',
};

/** Melbourne date + time for "checked at" lines. */
export function melbourneTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-AU', { timeZone: 'Australia/Melbourne', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}
