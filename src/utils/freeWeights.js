// G21 (owner, 29 Oct 2026) — shared bits of the Brand New Free Weights stock tab. Pure and
// JSX-free (scripts/ops-free-weights-smoke.mjs loads it in node). Category + reason keys mirror
// lib/freeWeights.js — the smoke pins the two equal. The server is the real authority on who
// may see cost and who may change stock.

export const FREE_WEIGHT_CATEGORIES = [
  { key: 'plate', label: 'Plates' },
  { key: 'bumper', label: 'Bumper plates' },
  { key: 'dumbbell', label: 'Dumbbells' },
  { key: 'kettlebell', label: 'Kettlebells' },
  { key: 'bar', label: 'Bars' },
  { key: 'collar', label: 'Collars' },
  { key: 'other', label: 'Other' },
];

// sign: +1 adds stock, -1 takes it out, 0 = the user chooses (adjustment).
export const MOVE_REASONS = [
  { key: 'received', label: 'Received', sign: 1 },
  { key: 'sold', label: 'Sold', sign: -1 },
  { key: 'adjustment', label: 'Adjustment (stocktake)', sign: 0 },
  { key: 'damaged', label: 'Damaged / written off', sign: -1 },
  { key: 'returned', label: 'Returned', sign: 1 },
];

// Common weight ladders offered when adding a line — editable before saving.
export const LADDERS = {
  plate: [1.25, 2.5, 5, 10, 15, 20, 25],
  bumper: [5, 10, 15, 20, 25],
  dumbbell: Array.from({ length: 20 }, (_, i) => (i + 1) * 2.5),
  kettlebell: [4, 6, 8, 10, 12, 16, 20, 24, 28, 32],
};

export const categoryLabel = (key) => FREE_WEIGHT_CATEGORIES.find((c) => c.key === key)?.label || 'Other';

/** "1.25 kg", "20 kg". */
export function formatKg(w) {
  const n = Number(w);
  return `${Number.isFinite(n) ? String(Math.round(n * 100) / 100) : '—'} kg`;
}

/** AUD, GST-inclusive as stored: "$1,795" for whole dollars, "$12.50" otherwise. */
export function formatAud(v) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const whole = Math.abs(n - Math.round(n)) < 0.005;
  return `$${n.toLocaleString('en-AU', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 })}`;
}

/** 'out' (0 on hand) · 'low' (at or below the reorder level) · 'ok'. */
export function stockStatus(v) {
  const stock = Number(v?.stock) || 0;
  if (stock <= 0) return 'out';
  if (v?.reorder_level != null && stock <= Number(v.reorder_level)) return 'low';
  return 'ok';
}

const liveVariants = (p) => (p.variants || []).filter((v) => v.active !== false);

function searchText(p) {
  const weights = liveVariants(p).map((v) => {
    const kg = String(Math.round(Number(v.weight_kg) * 100) / 100);
    return `${kg}kg ${kg} ${v.sku || ''}`;
  });
  return `${p.brand} ${p.name} ${categoryLabel(p.category)} ${weights.join(' ')}`.toLowerCase();
}

/** Search (every word must match brand / name / category / a weight like "20kg"), category, low stock. */
export function filterProducts(products, { term = '', category = '', lowOnly = false } = {}) {
  // "10 kg" → "10kg" so a weight typed with a space still matches.
  const words = String(term).toLowerCase().replace(/(\d)\s+kg\b/g, '$1kg').split(/\s+/).filter(Boolean);
  return (products || []).filter((p) => {
    if (category && p.category !== category) return false;
    if (lowOnly && !liveVariants(p).some((v) => stockStatus(v) !== 'ok')) return false;
    if (!words.length) return true;
    const text = searchText(p);
    return words.every((w) => text.includes(w));
  });
}

// Always quote; a leading = + - @ would run as a spreadsheet formula, so prefix a quote mark.
function cell(v) {
  if (v === null || v === undefined) return '""';
  let s = String(v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
const fixed2 = (v) => (v === null || v === undefined || v === '' ? '' : Number(v).toFixed(2));

/** One CSV row per weight. Unit cost only when the caller may see it; unknown cost stays blank. */
export function buildCsv(products, { canSeeCost = false } = {}) {
  const head = ['Brand', 'Product', 'Category', 'Weight (kg)', 'SKU', 'On hand', 'Price (inc GST)', 'Reorder level'];
  if (canSeeCost) head.push('Unit cost');
  const lines = [head.map(cell).join(',')];
  for (const p of products || []) {
    for (const v of liveVariants(p)) {
      const row = [p.brand, p.name, categoryLabel(p.category), Math.round(Number(v.weight_kg) * 100) / 100, v.sku || '',
        Number(v.stock) || 0, fixed2(v.price), v.reorder_level ?? ''];
      if (canSeeCost) row.push(fixed2(v.unit_cost));
      lines.push(row.map(cell).join(','));
    }
  }
  return lines.join('\r\n');
}

/** "1.25, 2.5 ,5;10 kg" → [1.25, 2.5, 5, 10]; bad or repeated entries dropped. */
export function parseWeightList(text) {
  const out = [];
  for (const part of String(text || '').split(/[,;\n]+/)) {
    const n = Number(part.replace(/kg/i, '').trim());
    if (part.trim() && Number.isFinite(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}
