// scripts/podium-integrations-smoke.mjs — offline smoke for F10 (Integrations observability).
//
// Exercises lib/handlers/integrations.js with an INJECTED fake pg client (deps.getClient)
// and fake req/res, so there is NO network, NO database, NO secrets:
//
//   node scripts/podium-integrations-smoke.mjs
//
// Covers: the superadmin gate (401/403); method + resource routing; the newest-first
// listing; the status/source/event_type/reference filters (all PARAMETERISED — a filter
// value must never reach the SQL text); the limit cap; the health summary that powers the
// failure alert; and the 42P01 (bare-DB) degrade.

process.env.JWT_SECRET = 'test-secret-for-integrations-smoke';

const jwt = (await import('jsonwebtoken')).default;
const handler = (await import('../lib/handlers/integrations.js')).default;

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ---- fakes -------------------------------------------------------------------
const tokenFor = (roles) => jwt.sign({ id: 'GS', email: 'a@b.c', roles }, process.env.JWT_SECRET);
const reqFor = (roles, query = {}, method = 'GET') => ({
  method,
  query,
  headers: roles ? { authorization: `Bearer ${tokenFor(roles)}` } : {},
});

function resSpy() {
  const out = { statusCode: null, body: null, headers: {} };
  return {
    out,
    setHeader(k, v) { out.headers[k] = v; },
    status(code) { out.statusCode = code; return this; },
    json(body) { out.body = body; return this; },
  };
}

const LOG_ROW = (over = {}) => ({
  id: 9, source: 'podium', direction: 'outbound', event_type: 'workorder.review_request',
  reference_id: 'review_request:42', status: 'sent', payload: { workorder_id: 42 },
  error: null, created_at: '2026-07-17T01:00:00.000Z', ...over,
});

// Scripted client: LIST_RE returns rows, SUMMARY_RE returns status counts.
const LIST_RE = /FROM integration_sync_log/i;
const SUMMARY_RE = /count\(\*\)/i;
function makeClient(scripts = []) {
  const calls = [];
  return {
    calls,
    released: 0,
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
    release() { this.released += 1; },
  };
}
const deps = (client) => ({ getClient: async () => client });

console.log('F10 Integrations observability smoke — fake client, no DB\n');

console.log('gate (superadmin-only ops page):');
{
  const res1 = resSpy();
  await handler(reqFor(null, { resource: 'sync-log' }), res1, [], deps(makeClient()));
  check('no token → 401', res1.out.statusCode === 401);

  const res2 = resSpy();
  await handler(reqFor(['sales'], { resource: 'sync-log' }), res2, [], deps(makeClient()));
  check('sales user → 403 (ops page, not a sales tool)', res2.out.statusCode === 403);

  const res3 = resSpy();
  await handler(reqFor(['logistics'], { resource: 'sync-log' }), res3, [], deps(makeClient()));
  check('logistics user → 403', res3.out.statusCode === 403);

  const client = makeClient([{ match: LIST_RE, result: { rowCount: 1, rows: [LOG_ROW()] } }]);
  const res4 = resSpy();
  await handler(reqFor(['superadmin'], { resource: 'sync-log' }), res4, [], deps(client));
  check('superadmin → 200', res4.out.statusCode === 200);
  check('a multi-role user holding superadmin also passes',
    (await (async () => { const r = resSpy(); await handler(reqFor(['sales', 'superadmin'], { resource: 'sync-log' }), r, [], deps(makeClient())); return r.out.statusCode; })()) === 200);
}

console.log('\nrouting:');
{
  const res1 = resSpy();
  await handler(reqFor(['superadmin'], { resource: 'sync-log' }, 'POST'), res1, [], deps(makeClient()));
  check('non-GET → 405', res1.out.statusCode === 405);
  check('405 advertises Allow: GET', String(res1.out.headers.Allow) === 'GET');

  const res2 = resSpy();
  await handler(reqFor(['superadmin'], { resource: 'nope' }), res2, [], deps(makeClient()));
  check('unknown resource → 404', res2.out.statusCode === 404);

  // The path form must work too, but the front-end uses ?resource= (Vercel multi-segment 404s).
  const res3 = resSpy();
  await handler(reqFor(['superadmin'], {}), res3, ['sync-log'], deps(makeClient()));
  check('path form resolves the same resource', res3.out.statusCode === 200);
}

