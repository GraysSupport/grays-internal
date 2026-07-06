// scripts/podium-inbox-smoke.mjs — offline smoke for the F3 inbox live-proxy layer.
//
// Covers the pure/mock-safe logic added in F3 increment 1: the lib/podiumInbox.js
// helpers (clampLimit, filterUpdatedSince, resolveSelfPodiumUid with an INJECTED fake
// pg client), the mock Podium read/send helpers used by the endpoint, and the single
// api/podium/inbox.js dispatcher's auth/validation gates (resource=conversations|
// messages|poll). NO network, NO database, NO real secrets:
//
//   node scripts/podium-inbox-smoke.mjs
//
// (One dispatcher file, not three: the Vercel project is on the Hobby plan, capped at
// 12 Serverless Functions per deployment.) The messages resource opens no DB client, so
// its GET/POST happy paths run fully here. The conversations/poll resources open
// getClientWithTimezone() (a live connection), so only their pre-DB gates are exercised
// here; the mine-filter logic is validated directly via resolveSelfPodiumUid +
// listConversations(assigneeUid) below, and the end-to-end mine view is checked against
// the Neon dev branch separately (see report). getClientWithTimezone()'s pool is lazy,
// so importing the handler opens no connection as long as we only hit pre-DB branches.

process.env.PODIUM_MOCK = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'smoke_secret';
process.env.PODIUM_API_VERSION = process.env.PODIUM_API_VERSION || '2021-04-01';

const jwt = (await import('jsonwebtoken')).default;
const { clampLimit, filterUpdatedSince, resolveSelfPodiumUid } = await import('../lib/podiumInbox.js');
const { listConversations, listMessages, sendMessage } = await import('../lib/podium.js');
const inboxHandler = (await import('../api/podium/inbox.js')).default;

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

console.log('Podium inbox (F3 incr 1) smoke (PODIUM_MOCK=true)\n');

// ---- clampLimit ---------------------------------------------------------------
console.log('clampLimit:');
check('clamp: default when non-numeric', clampLimit(undefined, 30) === 30);
check('clamp: floors at 1', clampLimit('0') === 1);
check('clamp: caps at 100', clampLimit('9999') === 100);
check('clamp: passes a valid value through', clampLimit('42') === 42);

// ---- filterUpdatedSince (pure poll helper) ------------------------------------
console.log('\nfilterUpdatedSince:');
{
  const convs = [
    { uid: 'a', lastMessageAt: '2026-07-03T09:15:00+10:00' },
    { uid: 'b', lastMessageAt: '2026-07-02T16:40:00+10:00' },
    { uid: 'c', lastMessageAt: '2026-07-01T11:20:00+10:00' },
  ];
  check('filter: no `since` returns all (first poll)', filterUpdatedSince(convs, null).length === 3);
  const since = '2026-07-02T18:00:00+10:00';
  const got = filterUpdatedSince(convs, since);
  check('filter: keeps only conversations newer than `since`', got.length === 1 && got[0].uid === 'a', `got ${got.map((x) => x.uid)}`);
  check('filter: strictly-greater (equal timestamp excluded)', filterUpdatedSince(convs, '2026-07-03T09:15:00+10:00').length === 0);
  check('filter: unparseable timestamp is surfaced, not dropped', filterUpdatedSince([{ uid: 'x', lastMessageAt: 'not-a-date' }], since).length === 1);
  check('filter: empty/undefined input → []', filterUpdatedSince(undefined, since).length === 0);
}

// ---- resolveSelfPodiumUid (mine-view resolution) ------------------------------
console.log('\nresolveSelfPodiumUid:');
{
  // fast path: rep already has a stored podium_user_id → one SELECT, no getUsers/UPDATE
  const client = makeClient([{ match: (s) => /SELECT .*FROM users/i.test(s), result: { rowCount: 1, rows: [{ id: 'AM', email: 'amelia@graysfitness.com.au', podium_user_id: 'pod_usr_amELia' }] } }]);
  const uid = await resolveSelfPodiumUid(client, { id: 'AM', email: 'amelia@graysfitness.com.au' });
  check('self: returns stored podium_user_id on fast path', uid === 'pod_usr_amELia', `got ${uid}`);
  check('self: fast path issues exactly one query (the users SELECT)', client.calls.length === 1);
}
{
  // fallback: no stored id, email matches a mock Podium member → resolves + persists
  const client = makeClient([
    { match: (s) => /SELECT .*FROM users/i.test(s), result: { rowCount: 1, rows: [{ id: 'AM', email: 'amelia@graysfitness.com.au', podium_user_id: null }] } },
    { match: (s) => /UPDATE users/i.test(s), result: { rowCount: 1 } },
  ]);
  const uid = await resolveSelfPodiumUid(client, { id: 'AM', email: 'amelia@graysfitness.com.au' });
  check('self: fallback resolves via GET /v4/users email match', uid === 'pod_usr_amELia', `got ${uid}`);
  check('self: fallback persists the resolved uid (UPDATE users)', client.calls.some((c) => /UPDATE users/i.test(c.sql)));
}
{
  // rep row not found → null (empty "mine" view)
  const client = makeClient([{ match: (s) => /SELECT .*FROM users/i.test(s), result: { rowCount: 0, rows: [] } }]);
  const uid = await resolveSelfPodiumUid(client, { id: 'ZZ', email: 'nobody@nowhere.example' });
  check('self: null when the rep row is missing', uid === null);
}
{
  // no stored id + email matches nothing → null
  const client = makeClient([{ match: (s) => /SELECT .*FROM users/i.test(s), result: { rowCount: 1, rows: [{ id: 'ZZ', email: 'nobody@nowhere.example', podium_user_id: null }] } }]);
  const uid = await resolveSelfPodiumUid(client, { id: 'ZZ', email: 'nobody@nowhere.example' });
  check('self: null when no Podium member matches the rep', uid === null);
}

