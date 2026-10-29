// scripts/ops-director-smoke.mjs — offline smoke for G22a (owner, 29 Oct 2026): the Director's
// View, sales team performance. Superadmin only, server-checked; read-only by construction.
//
//   GET /api/director?resource=sales&from=YYYY-MM-DD&to=YYYY-MM-DD[&compare=1]
//   GET /api/director?resource=sales-workorders&salesperson=XX&from=…&to=…
//
// Exercises lib/director.js with a fake pg client — no network, no database, no secrets.
//
//   node scripts/ops-director-smoke.mjs

process.env.JWT_SECRET = process.env.JWT_SECRET || 'smoke_secret';

const jwt = (await import('jsonwebtoken')).default;
const { handleDirector, previousPeriod, parseRange } = await import('../lib/director.js');

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const token = (id, roles) => `Bearer ${jwt.sign({ id, email: `${id}@x`, roles }, process.env.JWT_SECRET)}`;
const SUPER = token('GS', ['superadmin']);

// Rows as pg returns them (numerics as strings).
const ROW = (sp, name, over = {}) => ({
  salesperson: sp, salesperson_name: name, workorders: '10', open: '2', completed: '8', invoices: '9',
  units: '12.00', sales: '20000.00', priced_lines: '4', estimated_lines: '6', unpriced_lines: '0',
  costed_lines: '5', costed_sales: '10000.00', cogs: '2500.00', delivery_jobs: '8', delivery_charged: '1600.00',
  carrier_cost: '2000.00', free_jobs: '2', free_cost: '450.00', jobs_no_cost: '1', outstanding: '3000.00',
  completed_timed: '8', avg_days: '20.0', on_time_eligible: '8', on_time: '6', ecommerce: '7', ...over,
});

// Product rows (G22b) as pg returns them.
const P = (sku, name, brand, over = {}) => ({
  sku, name, brand, units: '2.00', revenue: '10000.00', costed_revenue: '10000.00', cogs: '2000.00',
  lines: '2', costed_lines: '2', priced_lines: '1', estimated_lines: '1', ...over,
});
const PRODUCT_ROWS = [
  P('A', 'Alpha', 'TEC', { revenue: '50000.00', costed_revenue: '50000.00', cogs: '45000.00' }), // big revenue, thin profit
  P('B', 'Bravo', 'TEC', { revenue: '20000.00', costed_revenue: '20000.00', cogs: '2000.00' }),
  P('C', 'Charlie', 'PRE', { revenue: '5000.00', costed_revenue: '0', cogs: '0', costed_lines: '0' }), // no cost known
  P('OTHER', null, null, { revenue: '300.00', costed_revenue: '0', cogs: '0', costed_lines: '0', priced_lines: '1', estimated_lines: '0', lines: '1' }),
];

// Delivery rows (G22c) as pg returns them.
const R = (id, name, over = {}) => ({
  removalist_id: id, removalist: name, jobs: '10', jobs_with_cost: '8', jobs_both: '8', carrier_cost: '4000.00', charged: '3500.00',
  both_cost: '4000.00', both_charged: '3200.00', avg_cost: '500.00', median_cost: '450.00', loss_jobs: '5', loss_amount: '900.00',
  free_jobs: '2', free_cost: '700.00', under_target_jobs: '7', target: '4800.00', cash_jobs: '0', install_jobs: '0', install_cost: '0', ...over,
});
const REMOVALIST_ROWS = [R(1, 'Moving Soon'), R(14, 'DTL Logistics', { both_cost: '2000.00', both_charged: '2600.00', loss_jobs: '0', loss_amount: '0', target: '2400.00' }), R(null, null, { jobs: '2', jobs_both: '0', both_cost: '0', both_charged: '0', target: '0' })];
const STATE_ROWS = [
  { state: 'ACT', jobs: '13', single_jobs: '9', single_avg_cost: '524.10', both_cost: '100', both_charged: '90' },
  { state: 'TAS', jobs: '12', single_jobs: '4', single_avg_cost: '687.50', both_cost: '100', both_charged: '90' },
  { state: 'NT', jobs: '2', single_jobs: '1', single_avg_cost: '2000.00', both_cost: '0', both_charged: '0' },
  { state: 'VIC', jobs: '262', single_jobs: '91', single_avg_cost: '279.78', both_cost: '100', both_charged: '90' },
];
const LIKE_ROWS = [
  { state: 'NSW', removalist_id: 14, removalist: 'DTL Logistics', like_jobs: '30', avg_cost: '750.00', median_cost: '700.00' },
  { state: 'NSW', removalist_id: 1, removalist: 'Moving Soon', like_jobs: '5', avg_cost: '600.00', median_cost: '590.00' },
  { state: 'WA', removalist_id: 9, removalist: 'Solo', like_jobs: '14', avg_cost: '656.43', median_cost: '650.00' },
];

