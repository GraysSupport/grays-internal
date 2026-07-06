// scripts/podium-assign-smoke.mjs — offline smoke for the F1b assignment glue + endpoint.
//
// Covers the pure/mock-safe logic added in F1b (portal → Podium direction): the
// lib/podiumAssign.js helpers (resolvePodiumUserId, mirrorAssignmentToLead) exercised
// with INJECTED fake pg clients, the mock Podium assign/read helpers, and the
// api/podium/assign.js auth/validation gates that run BEFORE any DB access. NO network,
// NO database, NO real secrets:
//
//   node scripts/podium-assign-smoke.mjs
//
// The DB-touching happy paths (POST assign, GET assignee) are validated separately
// against the Neon dev branch (leads mirror + users resolution round-trip) — see the
// F1b report. `getClientWithTimezone()`'s pool is lazy, so importing the endpoint here
// opens no connection as long as we only hit its pre-DB branches.

process.env.PODIUM_MOCK = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'smoke_secret';
process.env.PODIUM_API_VERSION = process.env.PODIUM_API_VERSION || '2021-04-01';

const jwt = (await import('jsonwebtoken')).default;
const { resolvePodiumUserId, mirrorAssignmentToLead } = await import('../lib/podiumAssign.js');
const { assignConversation, getAssignee } = await import('../lib/podium.js');
const assignHandler = (await import('../api/podium/assign.js')).default;

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ---- Fake pg client: records queries, returns scripted results ----------------
function makeClient(scripts = []) {
  // `scripts` = array of { match:(sql)=>bool, result } OR a default {result}. Each call
  // records the (sql, params) and returns the first matching scripted result.
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const s of scripts) {
        if (typeof s.match === 'function' ? s.match(sql) : true) {
          if (s.throws) throw s.throws;
          return s.result ?? { rowCount: 0, rows: [] };
        }
      }
      return { rowCount: 0, rows: [] };
    },
  };
}
function err(code) { const e = new Error(code); e.code = code; return e; }

// ---- req/res doubles (Vercel Node handler shape) ------------------------------
function makeReq({ method = 'GET', roles = ['sales'], id = 'AM', email = 'amelia@graysfitness.com.au', query = {}, body = {}, noAuth = false } = {}) {
  const headers = {};
  if (!noAuth) headers.authorization = `Bearer ${jwt.sign({ id, email, roles }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
  return { method, headers, query, body };
}
function makeRes() {
  return {
    statusCode: 0, body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
  };
}

console.log('Podium assignment (F1b) smoke (PODIUM_MOCK=true)\n');

// 1. resolvePodiumUserId — fast path: already-linked target, no API/UPDATE
{
  const client = makeClient();
  const uid = await resolvePodiumUserId(client, 'AM', { id: 'BN', email: 'x@y.z', podium_user_id: 'pod_usr_bENjin' });
  check('resolve: returns stored podium_user_id on fast path', uid === 'pod_usr_bENjin');
  check('resolve: fast path issues no DB query', client.calls.length === 0);
}

// 2. resolvePodiumUserId — fallback: email matches a mock Podium user → resolves + persists
{
  const client = makeClient([{ match: (s) => /UPDATE users/i.test(s), result: { rowCount: 1 } }]);
  const uid = await resolvePodiumUserId(client, 'AM', { id: 'AM', email: 'amelia@graysfitness.com.au' });
  check('resolve: fallback matches mock user by email', uid === 'pod_usr_amELia', `got ${uid}`);
  check('resolve: fallback persists the resolved uid (UPDATE users)', client.calls.some((c) => /UPDATE users/i.test(c.sql)));
}

// 3. resolvePodiumUserId — target with no email → null (can't resolve)
{
  const uid = await resolvePodiumUserId(makeClient(), 'AM', { id: 'ZZ', email: null });
  check('resolve: null when target has no email', uid === null);
}

// 4. resolvePodiumUserId — email that matches no Podium member → null
{
  const uid = await resolvePodiumUserId(makeClient(), 'AM', { id: 'ZZ', email: 'nobody@nowhere.example' });
  check('resolve: null when no Podium member matches', uid === null);
}

// 5. mirrorAssignmentToLead — returns the DB rowCount
{
  const client = makeClient([{ match: (s) => /UPDATE leads/i.test(s), result: { rowCount: 2 } }]);
  const n = await mirrorAssignmentToLead(client, 'pod_cnv_00001', 'AM');
  check('mirror: returns rows updated', n === 2);
  const call = client.calls.find((c) => /UPDATE leads/i.test(c.sql));
  check('mirror: filters by podium_conversation_id', call && call.params[1] === 'pod_cnv_00001');
  check('mirror: sets assigned_to to the owner', call && call.params[0] === 'AM');
}

// 6. mirrorAssignmentToLead — leads table missing (42P01) → 0, not a throw
{
  const client = makeClient([{ match: (s) => /UPDATE leads/i.test(s), throws: err('42P01') }]);
  const n = await mirrorAssignmentToLead(client, 'pod_cnv_00001', 'AM');
  check('mirror: 0 (not error) when leads table absent (42P01)', n === 0);
}

// 7. mirrorAssignmentToLead — empty conversationUid → 0, no query
{
  const client = makeClient();
  const n = await mirrorAssignmentToLead(client, '', 'AM');
  check('mirror: 0 and no query for empty conversationUid', n === 0 && client.calls.length === 0);
}

// 8. mirrorAssignmentToLead — clearing an owner passes NULL through
{
  const client = makeClient([{ match: (s) => /UPDATE leads/i.test(s), result: { rowCount: 1 } }]);
  await mirrorAssignmentToLead(client, 'pod_cnv_00003', null);
  const call = client.calls.find((c) => /UPDATE leads/i.test(c.sql));
  check('mirror: null owner is passed as NULL', call && call.params[0] === null);
}

// 9. assignConversation (mock) — echoes the new assignee
{
  const r = await assignConversation('AM', 'pod_cnv_00003', 'pod_usr_amELia');
  check('assignConversation: mock echoes assigned member', r?.assignedUser?.uid === 'pod_usr_amELia');
  check('assignConversation: mock echoes conversation', r?.conversationUid === 'pod_cnv_00003');
}

// 10. getAssignee (mock) — reads the fixture assignee
{
  const r = await getAssignee('AM', 'pod_cnv_00001');
  check('getAssignee: mock returns fixture assignee', r?.assignedUser?.uid === 'pod_usr_amELia');
}

// 11. endpoint gates (all reached BEFORE any DB access → offline-safe)
{
  const res = makeRes();
  await assignHandler(makeReq({ noAuth: true }), res);
  check('endpoint: 401 when unauthenticated', res.statusCode === 401);
}
{
  const res = makeRes();
  await assignHandler(makeReq({ roles: ['technician'] }), res);
  check('endpoint: 403 without sales/superadmin', res.statusCode === 403);
}
{
  const res = makeRes();
  await assignHandler(makeReq({ method: 'DELETE', roles: ['sales'] }), res);
  check('endpoint: 405 on unsupported method', res.statusCode === 405);
}
{
  const res = makeRes();
  await assignHandler(makeReq({ method: 'GET', roles: ['sales'], query: {} }), res);
  check('endpoint: GET 400 without conversationId', res.statusCode === 400);
}
{
  const res = makeRes();
  await assignHandler(makeReq({ method: 'POST', roles: ['superadmin'], body: {} }), res);
  check('endpoint: POST 400 without conversationId', res.statusCode === 400);
}

console.log(`\nAll ${passed} checks passed ✅`);
