// scripts/podium-logistics-smoke.mjs — offline smoke for the F7b logistics queue handler.
//
// Exercises lib/handlers/logistics.js with an INJECTED fake pg client (deps.getClient), so
// there is NO network, NO database, NO secrets:
//
//   node scripts/podium-logistics-smoke.mjs
//
// Covers: auth/role gates (logistics + superadmin allowed, others 403), method gate,
// resource resolution from BOTH the path segment and ?resource=, the unknown-resource
// 404, the Quoted-with-invoice filter in the SELECT, the bare-array shape, the 42P01
// (leads table absent) → empty-array degrade, and client release. The end-to-end SELECT
// is additionally round-tripped read-only against the Neon dev branch (see report).

process.env.JWT_SECRET = process.env.JWT_SECRET || 'smoke_secret';

const jwt = (await import('jsonwebtoken')).default;
const logisticsHandler = (await import('../lib/handlers/logistics.js')).default;

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ---- Fake pg client (records queries, returns scripted results) ---------------
function makeClient(scripts = []) {
  const calls = [];
  return {
    calls,
    released: false,
    release() { this.released = true; },
    async query(sql, params) {
      calls.push({ sql, params });
      for (const s of scripts) {
        if (typeof s.match === 'function' ? s.match(sql) : s.match.test(sql)) {
          if (s.throws) throw s.throws;
          return s.result ?? { rowCount: 0, rows: [] };
        }
      }
      return { rowCount: 0, rows: [] };
    },
  };
}
const depsFor = (client) => ({ getClient: async () => client });

function makeReq({ method = 'GET', roles = ['logistics'], id = 'LG', email = 'logistics@graysfitness.com.au', query = {}, noAuth = false } = {}) {
  const headers = {};
  if (!noAuth) headers.authorization = `Bearer ${jwt.sign({ id, email, roles }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
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

const AWAIT_RE = /FROM leads l/i;
const rowsResult = { rowCount: 2, rows: [
  { lead_id: 5, stage: 'Quoted', quote_invoice_id: '20431', order_total: 3590, customer_id: 26, customer_name: 'Demo Customer', source_channel: 'phone', updated_at: '2026-07-12T02:00:00Z' },
  { lead_id: 6, stage: 'Quoted', quote_invoice_id: '20500', order_total: 1795, customer_id: 555, customer_name: 'Another Customer', source_channel: 'email', updated_at: '2026-07-13T02:00:00Z' },
] };

console.log('Logistics queue (F7b) smoke — fake client, no DB\n');

// ---- auth + method gates (return before any DB) -------------------------------
console.log('auth / method gates:');
{
  const res = makeRes();
  await logisticsHandler(makeReq({ noAuth: true }), res, ['awaiting-workorder'], depsFor(makeClient()));
  check('401 without auth', res.statusCode === 401);
}
{
  const res = makeRes();
  await logisticsHandler(makeReq({ roles: ['sales'], query: { resource: 'awaiting-workorder' } }), res, [], depsFor(makeClient()));
  check('403 for a sales role (not logistics)', res.statusCode === 403);
}
{
  const res = makeRes();
  await logisticsHandler(makeReq({ roles: ['technician'], query: { resource: 'awaiting-workorder' } }), res, [], depsFor(makeClient()));
  check('403 for a technician role', res.statusCode === 403);
}
{
  const res = makeRes();
  await logisticsHandler(makeReq({ method: 'POST', query: { resource: 'awaiting-workorder' } }), res, [], depsFor(makeClient()));
  check('405 for a non-GET method', res.statusCode === 405 && res.headers.Allow?.includes('GET'));
}
{
  const res = makeRes();
  await logisticsHandler(makeReq({ query: { resource: 'nope' } }), res, [], depsFor(makeClient()));
  check('404 for an unknown resource', res.statusCode === 404);
}

// ---- GET awaiting-workorder — resource via QUERY form (the front-end path) -----
console.log('\nGET /api/logistics?resource=awaiting-workorder:');
{
  const client = makeClient([{ match: AWAIT_RE, result: rowsResult }]);
  const res = makeRes();
  await logisticsHandler(makeReq({ query: { resource: 'awaiting-workorder' } }), res, [], depsFor(client));
  check('200 returns a bare array of rows', res.statusCode === 200 && Array.isArray(res.body) && res.body.length === 2, `status ${res.statusCode}`);
  check('client released', client.released === true);
  const q = client.calls.find((c) => AWAIT_RE.test(c.sql));
  check('SELECT filters stage = Quoted', !!q && /stage = 'Quoted'::lead_stage/i.test(q.sql));
  check('SELECT requires a non-empty quote_invoice_id', !!q && /quote_invoice_id IS NOT NULL/i.test(q.sql) && /btrim\(l\.quote_invoice_id\) <> ''/i.test(q.sql));
  check('SELECT orders oldest-first (updated_at ASC)', !!q && /ORDER BY l\.updated_at ASC/i.test(q.sql));
}

// ---- resource via PATH segment (the fallback route form) ----------------------
console.log('\nGET /api/logistics/awaiting-workorder (path form):');
{
  const client = makeClient([{ match: AWAIT_RE, result: rowsResult }]);
  const res = makeRes();
  await logisticsHandler(makeReq(), res, ['awaiting-workorder'], depsFor(client));
  check('200 via the path segment too', res.statusCode === 200 && res.body.length === 2);
}

// ---- superadmin is allowed ----------------------------------------------------
console.log('\nrole coverage:');
{
  const client = makeClient([{ match: AWAIT_RE, result: rowsResult }]);
  const res = makeRes();
  await logisticsHandler(makeReq({ roles: ['superadmin'], query: { resource: 'awaiting-workorder' } }), res, [], depsFor(client));
  check('200 for superadmin', res.statusCode === 200);
}
{
  // a user holding BOTH sales + logistics still gets in (set membership)
  const client = makeClient([{ match: AWAIT_RE, result: { rowCount: 0, rows: [] } }]);
  const res = makeRes();
  await logisticsHandler(makeReq({ roles: ['sales', 'logistics'], query: { resource: 'awaiting-workorder' } }), res, [], depsFor(client));
  check('200 for a sales+logistics user', res.statusCode === 200 && Array.isArray(res.body));
}

// ---- degrade gracefully when leads is absent (42P01) --------------------------
console.log('\nbare-DB degrade:');
{
  const err = new Error('relation "leads" does not exist'); err.code = '42P01';
  const client = makeClient([{ match: AWAIT_RE, throws: err }]);
  const res = makeRes();
  await logisticsHandler(makeReq({ query: { resource: 'awaiting-workorder' } }), res, [], depsFor(client));
  check('200 empty array when leads table is missing (42P01)', res.statusCode === 200 && Array.isArray(res.body) && res.body.length === 0);
  check('client released after error', client.released === true);
}

console.log(`\n✅ logistics smoke: ${passed} checks passed`);