// ---- mine-filter logic via the mock (assignee filter) -------------------------
console.log('\nlistConversations mine-filter (mock):');
{
  const mine = await listConversations('AM', { assigneeUid: 'pod_usr_amELia' });
  check('mine: filters by assignee uid', Array.isArray(mine.data) && mine.data.every((c) => c.assignedUser?.uid === 'pod_usr_amELia'));
  check('mine: amELia owns 2 fixture conversations', mine.data.length === 2, `got ${mine.data.length}`);
  const all = await listConversations('AM', {});
  check('all: unfiltered returns every fixture conversation', all.data.length === 5, `got ${all.data.length}`);
  check('all: cursor pagination envelope present', 'metadata' in all && 'nextCursor' in all.metadata);
}

// ---- inbox.js dispatcher — top-level gates + unknown resource -----------------
console.log('\napi/podium/inbox.js (dispatcher gates):');
{
  const res = makeRes();
  await inboxHandler(makeReq({ noAuth: true, query: { resource: 'conversations' } }), res);
  check('inbox: 401 without auth', res.statusCode === 401);
}
{
  const res = makeRes();
  await inboxHandler(makeReq({ roles: ['technician'], query: { resource: 'messages' } }), res);
  check('inbox: 403 for a non-sales role', res.statusCode === 403);
}
{
  const res = makeRes();
  await inboxHandler(makeReq({ query: { resource: 'wat' } }), res);
  check('inbox: 400 for an unknown resource', res.statusCode === 400);
}
{
  const res = makeRes();
  await inboxHandler(makeReq({ query: {} }), res);
  check('inbox: 400 when resource is missing', res.statusCode === 400);
}

// ---- resource=messages — full happy paths (no DB client) ----------------------
console.log('\ninbox resource=messages:');
{
  const res = makeRes();
  await inboxHandler(makeReq({ method: 'PUT', query: { resource: 'messages' } }), res);
  check('messages: 405 for an unsupported method', res.statusCode === 405);
}
{
  const res = makeRes();
  await inboxHandler(makeReq({ method: 'GET', query: { resource: 'messages' } }), res);
  check('messages GET: 400 without conversationId', res.statusCode === 400);
}
{
  const res = makeRes();
  await inboxHandler(makeReq({ method: 'GET', query: { resource: 'messages', conversationId: 'pod_cnv_00001' } }), res);
  check('messages GET: 200 returns the live thread', res.statusCode === 200 && Array.isArray(res.body.data) && res.body.data.length === 3, `status ${res.statusCode}`);
  check('messages GET: mock flag surfaced', res.body.mock === true);
}
{
  const res = makeRes();
  await inboxHandler(makeReq({ method: 'GET', query: { resource: 'messages', conversationId: 'pod_cnv_nope' } }), res);
  check('messages GET: 404 for an unknown conversation', res.statusCode === 404, `status ${res.statusCode}`);
}
{
  const res = makeRes();
  await inboxHandler(makeReq({ method: 'POST', query: { resource: 'messages' }, body: { conversationId: 'pod_cnv_00001' } }), res);
  check('messages POST: 400 without a body', res.statusCode === 400);
}
{
  const res = makeRes();
  await inboxHandler(makeReq({ method: 'POST', query: { resource: 'messages' }, body: { conversationId: 'pod_cnv_00001', body: 'On my way!' } }), res);
  check('messages POST: 201 send returns the upstream result', res.statusCode === 201 && res.body.sent?.status === 'sent', `status ${res.statusCode}`);
}

// ---- resource=conversations|poll — pre-DB gates only --------------------------
console.log('\ninbox resource=conversations|poll (gates):');
for (const resource of ['conversations', 'poll']) {
  {
    const res = makeRes();
    await inboxHandler(makeReq({ noAuth: true, query: { resource } }), res);
    check(`${resource}: 401 without auth`, res.statusCode === 401);
  }
  {
    const res = makeRes();
    await inboxHandler(makeReq({ roles: ['technician'], query: { resource } }), res);
    check(`${resource}: 403 for a non-sales role`, res.statusCode === 403);
  }
  {
    const res = makeRes();
    await inboxHandler(makeReq({ method: 'POST', query: { resource } }), res);
    check(`${resource}: 405 for an unsupported method`, res.statusCode === 405);
  }
}

// ---- direct helper sanity: sendMessage / listMessages via mock ----------------
console.log('\nmock helpers:');
{
  const sent = await sendMessage('AM', { conversationUid: 'pod_cnv_00003', body: 'Saturday pickup is 9–1.' });
  check('sendMessage: mock returns an outbound sent message', sent.direction === 'outbound' && sent.status === 'sent');
  const thread = await listMessages('AM', 'pod_cnv_00004', {});
  check('listMessages: mock returns the thread envelope', Array.isArray(thread.data) && thread.data.length === 2);
}

console.log(`\n✅ inbox smoke: ${passed} checks passed`);
