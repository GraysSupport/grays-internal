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
const { clampLimit, filterUpdatedSince, resolveSelfPodiumUid, normalizeBucket, normalizeStatus } = await import('../lib/podiumInbox.js');
const { listConversations, listMessages, sendMessage, listMessageTemplates, postInternalNote } = await import('../lib/podium.js');
const inboxHandler = (await import('../lib/podiumRoutes/inbox.js')).default;

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
  check('all: unfiltered returns every fixture conversation', all.data.length === 6, `got ${all.data.length}`);
  check('all: cursor pagination envelope present', 'metadata' in all && 'nextCursor' in all.metadata);
}

// ---- F11 buckets: normalizers + unassigned/status filters (mock) --------------
console.log('\nF11 buckets (normalizers + filters):');
{
  check('normalizeBucket: default → mine', normalizeBucket(undefined) === 'mine' && normalizeBucket('nonsense') === 'mine');
  check('normalizeBucket: legacy scope=all → all', normalizeBucket('all') === 'all');
  check('normalizeBucket: unassigned', normalizeBucket('unassigned') === 'unassigned');
  check('normalizeStatus: open/closed pass through', normalizeStatus('open') === 'open' && normalizeStatus('closed') === 'closed');
  check('normalizeStatus: absent/all → null (no filter)', normalizeStatus(undefined) === null && normalizeStatus('all') === null);

  const unassigned = await listConversations('AM', { unassigned: true });
  check('unassigned: every row has no assignee', unassigned.data.every((c) => !c.assignedUser?.uid));
  check('unassigned: 2 fixtures (00003 open, 00006 closed)', unassigned.data.length === 2, `got ${unassigned.data.length}`);

  const open = await listConversations('AM', { status: 'open' });
  check('status=open: only open conversations', open.data.every((c) => (c.status || 'open') === 'open'));
  const closed = await listConversations('AM', { status: 'closed' });
  check('status=closed: only closed conversations', closed.data.every((c) => c.status === 'closed'));
  check('open + closed partition the 6 fixtures', open.data.length + closed.data.length === 6, `got ${open.data.length}+${closed.data.length}`);

  const mineClosed = await listConversations('AM', { assigneeUid: 'pod_usr_amELia', status: 'closed' });
  check('mine+closed: amELia has exactly 1 closed (00004)', mineClosed.data.length === 1 && mineClosed.data[0].uid === 'pod_cnv_00004', `got ${mineClosed.data.map((x) => x.uid)}`);
  const unassignedOpen = await listConversations('AM', { unassigned: true, status: 'open' });
  check('unassigned+open: exactly 1 (00003)', unassignedOpen.data.length === 1 && unassignedOpen.data[0].uid === 'pod_cnv_00003', `got ${unassignedOpen.data.map((x) => x.uid)}`);
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
  check('messages GET: 200 returns the live thread', res.statusCode === 200 && Array.isArray(res.body.data) && res.body.data.length === 4, `status ${res.statusCode}`);
  check('messages GET: mock flag surfaced', res.body.mock === true);
  // F13 sender attribution: outbound messages carry senderUser; 00001 is a two-rep thread.
  const outs = res.body.data.filter((m) => m.direction === 'outbound');
  check('messages GET: outbound messages carry a senderUser', outs.every((m) => m.senderUser?.uid));
  check('messages GET: two distinct outbound senders (multi-rep)', new Set(outs.map((m) => m.senderUser.uid)).size === 2);
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

// ---- resource=status — open/close a conversation ------------------------------
console.log('\ninbox resource=status (open/close):');
{
  const res = makeRes();
  await inboxHandler(makeReq({ method: 'GET', query: { resource: 'status' } }), res);
  check('status: 405 for GET', res.statusCode === 405);
}
{
  const res = makeRes();
  await inboxHandler(makeReq({ method: 'POST', query: { resource: 'status' }, body: { status: 'closed' } }), res);
  check('status: 400 without conversationId', res.statusCode === 400);
}
{
  const res = makeRes();
  await inboxHandler(makeReq({ method: 'POST', query: { resource: 'status' }, body: { conversationId: 'pod_cnv_00006', status: 'weird' } }), res);
  check('status: 400 for an invalid status value', res.statusCode === 400);
}
{
  const res = makeRes();
  await inboxHandler(makeReq({ method: 'POST', query: { resource: 'status' }, body: { conversationId: 'pod_cnv_00001', status: 'closed' } }), res);
  check('status: 200 close mutates the conversation', res.statusCode === 200 && res.body.status === 'closed' && res.body.conversation?.status === 'closed', `status ${res.statusCode}`);
  // The mock now returns it under the Closed bucket for the assignee.
  const closedForAmelia = await listConversations('AM', { assigneeUid: 'pod_usr_amELia', status: 'closed' });
  check('status: closed conversation moves into the Closed bucket', closedForAmelia.data.some((c) => c.uid === 'pod_cnv_00001'));
}

// ---- resource=conversation — single fetch for the funnel → chat deep-link -------
console.log('\ninbox resource=conversation (deep-link):');
{
  const res = makeRes();
  await inboxHandler(makeReq({ method: 'POST', query: { resource: 'conversation' } }), res);
  check('conversation: 405 for POST', res.statusCode === 405);
}
{
  const res = makeRes();
  await inboxHandler(makeReq({ method: 'GET', query: { resource: 'conversation' } }), res);
  check('conversation: 400 without conversationId', res.statusCode === 400);
}
{
  const res = makeRes();
  await inboxHandler(makeReq({ method: 'GET', query: { resource: 'conversation', conversationId: 'pod_cnv_00002' } }), res);
  check('conversation: 200 returns the single conversation', res.statusCode === 200 && res.body.conversation?.uid === 'pod_cnv_00002', `status ${res.statusCode}`);
}

// ---- direct helper sanity: sendMessage / listMessages via mock ----------------
console.log('\nmock helpers:');
{
  const sent = await sendMessage('AM', { conversationUid: 'pod_cnv_00003', body: 'Saturday pickup is 9–1.' });
  check('sendMessage: mock returns an outbound sent message', sent.direction === 'outbound' && sent.status === 'sent');
  const thread = await listMessages('AM', 'pod_cnv_00004', {});
  check('listMessages: mock returns the thread envelope', Array.isArray(thread.data) && thread.data.length === 2);
}

// ---- F12 rich messaging: templates -------------------------------------------
console.log('\nF12 resource=templates:');
{
  const res = makeRes();
  await inboxHandler(makeReq({ method: 'POST', query: { resource: 'templates' } }), res);
  check('templates: 405 for POST', res.statusCode === 405);
}
{
  const res = makeRes();
  await inboxHandler(makeReq({ method: 'GET', query: { resource: 'templates' } }), res);
  check('templates GET: 200 returns the template list', res.statusCode === 200 && Array.isArray(res.body.data) && res.body.data.length >= 3, `status ${res.statusCode}`);
  check('templates GET: each has uid/title/body', res.body.data.every((t) => t.uid && t.title && t.body));
  check('templates GET: mock flag surfaced', res.body.mock === true);
}
{
  const tpls = await listMessageTemplates('AM', { limit: 50 });
  check('listMessageTemplates: mock helper returns templates', Array.isArray(tpls.data) && tpls.data.length >= 3);
}

// ---- F12 rich messaging: internal notes --------------------------------------
console.log('\nF12 resource=note (internal notes):');
{
  const res = makeRes();
  await inboxHandler(makeReq({ method: 'GET', query: { resource: 'note' } }), res);
  check('note: 405 for GET', res.statusCode === 405);
}
{
  const res = makeRes();
  await inboxHandler(makeReq({ method: 'POST', query: { resource: 'note' }, body: { body: 'hi' } }), res);
  check('note: 400 without conversationId', res.statusCode === 400);
}
{
  const res = makeRes();
  await inboxHandler(makeReq({ method: 'POST', query: { resource: 'note' }, body: { conversationId: 'pod_cnv_00005' } }), res);
  check('note: 400 without a body', res.statusCode === 400);
}
{
  const before = (await listMessages('AM', 'pod_cnv_00005', {})).data.length;
  const res = makeRes();
  await inboxHandler(makeReq({ method: 'POST', query: { resource: 'note' }, body: { conversationId: 'pod_cnv_00005', body: 'Customer wants a callback Monday.' } }), res);
  check('note POST: 201 returns an internal note', res.statusCode === 201 && res.body.note?.internal === true && res.body.note?.direction === 'internal', `status ${res.statusCode}`);
  check('note POST: attributed to the acting rep (id only, P1)', res.body.note?.author === 'AM');
  const after = (await listMessages('AM', 'pod_cnv_00005', {})).data;
  check('note POST: appended to the thread (team-visible)', after.length === before + 1 && after[after.length - 1].internal === true, `before ${before} after ${after.length}`);
}
{
  const note = await postInternalNote('AM', { conversationUid: 'pod_cnv_00003', body: 'Direct helper note.', author: 'AM' });
  check('postInternalNote: mock helper returns an internal note', note.internal === true && note.body === 'Direct helper note.');
}

// ---- F12 rich messaging: attachments on send ---------------------------------
console.log('\nF12 resource=messages with attachments:');
{
  // body-less send is rejected only when there are also no attachments
  const res = makeRes();
  await inboxHandler(makeReq({ method: 'POST', query: { resource: 'messages' }, body: { conversationId: 'pod_cnv_00001', attachments: [] } }), res);
  check('messages POST: 400 with neither body nor attachment', res.statusCode === 400);
}
{
  const res = makeRes();
  await inboxHandler(makeReq({
    method: 'POST',
    query: { resource: 'messages' },
    body: { conversationId: 'pod_cnv_00001', attachments: [{ kind: 'image', filename: 'squat-rack.jpg', mimeType: 'image/jpeg', size: 12345 }] },
  }), res);
  check('messages POST: 201 attachment-only send is allowed', res.statusCode === 201, `status ${res.statusCode}`);
  check('messages POST: attachments echoed on the sent message', Array.isArray(res.body.sent?.attachments) && res.body.sent.attachments[0].kind === 'image' && res.body.sent.attachments[0].filename === 'squat-rack.jpg');
}
{
  const res = makeRes();
  await inboxHandler(makeReq({
    method: 'POST',
    query: { resource: 'messages' },
    body: { conversationId: 'pod_cnv_00001', body: 'See attached', templateId: 'pod_tpl_deliv', attachments: [{ kind: 'nonsense', filename: 'x'.repeat(500) }] },
  }), res);
  check('messages POST: 201 with body + template + attachment', res.statusCode === 201);
  check('messages POST: bad kind sanitised to file', res.body.sent?.attachments?.[0].kind === 'file');
  check('messages POST: long filename clamped to 200 chars', (res.body.sent?.attachments?.[0].filename || '').length === 200);
  check('messages POST: templateId echoed', res.body.sent?.templateId === 'pod_tpl_deliv');
}

// ---- F13 multi-assignee: mine-filter membership + reps route gates ------------
console.log('\nF13 multi-assignee:');
{
  // 00001 is assigned to Amelia AND Ben → it appears in BOTH reps' "mine" buckets.
  const amMine = await listConversations('AM', { assigneeUid: 'pod_usr_amELia' });
  const bnMine = await listConversations('AM', { assigneeUid: 'pod_usr_bENjin' });
  check('mine: 00001 (shared) appears for Amelia', amMine.data.some((c) => c.uid === 'pod_cnv_00001'));
  check('mine: 00001 (shared) also appears for Ben', bnMine.data.some((c) => c.uid === 'pod_cnv_00001'));
  check('mine: Ben also owns his own convos (00002/00005)', bnMine.data.some((c) => c.uid === 'pod_cnv_00002'));
}
{
  const res = makeRes();
  await inboxHandler(makeReq({ method: 'POST', query: { resource: 'reps' } }), res);
  check('reps: 405 for POST', res.statusCode === 405);
}
{
  const res = makeRes();
  await inboxHandler(makeReq({ noAuth: true, query: { resource: 'reps' } }), res);
  check('reps: 401 without auth', res.statusCode === 401);
}
{
  const res = makeRes();
  await inboxHandler(makeReq({ roles: ['technician'], query: { resource: 'reps' } }), res);
  check('reps: 403 for a non-sales role', res.statusCode === 403);
}

console.log(`\n✅ inbox smoke: ${passed} checks passed`);
