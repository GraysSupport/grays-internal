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

console.log(`\nsec1 smoke: ${passed} checks passed`);
