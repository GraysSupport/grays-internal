// P7 (owner approved 5 Nov 2026) — the workorder / delivery / customer / waitlist / lots APIs
// need a valid login. This is the browser half, installed once in src/index.js:
//
//   - every same-origin /api call carries the login token and the user id (pages that already
//     set their own headers keep them), so no page had to be rewritten;
//   - a login within 10 minutes of expiry is renewed (POST /api/auth/refresh) before the call —
//     App.js also asks every 5 s while the session is active — so people working all day are
//     not signed out every hour. The WK workshop kiosk does not renew: one 12 h shift;
//   - a 401 from one of the five login-only areas means the login is dead: clear it and go to
//     the sign-in page (never from the sign-in page itself or the public /scan page).
//
// The server is the authority (lib/apiLogin.js); this only keeps the browser in step with it.

import { getStoredUser, getToken } from './auth.js';

const GATED_ROOTS = ['workorder', 'delivery', 'customers', 'customer', 'waitlist', 'waitlists', 'lots', 'lot'];
const REFRESH_URL = '/api/auth/refresh';
const RENEW_WINDOW_MS = 10 * 60 * 1000;
const NO_REDIRECT_PATHS = ['/', '/scan'];
const KIOSK_ID = 'WK';

function urlOf(input) {
  if (typeof input === 'string') return input;
  if (input && typeof input.url === 'string') return input.url;
  return String(input || '');
}

/** The /api path of a same-origin API call, or null. */
function apiPath(input) {
  let raw = urlOf(input);
  try {
    const u = new URL(raw, window.location.origin);
    if (u.origin !== window.location.origin) return null;
    raw = u.pathname;
  } catch {
    return null;
  }
  return raw.startsWith('/api/') ? raw : null;
}

export function isApiUrl(input) {
  return apiPath(input) !== null;
}

export function isLoginGatedUrl(input) {
  const path = apiPath(input);
  if (!path) return false;
  const root = path.slice('/api/'.length).split('/')[0];
  return GATED_ROOTS.includes(root);
}

/** fetch init with the login added (never overwriting a header the page set). */
export function withLogin(init = {}, input = null) {
  // fetch(Request, init) uses init.headers INSTEAD of the Request's own — so start from those.
  const headers = new Headers(init.headers || (input && typeof input === 'object' && input.headers) || {});
  const token = getToken();
  const id = getStoredUser()?.id;
  if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
  if (id && !headers.has('X-User-Id')) headers.set('X-User-Id', id);
  return { ...init, headers };
}

function tokenPayload(token) {
  try {
    const part = String(token).split('.')[1];
    return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

/** Does this token expire within `ms`? (Unreadable → false: let the server decide.) */
export function tokenExpiresWithin(token, ms) {
  const exp = Number(tokenPayload(token)?.exp);
  if (!Number.isFinite(exp)) return false;
  return exp * 1000 - Date.now() <= ms;
}

let inFlight = null;
export function __resetRefreshForTests() {
  inFlight = null;
}

/** Renew the login if it is close to expiry. Single-flight; never throws. */
export function refreshTokenIfDue({ fetchImpl } = {}) {
  const token = getToken();
  const user = getStoredUser();
  if (!token || String(user?.id || '').toUpperCase() === KIOSK_ID) return Promise.resolve();
  if (!tokenExpiresWithin(token, RENEW_WINDOW_MS)) return Promise.resolve();
  const exp = Number(tokenPayload(token)?.exp);
  if (Number.isFinite(exp) && exp * 1000 <= Date.now()) return Promise.resolve(); // already dead
  if (inFlight) return inFlight;
  const doFetch = fetchImpl || window.fetch.bind(window);
  inFlight = (async () => {
    try {
      const res = await doFetch(REFRESH_URL, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return;
      const body = await res.json();
      if (!body?.token) return;
      localStorage.setItem('token', body.token);
      if (Array.isArray(body.roles) && user) localStorage.setItem('user', JSON.stringify({ ...user, roles: body.roles }));
    } catch {
      /* offline / server error — keep the current login; the server decides when it is dead */
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

function endSession(win) {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  localStorage.removeItem('sessionExpiry');
  if (!NO_REDIRECT_PATHS.includes(win.location?.pathname)) win.location.replace('/');
}

/** Wrap win.fetch once. */
export function installApiAuth(win = window) {
  if (!win || typeof win.fetch !== 'function' || win.fetch.__p7ApiAuth) return;
  const original = win.fetch;
  const call = (input, init) => original.call(win, input, init);
  const wrapped = async (input, init) => {
    if (!isApiUrl(input)) return call(input, init);
    const path = apiPath(input);
    if (path !== REFRESH_URL) await refreshTokenIfDue({ fetchImpl: call });
    const res = await call(input, withLogin(init || {}, input));
    if (res && res.status === 401 && isLoginGatedUrl(input)) endSession(win);
    return res;
  };
  wrapped.__p7ApiAuth = true;
  win.fetch = wrapped;
}
