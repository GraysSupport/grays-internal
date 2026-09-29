// scripts/ops-temp-run-smoke.mjs — offline smoke for G8's run-candidates read.
//
// G8 (Nick, 28 Sep 2026): the "temporary delivery run" planner must NOT create, update or
// delete any workorder, workorder item, delivery or log row. The client half of that promise
// is pinned in src/pages/__tests__/tempDeliveryRun.test.js; THIS file pins the server half:
// the one endpoint the planner calls issues SELECTs and nothing else.
//
//   node scripts/ops-temp-run-smoke.mjs
//
// Exercises lib/handlers/logistics.js with an INJECTED fake pg client that records every
// statement — no network, no database, no secrets. The strongest assertion here is the
// EXACT statement count: a write slipped in under any spelling (quoted identifiers, CTEs,
// a helper call) changes the count, so a regex over the SQL is not the only defence.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'smoke_secret';

const jwt = (await import('jsonwebtoken')).default;
const logisticsHandler = (await import('../lib/handlers/logistics.js')).default;

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function makeClient(scripts = []) {
  const calls = [];
  return {
    calls,
    released: false,
    release() { this.released = true; },
    async query(sql, params) {
      calls.push({ sql, params });
      for (const s of scripts) {
        if (s.match.test(sql)) {
          if (s.throws) throw s.throws;
          return s.result ?? { rowCount: 0, rows: [] };
        }
      }
      return { rowCount: 0, rows: [] };
    },
  };
}
const depsFor = (client) => ({ getClient: async () => client });

