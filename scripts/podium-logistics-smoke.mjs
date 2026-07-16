// scripts/podium-logistics-smoke.mjs — offline smoke for the F7b/F7c logistics handler.
//
// Exercises lib/handlers/logistics.js with an INJECTED fake pg client (deps.getClient), so
// there is NO network, NO database, NO secrets:
//
//   node scripts/podium-logistics-smoke.mjs
//
// F7b (GET queue) covers: auth/role gates (logistics + superadmin allowed, others 403),
// method gate, resource resolution from BOTH the path segment and ?resource=, the
// unknown-resource 404, the Quoted-with-invoice filter in the SELECT, the bare-array
// shape, the 42P01 (leads table absent) → empty-array degrade, and client release.
//
// F7c (POST confirm-payment) covers: the auth/role gate on POST, body validation
// (payment type, delivery_state, lead_time, exception-needs-note), the lead guards
// (404 not-found, 409 not-Quoted, 409 already-converted, 400 missing invoice/customer/
// order_total), the outstanding-balance math (paid_full → 0, deposit_50 → half,
// exception → explicit), the workorder INSERT + WORKORDER_CREATED log, the lead → Won
// UPDATE + Quoted→Won lead_stage_log, transaction (BEGIN/COMMIT, ROLLBACK on guard),
// and client release. The end-to-end SELECT is additionally round-tripped read-only
// against the Neon dev branch (see report).

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

// ===========================================================================
// F7c — POST /api/logistics?resource=confirm-payment
// ===========================================================================

