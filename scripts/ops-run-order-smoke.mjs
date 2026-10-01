// scripts/ops-run-order-smoke.mjs — offline smoke for G9 (Nick, 28 Sep 2026): drag-to-reorder
// booked deliveries within a run (one carrier on one day).
//
//   GET /api/delivery?resource=run-order   anyone on the tab reads the saved order (no token)
//   PUT /api/delivery?resource=run-order   logistics / admin / superadmin save a run's order
//
// Exercises lib/deliveryRunOrder.js with a fake pg client that applies the same rule the real
// statement does (verified against Neon dev on 1 Oct 2026): every id must be a booked delivery
// of that carrier on that day, or nothing is written.
//
//   node scripts/ops-run-order-smoke.mjs

process.env.JWT_SECRET = process.env.JWT_SECRET || 'smoke_secret';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const jwt = (await import('jsonwebtoken')).default;
const { handleRunOrder, RUN_ORDER_ROLES, RUN_ORDER_MAX_STOPS } = await import('../lib/deliveryRunOrder.js');

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const BOOKED = 'Booked for Delivery';
const seed = () => [
  { delivery_id: 1, removalist_id: 7, delivery_date: '2026-10-02', delivery_status: BOOKED, run_order: null },
  { delivery_id: 2, removalist_id: 7, delivery_date: '2026-10-02', delivery_status: BOOKED, run_order: null },
  { delivery_id: 3, removalist_id: 7, delivery_date: '2026-10-02', delivery_status: BOOKED, run_order: null },
  { delivery_id: 4, removalist_id: 9, delivery_date: '2026-10-02', delivery_status: BOOKED, run_order: null }, // other carrier
  { delivery_id: 5, removalist_id: 7, delivery_date: '2026-10-03', delivery_status: BOOKED, run_order: null }, // other day
  { delivery_id: 6, removalist_id: 7, delivery_date: '2026-10-02', delivery_status: 'To Be Booked', run_order: null },
  { delivery_id: 8, removalist_id: null, delivery_date: '2026-10-02', delivery_status: BOOKED, run_order: null }, // no carrier yet
  { delivery_id: 9, removalist_id: null, delivery_date: '2026-10-02', delivery_status: BOOKED, run_order: null },
];

const keyOf = (r) => `${r.removalist_id ?? 'none'}|${r.delivery_date}`;

function makeClient({ missing = false } = {}) {
  const rows = seed();
  const calls = [];
  return {
    rows, calls,
    async query(text, params = []) {
      calls.push({ text, params });
      if (missing) throw Object.assign(new Error('column "run_order" does not exist'), { code: '42703' });
      const sql = text.replace(/\s+/g, ' ').trim();
      if (/^SELECT d\.delivery_id, d\.run_order FROM delivery d/i.test(sql)) {
        if (!/d\.run_order_key = COALESCE\(d\.removalist_id::text, 'none'\) \|\| '\|' \|\| to_char\(d\.delivery_date, 'YYYY-MM-DD'\)/.test(sql)) throw new Error('smoke: the read must only return numbers whose run key still matches');
        return { rows: rows.filter((r) => r.run_order != null && r.delivery_status === BOOKED && r.run_order_key === keyOf(r)).map(({ delivery_id, run_order }) => ({ delivery_id, run_order })) };
      }
      if (/^WITH v AS .* UPDATE delivery d SET run_order = v\.pos/i.test(sql)) {
        const [ids, carrier, day] = params;
        const matching = ids.filter((id) => rows.some((r) => r.delivery_id === id && r.removalist_id === carrier && r.delivery_date === day && r.delivery_status === BOOKED));
        if (matching.length !== ids.length) return { rows: [] };
        if (!/run_order_key = COALESCE\(d\.removalist_id::text, 'none'\)/.test(sql)) throw new Error('smoke: the save must stamp run_order_key');
        ids.forEach((id, i) => { const r = rows.find((x) => x.delivery_id === id); r.run_order = i + 1; r.run_order_key = keyOf(r); });
        return { rows: ids.map((id, i) => ({ delivery_id: id, run_order: i + 1 })) };
      }
      throw new Error(`unexpected SQL in smoke: ${sql}`);
    },
  };
}

