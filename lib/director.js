// lib/director.js — G22 Director's View (owner, 29 Oct 2026). This file = G22a, sales team
// performance; later phases (products/profit, deliveries, overview) add resources here.
//
//   GET /api/director?resource=sales&from=YYYY-MM-DD&to=YYYY-MM-DD[&compare=1]
//   GET /api/director?resource=sales-workorders&salesperson=XX&from=…&to=…
//   GET /api/director?resource=products&from=…&to=…[&compare=year|1]     (G22b)
//   GET /api/director?resource=deliveries&from=…&to=…[&compare=year|1]   (G22c)
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
       AND w.status::text <> 'Cancelled' -- G23: a cancelled sale is not a sale
  ),
  lines AS (
    SELECT i.workorder_id, i.product_id AS sku, p.name AS product_name, p.brand, i.condition,
           COALESCE(i.quantity, 0) AS qty,
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

/* ---------- G22b: products sold, earnings and profit ---------- */
const PRODUCTS_BY_SKU = `
  WITH ${PERIOD_CTES}
  SELECT lines.sku, max(lines.product_name) AS name, max(lines.brand) AS brand,
         sum(lines.qty) AS units,
         round(COALESCE(sum(lines.qty * lines.unit_price), 0), 2) AS revenue,
         round(COALESCE(sum(lines.qty * lines.unit_price) FILTER (WHERE lines.unit_cost IS NOT NULL), 0), 2) AS costed_revenue,
         round(COALESCE(sum(lines.qty * lines.unit_cost) FILTER (WHERE lines.unit_cost IS NOT NULL AND lines.unit_price IS NOT NULL), 0), 2) AS cogs,
         count(*) AS lines,
         count(*) FILTER (WHERE lines.unit_cost IS NOT NULL AND lines.unit_price IS NOT NULL) AS costed_lines,
         count(*) FILTER (WHERE lines.price_source = 'order') AS priced_lines,
         count(*) FILTER (WHERE lines.price_source = 'list') AS estimated_lines,
         count(*) FILTER (WHERE lines.price_source = 'none') AS unpriced_lines
    FROM lines
   GROUP BY lines.sku
`;

const PRODUCTS_CONDITIONS = `
  WITH ${PERIOD_CTES}
  SELECT COALESCE(lines.condition::text, 'Not set') AS condition_code,
         sum(lines.qty) AS units,
         round(COALESCE(sum(lines.qty * lines.unit_price), 0), 2) AS revenue,
         count(*) AS lines
    FROM lines
   GROUP BY 1
   ORDER BY 3 DESC
`;

// All time (not the period): units + revenue per Australian financial year (FY2026 = Jul 2025 – Jun 2026).
const PRODUCTS_BY_FY = `
  SELECT (extract(year FROM w.date_created) + CASE WHEN extract(month FROM w.date_created) >= 7 THEN 1 ELSE 0 END)::int AS fy,
         sum(COALESCE(i.quantity, 0)) AS units,
         round(COALESCE(sum(COALESCE(i.quantity, 0) * COALESCE(i.selling_price, i.custom_unit_price, p.price)), 0), 2) AS revenue,
         count(*) AS lines,
         count(*) FILTER (WHERE i.selling_price IS NOT NULL OR i.custom_unit_price IS NOT NULL) AS priced_lines,
         bool_or(now() < make_date((extract(year FROM w.date_created) + CASE WHEN extract(month FROM w.date_created) >= 7 THEN 1 ELSE 0 END)::int, 7, 1)) AS is_current
    FROM workorder w
    JOIN workorder_items i ON i.workorder_id = w.workorder_id
    LEFT JOIN product p ON p.sku = i.product_id
   WHERE i.status IS DISTINCT FROM 'Canceled'
   GROUP BY 1
   ORDER BY 1
`;

// Stock on hand today. Negative stock (data errors) is left out and counted.
const PRODUCTS_STOCK = `
  SELECT count(*) FILTER (WHERE stock > 0) AS products,
         COALESCE(sum(stock) FILTER (WHERE stock > 0), 0) AS units,
         COALESCE(sum(stock) FILTER (WHERE stock > 0 AND avg_cost > 0), 0) AS units_costed,
         round(COALESCE(sum(stock * avg_cost) FILTER (WHERE stock > 0 AND avg_cost > 0), 0), 2) AS value_cost,
         COALESCE(sum(stock) FILTER (WHERE stock > 0 AND price IS NOT NULL), 0) AS units_priced,
         round(COALESCE(sum(stock * price) FILTER (WHERE stock > 0 AND price IS NOT NULL), 0), 2) AS value_sell,
         count(*) FILTER (WHERE stock < 0) AS negative
    FROM product
`;

const PRODUCTS_AGED = `
  SELECT count(*) AS in_stock,
         count(*) FILTER (WHERE (now()::date - created_at::date) > 90) AS over90,
         count(*) FILTER (WHERE (now()::date - created_at::date) > 180) AS over180
    FROM product_lots
   WHERE status = 'In Stock'
`;

const PRODUCTS_AGED_LIST = `
  SELECT pl.lot_number, pl.product_sku, p.name, (now()::date - pl.created_at::date) AS age_days
    FROM product_lots pl
    LEFT JOIN product p ON p.sku = pl.product_sku
   WHERE pl.status = 'In Stock' AND (now()::date - pl.created_at::date) > 90
   ORDER BY pl.created_at
   LIMIT 20
`;

// The clean-up worklist: a sell price but no cost, in stock now or sold in the period.
const PRODUCTS_COST_MISSING = `
  SELECT p.sku, p.name, p.brand, p.price, p.stock, count(*) OVER () AS missing_total
    FROM product p
   WHERE p.price > 0 AND NULLIF(p.avg_cost, 0) IS NULL
     AND NOT EXISTS (SELECT 1 FROM product_lots pl WHERE pl.product_sku = p.sku AND NULLIF(pl.unit_cost, 0) IS NOT NULL)
     AND (p.stock > 0 OR EXISTS (
           SELECT 1 FROM workorder_items i JOIN workorder w ON w.workorder_id = i.workorder_id
            WHERE i.product_id = p.sku AND i.status IS DISTINCT FROM 'Canceled'
              AND w.date_created >= $1::date AND w.date_created < $2::date))
   ORDER BY GREATEST(COALESCE(p.stock, 0), 0) * p.price DESC NULLS LAST, p.sku
   LIMIT 100
`;

const RANK = 10;
const CUSTOM_SKU = 'OTHER';

function shapeProductRows(rows) {
  return rows.map((r) => {
    const costed = n(r.costed_lines) ?? 0;
    const costedRevenue = n(r.costed_revenue) ?? 0;
    const cogs = n(r.cogs) ?? 0;
    return {
      sku: r.sku,
      name: r.name || (r.sku === CUSTOM_SKU ? 'Custom / misc items' : r.sku || 'Unknown product'),
      brand: r.brand || (r.sku === CUSTOM_SKU ? 'Custom' : 'No brand'),
      units: n(r.units) ?? 0, revenue: n(r.revenue) ?? 0,
      lines: n(r.lines) ?? 0, costed_lines: costed,
      priced_lines: n(r.priced_lines) ?? 0, estimated_lines: n(r.estimated_lines) ?? 0, unpriced_lines: n(r.unpriced_lines) ?? 0,
      costed_revenue: costedRevenue, cogs,
      gross_profit: costed > 0 ? money(costedRevenue - cogs) : null,
      margin: costed > 0 ? ratio(costedRevenue - cogs, costedRevenue) : null,
    };
  });
}

function productTotals(products) {
  const t = { units: 0, revenue: 0, costed_revenue: 0, cogs: 0, lines: 0, costed_lines: 0, priced_lines: 0, estimated_lines: 0, unpriced_lines: 0 };
  for (const p of products) for (const k of Object.keys(t)) t[k] += p[k];
  for (const k of ['revenue', 'costed_revenue', 'cogs']) t[k] = money(t[k]);
  t.gross_profit = t.costed_lines > 0 ? money(t.costed_revenue - t.cogs) : null;
  t.margin = t.costed_lines > 0 ? ratio(t.costed_revenue - t.cogs, t.costed_revenue) : null;
  return t;
}

function brandRollup(products) {
  const by = new Map();
  for (const p of products) {
    const b = by.get(p.brand) || { brand: p.brand, units: 0, revenue: 0, costed_revenue: 0, cogs: 0, costed_lines: 0, lines: 0 };
    b.units += p.units; b.revenue += p.revenue; b.costed_revenue += p.costed_revenue; b.cogs += p.cogs;
    b.costed_lines += p.costed_lines; b.lines += p.lines;
    by.set(p.brand, b);
  }
  return [...by.values()].map((b) => ({
    brand: b.brand, units: b.units, revenue: money(b.revenue), lines: b.lines, costed_lines: b.costed_lines,
    gross_profit: b.costed_lines > 0 ? money(b.costed_revenue - b.cogs) : null,
  })).sort((a, b) => b.revenue - a.revenue).slice(0, RANK);
}

export function shapeProducts(q) {
  const products = shapeProductRows(q.bySku);
  // Custom (OTHER) lines and lines with no product are in the totals, but they are not a product to rank.
  const ranked = products.filter((p) => p.sku && p.sku !== CUSTOM_SKU);
  const byRevenue = [...ranked].sort((a, b) => b.revenue - a.revenue);
  // Profit is ranked only for products with EVERY line costed — a profit on 1 of 5 lines would mislead.
  const withProfit = ranked.filter((p) => p.lines > 0 && p.costed_lines === p.lines).sort((a, b) => b.gross_profit - a.gross_profit);
  const s = q.stock[0] || {};
  const a = q.aged[0] || {};
  return {
    totals: productTotals(products),
    product_count: ranked.length,
    profit_ranked: withProfit.length,
    top_revenue: byRevenue.slice(0, RANK),
    bottom_revenue: byRevenue.filter((p) => p.revenue > 0).slice(-RANK).reverse(),
    top_profit: withProfit.slice(0, RANK),
    bottom_profit: withProfit.slice(-RANK).reverse(),
    brands: brandRollup(products),
    conditions: q.conditions.map((c) => ({ condition: c.condition_code, units: n(c.units) ?? 0, revenue: n(c.revenue) ?? 0, lines: n(c.lines) ?? 0 })),
    by_fy: q.byFy.map((f) => ({
      fy: Number(f.fy), units: n(f.units) ?? 0, revenue: n(f.revenue) ?? 0,
      lines: n(f.lines) ?? 0, priced_lines: n(f.priced_lines) ?? 0, is_current: f.is_current === true,
    })),
    stock: {
      products: n(s.products) ?? 0, units: n(s.units) ?? 0, units_costed: n(s.units_costed) ?? 0, value_cost: n(s.value_cost) ?? 0,
      units_priced: n(s.units_priced) ?? 0, value_sell: n(s.value_sell) ?? 0, negative: n(s.negative) ?? 0,
    },
    aged: {
      in_stock: n(a.in_stock) ?? 0, over90: n(a.over90) ?? 0, over180: n(a.over180) ?? 0,
      oldest: q.agedList.map((l) => ({ lot_number: l.lot_number, sku: l.product_sku, name: l.name || l.product_sku, age_days: Number(l.age_days) })),
    },
    cost_missing: {
      total: n(q.costMissing[0]?.missing_total) ?? 0,
      items: q.costMissing.map((p) => ({ sku: p.sku, name: p.name, brand: p.brand, price: n(p.price) ?? 0, stock: Number(p.stock) || 0 })),
    },
  };
}

/* ---------- G22c: deliveries & removalists (live version of the 22 Sep 2026 rate-card review) ---------- */
// Delivery jobs in the period. A job is in the period by its delivery date, else its created date.
// Pickups are not carrier jobs: Customer Collect is a delivery_type, but it also appears as a
// delivery_state value AND as a removalist named "Customer Collect" (84 jobs on dev) — all three
// are excluded (and counted for the coverage line). A carrier cost of 0 means "not entered".
const PERIOD_DAY = 'COALESCE(d.delivery_date, d.date_created::date)';
const IS_COLLECT = `(d.delivery_type = 'Customer Collect' OR d.delivery_state = 'Customer Collect'
                     OR lower(COALESCE(r.name, '')) = 'customer collect')`;
const DELIVERY_CTE = `
  dj AS (
    SELECT d.delivery_id, d.removalist_id, r.name AS removalist, d.delivery_state::text AS state,
           NULLIF(d.delivery_quoted, 0) AS cost, d.delivery_charged AS charged,
           ${PERIOD_DAY} AS day,
           COALESCE(d.cash_to_removalist, false) AS cash, NULLIF(d.installation_cost, 0) AS install,
           (SELECT COALESCE(sum(i.quantity), 0) FROM workorder_items i
             WHERE i.workorder_id = d.workorder_id AND i.status IS DISTINCT FROM 'Canceled') AS items
      FROM delivery d
      LEFT JOIN removalist r ON r.id = d.removalist_id
     WHERE d.delivery_type IS DISTINCT FROM 'Customer Collect'
       AND d.delivery_state IS DISTINCT FROM 'Customer Collect'
       AND COALESCE(lower(r.name), '') <> 'customer collect'
       AND ${PERIOD_DAY} >= $1::date AND ${PERIOD_DAY} < $2::date
  )`;

const DELIVERY_REMOVALISTS = `
  WITH ${DELIVERY_CTE}
  SELECT dj.removalist_id, COALESCE(max(dj.removalist), 'No carrier set') AS removalist,
         count(*) AS jobs,
         count(*) FILTER (WHERE dj.cost IS NOT NULL) AS jobs_with_cost,
         count(*) FILTER (WHERE dj.cost IS NOT NULL AND dj.charged IS NOT NULL) AS jobs_both,
         round(COALESCE(sum(dj.cost), 0), 2) AS carrier_cost,
         round(COALESCE(sum(dj.charged), 0), 2) AS charged,
         round(COALESCE(sum(dj.cost) FILTER (WHERE dj.charged IS NOT NULL), 0), 2) AS both_cost,
         round(COALESCE(sum(dj.charged) FILTER (WHERE dj.cost IS NOT NULL), 0), 2) AS both_charged,
         round(avg(dj.cost), 2) AS avg_cost,
         round((percentile_cont(0.5) WITHIN GROUP (ORDER BY dj.cost))::numeric, 2) AS median_cost,
         count(*) FILTER (WHERE dj.charged < dj.cost) AS loss_jobs,
         round(COALESCE(sum(dj.cost - dj.charged) FILTER (WHERE dj.charged < dj.cost), 0), 2) AS loss_amount,
         count(*) FILTER (WHERE dj.charged = 0) AS free_jobs,
         count(*) FILTER (WHERE dj.charged = 0 AND dj.cost IS NOT NULL) AS free_jobs_with_cost,
         round(COALESCE(sum(dj.cost) FILTER (WHERE dj.charged = 0), 0), 2) AS free_cost,
         count(*) FILTER (WHERE dj.charged < dj.cost * 1.2) AS under_target_jobs,
         round(COALESCE(sum(dj.cost * 1.2) FILTER (WHERE dj.charged IS NOT NULL), 0), 2) AS target,
         count(*) FILTER (WHERE dj.cash) AS cash_jobs,
         count(*) FILTER (WHERE dj.install IS NOT NULL) AS install_jobs,
         round(COALESCE(sum(dj.install), 0), 2) AS install_cost
    FROM dj
   GROUP BY dj.removalist_id
   ORDER BY jobs DESC
`;

// Per state: single-item jobs (one unit on the workorder) are the like-for-like base.
const DELIVERY_STATES = `
  WITH ${DELIVERY_CTE}
  SELECT dj.state, count(*) AS jobs,
         count(*) FILTER (WHERE dj.cost IS NOT NULL AND dj.charged IS NOT NULL) AS jobs_both,
         count(*) FILTER (WHERE dj.items = 1 AND dj.cost IS NOT NULL) AS single_jobs,
         round(avg(dj.cost) FILTER (WHERE dj.items = 1), 2) AS single_avg_cost,
         round(COALESCE(sum(dj.cost) FILTER (WHERE dj.charged IS NOT NULL), 0), 2) AS both_cost,
         round(COALESCE(sum(dj.charged) FILTER (WHERE dj.cost IS NOT NULL), 0), 2) AS both_charged
    FROM dj
   GROUP BY dj.state
   ORDER BY jobs DESC
`;

// Carriers are zone specialists, so compare them only inside one state, on single-item jobs.
const DELIVERY_LIKE = `
  WITH ${DELIVERY_CTE}
  SELECT dj.state, dj.removalist_id, COALESCE(max(dj.removalist), 'No carrier set') AS removalist,
         count(*) AS like_jobs, round(avg(dj.cost), 2) AS avg_cost,
         round((percentile_cont(0.5) WITHIN GROUP (ORDER BY dj.cost))::numeric, 2) AS median_cost
    FROM dj
   WHERE dj.items = 1 AND dj.cost IS NOT NULL AND dj.removalist_id IS NOT NULL
   GROUP BY dj.state, dj.removalist_id
   ORDER BY dj.state, avg_cost
`;

const DELIVERY_MONTHLY = `
  WITH ${DELIVERY_CTE}
  SELECT to_char(date_trunc('month', dj.day), 'YYYY-MM') AS dj_month, count(*) AS jobs,
         count(*) FILTER (WHERE dj.cost IS NOT NULL AND dj.charged IS NOT NULL) AS jobs_both,
         round(COALESCE(sum(dj.cost) FILTER (WHERE dj.charged IS NOT NULL), 0), 2) AS cost,
         round(COALESCE(sum(dj.charged) FILTER (WHERE dj.cost IS NOT NULL), 0), 2) AS charged
    FROM dj
   GROUP BY 1
   ORDER BY 1
`;

const DELIVERY_EXCLUDED = `
  SELECT count(*) AS excluded_collects
    FROM delivery d
    LEFT JOIN removalist r ON r.id = d.removalist_id
   WHERE ${IS_COLLECT}
     AND ${PERIOD_DAY} >= $1::date AND ${PERIOD_DAY} < $2::date
`;

// The 22 Sep 2026 rate-card zone bases that map to ONE state. VIC, NSW and QLD each span several
// card zones (e.g. Melbourne Metro 262 / Outer 313 / VIC Regional 474), and deliveries hold no
// zone — so those states are shown without a card comparison until suburbs are mapped to zones.
export const RATE_CARD_STATE_BASE = { ACT: 474, SA: 583, WA: 663, TAS: 724, NT: 1257 };
// SA and WA use the METRO base (Adelaide, Perth): regional jobs in those states push the average
// up, so the drift there may be overstated — the screen says so.
const CARD_ZONE_NAME = { ACT: 'ACT', SA: 'Adelaide (metro)', WA: 'Perth (metro)', TAS: 'Tasmania', NT: 'NT' };
const METRO_BASE_STATES = ['SA', 'WA'];
const MULTI_ZONE_STATES = ['VIC', 'NSW', 'QLD'];
const DRIFT_LIMIT = 0.10;
const MIN_JOBS_FOR_DRIFT = 3;
const TARGET_MARKUP = 1.2; // cost + 20% (~17% gross margin), the rate-card review's target

const D_SUM = ['jobs', 'jobs_with_cost', 'jobs_both', 'carrier_cost', 'charged', 'both_cost', 'both_charged', 'loss_jobs',
  'loss_amount', 'free_jobs', 'free_jobs_with_cost', 'free_cost', 'under_target_jobs', 'target', 'cash_jobs', 'install_jobs', 'install_cost'];
const MONEY_FIELDS = ['carrier_cost', 'charged', 'both_cost', 'both_charged', 'loss_amount', 'free_cost', 'target', 'install_cost'];

function deriveDelivery(r) {
  const out = { ...r };
  out.price_difference = money(r.both_charged - r.both_cost);
  out.recovery = r.jobs_both > 0 ? ratio(r.both_charged, r.both_cost) : null;
  out.vs_target = money(r.both_charged - r.target);
  return out;
}

function deliveryRows(rows) {
  return rows.map((r) => {
    const o = { removalist_id: r.removalist_id ?? null, removalist: r.removalist || 'No carrier set' };
    for (const f of D_SUM) o[f] = n(r[f]) ?? 0;
    o.avg_cost = n(r.avg_cost);
    o.median_cost = n(r.median_cost);
    return deriveDelivery(o);
  });
}

function deliveryTotals(rows) {
  const t = Object.fromEntries(D_SUM.map((f) => [f, 0]));
  for (const r of rows) for (const f of D_SUM) t[f] += r[f];
  for (const f of MONEY_FIELDS) t[f] = money(t[f]);
  return deriveDelivery(t);
}

export function shapeDeliveries(q) {
  const removalists = deliveryRows(q.removalists);
  const states = q.states.map((s) => {
    const state = s.state || 'No state set';
    const jobsBoth = n(s.jobs_both) ?? 0;
    const singleJobs = n(s.single_jobs) ?? 0;
    const avg = n(s.single_avg_cost);
    const base = RATE_CARD_STATE_BASE[state] ?? null;
    let flag = 'no-card';
    let drift = null;
    if (MULTI_ZONE_STATES.includes(state)) flag = 'several-zones';
    else if (base !== null) {
      if (singleJobs < MIN_JOBS_FOR_DRIFT || avg === null) flag = 'too-few';
      else {
        drift = Math.round((avg / base - 1) * 10000) / 10000;
        flag = Math.abs(drift) > DRIFT_LIMIT ? 'drift' : 'ok';
      }
    }
    const bothCost = n(s.both_cost) ?? 0;
    const bothCharged = n(s.both_charged) ?? 0;
    return {
      state, jobs: n(s.jobs) ?? 0, single_jobs: singleJobs, single_avg_cost: avg,
      card_zone: base !== null ? CARD_ZONE_NAME[state] : null, card_base: base, drift, flag,
      jobs_both: jobsBoth, regional_caveat: METRO_BASE_STATES.includes(state),
      both_cost: bothCost, both_charged: bothCharged, price_difference: jobsBoth > 0 ? money(bothCharged - bothCost) : null,
    };
  });
  const byState = new Map();
  for (const l of q.like) {
    if (!byState.has(l.state)) byState.set(l.state, []);
    byState.get(l.state).push({
      removalist_id: l.removalist_id ?? null, removalist: l.removalist || 'No carrier set',
      jobs: n(l.like_jobs) ?? 0, avg_cost: n(l.avg_cost), median_cost: n(l.median_cost),
    });
  }
  const likeForLike = [...byState.entries()].filter(([, carriers]) => carriers.length >= 2).map(([state, carriers]) => ({ state, carriers }));
  const totals = deliveryTotals(removalists);
  return {
    totals,
    removalists,
    states,
    like_for_like: likeForLike,
    monthly: q.monthly.map((m) => {
      const cost = n(m.cost) ?? 0;
      const charged = n(m.charged) ?? 0;
      const jobsBoth = n(m.jobs_both) ?? 0;
      return { month: m.dj_month, jobs: n(m.jobs) ?? 0, jobs_both: jobsBoth, cost, charged, margin: jobsBoth > 0 ? money(charged - cost) : null };
    }),
    target_markup: TARGET_MARKUP,
    coverage: {
      jobs: totals.jobs, jobs_with_cost: totals.jobs_with_cost, jobs_both: totals.jobs_both,
      excluded_collects: n(q.excluded[0]?.excluded_collects) ?? 0,
    },
  };
}

// The company-wide invoice count: one invoice can sit on workorders of two salespeople, so the
// total is its own DISTINCT count, not the sum of the per-person counts.
const SALES_INVOICES = `
  SELECT count(DISTINCT w.invoice_id) AS invoices
    FROM workorder w
   WHERE w.date_created >= $1::date AND w.date_created < $2::date
     AND w.status::text <> 'Cancelled'
`;

const SALES_WORKORDERS = `
  SELECT w.workorder_id, w.invoice_id, w.date_created, w.status, w.outstanding_balance,
         (SELECT round(COALESCE(sum(COALESCE(i.quantity, 0) * COALESCE(i.selling_price, i.custom_unit_price, p.price)), 0), 2)
            FROM workorder_items i
            LEFT JOIN product p ON p.sku = i.product_id
           WHERE i.workorder_id = w.workorder_id AND i.status IS DISTINCT FROM 'Canceled') AS sales
    FROM workorder w
   WHERE w.salesperson = $3 AND w.date_created >= $1::date AND w.date_created < $2::date
     AND w.status::text <> 'Cancelled'
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
    if (!['sales', 'sales-workorders', 'products', 'deliveries'].includes(resource)) throw new BadRequest("Unknown Director's View request");
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

  if (resource === 'deliveries') {
    const p = [range.from, range.toExclusive];
    const q3 = await readOnly(client, async () => ({
      removalists: (await client.query(DELIVERY_REMOVALISTS, p)).rows,
      states: (await client.query(DELIVERY_STATES, p)).rows,
      like: (await client.query(DELIVERY_LIKE, p)).rows,
      monthly: (await client.query(DELIVERY_MONTHLY, p)).rows,
      excluded: (await client.query(DELIVERY_EXCLUDED, p)).rows,
      previous: prev ? (await client.query(DELIVERY_REMOVALISTS, [prev.from, prev.toExclusive])).rows : null,
    }));
    return ok({
      range: echo(range),
      ...shapeDeliveries(q3),
      previous: prev ? { mode, range: echo(prev), totals: deliveryTotals(deliveryRows(q3.previous)) } : null,
    });
  }

  if (resource === 'products') {
    const p = [range.from, range.toExclusive];
    const q2 = await readOnly(client, async () => ({
      bySku: (await client.query(PRODUCTS_BY_SKU, p)).rows,
      conditions: (await client.query(PRODUCTS_CONDITIONS, p)).rows,
      byFy: (await client.query(PRODUCTS_BY_FY)).rows,
      stock: (await client.query(PRODUCTS_STOCK)).rows,
      aged: (await client.query(PRODUCTS_AGED)).rows,
      agedList: (await client.query(PRODUCTS_AGED_LIST)).rows,
      costMissing: (await client.query(PRODUCTS_COST_MISSING, p)).rows,
      previous: prev ? (await client.query(PRODUCTS_BY_SKU, [prev.from, prev.toExclusive])).rows : null,
    }));
    return ok({
      range: echo(range),
      ...shapeProducts(q2),
      previous: prev ? { mode, range: echo(prev), totals: productTotals(shapeProductRows(q2.previous)) } : null,
    });
  }

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
