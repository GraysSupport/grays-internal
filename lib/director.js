// lib/director.js — G22 Director's View (owner, 29 Oct 2026). This file = G22a, sales team
// performance; later phases (products/profit, deliveries, overview) add resources here.
//
//   GET /api/director?resource=sales&from=YYYY-MM-DD&to=YYYY-MM-DD[&compare=1]
//   GET /api/director?resource=sales-workorders&salesperson=XX&from=…&to=…
//
// Routed from api/[...path].js (no new serverless function).
//
// SUPERADMIN ONLY, checked here on every request from the signed login token — the dashboard
// button is display only. READ-ONLY BY CONSTRUCTION: every request runs inside
// `BEGIN TRANSACTION READ ONLY`, so Postgres itself refuses any write; the statements are
// SELECT / WITH only (scripts/ops-director-smoke.mjs proves both).
//
// Money is AUD, GST-inclusive as stored. A workorder is "in the period" by date_created
// (the connection runs in Australia/Melbourne, so `$1::date` is Melbourne midnight).
// Data facts this is built around (dev snapshot, 29–30 Oct 2026):
//  - line value = quantity × COALESCE(selling_price, custom_unit_price, product.price);
//    selling_price is per unit. Lines priced from product.price are "estimated".
//  - cost = average lot unit_cost, else product.avg_cost — and 0 means NOT SET (708 of 1,006
//    products store 0), so both go through NULLIF(…, 0). Unknown cost is never treated as zero:
//    profit is only over lines with a cost, and the coverage block says how many.
//  - invoice_id is not unique across workorders → invoices = COUNT(DISTINCT invoice_id).
//  - "completed" time = first WORKORDER_COMPLETED log entry (there is no completed_at column).
//  - Customer Collect is a delivery_type, excluded from delivery figures; "free" = charged $0.

import { requireRoles } from './rbac.js';

const MAX_RANGE_DAYS = 5 * 366;
const DAY_MS = 86400000;

// The workorders in the period + their live (not Canceled) lines, priced and costed.
const PERIOD_CTES = `
  wo AS (
    SELECT w.workorder_id, w.invoice_id, w.salesperson, w.status, w.date_created, w.estimated_completion,
           COALESCE(w.outstanding_balance, 0) AS outstanding_balance, COALESCE(w.ecommerce, false) AS ecommerce
      FROM workorder w
     WHERE w.date_created >= $1::date AND w.date_created < $2::date
  ),
  lines AS (
    SELECT i.workorder_id, COALESCE(i.quantity, 0) AS qty,
           COALESCE(i.selling_price, i.custom_unit_price, p.price) AS unit_price,
           CASE WHEN i.selling_price IS NOT NULL OR i.custom_unit_price IS NOT NULL THEN 'order'
                WHEN p.price IS NOT NULL THEN 'list' ELSE 'none' END AS price_source,
           COALESCE(lc.unit_cost, NULLIF(p.avg_cost, 0)) AS unit_cost
      FROM workorder_items i
      JOIN wo ON wo.workorder_id = i.workorder_id
      LEFT JOIN product p ON p.sku = i.product_id
      LEFT JOIN LATERAL (
        SELECT avg(NULLIF(pl.unit_cost, 0)) AS unit_cost
          FROM product_lots pl
         WHERE pl.workorder_items_id = i.workorder_items_id
      ) lc ON true
     WHERE i.status IS DISTINCT FROM 'Canceled'
  )`;