console.log('\nlisting + summary:');
{
  const client = makeClient([
    { match: SUMMARY_RE, result: { rowCount: 1, rows: [{ total: '4', sent: '2', failed: '1', pending: '1', skipped: '0' }] } },
    { match: LIST_RE, result: { rowCount: 1, rows: [LOG_ROW()] } },
  ]);
  const res = resSpy();
  await handler(reqFor(['superadmin'], { resource: 'sync-log' }), res, [], deps(client));
  check('returns rows', Array.isArray(res.out.body?.rows) && res.out.body.rows.length === 1);
  check('returns a health summary (drives the failure alert)', res.out.body?.summary?.failed === 1 && res.out.body.summary.sent === 2);
  check('summary counts are numbers, not strings', typeof res.out.body.summary.total === 'number');
  const list = client.calls.find((c) => LIST_RE.test(c.sql) && /ORDER BY/i.test(c.sql));
  check('newest-first (an ops log reads top-down)', /ORDER BY\s+id\s+DESC/i.test(list.sql));
  check('client is released', client.released === 1);
}

console.log('\nfilters are parameterised (never string-interpolated):');
{
  const client = makeClient([{ match: LIST_RE, result: { rowCount: 0, rows: [] } }]);
  const res = resSpy();
  await handler(reqFor(['superadmin'], {
    resource: 'sync-log', status: 'failed', source: 'podium',
    event_type: 'workorder.review_request', q: "review_request:42'; DROP TABLE users;--",
  }), res, [], deps(client));
  // NB: pick the LIST query specifically — the summary query legitimately contains the
  // literal 'failed' inside its count(*) FILTER, which would mask an interpolation bug.
  const list = client.calls.find((c) => LIST_RE.test(c.sql) && /LIMIT/i.test(c.sql));
  check('status filter is a bound param', list.params.includes('failed') && !/status = 'failed'/.test(list.sql));
  check('source filter is a bound param', list.params.includes('podium') && !/'podium'/.test(list.sql));
  check('event_type filter is a bound param', list.params.includes('workorder.review_request'));
  check('a SQL-injection attempt stays in params, never in the SQL text', !/DROP TABLE/i.test(list.sql));
  check('reference search uses a bound LIKE pattern', list.params.some((p) => String(p).includes('DROP TABLE')));
}

console.log('\nlimit:');
{
  const client = makeClient([{ match: LIST_RE, result: { rowCount: 0, rows: [] } }]);
  const res = resSpy();
  await handler(reqFor(['superadmin'], { resource: 'sync-log', limit: '9999' }), res, [], deps(client));
  const list = client.calls.find((c) => LIST_RE.test(c.sql) && /LIMIT/i.test(c.sql));
  check('an absurd limit is capped (no unbounded scan)', list.params.includes(200));

  const client2 = makeClient([{ match: LIST_RE, result: { rowCount: 0, rows: [] } }]);
  const res2 = resSpy();
  await handler(reqFor(['superadmin'], { resource: 'sync-log', limit: 'abc' }), res2, [], deps(client2));
  const list2 = client2.calls.find((c) => LIST_RE.test(c.sql) && /LIMIT/i.test(c.sql));
  check('a junk limit falls back to the default', list2.params.includes(100));
}

console.log('\nbare-DB degrade (42P01):');
{
  const err = new Error('relation "integration_sync_log" does not exist'); err.code = '42P01';
  const client = makeClient([{ match: LIST_RE, throws: err }]);
  const res = resSpy();
  await handler(reqFor(['superadmin'], { resource: 'sync-log' }), res, [], deps(client));
  check('missing table → 200 with empty rows, not a 500', res.out.statusCode === 200 && res.out.body.rows.length === 0);
  check('client still released on the degrade path', client.released === 1);
}

console.log(`\n✅ integrations smoke: ${passed} checks passed`);
