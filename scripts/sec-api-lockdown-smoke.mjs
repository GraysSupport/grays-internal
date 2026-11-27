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

console.log(`\nsec1 smoke: ${passed} checks passed`);
