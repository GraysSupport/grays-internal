// G8 (Nick, 28 Sep 2026) — the pure logic behind the TEMPORARY delivery run planner.
//
// A temporary run is a planning draft: which stops go on which run, in what order, with a
// carrier and a planned day, so logistics can send drivers a run sheet BEFORE anything is
// booked. It is deliberately browser-only — there is no table and no write endpoint, so
// nothing here can change a workorder, item, delivery or log row. The plan survives a refresh
// via localStorage and is wiped by "Clear run".
//
// Every function returns a NEW plan (never mutates) so it can be dropped straight into React
// state. Stops are snapshotted when added: the printed sheet stays stable even if the source
// list changes underneath it.

export const PLAN_STORAGE_KEY = 'grays.tempDeliveryRun.v1';

let seq = 0;
function newRunId() {
  seq += 1;
  return `run-${Date.now().toString(36)}-${seq}`;
}

export function emptyPlan() {
  return { runs: [{ id: newRunId(), carrier: '', day: '', stops: [] }], stops: {} };
}

// "1.00 × Treadmill" → "1 × Treadmill"; "2.50 ×" → "2.5 ×". Postgres numeric quantities
// arrive with trailing zeros from the items_text aggregate.
function tidyQuantities(text) {
  return String(text ?? '').replace(/\b(\d+)\.(\d*?)0+(?=\s*×)/g, (_, int, frac) => (frac ? `${int}.${frac}` : int));
}

/** Snapshot a candidate row (from GET /api/logistics?resource=run-candidates) as a stop. */
export function toStop(row, source) {
  const isDelivery = source === 'delivery';
  return {
    key: isDelivery ? `D-${row.delivery_id}` : `W-${row.workorder_id}`,
    source: isDelivery ? 'delivery' : 'workorder',
    delivery_id: isDelivery ? row.delivery_id : null,
    workorder_id: row.workorder_id ?? null,
    invoice_id: row.invoice_id ?? '',
    customer_name: row.customer_name ?? '',
    phone: row.customer_phone ?? '',
    address: row.customer_address ?? '',
    suburb: row.delivery_suburb ?? '',
    state: row.delivery_state ?? '',
    delivery_type: isDelivery ? (row.delivery_type ?? '') : '',
    items_text: tidyQuantities(row.items_text || '—'),
    // Only a DELIVERY's notes are delivery instructions. A workorder's notes field is the
    // general internal notes box (balances, chasing, pricing) — shown on screen for context
    // but never printed or exported to a driver, who may work for a third-party carrier.
    notes: isDelivery ? (row.notes ?? '') : '',
    internal_notes: isDelivery ? '' : (row.notes ?? ''),
  };
}

const SNAPSHOT_FIELDS = ['invoice_id', 'customer_name', 'phone', 'address', 'suburb', 'state', 'delivery_type', 'items_text', 'notes', 'internal_notes'];

/**
 * Refresh planned stops' snapshots from the latest live candidates (e.g. a corrected phone
 * number), keeping every run's order. Stops that are no longer live keep their snapshot.
 * Returns the SAME plan object when nothing changed, so React doesn't re-render or re-save.
 */
export function refreshStops(plan, liveStops) {
  let changed = false;
  const stops = { ...plan.stops };
  for (const live of liveStops) {
    const cur = stops[live.key];
    if (!cur) continue;
    if (SNAPSHOT_FIELDS.some((f) => (cur[f] ?? '') !== (live[f] ?? ''))) {
      stops[live.key] = { ...cur, ...live };
      changed = true;
    }
  }
  return changed ? { ...plan, stops } : plan;
}

function mapRun(plan, runId, fn) {
  return { ...plan, runs: plan.runs.map((r) => (r.id === runId ? fn(r) : r)) };
}

/** Every stop key currently on any run. */
export function plannedKeys(plan) {
  return new Set(plan.runs.flatMap((r) => r.stops));
}

export function addRun(plan) {
  return { ...plan, runs: [...plan.runs, { id: newRunId(), carrier: '', day: '', stops: [] }] };
}

export function updateRun(plan, runId, patch) {
  return mapRun(plan, runId, (r) => ({ ...r, ...patch }));
}