const SALES_SUMMARY = `
  WITH ${PERIOD_CTES},
  line_sum AS (
    SELECT workorder_id,
           sum(qty) AS units,
           sum(qty * unit_price) AS sales,
           count(*) FILTER (WHERE price_source = 'order') AS priced_lines,
           count(*) FILTER (WHERE price_source = 'list') AS estimated_lines,
           count(*) FILTER (WHERE price_source = 'none') AS unpriced_lines,
           count(*) FILTER (WHERE unit_cost IS NOT NULL AND unit_price IS NOT NULL) AS costed_lines,
           sum(qty * unit_price) FILTER (WHERE unit_cost IS NOT NULL) AS costed_sales,
           sum(qty * unit_cost) FILTER (WHERE unit_cost IS NOT NULL AND unit_price IS NOT NULL) AS cogs
      FROM lines
     GROUP BY workorder_id
  ),
  del AS (
    SELECT d.workorder_id,
           count(*) AS jobs,
           sum(COALESCE(d.delivery_charged, 0)) AS charged,
           sum(COALESCE(d.delivery_quoted, 0)) AS carrier_cost,
           count(*) FILTER (WHERE d.delivery_charged = 0) AS free_jobs,
           sum(COALESCE(d.delivery_quoted, 0)) FILTER (WHERE d.delivery_charged = 0) AS free_cost,
           count(*) FILTER (WHERE d.delivery_charged IS NULL) AS jobs_no_charge,
           count(*) FILTER (WHERE d.delivery_quoted IS NULL) AS jobs_no_cost
      FROM delivery d
      JOIN wo ON wo.workorder_id = d.workorder_id
     WHERE d.delivery_type IS DISTINCT FROM 'Customer Collect'
     GROUP BY d.workorder_id
  ),
  done AS (
    SELECT l.workorder_id, min(l.created_at) AS completed_at
      FROM workorder_logs l
      JOIN wo ON wo.workorder_id = l.workorder_id
     WHERE l.event_type = 'WORKORDER_COMPLETED'
     GROUP BY l.workorder_id
  )
  SELECT wo.salesperson, u.name AS salesperson_name,
         count(*) AS workorders,
         count(*) FILTER (WHERE wo.status = 'Work Ordered') AS open,
         count(*) FILTER (WHERE wo.status = 'Completed') AS completed,
         count(DISTINCT wo.invoice_id) AS invoices,
         COALESCE(sum(ls.units), 0) AS units,
         round(COALESCE(sum(ls.sales), 0), 2) AS sales,
         COALESCE(sum(ls.priced_lines), 0) AS priced_lines,
         COALESCE(sum(ls.estimated_lines), 0) AS estimated_lines,
         COALESCE(sum(ls.unpriced_lines), 0) AS unpriced_lines,
         COALESCE(sum(ls.costed_lines), 0) AS costed_lines,
         round(COALESCE(sum(ls.costed_sales), 0), 2) AS costed_sales,
         round(COALESCE(sum(ls.cogs), 0), 2) AS cogs,
         COALESCE(sum(del.jobs), 0) AS delivery_jobs,
         round(COALESCE(sum(del.charged), 0), 2) AS delivery_charged,
         round(COALESCE(sum(del.carrier_cost), 0), 2) AS carrier_cost,
         COALESCE(sum(del.free_jobs), 0) AS free_jobs,
         round(COALESCE(sum(del.free_cost), 0), 2) AS free_cost,
         COALESCE(sum(del.jobs_no_cost), 0) AS jobs_no_cost,
         COALESCE(sum(del.jobs_no_charge), 0) AS jobs_no_charge,
         round(COALESCE(sum(wo.outstanding_balance) FILTER (WHERE wo.status = 'Work Ordered'), 0), 2) AS outstanding,
         count(done.completed_at) FILTER (WHERE wo.status = 'Completed') AS completed_timed,
         round(avg(EXTRACT(EPOCH FROM (done.completed_at - wo.date_created)) / 86400) FILTER (WHERE wo.status = 'Completed'), 1) AS avg_days,
         count(*) FILTER (WHERE wo.status = 'Completed' AND done.completed_at IS NOT NULL AND wo.estimated_completion IS NOT NULL) AS on_time_eligible,
         count(*) FILTER (WHERE wo.status = 'Completed' AND done.completed_at IS NOT NULL AND wo.estimated_completion IS NOT NULL
                            AND done.completed_at::date <= wo.estimated_completion) AS on_time,
         count(*) FILTER (WHERE wo.ecommerce) AS ecommerce
    FROM wo
    LEFT JOIN line_sum ls ON ls.workorder_id = wo.workorder_id
    LEFT JOIN del ON del.workorder_id = wo.workorder_id
    LEFT JOIN done ON done.workorder_id = wo.workorder_id
    LEFT JOIN users u ON u.id = wo.salesperson
   GROUP BY wo.salesperson, u.name
   ORDER BY sales DESC
`;

const SALES_MONTHLY = `
  WITH ${PERIOD_CTES}
  SELECT wo.salesperson, to_char(date_trunc('month', wo.date_created), 'YYYY-MM') AS month,
         round(COALESCE(sum(lines.qty * lines.unit_price), 0), 2) AS sales
    FROM lines
    JOIN wo ON wo.workorder_id = lines.workorder_id
   GROUP BY wo.salesperson, 2
   ORDER BY 2
`;

