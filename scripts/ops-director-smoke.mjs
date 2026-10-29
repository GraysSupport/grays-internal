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

function makeClient({ failOn = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(text, params = []) {
      const sql = text.replace(/\s+/g, ' ').trim();
      calls.push({ sql, params });
      if (failOn && failOn.test(sql)) throw Object.assign(new Error('boom'), { code: 'XX000' });
      if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return { rows: [] };
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
