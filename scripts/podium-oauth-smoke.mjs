// scripts/podium-oauth-smoke.mjs — offline smoke for the F1 increment-2 OAuth glue.
//
// Covers the pure/mock-safe logic added in increment 2: the signed OAuth `state`
// (sign/verify/tamper/purpose), redirect_uri derivation, and the api/podium/oauth/
// start.js handler in mock mode (auth gate + loopback authorize URL). NO network, NO
// database, NO real secrets — start.js never touches the DB, so this runs fully offline:
//
//   node scripts/podium-oauth-smoke.mjs
//
// The DB-touching endpoints (callback.js, status.js) are validated separately against
// the Neon dev branch (the podium_oauth round-trip) — see the F1 increment-2 report.

process.env.PODIUM_MOCK = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'smoke_secret';
process.env.PODIUM_API_VERSION = process.env.PODIUM_API_VERSION || '2021-04-01';
// Force host-derived redirect (leave PODIUM_REDIRECT_URI unset) so the loopback path is exercised.
delete process.env.PODIUM_REDIRECT_URI;

const jwt = (await import('jsonwebtoken')).default;
const { signState, verifyState, computeRedirectUri } = await import('../lib/podiumOAuth.js');
const startHandler = (await import('../api/podium/oauth/start.js')).default;

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// Minimal req/res doubles shaped like Vercel's Node handler signature.
function makeReq({ method = 'GET', roles = [], id = 'AM', email = 'amelia@graysfitness.com.au', host = 'preview.example.app', noAuth = false } = {}) {
  const headers = { host };
  if (!noAuth) {
    const token = jwt.sign({ id, email, roles }, process.env.JWT_SECRET, { expiresIn: '1h' });
    headers.authorization = `Bearer ${token}`;
  }
  return { method, headers, query: {} };
}
function makeRes() {
  return {
    statusCode: 0,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
  };
}

console.log('Podium OAuth (increment 2) smoke (PODIUM_MOCK=true)\n');

// 1. state sign/verify round-trip
const st = signState('AM');
check('signState returns a JWT string', typeof st === 'string' && st.split('.').length === 3);
check('verifyState recovers the uid', verifyState(st)?.uid === 'AM');
check('verifyState rejects a tampered token', verifyState(st.slice(0, -2) + 'xy') === null);
check('verifyState rejects empty', verifyState('') === null);
// a JWT signed with the right secret but WRONG purpose must not pass as OAuth state
const wrongPurpose = jwt.sign({ uid: 'AM', purpose: 'login' }, process.env.JWT_SECRET);
check('verifyState rejects wrong-purpose token', verifyState(wrongPurpose) === null);
// an expired state must fail
const expired = jwt.sign({ uid: 'AM', purpose: 'podium_oauth_state' }, process.env.JWT_SECRET, { expiresIn: -10 });
check('verifyState rejects an expired token', verifyState(expired) === null);

// 2. redirect_uri derivation
check('computeRedirectUri derives https from host', computeRedirectUri({ headers: { host: 'foo.app' } }) === 'https://foo.app/api/podium/oauth/callback');
check('computeRedirectUri honours x-forwarded-proto/host', computeRedirectUri({ headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'bar.app' } }) === 'https://bar.app/api/podium/oauth/callback');
process.env.PODIUM_REDIRECT_URI = 'https://portal.example/api/podium/oauth/callback';
check('computeRedirectUri prefers PODIUM_REDIRECT_URI', computeRedirectUri({ headers: { host: 'ignored.app' } }) === 'https://portal.example/api/podium/oauth/callback');
delete process.env.PODIUM_REDIRECT_URI;

// 3. start.js auth gate
{
  const res = makeRes();
  await startHandler(makeReq({ noAuth: true }), res);
  check('start: 401 when unauthenticated', res.statusCode === 401);
}
{
  const res = makeRes();
  await startHandler(makeReq({ roles: ['technician'] }), res);
  check('start: 403 without sales/superadmin', res.statusCode === 403);
}
{
  const res = makeRes();
  await startHandler(makeReq({ method: 'DELETE', roles: ['sales'] }), res);
  check('start: 405 on unsupported method', res.statusCode === 405);
}

// 4. start.js happy path (mock loopback) for both allowed roles
for (const roles of [['sales'], ['superadmin'], ['sales', 'logistics']]) {
  const res = makeRes();
  await startHandler(makeReq({ roles, id: 'AM' }), res);
  check(`start: 200 for roles [${roles}]`, res.statusCode === 200, `got ${res.statusCode}`);
  const url = res.body?.authorizeUrl;
  check(`start: authorizeUrl present for [${roles}]`, typeof url === 'string' && url.length > 0);
  check(`start: mock flag true for [${roles}]`, res.body?.mock === true);
  const u = new URL(url);
  check(`start: loopback points at our callback for [${roles}]`, u.pathname === '/api/podium/oauth/callback');
  check(`start: loopback carries a mock code for [${roles}]`, u.searchParams.get('code') === 'AM' ? false : u.searchParams.get('code') === 'mock_code_AM');
  const carriedState = u.searchParams.get('state');
  check(`start: loopback state verifies back to the rep for [${roles}]`, verifyState(carriedState)?.uid === 'AM');
}

console.log(`\nAll ${passed} checks passed ✅`);
