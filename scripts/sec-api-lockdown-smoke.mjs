// scripts/sec-api-lockdown-smoke.mjs — SEC1 (owner, 27 Nov 2026): close the API holes found in the
// 27 Nov 2026 audit (handbook chapter 12). Fake pg clients only — no network, no database.
//
//   node scripts/sec-api-lockdown-smoke.mjs

process.env.JWT_SECRET = process.env.JWT_SECRET || 'sec1_smoke_secret';
// The router builds a pg Pool at import; this URL is never dialled (the gate answers first).
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://nobody:nothing@127.0.0.1:1/none';

const jwt = (await import('jsonwebtoken')).default;
const { LOGIN_REQUIRED_ROOTS, apiLoginGate } = await import('../lib/apiLogin.js');
const router = (await import('../api/[...path].js')).default;

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}
const bearer = (id, roles) => `Bearer ${jwt.sign({ id, email: `${id}@x`, roles }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
function fakeRes() {
  const res = { statusCode: 200, body: undefined, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.end = () => res;
  res.setHeader = (k, v) => { res.headers[k] = v; };
  return res;
}
const req = ({ url, method = 'GET', query = {}, headers = {}, body = {} }) => ({ url, method, query, headers, body });

console.log('SEC1 — the login gate');
for (const root of ['products', 'product', 'collections', 'users', 'access-log']) {
  check(`/api/${root} needs a login`, LOGIN_REQUIRED_ROOTS.includes(root));
}
check('sign-in, renewal, brands and change-password stay open',
  !['login', 'auth', 'brands', 'change-password', 'register', 'signup'].some((r) => LOGIN_REQUIRED_ROOTS.includes(r)));
for (const [url, method] of [['/api/products', 'GET'], ['/api/products', 'PUT'], ['/api/collections', 'GET'],
  ['/api/collections', 'DELETE'], ['/api/users', 'GET'], ['/api/access-log', 'POST']]) {
  const res = fakeRes();
  await router(req({ url, method, headers: {} }), res);
  check(`${method} ${url} without a login → 401 before any database work`, res.statusCode === 401, JSON.stringify(res.body));
}
{
  const r = req({ url: '/api/collections', method: 'POST', headers: { authorization: bearer('GA', ['admin']), 'x-user-id': 'GS' } });
  apiLoginGate('collections', r);
  check('a claimed x-user-id is replaced by the signed one on collections', r.headers['x-user-id'] === 'GA');
}

console.log('SEC1 — products');
const { handleProducts } = await import('../lib/products.js');
function productDb() {
  const db = {
    sql: [], released: false,
    release() { db.released = true; },
    async query(text, params = []) {
      const t = String(text).replace(/\s+/g, ' ').trim();
      db.sql.push({ t, params });
      const row = { sku: 'TREAD', stock: 2, price: 1795, ...(/avg_cost/.test(t) ? { avg_cost: 900 } : {}) };
      if (/^SELECT .* FROM product/i.test(t)) return { rows: [row] };
      return { rows: [], rowCount: 1 };
    },
  };
  return db;
}
const callProducts = async (method, auth, { sub, query = {}, body = {}, headers = {} } = {}) => {
  const db = productDb();
  const res = fakeRes();
  await handleProducts(req({ method, query, body, headers: { ...(auth ? { authorization: bearer(...auth) } : {}), ...headers } }), res, sub, { getClient: async () => db });
  return { res, db };
};
check('no login → 401', (await callProducts('GET', null)).res.statusCode === 401);
{
  const { res } = await callProducts('GET', ['GS', ['superadmin']]);
  check('superadmin (signed) sees cost', res.statusCode === 200 && res.body[0].avg_cost === 900);
}
{
  const { res } = await callProducts('GET', ['SF', ['staff']], { headers: { 'x-user-access': 'superadmin' } });
  check('a staff login claiming "x-user-access: superadmin" gets NO cost', res.statusCode === 200 && !('avg_cost' in res.body[0]));
}
{
  const { res } = await callProducts('GET', ['TE', ['technician']]);
  check('a workshop login can read the list (dashboard counts) without cost', res.statusCode === 200 && !('avg_cost' in res.body[0]));
}
for (const [m, extra] of [['POST', { body: { sku: 'X1', name: 'x', brand: 'B', stock: 1, price: 1 } }], ['PUT', { sub: 'TREAD', body: { name: 'x', brand: 'B', stock: 99, price: 1 } }]]) {
  const tech = await callProducts(m, ['TE', ['technician']], extra);
  check(`workshop login ${m} → 403, nothing written`, tech.res.statusCode === 403 && !tech.db.sql.length);
  const kiosk = await callProducts(m, ['WK', ['admin']], extra);
  check(`WK kiosk ${m} → 403`, kiosk.res.statusCode === 403);
  const staff = await callProducts(m, ['SF', ['staff']], extra);
  check(`staff ${m} still works`, staff.res.statusCode === (m === 'POST' ? 201 : 200));
}
check('PUT without a SKU → 400', (await callProducts('PUT', ['SF', ['staff']], { body: {} })).res.statusCode === 400);
check('DELETE → 405', (await callProducts('DELETE', ['GS', ['superadmin']])).res.statusCode === 405);
check('connection given back', (await callProducts('GET', ['SF', ['staff']])).db.released === true);

console.log('SEC1 — access log + collections identity');
const { handleAccessLog } = await import('../lib/accessLog.js');
{
  const writes = [];
  const db = { release() {}, async query(t, p) { writes.push(p); return { rows: [] }; } };
  const res = fakeRes();
  await handleAccessLog(req({ method: 'POST', headers: { authorization: bearer('GA', ['admin']) }, body: { userId: 'GS', description: 'User manually logged out' } }), res, { getClient: async () => db });
  check('access log written under the SIGNED id, not the claimed userId', res.statusCode === 200 && writes[0][0] === 'GA' && writes[0][1] === 'User manually logged out');
  const r2 = fakeRes();
  await handleAccessLog(req({ method: 'POST', body: { userId: 'GS', description: 'x' } }), r2, { getClient: async () => db });
  check('no login → 401', r2.statusCode === 401);
  const r3 = fakeRes();
  await handleAccessLog(req({ method: 'POST', headers: { authorization: bearer('GA', ['admin']) }, body: { description: '  ' } }), r3, { getClient: async () => db });
  check('empty description → 400', r3.statusCode === 400);
  const r4 = fakeRes();
  await handleAccessLog(req({ method: 'GET', headers: { authorization: bearer('GA', ['admin']) } }), r4, { getClient: async () => db });
  check('GET → 405', r4.statusCode === 405);
}
const { default: collectionsHandler } = await import('../lib/handlers/collections.js');
{
  const db = { release() {}, async query(t, p = []) {
    const s = String(t).replace(/\s+/g, ' ');
    if (/SELECT id, access FROM users WHERE id/i.test(s)) return { rows: [{ id: p[0], access: p[0] === 'GS' ? 'superadmin' : 'admin' }] };
    return { rows: [], rowCount: 0 };
  } };
  const res = fakeRes();
  await collectionsHandler(req({ method: 'POST', query: { resource: 'apply-inventory', id: '3' }, headers: { authorization: bearer('GA', ['admin']), 'x-user-id': 'GS' } }), res, [], { getClient: async () => db });
  check('apply inventory: an admin claiming x-user-id GS is refused (403)', res.statusCode === 403, JSON.stringify(res.body));
  const r2 = fakeRes();
  await collectionsHandler(req({ method: 'POST', query: { resource: 'apply-inventory', id: '3' }, headers: { 'x-user-id': 'GS' } }), r2, [], { getClient: async () => db });
  check('apply inventory with only a claimed id (no login) → 401', r2.statusCode === 401, JSON.stringify(r2.body));
}

console.log('SEC1 — hard deletes are superadmin only');
const { default: workorderHandler } = await import('../lib/handlers/workorder.js');
const { default: deliveryHandler } = await import('../lib/handlers/delivery.js');
function recordingDb() {
  const db = { sql: [], release() {}, async query(t) { db.sql.push(String(t).replace(/\s+/g, ' ').trim()); return { rows: [], rowCount: 0 }; } };
  return db;
}
const deletes = [
  ['workorder', (r, s, d) => workorderHandler(r, s, [], d), { id: '41' }],
  ['delivery', (r, s, d) => deliveryHandler(r, s, [], d), { id: '7' }],
  ['collection', (r, s, d) => collectionsHandler(r, s, [], d), { id: '3' }],
];
for (const [label, h, query] of deletes) {
  const db = recordingDb();
  const res = fakeRes();
  await h(req({ method: 'DELETE', query, headers: { authorization: bearer('GA', ['admin']), 'x-user-id': 'GA' } }), res, { getClient: async () => db });
  check(`admin cannot delete a ${label} (403), nothing deleted`, res.statusCode === 403 && !db.sql.some((q) => /^DELETE FROM/i.test(q)), `${res.statusCode} ${JSON.stringify(res.body)}`);
}
for (const [label, h, query, table] of [
  ['workorder', deletes[0][1], { id: '41' }, 'workorder'],
  ['delivery', deletes[1][1], { id: '7' }, 'delivery'],
  ['collection', deletes[2][1], { id: '3' }, 'collections'],
]) {
  const db = recordingDb();
  const res = fakeRes();
  await h(req({ method: 'DELETE', query, headers: { authorization: bearer('GS', ['superadmin']), 'x-user-id': 'GS' } }), res, { getClient: async () => db });
  check(`a superadmin can still delete a ${label}`, res.statusCode < 400 && db.sql.some((q) => new RegExp(`^DELETE FROM ${table}\\b`, 'i').test(q)), `${res.statusCode} ${JSON.stringify(res.body)}`);
}

console.log('SEC1 — no dispatch while money is owing');
const { balanceOwing, owingMessage } = await import('../lib/deliveryBalance.js');
check('message formats whole dollars without cents', owingMessage(2125) === 'Cannot set to "Delivery Completed": $2,125 is still owing. The balance must be paid in full before dispatch.', owingMessage(2125));
check('…and cents when there are some', owingMessage(2125.5).includes('$2,125.50'));
check('no workorder → nothing owing', (await balanceOwing({ query: () => { throw new Error('no query'); } }, null)) === 0);
function deliveryDb({ balance, prev = 'Booked for Delivery', workorderId = 41 }) {
  const db = {
    sql: [], release() {},
    async query(text) {
      const t = String(text).replace(/\s+/g, ' ').trim();
      db.sql.push(t);
      if (/FROM delivery WHERE delivery_id = \$1/i.test(t)) return { rows: [{ delivery_id: 7, workorder_id: workorderId, delivery_status: prev, cur_removalist_id: 3, cur_delivery_date: '2026-11-28' }] };
      if (/SELECT outstanding_balance FROM workorder/i.test(t)) return { rows: [{ outstanding_balance: balance }] };
      if (/^INSERT INTO delivery/i.test(t)) return { rows: [{ delivery_id: 9, workorder_id: workorderId, delivery_status: 'Delivery Completed' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  };
  return db;
}
const completeDelivery = async (db, body = { delivery_status: 'Delivery Completed' }) => {
  const res = fakeRes();
  await deliveryHandler(req({ method: 'PUT', query: { id: '7' }, headers: { authorization: bearer('LG', ['logistics']), 'x-user-id': 'LG' }, body }), res, [], { getClient: async () => db });
  return res;
};
{
  const db = deliveryDb({ balance: '2125.00' });
  const res = await completeDelivery(db);
  check('owing $2,125 → 409 BALANCE_OWING, nothing updated', res.statusCode === 409 && res.body?.code === 'BALANCE_OWING' && !db.sql.some((q) => /^UPDATE delivery/i.test(q)), `${res.statusCode} ${JSON.stringify(res.body)}`);
  check('…and the transaction was rolled back', db.sql.includes('ROLLBACK'));
}
check('paid in full → allowed', (await completeDelivery(deliveryDb({ balance: '0.00' }))).statusCode === 200);
check('half a cent counts as paid', (await completeDelivery(deliveryDb({ balance: '0.004' }))).statusCode === 200);
check('already completed + owing: editing notes is not blocked', (await completeDelivery(deliveryDb({ balance: '50', prev: 'Delivery Completed' }), { notes: 'x' })).statusCode === 200);
check('a delivery with no workorder is not blocked', (await completeDelivery(deliveryDb({ balance: '50', workorderId: null }))).statusCode === 200);
{
  const db = deliveryDb({ balance: '300' });
  const res = fakeRes();
  await deliveryHandler(req({ method: 'POST', query: {}, headers: { authorization: bearer('LG', ['logistics']), 'x-user-id': 'LG' }, body: { invoice_id: 'INV-41', customer_id: 7, delivery_state: 'VIC', workorder_id: 41, delivery_status: 'Delivery Completed', removalist_id: 3, delivery_date: '2026-11-28' } }), res, [], { getClient: async () => db });
  check('creating a delivery straight as Delivery Completed while owing → 409', res.statusCode === 409 && !db.sql.some((q) => /^INSERT INTO delivery/i.test(q)), `${res.statusCode} ${JSON.stringify(res.body)}`);
}

console.log(`\nsec1 smoke: ${passed} checks passed`);
