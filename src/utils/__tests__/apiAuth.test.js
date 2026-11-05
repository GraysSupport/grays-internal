// P7 — every /api call carries the login; active logins renew; a dead login goes back to sign-in.
import {
  isApiUrl, isLoginGatedUrl, withLogin, tokenExpiresWithin, refreshTokenIfDue, installApiAuth,
  __resetRefreshForTests,
} from '../apiAuth';

const b64 = (o) => btoa(JSON.stringify(o)).replace(/=+$/, '');
const tokenExp = (secondsFromNow, id = 'GA') =>
  `h.${b64({ id, roles: ['admin'], exp: Math.floor(Date.now() / 1000) + secondsFromNow })}.s`;

function signIn(token, user = { id: 'GA', email: 'ga@x', access: 'admin' }) {
  localStorage.setItem('token', token);
  localStorage.setItem('user', JSON.stringify(user));
  localStorage.setItem('sessionExpiry', String(Date.now() + 60000));
}

beforeEach(() => {
  localStorage.clear();
  __resetRefreshForTests();
});

test('only same-origin /api calls are treated as API calls', () => {
  expect(isApiUrl('/api/workorder?id=1')).toBe(true);
  expect(isApiUrl(`${window.location.origin}/api/delivery`)).toBe(true);
  expect(isApiUrl('https://graph.microsoft.com/v1.0/me')).toBe(false);
  expect(isApiUrl('/static/js/main.js')).toBe(false);
  expect(isApiUrl(new Request('/api/lots?sku=1'))).toBe(true);
});

test('the five login-only areas are recognised (not login or products)', () => {
  for (const u of ['/api/workorder', '/api/delivery?x=1', '/api/customers/7/journey', '/api/customer', '/api/waitlist', '/api/waitlists', '/api/lots?sku=1', '/api/lot']) {
    expect(isLoginGatedUrl(u)).toBe(true);
  }
  for (const u of ['/api/login', '/api/products', '/api/auth/refresh', '/api/workorders-report']) {
    expect(isLoginGatedUrl(u)).toBe(false);
  }
});

test('withLogin adds the token and user id without overwriting what a page set', () => {
  signIn('tok-1');
  const h = new Headers(withLogin({ headers: { 'Content-Type': 'application/json' } }).headers);
  expect(h.get('Authorization')).toBe('Bearer tok-1');
  expect(h.get('X-User-Id')).toBe('GA');
  expect(h.get('Content-Type')).toBe('application/json');
  const kept = new Headers(withLogin({ headers: { Authorization: 'Bearer page-own' } }).headers);
  expect(kept.get('Authorization')).toBe('Bearer page-own');
});

test('withLogin with nobody signed in adds nothing', () => {
  const h = new Headers(withLogin({}).headers);
  expect(h.get('Authorization')).toBeNull();
  expect(h.get('X-User-Id')).toBeNull();
});

test('tokenExpiresWithin reads the token expiry', () => {
  expect(tokenExpiresWithin(tokenExp(5 * 60), 10 * 60 * 1000)).toBe(true);
  expect(tokenExpiresWithin(tokenExp(50 * 60), 10 * 60 * 1000)).toBe(false);
  expect(tokenExpiresWithin('garbage', 10 * 60 * 1000)).toBe(false);
});

test('a login close to expiry is renewed once and stored', async () => {
  signIn(tokenExp(5 * 60));
  const fetchImpl = jest.fn(async () => new Response(JSON.stringify({ token: 'fresh', roles: ['admin', 'sales'] }), { status: 200 }));
  await Promise.all([refreshTokenIfDue({ fetchImpl }), refreshTokenIfDue({ fetchImpl })]);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const [url, init] = fetchImpl.mock.calls[0];
  expect(url).toBe('/api/auth/refresh');
  expect(init.method).toBe('POST');
  expect(new Headers(init.headers).get('Authorization')).toMatch(/^Bearer h\./);
  expect(localStorage.getItem('token')).toBe('fresh');
  expect(JSON.parse(localStorage.getItem('user')).roles).toEqual(['admin', 'sales']);
});

test('signing out during a renewal does not bring the old login back', async () => {
  signIn(tokenExp(5 * 60));
  let finish;
  const fetchImpl = jest.fn(() => new Promise((r) => { finish = r; }));
  const p = refreshTokenIfDue({ fetchImpl });
  localStorage.clear(); // signed out while the renewal was in flight
  finish(new Response(JSON.stringify({ token: 'fresh', roles: ['admin'] }), { status: 200 }));
  await p;
  expect(localStorage.getItem('token')).toBeNull();
  expect(localStorage.getItem('user')).toBeNull();
});