function makeReq({ method = 'GET', roles = ['logistics'], query = { resource: 'run-candidates' }, noAuth = false } = {}) {
  const headers = {};
  if (!noAuth) headers.authorization = `Bearer ${jwt.sign({ id: 'LG', email: 'logistics@graysfitness.com.au', roles }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
  return { method, headers, query, body: {} };
}
function makeRes() {
  return {
    statusCode: 0, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
  };
}

const DELIV_RE = /FROM delivery d/i;
const WO_RE = /FROM workorder wo/i;
const deliveryRows = { rowCount: 1, rows: [
  { delivery_id: 101, workorder_id: 9, invoice_id: '20431', customer_name: 'Demo Customer', customer_phone: '0400 000 000', customer_address: '1 Test St', delivery_suburb: 'Altona North', delivery_state: 'VIC', items_text: '1 × Treadmill (Grade A)', notes: 'Rear access' },
] };
const woRows = { rowCount: 1, rows: [
  { workorder_id: 12, invoice_id: '20500', customer_name: 'Another Customer', customer_phone: '0411 111 111', customer_address: '2 Test Rd', delivery_suburb: 'Geelong', delivery_state: 'VIC', items_text: '2 × Dumbbell rack', notes: null },
] };

console.log('G8 run-candidates smoke — fake client, no DB\n');

console.log('gates:');
{
  const res = makeRes();
  await logisticsHandler(makeReq({ noAuth: true }), res, [], depsFor(makeClient()));
  check('401 without a token', res.statusCode === 401);
}
for (const role of ['sales', 'technician', 'staff', 'workshop']) {
  const client = makeClient();
  const res = makeRes();
  await logisticsHandler(makeReq({ roles: [role] }), res, [], depsFor(client));
  check(`403 for ${role} — and no query ran`, res.statusCode === 403 && client.calls.length === 0);
}
for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
  const client = makeClient();
  const res = makeRes();
  await logisticsHandler(makeReq({ method }), res, [], depsFor(client));
  check(`405 for ${method} — and no query ran`, res.statusCode === 405 && client.calls.length === 0);
}

console.log('\nGET ?resource=run-candidates:');
{
  // WO_RE first: the workorder query ALSO contains "FROM delivery d" (inside its NOT EXISTS).
  const client = makeClient([
    { match: WO_RE, result: woRows },
    { match: DELIV_RE, result: deliveryRows },
  ]);
  const res = makeRes();
  await logisticsHandler(makeReq(), res, [], depsFor(client));
  check('200', res.statusCode === 200, `status ${res.statusCode}`);
  check('body is { deliveries, workorders }', Array.isArray(res.body?.deliveries) && Array.isArray(res.body?.workorders));
  check('deliveries carried through', res.body.deliveries.length === 1 && res.body.deliveries[0].delivery_id === 101);
  check('workorders carried through', res.body.workorders.length === 1 && res.body.workorders[0].workorder_id === 12);
  check('client released', client.released === true);

  // ⭐ the zero-write proof on the server side
  check('EXACTLY two statements issued', client.calls.length === 2, `got ${client.calls.length}`);
  check('every statement is a read (starts with SELECT or WITH)',
    client.calls.every((c) => /^\s*(SELECT|WITH)\b/i.test(c.sql)));
  check('no write keyword anywhere (INSERT/UPDATE/DELETE/UPSERT/TRUNCATE/ALTER)',
    client.calls.every((c) => !/\b(INSERT|UPDATE|DELETE|UPSERT|TRUNCATE|ALTER|DROP|CREATE)\b/i.test(c.sql)));
  check('no logEvent / workorder_logs write', client.calls.every((c) => !/workorder_logs/i.test(c.sql)));

  const dq = client.calls.find((c) => DELIV_RE.test(c.sql) && !WO_RE.test(c.sql));
  check('deliveries: only To Be Booked', !!dq && /delivery_status\s*=\s*'To Be Booked'/i.test(dq.sql));
  check('deliveries: customer phone + address for the run sheet', !!dq && /c\.phone/i.test(dq.sql) && /c\.address/i.test(dq.sql));
  check('deliveries: cancelled items excluded from items_text', !!dq && /<>\s*'Canceled'/i.test(dq.sql));
  // Review fix: a Customer Collect is a pickup, not a stop — it must never reach a driver's sheet.
  check('deliveries: Customer Collect (by type) excluded', !!dq && /d\.delivery_type IS DISTINCT FROM 'Customer Collect'/i.test(dq.sql));
  check('deliveries: Customer Collect (by carrier name) excluded', !!dq && /lower\(r\.name\)[^\n]*'customer collect'/i.test(dq.sql));
  check('deliveries: delivery_type selected (installation must be visible)', !!dq && /d\.delivery_type/.test(dq.sql.split('FROM delivery d')[0]));

  const wq = client.calls.find((c) => WO_RE.test(c.sql));
  check('workorders: only current (Work Ordered)', !!wq && /wo\.status\s*=\s*'Work Ordered'/i.test(wq.sql));
  check('workorders: skip ones already on a live delivery (no double stop)',
    !!wq && /NOT EXISTS/i.test(wq.sql) && /'To Be Booked'/.test(wq.sql) && /'Booked for Delivery'/.test(wq.sql));
  check('workorders: customer phone + address', !!wq && /c\.phone/i.test(wq.sql) && /c\.address/i.test(wq.sql));
  check('no price/cost columns exposed', client.calls.every((c) => !/selling_price|custom_unit_price|avg_cost/i.test(c.sql)));
}

console.log('\npath form + roles:');
{
  const client = makeClient();
  const res = makeRes();
  await logisticsHandler(makeReq({ query: {} }), res, ['run-candidates'], depsFor(client));
  check('200 via the path segment', res.statusCode === 200 && Array.isArray(res.body?.deliveries));
}
{
  const res = makeRes();
  await logisticsHandler(makeReq({ roles: ['superadmin'] }), res, [], depsFor(makeClient()));
  check('200 for superadmin', res.statusCode === 200);
}
{
  const client = makeClient([{ match: DELIV_RE, throws: Object.assign(new Error('boom'), { code: 'XX000' }) }]);
  const res = makeRes();
  await logisticsHandler(makeReq(), res, [], depsFor(client));
  check('500 on a DB error, client still released', res.statusCode === 500 && client.released === true);
}

console.log('\nexisting queue unaffected:');
{
  const client = makeClient();
  const res = makeRes();
  await logisticsHandler(makeReq({ query: { resource: 'awaiting-workorder' } }), res, [], depsFor(client));
  check('awaiting-workorder still a bare array', res.statusCode === 200 && Array.isArray(res.body));
}

console.log(`\n✅ G8 run-candidates smoke: ${passed} checks passed`);