// The company-wide invoice count: one invoice can sit on workorders of two salespeople, so the
// total is its own DISTINCT count, not the sum of the per-person counts.
const SALES_INVOICES = `
  SELECT count(DISTINCT w.invoice_id) AS invoices
    FROM workorder w
   WHERE w.date_created >= $1::date AND w.date_created < $2::date
`;

const SALES_WORKORDERS = `
  SELECT w.workorder_id, w.invoice_id, w.date_created, w.status, w.outstanding_balance,
         (SELECT round(COALESCE(sum(COALESCE(i.quantity, 0) * COALESCE(i.selling_price, i.custom_unit_price, p.price)), 0), 2)
            FROM workorder_items i
            LEFT JOIN product p ON p.sku = i.product_id
           WHERE i.workorder_id = w.workorder_id AND i.status IS DISTINCT FROM 'Canceled') AS sales
    FROM workorder w
   WHERE w.salesperson = $3 AND w.date_created >= $1::date AND w.date_created < $2::date
   ORDER BY w.date_created DESC
   LIMIT 500
`;

class BadRequest extends Error {}

/* ---------- periods ---------- */
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
function toUtcDate(s) {
  const m = ISO.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  // Reject roll-overs like 2025-02-30 → 2 Mar.
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? d : null;
}
const iso = (d) => d.toISOString().slice(0, 10);

/** from + inclusive to (YYYY-MM-DD) → { from, toExclusive }. Throws BadRequest. */
export function parseRange(from, to) {
  const f = toUtcDate(from);
  const t = toUtcDate(to);
  if (!f || !t) throw new BadRequest('from and to must be dates (YYYY-MM-DD)');
  if (t < f) throw new BadRequest('to must be on or after from');
  const days = (t - f) / DAY_MS + 1;
  if (days > MAX_RANGE_DAYS) throw new BadRequest('The period can be at most 5 years');
  return { from: iso(f), toExclusive: iso(new Date(t.getTime() + DAY_MS)) };
}

/** The same-length period immediately before. */
export function previousPeriod({ from, toExclusive }) {
  const f = toUtcDate(from);
  const len = toUtcDate(toExclusive) - f;
  return { from: iso(new Date(f.getTime() - len)), toExclusive: from };
}
/** The same dates one year earlier — "FY to date" vs "last FY to the same date". 29 Feb → 28 Feb. */
export function previousYear({ from, toExclusive }) {
  const back = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return toUtcDate(`${y - 1}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`) ? `${y - 1}-${s.slice(5)}` : `${y - 1}-02-28`;
  };
  return { from: back(from), toExclusive: back(toExclusive) };
}
const inclusiveTo = (toExclusive) => iso(new Date(toUtcDate(toExclusive).getTime() - DAY_MS));

/* ---------- shaping ---------- */
const n = (v) => (v === null || v === undefined ? null : Number(v));
const money = (v) => Math.round(v * 100) / 100;
const ratio = (a, b) => (b > 0 ? Math.round((a / b) * 10000) / 10000 : null);

const SUM_FIELDS = ['workorders', 'open', 'completed', 'invoices', 'units', 'sales', 'priced_lines', 'estimated_lines',
  'unpriced_lines', 'costed_lines', 'costed_sales', 'cogs', 'delivery_jobs', 'delivery_charged', 'carrier_cost',
  'free_jobs', 'free_cost', 'jobs_no_cost', 'jobs_no_charge', 'outstanding', 'completed_timed', 'on_time_eligible', 'on_time', 'ecommerce'];

function derive(s) {
  const out = { ...s };
  out.aov = s.workorders > 0 ? money(s.sales / s.workorders) : null;
  out.gross_profit = s.costed_lines > 0 ? money(s.costed_sales - s.cogs) : null;
  out.margin = s.costed_lines > 0 ? ratio(s.costed_sales - s.cogs, s.costed_sales) : null;
  out.delivery_net = money(s.delivery_charged - s.carrier_cost);
  out.on_time_pct = ratio(s.on_time, s.on_time_eligible);
  out.ecommerce_share = ratio(s.ecommerce, s.workorders);
  return out;
}