test('a renewal never overwrites the next person who signed in on a shared PC', async () => {
  signIn(tokenExp(5 * 60));
  let finish;
  const fetchImpl = jest.fn(() => new Promise((r) => { finish = r; }));
  const p = refreshTokenIfDue({ fetchImpl });
  signIn('tok-of-B', { id: 'NB', email: 'nb@x', access: 'staff' });
  finish(new Response(JSON.stringify({ token: 'fresh-for-A', roles: ['admin'] }), { status: 200 }));
  await p;
  expect(localStorage.getItem('token')).toBe('tok-of-B');
  expect(JSON.parse(localStorage.getItem('user')).id).toBe('NB');
});

test('a login with plenty of time left is not renewed', async () => {
  signIn(tokenExp(50 * 60));
  const fetchImpl = jest.fn();
  await refreshTokenIfDue({ fetchImpl });
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('the WK kiosk never renews (one 12 h shift)', async () => {
  signIn(tokenExp(5 * 60, 'WK'), { id: 'WK', email: 'workshop@graysfitness.com.au', access: 'admin' });
  const fetchImpl = jest.fn();
  await refreshTokenIfDue({ fetchImpl });
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('a failed renewal keeps the current token', async () => {
  signIn(tokenExp(5 * 60));
  const before = localStorage.getItem('token');
  await refreshTokenIfDue({ fetchImpl: jest.fn(async () => new Response('{}', { status: 500 })) });
  expect(localStorage.getItem('token')).toBe(before);
  await refreshTokenIfDue({ fetchImpl: jest.fn(async () => { throw new Error('offline'); }) });
  expect(localStorage.getItem('token')).toBe(before);
});

function fakeWindow(responder) {
  const original = jest.fn(responder);
  const win = { fetch: original, location: { origin: window.location.origin, pathname: '/delivery_operations', replace: jest.fn() } };
  return { win, original };
}

test('the installed fetch adds the login to API calls only', async () => {
  signIn(tokenExp(50 * 60));
  const { win, original } = fakeWindow(async () => new Response('[]', { status: 200 }));
  installApiAuth(win);
  await win.fetch('/api/customers');
  await win.fetch('https://example.com/x');
  expect(new Headers(original.mock.calls[0][1].headers).get('Authorization')).toMatch(/^Bearer /);
  expect(original.mock.calls[1][1]).toBeUndefined();
});

test('a Request object keeps its own headers when the login is added', async () => {
  signIn(tokenExp(50 * 60));
  const { win, original } = fakeWindow(async () => new Response('[]', { status: 200 }));
  installApiAuth(win);
  await win.fetch(new Request('/api/lots?sku=1', { headers: { 'Content-Type': 'application/json' } }));
  const h = new Headers(original.mock.calls[0][1].headers);
  expect(h.get('Content-Type')).toBe('application/json');
  expect(h.get('Authorization')).toMatch(/^Bearer /);
});

test('installing twice does not double-wrap', () => {
  const { win } = fakeWindow(async () => new Response('{}'));
  installApiAuth(win);
  const once = win.fetch;
  installApiAuth(win);
  expect(win.fetch).toBe(once);
});

test('a 401 from a login-only area ends the session and returns to sign-in', async () => {
  signIn(tokenExp(50 * 60));
  const { win } = fakeWindow(async () => new Response('{"error":"Please sign in again"}', { status: 401 }));
  installApiAuth(win);
  const res = await win.fetch('/api/workorder?id=1');
  expect(res.status).toBe(401);
  expect(localStorage.getItem('token')).toBeNull();
  expect(localStorage.getItem('user')).toBeNull();
  expect(localStorage.getItem('sessionExpiry')).toBeNull();
  expect(win.location.replace).toHaveBeenCalledWith('/');
});

test('a 401 elsewhere (wrong password on login) is left to the page', async () => {
  signIn(tokenExp(50 * 60));
  const { win } = fakeWindow(async () => new Response('{}', { status: 401 }));
  installApiAuth(win);
  await win.fetch('/api/login', { method: 'POST' });
  expect(localStorage.getItem('token')).not.toBeNull();
  expect(win.location.replace).not.toHaveBeenCalled();
});

test('no redirect loop on the sign-in or public scan page', async () => {
  const { win } = fakeWindow(async () => new Response('{}', { status: 401 }));
  win.location.pathname = '/scan';
  installApiAuth(win);
  await win.fetch('/api/workorder');
  expect(win.location.replace).not.toHaveBeenCalled();
});

test('an API call near expiry renews first, then sends the new token', async () => {
  signIn(tokenExp(5 * 60));
  const { win, original } = fakeWindow(async (url) =>
    (url === '/api/auth/refresh'
      ? new Response(JSON.stringify({ token: 'fresh', roles: ['admin'] }), { status: 200 })
      : new Response('[]', { status: 200 })));
  installApiAuth(win);
  await win.fetch('/api/delivery');
  expect(original.mock.calls[0][0]).toBe('/api/auth/refresh');
  expect(new Headers(original.mock.calls[1][1].headers).get('Authorization')).toBe('Bearer fresh');
});