/** Remove a run and free its stops. The last remaining run is never removed. */
export function removeRun(plan, runId) {
  if (plan.runs.length <= 1) return plan;
  const run = plan.runs.find((r) => r.id === runId);
  if (!run) return plan;
  const stops = { ...plan.stops };
  run.stops.forEach((k) => { delete stops[k]; });
  return { runs: plan.runs.filter((r) => r.id !== runId), stops };
}

/** Add a stop to a run. A stop already on ANY run is left where it is (one customer, one stop). */
export function addStop(plan, runId, stop) {
  if (!stop?.key || plannedKeys(plan).has(stop.key)) return plan;
  if (!plan.runs.some((r) => r.id === runId)) return plan;
  const next = mapRun(plan, runId, (r) => ({ ...r, stops: [...r.stops, stop.key] }));
  return { ...next, stops: { ...plan.stops, [stop.key]: stop } };
}

export function removeStop(plan, runId, key) {
  const next = mapRun(plan, runId, (r) => ({ ...r, stops: r.stops.filter((k) => k !== key) }));
  const stops = { ...plan.stops };
  delete stops[key];
  return { ...next, stops };
}

/** Move the stop at index `from` to index `to` within one run. Out-of-range moves are no-ops. */
export function moveStop(plan, runId, from, to) {
  return mapRun(plan, runId, (r) => {
    if (from < 0 || from >= r.stops.length || to < 0 || to >= r.stops.length || from === to) return r;
    const stops = [...r.stops];
    const [k] = stops.splice(from, 1);
    stops.splice(to, 0, k);
    return { ...r, stops };
  });
}

/* ------------------------------- day formatting ------------------------------- */

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-02" → "Fri 2 Oct 2026". Parsed as a calendar date (UTC) so no timezone drift. */
export function formatRunDay(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/* ------------------------------------ CSV ------------------------------------ */

const PHONE_LIKE = /^[+\d\s()-]+$/;

// Quote when needed, and neutralise spreadsheet formula injection: free text (customer names,
// notes) opening with = + - @ would otherwise execute when a driver opens the CSV in Excel.
// Phone numbers ("+61 …") are exempt so they arrive intact.
function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s) && !PHONE_LIKE.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

// "Customer address" is the customer record's address; the delivery itself only carries a
// suburb + state. They usually agree but can differ, so they are never merged into one line.
const CSV_HEADERS = ['Run', 'Carrier', 'Day', 'Stop', 'Customer', 'Phone', 'Customer address', 'Delivery suburb', 'State', 'Type', 'Items', 'WO', 'Invoice', 'Notes'];

export function buildCsv(plan) {
  const lines = [CSV_HEADERS.join(',')];
  plan.runs.forEach((run, ri) => {
    run.stops.forEach((key, si) => {
      const s = plan.stops[key];
      if (!s) return;
      lines.push([
        ri + 1, run.carrier, run.day, si + 1, s.customer_name, s.phone, s.address,
        s.suburb, s.state, s.delivery_type, s.items_text, s.workorder_id ?? '', s.invoice_id, s.notes,
      ].map(csvCell).join(','));
    });
  });
  return `${lines.join('\r\n')}\r\n`;
}

/* -------------------------------- print sheet -------------------------------- */

function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