function makeReq({ method = 'GET', roles = ['admin'], body = {}, noAuth = false } = {}) {
  const headers = {};
  if (!noAuth) headers.authorization = `Bearer ${jwt.sign({ id: 'GL', email: 'x@graysfitness.com.au', roles }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
  return { method, headers, query: { resource: 'run-order' }, body };
}
function makeRes() {
  return {
    statusCode: 0, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
  };
}
async function run(client, reqOpts) {
  const res = makeRes();
  await handleRunOrder(makeReq(reqOpts), res, client);
  return res;
}
const put = (client, body, extra = {}) => run(client, { method: 'PUT', body, ...extra });
const orderOf = (client) => client.rows.filter((r) => r.run_order != null).sort((a, b) => a.run_order - b.run_order).map((r) => r.delivery_id).join(',');
const RUN = { removalist_id: 7, delivery_date: '2026-10-02' };

console.log('G9 run-order smoke — fake client, no DB\n');

console.log('reading:');
{
  const client = makeClient();
  await put(client, { ...RUN, delivery_ids: [3, 1, 2] });
  const res = await run(client, { noAuth: true });
  check('readable without a token (like the rest of the tab)', res.statusCode === 200 && res.body.available === true);
  check('returns delivery_id → stop number', JSON.stringify(res.body.order) === JSON.stringify({ 1: 2, 2: 3, 3: 1 }));
  check('the read is exactly one SELECT', client.calls.at(-1) && /^\s*SELECT/i.test(client.calls.at(-1).text));
}
{
  const res = await run(makeClient({ missing: true }), { noAuth: true });
  check('column not migrated (42703) → 200 with available:false, not a 500', res.statusCode === 200 && res.body.available === false);
}

console.log('\nwho may reorder:');
check('roles = logistics, admin, superadmin', RUN_ORDER_ROLES.join(',') === 'logistics,admin,superadmin');
for (const role of ['technician', 'staff', 'sales', 'workshop']) {
  const client = makeClient();
  const res = await put(client, { ...RUN, delivery_ids: [2, 1, 3] }, { roles: [role] });
  check(`403 for ${role} — and no query ran`, res.statusCode === 403 && client.calls.length === 0);
}
{
  const client = makeClient();
  const res = await put(client, { ...RUN, delivery_ids: [2, 1, 3] }, { noAuth: true });
  check('401 without a token — and no query ran', res.statusCode === 401 && client.calls.length === 0);
}
for (const role of RUN_ORDER_ROLES) {
  const client = makeClient();
  const res = await put(client, { ...RUN, delivery_ids: [2, 3, 1] }, { roles: [role] });
  check(`${role} can save a run's order`, res.statusCode === 200 && orderOf(client) === '2,3,1', JSON.stringify(res.body));
}

console.log('\nthe rule — same carrier AND same day, or nothing is written:');
{
  const client = makeClient();
  const res = await put(client, { ...RUN, delivery_ids: [1, 4, 2] });
  check('409 when one stop is on another carrier', res.statusCode === 409 && orderOf(client) === '');
}
{
  const client = makeClient();
  const res = await put(client, { ...RUN, delivery_ids: [1, 5] });
  check('409 when one stop is on another day', res.statusCode === 409 && orderOf(client) === '');
}
{
  const client = makeClient();
  const res = await put(client, { ...RUN, delivery_ids: [1, 6] });
  check('409 when one stop is not a booked delivery', res.statusCode === 409 && orderOf(client) === '');
}
{
  const client = makeClient();
  const res = await put(client, { ...RUN, delivery_ids: [1, 999] });
  check('409 for an id that does not exist', res.statusCode === 409 && orderOf(client) === '');
}
{
  const client = makeClient();
  const res = await put(client, { removalist_id: 9, delivery_date: '2026-10-02', delivery_ids: [1, 2] });
  check('409 when the ids belong to a different carrier than the one named', res.statusCode === 409 && orderOf(client) === '');
}
{
  const client = makeClient();
  const res = await put(client, { removalist_id: null, delivery_date: '2026-10-02', delivery_ids: [9, 8] });
  check('deliveries with no carrier yet form their own run for the day', res.statusCode === 200 && orderOf(client) === '9,8');
}
{
  const client = makeClient();
  await put(client, { ...RUN, delivery_ids: [3, 2, 1] });
  const writes = client.calls.filter((c) => /\b(INSERT|UPDATE|DELETE)\b/i.test(c.text));
  check('a save is exactly ONE statement', client.calls.length === 1 && writes.length === 1);
  check('…which sets run_order + its run key and nothing else', /SET run_order = v\.pos,\s+run_order_key = [^;]*?\s+FROM v, ok/i.test(writes[0].text) && !/workorder|delivery_status\s*=\s*\$|INSERT|DELETE/i.test(writes[0].text));
  check('…and names the carrier + day in the same statement as the write', /removalist_id IS NOT DISTINCT FROM \$2::int/.test(writes[0].text) && /delivery_date::date = \$3::date/.test(writes[0].text) && /ok\.all_match/.test(writes[0].text));
}

