// scripts/podium-leads-smoke.mjs — offline smoke for the F5 lead-funnel handler.
//
// Exercises lib/handlers/leads.js with an INJECTED fake pg client (deps.getClient), so
// there is NO network, NO database, NO secrets:
//
//   node scripts/podium-leads-smoke.mjs
//
// Covers: auth/role gates, routing (list/create/getById/stage), stage validation
// (invalid stage, Lost-requires-reason), the NULL→New create log, from→to transition
// logging, the no-op transition (no spurious log), and 404s. The end-to-end SQL is
// additionally round-tripped against the Neon dev branch (see report).

process.env.JWT_SECRET = process.env.JWT_SECRET || 'smoke_secret';

const jwt = (await import('jsonwebtoken')).default;
const leadsHandler = (await import('../lib/handlers/leads.js')).default;
const { STAGES, LOST_REASONS } = await import('../lib/handlers/leads.js');

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

function makeReq({ method = 'GET', roles = ['sales'], id = 'SA', email = 'sales@graysfitness.com.au', query = {}, body = {}, noAuth = false } = {}) {
  const headers = {};
  if (!noAuth) headers.authorization = `Bearer ${jwt.sign({ id, email, roles }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
  return { method, headers, query, body };
}
function makeRes() {
  return {
    statusCode: 0, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
  };
}

console.log('Lead funnel (F5) smoke — fake client, no DB\n');

// ---- exported constants -------------------------------------------------------
console.log('STAGES:');
check('STAGES: Payment Received merged into Won', JSON.stringify(STAGES) === JSON.stringify(['New', 'Contacted', 'Quoted', 'Won', 'Lost']));
check('LOST_REASONS include Other', Array.isArray(LOST_REASONS) && LOST_REASONS.includes('Other') && LOST_REASONS.length >= 5);

// ---- auth gates (return before any DB) ----------------------------------------
console.log('\nauth gates:');
{
  const res = makeRes();
  await leadsHandler(makeReq({ noAuth: true }), res, [], depsFor(makeClient()));
  check('401 without auth', res.statusCode === 401);
}
{
  const res = makeRes();
  await leadsHandler(makeReq({ roles: ['technician'] }), res, [], depsFor(makeClient()));
  check('403 for a non-sales role', res.statusCode === 403);
}
{
  const res = makeRes();
  await leadsHandler(makeReq({ roles: ['superadmin'], method: 'DELETE' }), res, [], depsFor(makeClient()));
  check('405 for an unsupported method', res.statusCode === 405);
}

// ---- GET list -----------------------------------------------------------------
console.log('\nGET /api/leads:');
{
  const client = makeClient([{ match: /FROM leads l/i, result: { rowCount: 2, rows: [{ lead_id: 1, stage: 'New' }, { lead_id: 2, stage: 'Won' }] } }]);
  const res = makeRes();
  await leadsHandler(makeReq(), res, [], depsFor(client));
  check('200 returns the board rows', res.statusCode === 200 && Array.isArray(res.body) && res.body.length === 2, `status ${res.statusCode}`);
  check('client released', client.released === true);
}
{
  // ?stage= filter adds a WHERE clause
  const client = makeClient([{ match: /FROM leads l/i, result: { rowCount: 1, rows: [{ lead_id: 3, stage: 'Quoted' }] } }]);
  const res = makeRes();
  await leadsHandler(makeReq({ query: { stage: 'Quoted' } }), res, [], depsFor(client));
  const listCall = client.calls.find((c) => /FROM leads l/i.test(c.sql));
  check('stage filter param passed', res.statusCode === 200 && listCall.params.includes('Quoted'));
}

// ---- POST create --------------------------------------------------------------
console.log('\nPOST /api/leads:');
{
  const res = makeRes();
  await leadsHandler(makeReq({ method: 'POST', body: {} }), res, [], depsFor(makeClient()));
  check('400 when neither product_interest nor customer given', res.statusCode === 400);
}
{
  const client = makeClient([
    { match: /INSERT INTO leads/i, result: { rowCount: 1, rows: [{ lead_id: 99 }] } },
    { match: /FROM leads l/i, result: { rowCount: 1, rows: [{ lead_id: 99, stage: 'New', product_interest: 'Rowing machine' }] } },
  ]);
  const res = makeRes();
  await leadsHandler(makeReq({ method: 'POST', body: { product_interest: 'Rowing machine', value_est: 1795, source_channel: 'phone' } }), res, [], depsFor(client));
  check('201 create returns the new lead', res.statusCode === 201 && res.body.lead_id === 99, `status ${res.statusCode}`);
  check('create is transactional (BEGIN + COMMIT)', client.calls.some((c) => /BEGIN/i.test(c.sql)) && client.calls.some((c) => /COMMIT/i.test(c.sql)));
  const logCall = client.calls.find((c) => /lead_stage_log/i.test(c.sql));
  check('create writes a NULL→New stage log', !!logCall && /NULL,\s*\$2::lead_stage/i.test(logCall.sql) && logCall.params[0] === 99 && logCall.params[1] === 'New', `sql/params ${logCall && JSON.stringify(logCall.params)}`);
}
// Add-to-funnel: create from a conversation with a workorder link + initial stage.
{
  const client = makeClient([
    { match: /SELECT lead_id FROM leads/i, result: { rowCount: 0, rows: [] } }, // no dup
    { match: /INSERT INTO leads/i, result: { rowCount: 1, rows: [{ lead_id: 120 }] } },
    { match: /FROM leads l/i, result: { rowCount: 1, rows: [{ lead_id: 120, stage: 'Won' }] } },
  ]);
  const res = makeRes();
  await leadsHandler(makeReq({ method: 'POST', body: { podium_conversation_id: 'pod_cnv_00005', customer_id: 555, converted_workorder_id: 751, quote_invoice_id: '99999', stage: 'Won' } }), res, [], depsFor(client));
  check('201 add-to-funnel with conversation + workorder link', res.statusCode === 201 && res.body.lead_id === 120);
  const ins = client.calls.find((c) => /INSERT INTO leads/i.test(c.sql));
  check('add-to-funnel: source=podium, conversation + WO + invoice + stage persisted',
    ins && ins.params[0] === 'podium' && ins.params[2] === 'pod_cnv_00005' && ins.params[9] === 751 && ins.params[8] === '99999' && ins.params[10] === 'Won',
    `params ${ins && JSON.stringify(ins.params)}`);
}
// Add-to-funnel is idempotent: an open lead already on the conversation → return it, no insert.
{
  const client = makeClient([
    { match: /SELECT lead_id FROM leads/i, result: { rowCount: 1, rows: [{ lead_id: 121 }] } }, // dup exists
    { match: /FROM leads l/i, result: { rowCount: 1, rows: [{ lead_id: 121, stage: 'Payment Received' }] } },
  ]);
  const res = makeRes();
  await leadsHandler(makeReq({ method: 'POST', body: { podium_conversation_id: 'pod_cnv_00005', customer_id: 555 } }), res, [], depsFor(client));
  check('add-to-funnel: existing open lead returned (200), no duplicate insert',
    res.statusCode === 200 && res.body.lead_id === 121 && !client.calls.some((c) => /INSERT INTO leads/i.test(c.sql)));
}

// ---- PUT stage ----------------------------------------------------------------
console.log('\nPUT /api/leads/:id/stage:');
{
  const res = makeRes();
  await leadsHandler(makeReq({ method: 'PUT', body: { to_stage: 'Nonsense' } }), res, ['5', 'stage'], depsFor(makeClient()));
  check('400 for an invalid stage', res.statusCode === 400);
}
{
  const res = makeRes();
  await leadsHandler(makeReq({ method: 'PUT', body: { to_stage: 'Lost' } }), res, ['5', 'stage'], depsFor(makeClient()));
  check('400 LOST_REASON_REQUIRED when Lost has no category', res.statusCode === 400 && res.body.code === 'LOST_REASON_REQUIRED');
}
{
  const res = makeRes();
  await leadsHandler(makeReq({ method: 'PUT', body: { to_stage: 'Lost', lost_reason_category: 'Not a real reason' } }), res, ['5', 'stage'], depsFor(makeClient()));
  check('400 for an unknown lost reason category', res.statusCode === 400);
}
{
  const res = makeRes();
  await leadsHandler(makeReq({ method: 'PUT', body: { to_stage: 'Lost', lost_reason_category: 'Other' } }), res, ['5', 'stage'], depsFor(makeClient()));
  check('400 LOST_NOTE_REQUIRED when category is Other with no note', res.statusCode === 400 && res.body.code === 'LOST_NOTE_REQUIRED');
}
{
  const client = makeClient([
    { match: /SELECT stage FROM leads/i, result: { rowCount: 1, rows: [{ stage: 'New' }] } },
    { match: /UPDATE leads/i, result: { rowCount: 1 } },
    { match: /FROM leads l/i, result: { rowCount: 1, rows: [{ lead_id: 5, stage: 'Contacted' }] } },
  ]);
  const res = makeRes();
  await leadsHandler(makeReq({ method: 'PUT', body: { to_stage: 'Contacted' } }), res, ['5', 'stage'], depsFor(client));
  check('200 transitions the lead', res.statusCode === 200 && res.body.stage === 'Contacted', `status ${res.statusCode}`);
  const logCall = client.calls.find((c) => /lead_stage_log/i.test(c.sql));
  check('logs from→to (New→Contacted)', !!logCall && logCall.params[1] === 'New' && logCall.params[2] === 'Contacted');
}
{
  // no-op: from === to → no log row
  const client = makeClient([
    { match: /SELECT stage FROM leads/i, result: { rowCount: 1, rows: [{ stage: 'Contacted' }] } },
    { match: /FROM leads l/i, result: { rowCount: 1, rows: [{ lead_id: 5, stage: 'Contacted' }] } },
  ]);
  const res = makeRes();
  await leadsHandler(makeReq({ method: 'PUT', body: { to_stage: 'Contacted' } }), res, ['5', 'stage'], depsFor(client));
  check('no-op transition returns 200 and writes NO log', res.statusCode === 200 && !client.calls.some((c) => /lead_stage_log/i.test(c.sql)));
}
{
  // Lost with a valid category + note updates (category + note) + logs
  const client = makeClient([
    { match: /SELECT stage FROM leads/i, result: { rowCount: 1, rows: [{ stage: 'Quoted' }] } },
    { match: /UPDATE leads/i, result: { rowCount: 1 } },
    { match: /FROM leads l/i, result: { rowCount: 1, rows: [{ lead_id: 7, stage: 'Lost' }] } },
  ]);
  const res = makeRes();
  await leadsHandler(makeReq({ method: 'PUT', body: { to_stage: 'Lost', lost_reason_category: 'Went with a competitor', lost_reason: 'chose BrandX' } }), res, ['7', 'stage'], depsFor(client));
  check('200 Lost with a valid category', res.statusCode === 200 && res.body.stage === 'Lost');
  const upd = client.calls.find((c) => /UPDATE leads/i.test(c.sql));
  check('category + note passed to UPDATE', !!upd && upd.params.includes('Went with a competitor') && upd.params.includes('chose BrandX'));
  const logCall = client.calls.find((c) => /lead_stage_log/i.test(c.sql));
  check('stage log note combines category + note', !!logCall && /Went with a competitor — chose BrandX/.test(logCall.params[4] || ''));
}
{
  // lead not found
  const client = makeClient([{ match: /SELECT stage FROM leads/i, result: { rowCount: 0, rows: [] } }]);
  const res = makeRes();
  await leadsHandler(makeReq({ method: 'PUT', body: { to_stage: 'Contacted' } }), res, ['404', 'stage'], depsFor(client));
  check('404 when the lead does not exist', res.statusCode === 404);
}

// ---- GET /api/leads/:id/history -----------------------------------------------
console.log('\nGET /api/leads/:id/history:');
{
  const client = makeClient([
    { match: /FROM lead_stage_log/i, result: { rowCount: 2, rows: [
      { id: 1, from_stage: null, to_stage: 'New', created_at: 't1' },
      { id: 2, from_stage: 'New', to_stage: 'Contacted', created_at: 't2' },
    ] } },
  ]);
  const res = makeRes();
  await leadsHandler(makeReq({ method: 'GET' }), res, ['7', 'history'], depsFor(client));
  check('200 returns the stage history (ASC)', res.statusCode === 200 && res.body.lead_id === 7 && res.body.history.length === 2);
  const q = client.calls.find((c) => /FROM lead_stage_log/i.test(c.sql));
  check('history query ordered oldest → newest', !!q && /ORDER BY .*created_at ASC/i.test(q.sql));
}

console.log(`\n✅ leads smoke: ${passed} checks passed`);