function makeClient({ failOn = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(text, params = []) {
      const sql = text.replace(/\s+/g, ' ').trim();
      calls.push({ sql, params });
      if (failOn && failOn.test(sql)) throw Object.assign(new Error('boom'), { code: 'XX000' });
      if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return { rows: [] };
      // G22c — deliveries & removalists (CTE "dj").
      if (/FROM dj/i.test(sql)) {
        const prev = params[0] === '2024-07-01';
        if (/AS loss_amount/i.test(sql)) return { rows: prev ? [R(1, 'Moving Soon', { both_cost: '1000.00', both_charged: '900.00' })] : REMOVALIST_ROWS };
        if (/AS single_avg_cost/i.test(sql)) return { rows: STATE_ROWS };
        if (/AS like_jobs/i.test(sql)) return { rows: LIKE_ROWS };
        if (/AS dj_month/i.test(sql)) return { rows: [{ dj_month: '2025-07', jobs: '10', cost: '5000.00', charged: '4000.00' }] };
      }
      if (/AS excluded_collects/i.test(sql)) return { rows: [{ excluded_collects: '84' }] };
      // G22b — products, earnings and profit.
      if (/GROUP BY lines\.sku/i.test(sql)) {
        const prev = params[0] === '2024-07-01';
        return { rows: prev ? [P('A', 'Alpha', 'TEC', { revenue: '1000.00' })] : PRODUCT_ROWS };
      }
      if (/AS condition_code/i.test(sql)) return { rows: [{ condition_code: 'CS', units: '10.00', revenue: '30000.00', lines: '8' }, { condition_code: 'New', units: '2.00', revenue: '900.00', lines: '2' }] };
      if (/AS fy\b/i.test(sql)) return { rows: [{ fy: 2026, units: '1977.00', revenue: '2813375.50', lines: '919', priced_lines: '330', is_current: false }, { fy: 2027, units: '11.00', revenue: '17950.00', lines: '5', priced_lines: '5', is_current: true }] };
      if (/AS value_sell/i.test(sql)) return { rows: [{ products: '258', units: '4228', units_costed: '217', value_cost: '106323.54', units_priced: '4228', value_sell: '1602880.00', negative: '4' }] };
      if (/AS over90/i.test(sql)) return { rows: [{ in_stock: '73', over90: '35', over180: '0' }] };
      if (/AS age_days/i.test(sql)) return { rows: [{ lot_number: 'L00001', product_sku: 'A', name: 'Alpha', age_days: 112 }] };
      if (/AS missing_total/i.test(sql)) return { rows: [{ sku: 'CR-1', name: 'Chamber', brand: 'CR', price: '55900.00', stock: 3, missing_total: '287' }] };
      if (/AS month/i.test(sql)) {
        return { rows: [{ salesperson: 'KM', month: '2025-07', sales: '5000.00' }, { salesperson: 'KM', month: '2025-08', sales: '15000.00' }] };
      }
      if (/GROUP BY wo\.salesperson/i.test(sql)) {
        const prev = params[0] === '2024-07-01';
        return { rows: prev ? [ROW('KM', 'Kelly', { sales: '10000.00', workorders: '5' })] : [ROW('KM', 'Kelly'), ROW('JG', 'John', { sales: '5000.00', costed_lines: '0', costed_sales: '0', cogs: '0', on_time_eligible: '0', on_time: '0', completed_timed: '0', avg_days: null })] };
      }
      if (/count\(DISTINCT w\.invoice_id\)/i.test(sql)) return { rows: [{ invoices: '17' }] }; // 9 + 9 per person, 1 shared
      if (/ORDER BY w\.date_created/i.test(sql)) {
        return { rows: [{ workorder_id: 901, invoice_id: 'INV-901', date_created: '2025-08-01T00:00:00Z', status: 'Completed', outstanding_balance: '0.00', sales: '1795.00' }] };
      }
      throw new Error(`unexpected SQL in smoke: ${sql.slice(0, 120)}`);
    },
  };
}

