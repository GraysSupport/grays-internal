// scripts/ops-api-login-smoke.mjs — offline smoke for P7 (owner approved 5 Nov 2026):
// the workorder / delivery / customer / waitlist / lots APIs need a valid login.
//
//   - no token, a forged token or an expired token → 401 before any database work
//   - the PUBLIC /scan lot lookup (GET /api/lots?lot_number=) still answers without a login (D7)
//   - with a valid login the SIGNED id becomes the acting user (X-User-Id can no longer be claimed)
//   - the WK kiosk gets a 12 h login; everyone else keeps 1 h
//   - POST /api/auth/refresh renews a live login (sliding), re-reading roles; WK does not renew
//
// Fake pg clients only — no network, no database, no secrets.
//
//   node scripts/ops-api-login-smoke.mjs

process.env.JWT_SECRET = process.env.JWT_SECRET || 'smoke_secret';
// The router builds a pg Pool at import; give it a URL that is never dialled (the gate
// answers before any connection is taken — a connection attempt would fail the smoke).
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://nobody:nothing@127.0.0.1:1/none';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const jwt = (await import('jsonwebtoken')).default;
const login = await import('../lib/apiLogin.js');
const router = (await import('../api/[...path].js')).default;
const {
  LOGIN_REQUIRED_ROOTS, isPublicApiRequest, apiLoginGate, loginLifetimeFor, signLoginToken,
  refreshLogin, KIOSK_LOGIN_LIFETIME, LOGIN_LIFETIME,
} = login;

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const token = (id, roles, opts = {}) => jwt.sign({ id, email: `${id}@x`, roles }, process.env.JWT_SECRET, { expiresIn: '1h', ...opts });
const expired = (id, roles) => jwt.sign({ id, roles, exp: Math.floor(Date.now() / 1000) - 60 }, process.env.JWT_SECRET);
const forged = (id, roles) => jwt.sign({ id, roles }, 'not-the-secret');

function fakeRes() {
  const res = { statusCode: 200, body: undefined, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.end = () => res;
  res.setHeader = (k, v) => { res.headers[k] = v; };
  return res;
}
const req = ({ url, method = 'GET', query = {}, headers = {}, body = {} }) => ({ url, method, query, headers, body });

console.log('P7 — routes that need a login');
check('the five areas (and their aliases) are login-only',
  ['workorder', 'delivery', 'customers', 'customer', 'waitlist', 'waitlists', 'lots', 'lot']
    .every((r) => LOGIN_REQUIRED_ROOTS.includes(r)));
check('login, products, brands are NOT in scope (unchanged)',
  !['auth', 'login', 'products', 'brands', 'access-log'].some((r) => LOGIN_REQUIRED_ROOTS.includes(r)));

console.log('P7 — the public /scan lot lookup stays open (D7)');
check('GET /api/lots?lot_number= is public', isPublicApiRequest('lots', req({ query: { lot_number: 'L00042' } })));
check('… also on the /api/lot alias', isPublicApiRequest('lot', req({ query: { lot_number: 'L00042' } })));
check('a POST to lots is not public', !isPublicApiRequest('lots', req({ method: 'POST', query: { lot_number: 'L1', action: 'assign' } })));
check('lots by collection is not public', !isPublicApiRequest('lots', req({ query: { collection_id: '3' } })));
check('lots by sku is not public', !isPublicApiRequest('lots', req({ query: { sku: 'LF95X' } })));
check('the Lot Tracker journey (resource=) is not public', !isPublicApiRequest('lots', req({ query: { resource: 'journey', lot_number: 'L1' } })));
check('lot_number on a different area is not public', !isPublicApiRequest('workorder', req({ query: { lot_number: 'L1' } })));

console.log('P7 — the gate');
for (const [label, headers] of [
  ['no token', {}],
  ['a claimed X-User-Id only', { 'x-user-id': 'GS' }],
  ['an expired token', { authorization: `Bearer ${expired('GS', ['superadmin'])}` }],
  ['a forged token', { authorization: `Bearer ${forged('GS', ['superadmin'])}` }],
  ['a malformed header', { authorization: 'Token abc' }],
]) {
  const g = apiLoginGate('workorder', req({ headers }));
  check(`${label} → 401`, !g.ok && g.status === 401, JSON.stringify(g));
}
{
  const r = req({ headers: { authorization: `Bearer ${token('GA', ['admin'])}`, 'x-user-id': 'GS' }, body: { user_id: 'GS' } });
  const g = apiLoginGate('delivery', r);
  check('a valid login passes', g.ok && g.auth.id === 'GA');
  check('the signed id replaces a claimed X-User-Id (no acting as someone else)', r.headers['x-user-id'] === 'GA');
  check('… and replaces a claimed body.user_id', r.body.user_id === 'GA');
}
{
  const r = req({ method: 'GET', headers: { authorization: `Bearer ${token('GA', ['admin'])}` }, body: undefined });
  const g = apiLoginGate('customers', r);
  check('a GET with no body still passes (no crash on an absent body)', g.ok && r.headers['x-user-id'] === 'GA');
}
{
  const r = req({ query: { lot_number: 'L00042' } });
  check('the public lot lookup passes with no token', apiLoginGate('lots', r).ok === true);
  check('… and claims no identity', r.headers['x-user-id'] === undefined);
}
check('a route out of scope passes untouched', apiLoginGate('products', req({})).ok === true);

console.log('P7 — the router refuses before any database work');
for (const [url, query] of [
  ['/api/workorder', {}],
  ['/api/workorder', { id: '41' }],
  ['/api/delivery', { include_removalists: '1' }],
  ['/api/delivery', { resource: 'board-notes' }],
  ['/api/delivery', { resource: 'run-order' }],
  ['/api/customers', {}],
  ['/api/customers/7/journey', {}],
  ['/api/waitlist', {}],
  ['/api/lots', { collection_id: '3' }],
  ['/api/lots', { sku: 'LF95X' }],
]) {
  const res = fakeRes();
  // A DB connection here would hang/fail on the never-dialled DATABASE_URL — a 401 proves none was taken.
  await router(req({ url: `${url}?x`, query, headers: { 'x-user-id': 'GS' } }), res);
  check(`GET ${url} ${JSON.stringify(query)} with no login → 401`, res.statusCode === 401, `${res.statusCode} ${JSON.stringify(res.body)}`);
}
for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
  const res = fakeRes();
  await router(req({ url: '/api/workorder?id=41', method, query: { id: '41' }, body: { user_id: 'GS' } }), res);
  check(`${method} /api/workorder with no login → 401`, res.statusCode === 401);
}