const LEAD_SEL_RE   = /FROM leads\b[\s\S]*FOR UPDATE/i;
const WO_INSERT_RE  = /INSERT INTO workorder\s*\(/i;      // the table, not workorder_logs
const WO_LOG_RE     = /INSERT INTO workorder_logs/i;
const LEAD_UPD_RE   = /UPDATE leads\b/i;
const STAGE_LOG_RE  = /INSERT INTO lead_stage_log/i;

// A Quoted lead ready to convert (has invoice + customer + order_total, not yet converted).
function quotedLead(overrides = {}) {
  return {
    lead_id: 5, stage: 'Quoted', customer_id: 26, assigned_to: 'BR',
    quote_invoice_id: 'DEMO-20431', order_total: 3590, converted_workorder_id: null,
    ...overrides,
  };
}

// Fake client that plays the confirm-payment happy path (lead lookup → WO insert → logs).
function confirmClient(lead = quotedLead()) {
  return makeClient([
    { match: (s) => LEAD_SEL_RE.test(s), result: { rowCount: lead ? 1 : 0, rows: lead ? [lead] : [] } },
    { match: (s) => WO_INSERT_RE.test(s), result: { rowCount: 1, rows: [{ workorder_id: 987 }] } },
    { match: (s) => WO_LOG_RE.test(s),    result: { rowCount: 1, rows: [] } },
    { match: (s) => LEAD_UPD_RE.test(s),  result: { rowCount: 1, rows: [] } },
    { match: (s) => STAGE_LOG_RE.test(s), result: { rowCount: 1, rows: [] } },
  ]);
}

function confirmBody(overrides = {}) {
  return {
    lead_id: 5, payment: 'paid_full',
    delivery_state: 'VIC', lead_time: '2 Weeks',
    ...overrides,
  };
}
function makePost(body, { roles = ['logistics'], noAuth = false } = {}) {
  const req = makeReq({ method: 'POST', roles, query: { resource: 'confirm-payment' }, noAuth });
  req.body = body;
  return req;
}

console.log('\nPOST confirm-payment — gates & validation:');
{
  const res = makeRes();
  await logisticsHandler(makePost(confirmBody(), { noAuth: true }), res, [], depsFor(makeClient()));
  check('401 without auth', res.statusCode === 401);
}
{
  const res = makeRes();
  await logisticsHandler(makePost(confirmBody(), { roles: ['sales'] }), res, [], depsFor(makeClient()));
  check('403 for a sales role', res.statusCode === 403);
}
{
  const res = makeRes();
  await logisticsHandler(makePost(confirmBody({ lead_id: undefined })), res, [], depsFor(makeClient()));
  check('400 without lead_id', res.statusCode === 400);
}
{
  const res = makeRes();
  await logisticsHandler(makePost(confirmBody({ payment: 'wat' })), res, [], depsFor(makeClient()));
  check('400 for an invalid payment type', res.statusCode === 400);
}
{
  const res = makeRes();
  await logisticsHandler(makePost(confirmBody({ payment: 'exception' })), res, [], depsFor(makeClient()));
  check('400 for exception without a note', res.statusCode === 400 && res.body?.code === 'PAYMENT_NOTE_REQUIRED');
}
{
  const res = makeRes();
  await logisticsHandler(makePost(confirmBody({ delivery_state: 'ZZ' })), res, [], depsFor(makeClient()));
  check('400 for an invalid delivery_state', res.statusCode === 400);
}
{
  const res = makeRes();
  await logisticsHandler(makePost(confirmBody({ lead_time: '9 Weeks' })), res, [], depsFor(makeClient()));
  check('400 for an invalid lead_time', res.statusCode === 400);
}

console.log('\nPOST confirm-payment — lead guards:');
{
  const res = makeRes();
  const client = confirmClient(null); // lead not found
  await logisticsHandler(makePost(confirmBody()), res, [], depsFor(client));
  check('404 when the lead does not exist', res.statusCode === 404);
  check('ROLLBACK issued on the missing-lead guard', client.calls.some((c) => /ROLLBACK/i.test(c.sql)));
  check('client released', client.released === true);
}
{
  const res = makeRes();
  const client = confirmClient(quotedLead({ converted_workorder_id: 111 }));
  await logisticsHandler(makePost(confirmBody()), res, [], depsFor(client));
  check('409 when the lead is already converted', res.statusCode === 409 && res.body?.code === 'WORKORDER_EXISTS');
  check('no workorder INSERT after the already-converted guard', !client.calls.some((c) => WO_INSERT_RE.test(c.sql)));
}
{
  const res = makeRes();
  const client = confirmClient(quotedLead({ stage: 'Contacted' }));
  await logisticsHandler(makePost(confirmBody()), res, [], depsFor(client));
  check('409 when the lead is not Quoted', res.statusCode === 409 && res.body?.code === 'LEAD_NOT_QUOTED');
}
{
  const res = makeRes();
  const client = confirmClient(quotedLead({ quote_invoice_id: null }));
  await logisticsHandler(makePost(confirmBody()), res, [], depsFor(client));
  check('400 when the lead has no invoice', res.statusCode === 400 && res.body?.code === 'INVOICE_REQUIRED');
}
{
  const res = makeRes();
  const client = confirmClient(quotedLead({ customer_id: null }));
  await logisticsHandler(makePost(confirmBody()), res, [], depsFor(client));
  check('400 when the lead has no customer', res.statusCode === 400 && res.body?.code === 'CUSTOMER_REQUIRED');
}
{
  const res = makeRes();
  const client = confirmClient(quotedLead({ order_total: null }));
  await logisticsHandler(makePost(confirmBody({ payment: 'deposit_50' })), res, [], depsFor(client));
  check('400 deposit_50 without an order total', res.statusCode === 400 && res.body?.code === 'ORDER_TOTAL_REQUIRED');
}

console.log('\nPOST confirm-payment — happy paths (WO create + lead → Won):');
{
  const res = makeRes();
  const client = confirmClient();
  await logisticsHandler(makePost(confirmBody({ payment: 'paid_full' })), res, [], depsFor(client));
  check('201 on success', res.statusCode === 201, `status ${res.statusCode}`);
  check('returns the new workorder_id', res.body?.workorder_id === 987);
  check('paid_full → outstanding_balance 0', Number(res.body?.outstanding_balance) === 0);
  check('BEGIN + COMMIT wrap the write', client.calls.some((c) => /BEGIN/i.test(c.sql)) && client.calls.some((c) => /COMMIT/i.test(c.sql)));
  const woIns = client.calls.find((c) => WO_INSERT_RE.test(c.sql));
  check('workorder INSERT carries the invoice_id from the lead', !!woIns && woIns.params.includes('DEMO-20431'));
  check('workorder INSERT status defaults to Work Ordered', !!woIns && woIns.params.includes('Work Ordered'));
  check('WORKORDER_CREATED logged', client.calls.some((c) => WO_LOG_RE.test(c.sql) && (c.params || []).includes('WORKORDER_CREATED')));
  const leadUpd = client.calls.find((c) => LEAD_UPD_RE.test(c.sql));
  check('lead UPDATE sets stage Won', !!leadUpd && /stage\s*=\s*'Won'/i.test(leadUpd.sql));
  check('lead UPDATE stamps converted_workorder_id', !!leadUpd && /converted_workorder_id/i.test(leadUpd.sql) && (leadUpd.params || []).includes(987));
  const stageLog = client.calls.find((c) => STAGE_LOG_RE.test(c.sql));
  check('lead_stage_log records Quoted → Won', !!stageLog && /'Quoted'::lead_stage/i.test(stageLog.sql) && /'Won'::lead_stage/i.test(stageLog.sql));
  check('client released', client.released === true);
}
{
  const res = makeRes();
  const client = confirmClient();
  await logisticsHandler(makePost(confirmBody({ payment: 'deposit_50' })), res, [], depsFor(client));
  check('deposit_50 → outstanding_balance is half the order total', Number(res.body?.outstanding_balance) === 1795);
}
{
  const res = makeRes();
  const client = confirmClient();
  await logisticsHandler(makePost(confirmBody({ payment: 'exception', payment_note: 'Partial deposit agreed', outstanding_balance: 1000 })), res, [], depsFor(client));
  check('exception → uses the explicit outstanding_balance', res.statusCode === 201 && Number(res.body?.outstanding_balance) === 1000);
  const leadUpd = client.calls.find((c) => LEAD_UPD_RE.test(c.sql));
  check('exception note is persisted on the lead', !!leadUpd && (leadUpd.params || []).includes('Partial deposit agreed'));
}

console.log(`\n✅ logistics smoke: ${passed} checks passed`);