function makeRes() {
  return {
    statusCode: 200, body: undefined, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
async function call(client, { as = SUPER, method = 'GET', query = {} } = {}) {
  const req = { method, query, headers: as ? { authorization: as } : {} };
  const res = makeRes();
  await handleDirector(req, res, client);
  return res;
}
const FY = { resource: 'sales', from: '2025-07-01', to: '2026-06-30' };

console.log('G22a director — superadmin only, checked on the server');
{
  for (const [label, as] of [
    ['no token', null], ['admin', token('GA', ['admin'])], ['sales', token('BR', ['sales'])],
    ['logistics', token('LO', ['logistics'])], ['technician', token('TE', ['technician'])], ['WK kiosk', token('WK', ['admin'])],
  ]) {
    const c = makeClient();
    const r = await call(c, { as, query: FY });
    check(`${label} → ${as ? 403 : 401}, no query run`, r.statusCode === (as ? 403 : 401) && c.calls.length === 0);
  }
  const forged = `Bearer ${jwt.sign({ id: 'XX', roles: ['superadmin'] }, 'not-the-secret')}`;
  const c = makeClient();
  const r = await call(c, { as: forged, query: FY });
  check('a forged superadmin token → 401', r.statusCode === 401 && c.calls.length === 0);
  const ok = await call(makeClient(), { query: FY });
  check('superadmin → 200', ok.statusCode === 200, JSON.stringify(ok.body).slice(0, 200));
  const post = await call(makeClient(), { method: 'POST', query: FY });
  check('POST → 405', post.statusCode === 405);
}

console.log('G22a director — read-only by construction');
{
  const c = makeClient();
  await call(c, { query: { ...FY, compare: '1' } });
  check('opens a READ ONLY transaction first', /^BEGIN TRANSACTION READ ONLY$/i.test(c.calls[0].sql));
  check('commits last', /^COMMIT$/i.test(c.calls.at(-1).sql));
  const body = c.calls.slice(1, -1);
  check('every statement in between is a SELECT / WITH', body.length >= 3 && body.every((q) => /^(SELECT|WITH)\b/i.test(q.sql)));
  check('no write keyword anywhere', !c.calls.some((q) => /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|DROP|CREATE|GRANT)\b/i.test(q.sql)));
  check('parameters, not string-built dates', body.every((q) => !/'20\d\d-\d\d-\d\d'/.test(q.sql)));
  const f = makeClient({ failOn: /AS month/i });
  let threw = false;
  try { await call(f, { query: FY }); } catch { threw = true; }
  check('a failing query rolls back (and is not swallowed)', threw && /^ROLLBACK$/i.test(f.calls.at(-1).sql));
  const dd = makeClient();
  await call(dd, { query: { resource: 'sales-workorders', salesperson: 'KM', from: FY.from, to: FY.to } });
  check('drill-down is read-only too', /^BEGIN TRANSACTION READ ONLY$/i.test(dd.calls[0].sql) && dd.calls.slice(1, -1).every((q) => /^(SELECT|WITH)\b/i.test(q.sql)));
}

console.log('G22a director — periods');
{
  check('to is inclusive → exclusive next day', JSON.stringify(parseRange('2025-07-01', '2026-06-30')) === JSON.stringify({ from: '2025-07-01', toExclusive: '2026-07-01' }));
  check('previous period = same length immediately before', JSON.stringify(previousPeriod({ from: '2025-07-01', toExclusive: '2026-07-01' })) === JSON.stringify({ from: '2024-07-01', toExclusive: '2025-07-01' }));
  check('one-month previous period', JSON.stringify(previousPeriod({ from: '2026-10-01', toExclusive: '2026-11-01' })) === JSON.stringify({ from: '2026-08-31', toExclusive: '2026-10-01' }));
  for (const [q, label] of [
    [{ from: '2025-13-01', to: '2026-01-01' }, 'month 13'], [{ from: '2025-02-30', to: '2025-03-01' }, '30 Feb'],
    [{ from: '2026-01-02', to: '2026-01-01' }, 'to before from'], [{ from: '2015-01-01', to: '2026-01-01' }, 'over 5 years'],
    [{ from: "2025-07-01'; DROP TABLE x;--", to: '2026-01-01' }, 'injection text'], [{}, 'missing dates'],
  ]) {
    const c = makeClient();
    const r = await call(c, { query: { resource: 'sales', ...q } });
    check(`${label} → 400, nothing run`, r.statusCode === 400 && c.calls.length === 0);
  }
  const c = makeClient();
  await call(c, { query: FY });
  const summary = c.calls.find((q) => /GROUP BY wo\.salesperson/i.test(q.sql));
  check('summary runs on [from, toExclusive)', summary.params[0] === '2025-07-01' && summary.params[1] === '2026-07-01');
}

console.log('G22a director — the numbers');
{
  const r = await call(makeClient(), { query: { ...FY, compare: '1' } });
  const b = r.body;
  const km = b.salespeople.find((s) => s.salesperson === 'KM');
  const jg = b.salespeople.find((s) => s.salesperson === 'JG');
  check('numbers, not strings', typeof km.sales === 'number' && km.sales === 20000 && km.units === 12);
  check('average order value = sales ÷ workorders', km.aov === 2000);
  check('gross profit + margin only on costed lines', km.gross_profit === 7500 && km.margin === 0.75);
  check('no costed lines → profit + margin null (never 0)', jg.gross_profit === null && jg.margin === null);
  check('delivery net = charged − carrier cost', km.delivery_net === -400);
  check('on-time % from eligible completions', km.on_time_pct === 0.75 && jg.on_time_pct === null);
  check('avg days kept, null when unknown', km.avg_days === 20 && jg.avg_days === null);
  check('sorted by sales, highest first', b.salespeople[0].salesperson === 'KM');
  check('totals add up', b.totals.sales === 25000 && b.totals.workorders === 20 && b.totals.gross_profit === 7500);
  check('coverage block counts lines', b.coverage.lines === 20 && b.coverage.priced_lines === 8 && b.coverage.estimated_lines === 12 && b.coverage.costed_lines === 5);
  check('monthly series per salesperson', JSON.stringify(b.monthly.KM) === JSON.stringify({ '2025-07': 5000, '2025-08': 15000 }));
  check('previous period figures + range', b.previous && b.previous.range.from === '2024-07-01' && b.previous.salespeople[0].sales === 10000);
  check('range echoed back (to inclusive)', b.range.from === '2025-07-01' && b.range.to === '2026-06-30');
  check('cache: private, 5 minutes', r.headers['Cache-Control'] === 'private, max-age=300');
  const noCompare = await call(makeClient(), { query: FY });
  check('no compare → no previous', noCompare.body.previous === null);
}

console.log('G22a director — review fixes');
{
  const { previousYear } = await import('../lib/director.js');
  check('same dates a year earlier', JSON.stringify(previousYear({ from: '2026-07-01', toExclusive: '2026-10-31' })) === JSON.stringify({ from: '2025-07-01', toExclusive: '2025-10-31' }));
  check('29 Feb a year earlier → 28 Feb', JSON.stringify(previousYear({ from: '2028-02-29', toExclusive: '2028-03-01' })) === JSON.stringify({ from: '2027-02-28', toExclusive: '2027-03-01' }));
  let c = makeClient();
  let r = await call(c, { query: { resource: 'sales', from: '2026-07-01', to: '2026-10-30', compare: 'year' } });
  const prevQ = c.calls.filter((q) => /GROUP BY wo\.salesperson/i.test(q.sql) && !/AS month/i.test(q.sql))[1];
  check('compare=year queries the same dates last year', prevQ.params[0] === '2025-07-01' && prevQ.params[1] === '2025-10-31' && r.body.previous.range.to === '2025-10-30');
  check('compare=year is labelled as such', r.body.previous.mode === 'year');
  r = await call(makeClient(), { query: { ...FY, compare: '1' } });
  check('compare=1 is the period immediately before', r.body.previous.mode === 'previous');
  check('total invoices are distinct across salespeople (not 9 + 9)', r.body.totals.invoices === 17);
  check('previous total invoices distinct too', r.body.previous.totals.invoices === 17);
  c = makeClient();
  await call(c, { query: FY });
  const sum = c.calls.find((q) => /GROUP BY wo\.salesperson/i.test(q.sql)).sql;
  check('"free" = charged exactly $0 — an unknown charge is not free', /FILTER \(WHERE d\.delivery_charged = 0\)/i.test(sum) && !/COALESCE\(d\.delivery_charged, 0\) = 0/i.test(sum));
  check('unknown charges are counted for the coverage line', /jobs_no_charge/i.test(sum) && r.body.coverage.jobs_no_charge !== undefined);
  const bad = await call(makeClient(), { query: { resource: 'sales', from: 'x', to: 'y' } });
  check('no cache header on an error', bad.headers['Cache-Control'] === undefined);
  const una = await call({ calls: [], async query(text) { const sql = text.replace(/\s+/g, ' '); if (/GROUP BY wo\.salesperson/i.test(sql)) return { rows: [ROW(null, null)] }; if (/count\(DISTINCT/i.test(sql)) return { rows: [{ invoices: '9' }] }; return { rows: [] }; } }, { query: FY });
  check('a workorder with no salesperson shows as "Unassigned"', una.body.salespeople[0].salesperson_name === 'Unassigned' && una.body.salespeople[0].salesperson === null);
}

console.log('G22b director — products, earnings and profit');
{
  const PQ = { resource: 'products', from: FY.from, to: FY.to };
  for (const [label, as] of [['admin', token('GA', ['admin'])], ['WK kiosk', token('WK', ['admin'])], ['no token', null]]) {
    const c = makeClient();
    const r = await call(c, { as, query: PQ });
    check(`products: ${label} refused, no query run`, (r.statusCode === 401 || r.statusCode === 403) && c.calls.length === 0);
  }
  const c = makeClient();
  const r = await call(c, { query: { ...PQ, compare: 'year' } });
  const b = r.body;
  check('products → 200', r.statusCode === 200, JSON.stringify(b).slice(0, 200));
  check('read-only transaction, SELECT/WITH only', /^BEGIN TRANSACTION READ ONLY$/i.test(c.calls[0].sql) && /^COMMIT$/i.test(c.calls.at(-1).sql)
    && c.calls.slice(1, -1).every((q) => /^(SELECT|WITH)\b/i.test(q.sql)));
  check('totals: units + revenue', b.totals.units === 8 && b.totals.revenue === 75300);
  check('profit only over costed lines', b.totals.gross_profit === 23000 && b.totals.costed_lines === 4 && b.totals.lines === 7);
  check('margin = profit ÷ costed revenue', b.totals.margin === Math.round((23000 / 70000) * 10000) / 10000);
  check('top by revenue (custom lines are not a product)', b.top_revenue.map((p) => p.sku).join() === 'A,B,C');
  check('top by profit ranks profit, not revenue', b.top_profit.map((p) => p.sku).join() === 'B,A');
  check('a product with no cost has profit null and is left out of the profit ranking', b.top_revenue.find((p) => p.sku === 'C').gross_profit === null && !b.top_profit.some((p) => p.sku === 'C'));
  check('custom lines roll up under a named brand', b.brands.some((x) => x.brand === 'Custom'));
  check('brands rolled up, profit null when nothing costed', b.brands[0].brand === 'TEC' && b.brands[0].revenue === 70000 && b.brands.find((x) => x.brand === 'PRE').gross_profit === null);
  check('condition mix as stored', b.conditions[0].condition === 'CS' && b.conditions[0].revenue === 30000);
  check('units + revenue per financial year (all time)', b.by_fy.length === 2 && b.by_fy[0].fy === 2026 && b.by_fy[0].revenue === 2813375.5);
  check('stock value at cost + its coverage', b.stock.value_cost === 106323.54 && b.stock.units === 4228 && b.stock.units_costed === 217 && b.stock.negative === 4);
  check('aged stock', b.aged.over90 === 35 && b.aged.oldest[0].lot_number === 'L00001' && b.aged.oldest[0].age_days === 112);
  check('price set but cost missing worklist', b.cost_missing.total === 287 && b.cost_missing.items[0].sku === 'CR-1' && b.cost_missing.items[0].price === 55900);
  check('compare: previous totals', b.previous.mode === 'year' && b.previous.totals.revenue === 1000 && b.previous.range.from === '2024-07-01');
  check('cache header on success', r.headers['Cache-Control'] === 'private, max-age=300');
  const cm = c.calls.find((q) => /AS missing_total/i.test(q.sql));
  check('worklist uses the period as parameters', cm.params[0] === '2025-07-01' && cm.params[1] === '2026-07-01');

  // G22b review fixes
  check('worklist: NULL stock/price sorts last', /NULLS LAST/i.test(cm.sql));
  check('worklist: a product whose lots carry a cost is not "missing"', /NOT EXISTS[\s\S]*product_lots[\s\S]*NULLIF\(pl\.unit_cost, 0\) IS NOT NULL/i.test(cm.sql));
  const agedQ = c.calls.filter((q) => /product_lots/i.test(q.sql) && /In Stock/.test(q.sql));
  check('aged stock counted by whole days (> 90), the same rule as the list', agedQ.length === 2 && agedQ.every((q) => /now\(\)::date - (pl\.)?created_at::date\) > 90/i.test(q.sql)));
  const fyQ = c.calls.find((q) => /AS fy\b/i.test(q.sql));
  check('per-FY figures say which year is still running + how many lines are priced', /AS is_current/i.test(fyQ.sql) && /AS priced_lines/i.test(fyQ.sql));
  check('profit rankings only include fully costed products', b.top_profit.every((p) => p.costed_lines === p.lines) && b.profit_ranked === 2);
  check('custom (OTHER) lines are not ranked as a product, nor counted as one', !b.top_revenue.some((p) => p.sku === 'OTHER') && b.product_count === 3);
  check('…but stay in the totals', b.totals.revenue === 75300);
  check('unpriced lines are counted for the coverage line', b.totals.unpriced_lines !== undefined);
  check('brands keep how many lines are costed', b.brands[0].costed_lines === 4 && b.brands[0].lines === 4);
}

console.log('G22c director — deliveries & removalists');
{
  const DQ = { resource: 'deliveries', from: FY.from, to: FY.to };
  const refused = makeClient();
  const rr = await call(refused, { as: token('GA', ['admin']), query: DQ });
  check('deliveries: admin refused, no query', rr.statusCode === 403 && refused.calls.length === 0);
  const c = makeClient();
  const r = await call(c, { query: { ...DQ, compare: 'year' } });
  const b = r.body;
  check('deliveries → 200', r.statusCode === 200, JSON.stringify(b).slice(0, 200));
  check('read-only, SELECT/WITH only', /^BEGIN TRANSACTION READ ONLY$/i.test(c.calls[0].sql) && c.calls.slice(1, -1).every((q) => /^(SELECT|WITH)\b/i.test(q.sql)));
  const jobs = c.calls.find((q) => /AS loss_amount/i.test(q.sql)).sql;
  check('Customer Collect excluded: delivery_type, state AND the "Customer Collect" removalist', /delivery_type IS DISTINCT FROM 'Customer Collect'/i.test(jobs)
    && /delivery_state IS DISTINCT FROM 'Customer Collect'/i.test(jobs) && /lower\(r\.name\), ''\) <> 'customer collect'/i.test(jobs));
  check('carrier cost 0 = not entered (NULLIF)', /NULLIF\(d\.delivery_quoted, 0\)/i.test(jobs));
  check('period by delivery date, else created date', /COALESCE\(d\.delivery_date, d\.date_created::date\) >= \$1::date/i.test(jobs));
  const ms = b.removalists.find((x) => x.removalist_id === 1);
  check('price difference + recovery on jobs with both cost and charge', ms.price_difference === -800 && ms.recovery === 0.8);
  check('vs target (cost + 20%)', ms.vs_target === -1600);
  check('a carrier with no comparable jobs → recovery null', b.removalists.find((x) => x.removalist_id === null).recovery === null);
  check('no carrier set is named', b.removalists.find((x) => x.removalist_id === null).removalist === 'No carrier set');
  check('company totals', b.totals.both_cost === 6000 && b.totals.both_charged === 5800 && b.totals.price_difference === -200 && b.totals.loss_amount === 1800);
  const act = b.states.find((s) => s.state === 'ACT');
  const tas = b.states.find((s) => s.state === 'TAS');
  const vic = b.states.find((s) => s.state === 'VIC');
  const nt = b.states.find((s) => s.state === 'NT');
  check('zone drift vs the 22 Sep 2026 rate card (ACT 474)', act.card_zone === 'ACT' && act.card_base === 474 && act.drift === Math.round((524.10 / 474 - 1) * 10000) / 10000 && act.flag === 'drift');
  check('within 10% → no flag (TAS 724 vs 687.50)', tas.flag === 'ok');
  check('too few single-item jobs → not judged', nt.flag === 'too-few');
  check('multi-zone state → no card comparison, says why', vic.card_base === null && vic.flag === 'several-zones');
  check('like-for-like: only states with 2+ carriers', b.like_for_like.length === 1 && b.like_for_like[0].state === 'NSW' && b.like_for_like[0].carriers.length === 2);
  check('monthly trend', b.monthly[0].month === '2025-07' && b.monthly[0].margin === -1000);
  check('Customer Collect pickups counted for the coverage line', b.coverage.excluded_collects === 84);
  check('compare: previous totals', b.previous.mode === 'year' && b.previous.totals.price_difference === -100);
}

console.log('G22a director — drill-down');
{
  const c = makeClient();
  let r = await call(c, { query: { resource: 'sales-workorders', salesperson: 'KM', from: FY.from, to: FY.to } });
  check('lists that salesperson\'s workorders', r.statusCode === 200 && r.body.workorders[0].workorder_id === 901 && r.body.workorders[0].sales === 1795);
  const q = c.calls.find((x) => /ORDER BY w\.date_created/i.test(x.sql));
  check('filtered by salesperson + range as parameters', q.params.includes('KM') && q.params.includes('2025-07-01'));
  r = await call(makeClient(), { query: { resource: 'sales-workorders', salesperson: 'K;M', from: FY.from, to: FY.to } });
  check('bad salesperson id → 400', r.statusCode === 400);
  r = await call(makeClient(), { query: { resource: 'nope', from: FY.from, to: FY.to } });
  check('unknown resource → 400', r.statusCode === 400);
}

console.log(`\n✅ ops-director smoke: ${passed} checks passed`);