/** A printable, brand-styled run sheet (Brand Red #B50B1D, Inter, sales phone in the footer). */
export function buildRunSheetHtml(plan, printedAt = new Date()) {
  const runs = plan.runs
    .map((run, ri) => ({ run, ri }))
    .filter(({ run }) => run.stops.some((k) => plan.stops[k]));

  const body = runs.map(({ run, ri }) => {
    const rows = run.stops.map((k, si) => {
      const s = plan.stops[k];
      if (!s) return '';
      const suburb = [s.suburb, s.state].filter(Boolean).join(' ');
      return `<tr>
        <td class="n">${si + 1}</td>
        <td><strong>${esc(s.customer_name)}</strong><br>${esc(s.phone) || '—'}</td>
        <td>${esc(suburb) || '—'}</td>
        <td>${s.delivery_type ? `<span class="type">${esc(s.delivery_type)}</span><br>` : ''}${esc(s.items_text)}</td>
        <td>${s.workorder_id != null ? `WO ${esc(s.workorder_id)}` : ''}${s.invoice_id ? `<br>Inv ${esc(s.invoice_id)}` : ''}</td>
        <td>${esc(s.notes)}</td>
      </tr>`;
    }).join('');
    const title = [`Run ${ri + 1}`, run.carrier, formatRunDay(run.day)].filter(Boolean).map(esc).join(' · ');
    return `<section class="run">
      <h2>${title}</h2>
      <table>
        <thead><tr><th>#</th><th>Customer / phone</th><th>Suburb</th><th>Items</th><th>Ref</th><th>Notes</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
  }).join('');

  const printed = printedAt.toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' });

  return `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8" />
<title>Temporary delivery run</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet" />
<style>
  @media print { @page { size: A4 landscape; margin: 8mm; } }
  body { font-family: 'Inter', system-ui, sans-serif; color: #111; margin: 0; }
  header { border-bottom: 4px solid #B50B1D; padding: 0 0 8px; margin-bottom: 12px; }
  h1 { margin: 0; font-size: 20px; }
  .draft { display: inline-block; margin-top: 4px; padding: 2px 8px; border: 1px solid #B50B1D; color: #B50B1D; font-weight: 700; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  .meta { font-size: 11px; color: #555; margin-top: 4px; }
  h2 { font-size: 15px; margin: 16px 0 6px; color: #B50B1D; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ccc; padding: 6px 8px; font-size: 12px; vertical-align: top; text-align: left; }
  th { background: #f3f4f6; }
  td.n { width: 24px; font-weight: 700; text-align: center; }
  .type { font-weight: 700; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  thead { display: table-header-group; }
  footer { margin-top: 16px; padding-top: 6px; border-top: 1px solid #ddd; font-size: 11px; color: #333; }
</style>
</head>
<body>
  <header>
    <h1>Grays Fitness — delivery run sheet</h1>
    <div class="draft">Temporary run — not booked</div>
    <div class="meta">Planning draft only. Times and stops may change until the deliveries are booked. Printed ${esc(printed)}.</div>
  </header>
  ${body || '<p>No stops on this run yet.</p>'}
  <footer>Grays Fitness · <strong>1300 769 556</strong> · graysfitness.com.au</footer>
  <script>
    // Wait for Inter: web fonts aren't guaranteed to be ready at onload.
    window.onload = () => {
      const ready = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
      ready.then(() => window.print());
    };
  </script>
</body>
</html>`;
}

/* ------------------------------ browser storage ------------------------------ */

// Normalise a saved plan: drop stop keys with no snapshot and keys repeated across runs (a
// damaged entry would otherwise misalign the reorder indices), and default text fields so the
// inputs stay controlled. Anything unrecognisable falls back to an empty plan.
function normalisePlan(p) {
  if (!p || !Array.isArray(p.runs) || !p.runs.length || !p.stops || typeof p.stops !== 'object') return null;
  const seen = new Set();
  const runs = [];
  for (const r of p.runs) {
    if (!r || typeof r.id !== 'string' || !Array.isArray(r.stops)) return null;
    const stops = r.stops.filter((k) => {
      if (typeof k !== 'string' || !p.stops[k] || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    runs.push({
      id: r.id,
      carrier: typeof r.carrier === 'string' ? r.carrier : '',
      day: typeof r.day === 'string' ? r.day : '',
      stops,
    });
  }
  const stops = {};
  seen.forEach((k) => { stops[k] = p.stops[k]; });
  return { runs, stops };
}

export function loadPlan() {
  try {
    const raw = localStorage.getItem(PLAN_STORAGE_KEY);
    return normalisePlan(raw ? JSON.parse(raw) : null) || emptyPlan();
  } catch {
    return emptyPlan();
  }
}

export function savePlan(plan) {
  try { localStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify(plan)); } catch { /* private window / quota — the draft just won't survive a refresh */ }
}

export function clearPlan() {
  try { localStorage.removeItem(PLAN_STORAGE_KEY); } catch { /* ignore */ }
}