console.log('P7 — login lifetimes');
check('normal logins keep 1 h', loginLifetimeFor('GA') === LOGIN_LIFETIME && LOGIN_LIFETIME === '1h');
check('the WK kiosk gets one shift (12 h)', loginLifetimeFor('WK') === KIOSK_LOGIN_LIFETIME && KIOSK_LOGIN_LIFETIME === '12h');
check('the kiosk id match is case-insensitive', loginLifetimeFor('wk') === KIOSK_LOGIN_LIFETIME);
{
  const t = signLoginToken({ id: 'WK', email: 'workshop@x', roles: ['admin'] });
  const p = jwt.verify(t, process.env.JWT_SECRET);
  check('a signed WK token lives ~12 h', Math.abs(p.exp - p.iat - 12 * 3600) <= 1);
  const t2 = signLoginToken({ id: 'GA', email: 'ga@x', roles: ['admin'] });
  const p2 = jwt.verify(t2, process.env.JWT_SECRET);
  check('a signed normal token lives ~1 h', Math.abs(p2.exp - p2.iat - 3600) <= 1);
  check('the token carries id, email and roles', p2.id === 'GA' && p2.email === 'ga@x' && p2.roles[0] === 'admin');
}

console.log('P7 — refresh (sliding login for active staff)');
function fakeClient(users) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push(sql);
      if (/FROM users WHERE id/i.test(sql)) {
        const u = users[params[0]];
        return { rows: u ? [{ id: params[0], email: u.email, access: u.access }] : [] };
      }
      if (/FROM user_roles/i.test(sql)) return { rows: (users[params[0]]?.roles || []).map((role) => ({ role })) };
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}
const USERS = { GA: { email: 'ga@x', access: 'admin', roles: ['admin', 'sales'] }, WK: { email: 'workshop@x', access: 'admin', roles: ['admin'] } };
{
  const out = await refreshLogin(req({ method: 'POST', headers: { authorization: `Bearer ${token('GA', ['admin'])}` } }), fakeClient(USERS));
  check('a live login renews → 200 + new token', out.status === 200 && typeof out.body.token === 'string');
  const p = jwt.verify(out.body.token, process.env.JWT_SECRET);
  check('the renewed token re-reads roles from the database', p.id === 'GA' && p.roles.includes('sales'));
  check('… and returns the roles for the stored user', Array.isArray(out.body.roles) && out.body.roles.includes('sales'));
}
{
  const out = await refreshLogin(req({ method: 'POST', headers: { authorization: `Bearer ${expired('GA', ['admin'])}` } }), fakeClient(USERS));
  check('an expired login does not renew → 401', out.status === 401);
}
{
  const out = await refreshLogin(req({ method: 'POST', headers: {} }), fakeClient(USERS));
  check('no login does not renew → 401', out.status === 401);
}
{
  const out = await refreshLogin(req({ method: 'POST', headers: { authorization: `Bearer ${token('ZZ', ['admin'])}` } }), fakeClient(USERS));
  check('a deleted user does not renew → 401', out.status === 401);
}
{
  const c = fakeClient(USERS);
  const out = await refreshLogin(req({ method: 'POST', headers: { authorization: `Bearer ${token('WK', ['admin'], { expiresIn: '12h' })}` } }), c);
  check('the WK kiosk does not renew (one shift) → 403', out.status === 403);
  check('… without touching the database', c.calls.length === 0);
}

console.log('P7 — wiring');
const routerSrc = read('../api/[...path].js');
check('the router runs the gate before the route switch',
  routerSrc.indexOf('apiLoginGate(') > -1 && routerSrc.indexOf('apiLoginGate(') < routerSrc.indexOf('switch (root)'));
check('login signs with signLoginToken (WK 12 h)', /signLoginToken\(/.test(routerSrc) && !/expiresIn:\s*'1h'/.test(routerSrc));
check('/api/auth/refresh is routed', /action === 'refresh'/.test(routerSrc) && /refreshLogin\(/.test(routerSrc));

const indexSrc = read('../src/index.js');
check('the browser installs the API login wrapper before the app renders',
  /installApiAuth\(window\)/.test(indexSrc) && indexSrc.indexOf('installApiAuth(window)') < indexSrc.indexOf('root.render('));
const appSrc = read('../src/App.js');
check('App.js renews the login while the session is active', /refreshTokenIfDue\(\)/.test(appSrc));

console.log(`\nops-api-login-smoke: ${passed} checks passed`);