console.log('\na re-booked delivery loses its stale stop number (no change to the booking code):');
{
  const client = makeClient();
  await put(client, { ...RUN, delivery_ids: [3, 1, 2] });
  // The legacy PUT /api/delivery?id= moves delivery 3 to another carrier — it knows nothing of run order.
  client.rows.find((r) => r.delivery_id === 3).removalist_id = 9;
  const moved = await run(client, { noAuth: true });
  check('moved to another carrier → its number is no longer returned', JSON.stringify(moved.body.order) === JSON.stringify({ 1: 2, 2: 3 }));
  client.rows.find((r) => r.delivery_id === 1).delivery_date = '2026-10-03';
  const dayMoved = await run(client, { noAuth: true });
  check('moved to another day → same', JSON.stringify(dayMoved.body.order) === JSON.stringify({ 2: 3 }));
  client.rows.find((r) => r.delivery_id === 3).removalist_id = 7;
  const back = await run(client, { noAuth: true });
  check('moved back into its run → its number counts again', JSON.stringify(back.body.order) === JSON.stringify({ 2: 3, 3: 1 }));
}

console.log('\nbad input never reaches the database:');
for (const [label, body] of [
  ['no ids', { ...RUN, delivery_ids: [] }],
  ['ids not an array', { ...RUN, delivery_ids: '1,2' }],
  ['a non-integer id', { ...RUN, delivery_ids: [1, '2'] }],
  ['a negative id', { ...RUN, delivery_ids: [1, -2] }],
  ['an id beyond int range', { ...RUN, delivery_ids: [1, 1e10] }],
  ['the same delivery twice', { ...RUN, delivery_ids: [1, 2, 1] }],
  [`more than ${RUN_ORDER_MAX_STOPS} stops`, { ...RUN, delivery_ids: Array.from({ length: RUN_ORDER_MAX_STOPS + 1 }, (_, i) => i + 1) }],
  ['no date (unscheduled)', { removalist_id: 7, delivery_date: null, delivery_ids: [1, 2] }],
  ['a malformed date', { removalist_id: 7, delivery_date: '02/10/2026', delivery_ids: [1, 2] }],
  ['an impossible date', { removalist_id: 7, delivery_date: '2026-13-45', delivery_ids: [1, 2] }],
  ['30 February (parses in JS, Postgres would 500)', { removalist_id: 7, delivery_date: '2026-02-30', delivery_ids: [1, 2] }],
  ['a non-numeric carrier', { removalist_id: 'Nelson', delivery_date: '2026-10-02', delivery_ids: [1, 2] }],
]) {
  const client = makeClient();
  const res = await put(client, body);
  check(`400 for ${label} — and no query ran`, res.statusCode === 400 && client.calls.length === 0, `${res.statusCode}`);
}
{
  const client = makeClient({ missing: true });
  const res = await put(client, { ...RUN, delivery_ids: [1, 2] });
  check('column not migrated → 503 with a plain message, not a 500', res.statusCode === 503 && /not set up/i.test(res.body.error));
}
for (const method of ['POST', 'PATCH', 'DELETE']) {
  const client = makeClient();
  const res = await run(client, { method });
  check(`405 for ${method} — and no query ran`, res.statusCode === 405 && client.calls.length === 0);
}
{
  const client = makeClient();
  client.query = async () => { throw Object.assign(new Error('boom'), { code: 'XX000' }); };
  let threw = 0;
  try { await run(client); } catch { threw += 1; }
  try { await put(client, { ...RUN, delivery_ids: [1, 2] }); } catch { threw += 1; }
  check('an unexpected DB error is NOT swallowed as "not migrated"', threw === 2);
}

console.log('\nwiring + migration:');
{
  const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
  const handler = read('../lib/handlers/delivery.js');
  const at = handler.indexOf("=== 'run-order'");
  check('delivery handler routes resource=run-order to handleRunOrder', at > 0 && /handleRunOrder\(req,\s*res,\s*client\)/.test(handler));
  check('…and dispatches it BEFORE the ungated legacy routes', at < handler.indexOf("if (method === 'GET')"));
  check('the big deliveries list does NOT select run_order (it would 42703 on un-migrated prod)', !/d\.run_order/.test(handler));
  const util = read('../src/utils/runOrder.js');
  const clientRoles = /export const RUN_ORDER_ROLES = \[([^\]]*)\]/.exec(util)?.[1].replace(/['\s]/g, '');
  check('client RUN_ORDER_ROLES matches the server list', clientRoles === RUN_ORDER_ROLES.join(','), clientRoles);
  const up = read('../db/migrations/0008_delivery_run_order.sql');
  const down = read('../db/migrations/0008_delivery_run_order_down.sql');
  const sqlOnly = (s) => s.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  check('migration is additive + idempotent (two nullable columns)', /ALTER TABLE delivery ADD COLUMN IF NOT EXISTS run_order INTEGER;/.test(up) && /ALTER TABLE delivery ADD COLUMN IF NOT EXISTS run_order_key VARCHAR\(24\);/.test(up) && !/DROP|NOT NULL|DEFAULT/i.test(sqlOnly(up)));
  check('paired down migration drops only those columns', /DROP COLUMN IF EXISTS run_order;/.test(down) && /DROP COLUMN IF EXISTS run_order_key;/.test(down) && (sqlOnly(down).match(/DROP /g) || []).length === 2);
}

console.log(`\n✅ G9 run-order smoke: ${passed} checks passed`);