export function shapeSales(rows, invoiceRows = null) {
  const salespeople = rows.map((r) => {
    const s = { salesperson: r.salesperson ?? null, salesperson_name: r.salesperson_name || r.salesperson || 'Unassigned' };
    for (const f of SUM_FIELDS) s[f] = n(r[f]) ?? 0;
    s.avg_days = n(r.avg_days);
    return derive(s);
  }).sort((a, b) => b.sales - a.sales);

  const t = Object.fromEntries(SUM_FIELDS.map((f) => [f, 0]));
  let dayWeight = 0;
  for (const s of salespeople) {
    for (const f of SUM_FIELDS) t[f] += s[f];
    if (s.avg_days != null) dayWeight += s.avg_days * s.completed_timed;
  }
  for (const f of ['sales', 'costed_sales', 'cogs', 'delivery_charged', 'carrier_cost', 'free_cost', 'outstanding']) t[f] = money(t[f]);
  t.avg_days = t.completed_timed > 0 ? Math.round((dayWeight / t.completed_timed) * 10) / 10 : null;
  if (invoiceRows?.length) t.invoices = n(invoiceRows[0].invoices) ?? t.invoices;
  const totals = derive(t);
  const coverage = {
    lines: t.priced_lines + t.estimated_lines + t.unpriced_lines,
    priced_lines: t.priced_lines, estimated_lines: t.estimated_lines, unpriced_lines: t.unpriced_lines,
    costed_lines: t.costed_lines,
    workorders: t.workorders, completed: t.completed, completed_timed: t.completed_timed,
    delivery_jobs: t.delivery_jobs, jobs_no_cost: t.jobs_no_cost, jobs_no_charge: t.jobs_no_charge, ecommerce: t.ecommerce,
  };
  return { salespeople, totals, coverage };
}

function shapeMonthly(rows) {
  const out = {};
  for (const r of rows) {
    if (!out[r.salesperson]) out[r.salesperson] = {};
    out[r.salesperson][r.month] = n(r.sales) ?? 0;
  }
  return out;
}

/* ---------- read-only runner ---------- */
async function readOnly(client, work) {
  await client.query('BEGIN TRANSACTION READ ONLY');
  try {
    const out = await work();
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

export async function handleDirector(req, res, client) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const gate = requireRoles(req, ['superadmin']);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  const q = req.query || {};
  const resource = String(q.resource || '');
  let range;
  try {
    if (resource !== 'sales' && resource !== 'sales-workorders') throw new BadRequest("Unknown Director's View request");
    range = parseRange(q.from, q.to);
    if (resource === 'sales-workorders' && !/^[A-Za-z0-9]{1,2}$/.test(String(q.salesperson || ''))) {
      throw new BadRequest('salesperson must be a user id');
    }
  } catch (err) {
    if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
    throw err;
  }

  const echo = (r) => ({ from: r.from, to: inclusiveTo(r.toExclusive) });
  // Cached only on success — an error must not stick for five minutes.
  const ok = (body) => {
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.status(200).json(body);
  };

  if (resource === 'sales-workorders') {
    const salesperson = String(q.salesperson).toUpperCase();
    const rows = await readOnly(client, async () => (await client.query(SALES_WORKORDERS, [range.from, range.toExclusive, salesperson])).rows);
    return ok({
      range: echo(range), salesperson,
      workorders: rows.map((w) => ({
        workorder_id: w.workorder_id, invoice_id: w.invoice_id, date_created: w.date_created, status: w.status,
        outstanding_balance: n(w.outstanding_balance) ?? 0, sales: n(w.sales) ?? 0,
      })),
    });
  }

  // compare=year: the same dates a year earlier (FY / calendar year to date — like-for-like).
  // compare=1: the same-length period immediately before (custom ranges, last 12 months).
  const mode = q.compare === 'year' ? 'year' : (q.compare === '1' || q.compare === 'true') ? 'previous' : null;
  const prev = mode === 'year' ? previousYear(range) : mode === 'previous' ? previousPeriod(range) : null;
  const out = await readOnly(client, async () => {
    const summary = await client.query(SALES_SUMMARY, [range.from, range.toExclusive]);
    const invoices = await client.query(SALES_INVOICES, [range.from, range.toExclusive]);
    const monthly = await client.query(SALES_MONTHLY, [range.from, range.toExclusive]);
    let previous = null;
    if (prev) {
      previous = {
        summary: (await client.query(SALES_SUMMARY, [prev.from, prev.toExclusive])).rows,
        invoices: (await client.query(SALES_INVOICES, [prev.from, prev.toExclusive])).rows,
      };
    }
    return { summary: summary.rows, invoices: invoices.rows, monthly: monthly.rows, previous };
  });
  return ok({
    range: echo(range),
    ...shapeSales(out.summary, out.invoices),
    monthly: shapeMonthly(out.monthly),
    previous: prev ? { mode, range: echo(prev), ...shapeSales(out.previous.summary, out.previous.invoices) } : null,
  });
}
