#!/usr/bin/env node
/**
 * F19 incr 1 — Installable PWA (installability core) smoke.
 *
 * Offline. No DB, no network, no browser. Asserts the three things that decide
 * whether the portal actually installs, and the one thing that decides whether
 * installing it would break P1:
 *
 *   1. public/manifest.json is a real, complete, Grays-branded manifest whose
 *      icons exist on disk (a manifest pointing at a missing icon fails install).
 *   2. public/index.html carries the iOS/Safari meta (iOS has no
 *      beforeinstallprompt — the meta tags ARE the install path) and Brand Red.
 *   3. public/service-worker.js NEVER writes a Podium message body to Cache
 *      Storage (P1). The policy function is evaluated OUT OF THE REAL SHIPPED
 *      FILE via node:vm — not reimplemented here — so this test cannot drift
 *      away from what actually ships to the device.
 *   4. src/utils/pwa.js decides the install UI correctly (Android button vs the
 *      iOS Add-to-Home-Screen hint vs nothing when already installed).
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------------------
// 1. Manifest
// ---------------------------------------------------------------------------
const manifestPath = path.join(repo, 'public', 'manifest.json');
check('manifest.json exists', existsSync(manifestPath));

let manifest = {};
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  check('manifest.json parses as JSON', true);
} catch (err) {
  check('manifest.json parses as JSON', false, err.message);
}

eq('manifest name is the portal', manifest.name, 'Grays Internal Portal');
eq('manifest short_name fits a home screen', manifest.short_name, 'Grays Portal');
eq('manifest display is standalone', manifest.display, 'standalone');
eq('manifest start_url is absolute root', manifest.start_url, '/');
eq('manifest scope is absolute root', manifest.scope, '/');
eq('manifest theme_color is Brand Red', manifest.theme_color, '#B50B1D');
check('manifest background_color is set', typeof manifest.background_color === 'string' && /^#[0-9a-fA-F]{6}$/.test(manifest.background_color || ''));
eq('manifest orientation is any', manifest.orientation, 'any');

// The CRA default must be gone — shipping it means the home-screen icon is
// labelled "React App".
const manifestRaw = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : '';
check('manifest drops the CRA default name', !/React App|Create React App/i.test(manifestRaw));

const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
const bySize = (s) => icons.filter((i) => (i.sizes || '').split(' ').includes(s));

check('manifest has a 192x192 icon', bySize('192x192').length > 0);
check('manifest has a 512x512 icon', bySize('512x512').length > 0);

const maskable = icons.filter((i) => (i.purpose || '').split(/\s+/).includes('maskable'));
check('manifest has a maskable icon', maskable.length > 0, 'Android crops a non-maskable icon into its adaptive mask');
check('maskable icon is 512x512', maskable.some((i) => (i.sizes || '').split(' ').includes('512x512')));

const anyPurpose = icons.filter((i) => (i.purpose || '').split(/\s+/).includes('any'));
check('manifest has an explicit "any" purpose icon', anyPurpose.length > 0);

// Every referenced icon must exist, or install silently fails.
for (const icon of icons) {
  const rel = String(icon.src || '').replace(/^\//, '');
  check(`manifest icon exists on disk: ${icon.src}`, rel !== '' && existsSync(path.join(repo, 'public', rel)));
}
check('manifest references at least 3 icons', icons.length >= 3);
check('manifest icons are all PNG (an .ico can win icon selection on some densities)',
  icons.every((i) => (i.type || '') === 'image/png'));

// ---------------------------------------------------------------------------
// 2. index.html — iOS install path + brand
// ---------------------------------------------------------------------------
const htmlPath = path.join(repo, 'public', 'index.html');
const html = existsSync(htmlPath) ? readFileSync(htmlPath, 'utf8') : '';

check('index.html links the manifest', /<link[^>]+rel=["']manifest["']/i.test(html));
check('index.html theme-color is Brand Red', /<meta[^>]+name=["']theme-color["'][^>]+content=["']#B50B1D["']/i.test(html));
check('index.html drops the black CRA theme-color', !/content=["']#000000["']/i.test(html));
check('index.html drops the CRA boilerplate description', !/created using create-react-app/i.test(html));

check('index.html sets apple-mobile-web-app-capable', /apple-mobile-web-app-capable/i.test(html));
check('index.html sets apple-mobile-web-app-status-bar-style', /apple-mobile-web-app-status-bar-style/i.test(html));
// black-translucent puts content under the notch, and the safe-area insets that
// compensate are increment 2. Until then it must stay "default".
check('status bar style is not translucent while safe-area insets are unimplemented',
  !/apple-mobile-web-app-status-bar-style["'][^>]*black-translucent/i.test(html));
check('viewport does not opt into the notch area yet', !/viewport-fit=cover/i.test(html));
check('index.html sets apple-mobile-web-app-title', /apple-mobile-web-app-title/i.test(html));

const appleIcon = html.match(/<link[^>]+rel=["']apple-touch-icon["'][^>]*href=["']([^"']+)["']/i);
check('index.html links an apple-touch-icon', !!appleIcon, 'iOS uses this for the home-screen icon');
if (appleIcon) {
  const rel = appleIcon[1].replace(/^\.?\//, '');
  check('apple-touch-icon file exists on disk', existsSync(path.join(repo, 'public', rel)), appleIcon[1]);
}

// viewport must allow a real mobile layout
check('index.html keeps a responsive viewport', /name=["']viewport["'][^>]+width=device-width/i.test(html));

// ---------------------------------------------------------------------------
// 3. Service worker — P1 cache policy, read out of the REAL file
// ---------------------------------------------------------------------------
const swPath = path.join(repo, 'public', 'service-worker.js');
check('service-worker.js exists', existsSync(swPath));

const swSource = existsSync(swPath) ? readFileSync(swPath, 'utf8') : '';

const ORIGIN = 'https://portal.example.com';

/**
 * Evaluate the REAL service worker in an isolated context and hand back both
 * its pure functions AND its event handlers, plus a recording cache double.
 *
 * Capturing the handlers (not just their names) is what lets the behavioural
 * tests below drive the actual install/fetch code paths. An earlier version of
 * this file only unit-tested cachePolicyForUrl, which meant a Podium message
 * endpoint added straight to PRECACHE_URLS — or an ungated cache.put in the
 * fetch handler — passed the whole suite green. Both are P1 violations.
 *
 * @param {{assetManifest?: object|null, fetchImpl?: Function}} opts
 */
function loadServiceWorker(opts = {}) {
  const { assetManifest = { entrypoints: ['static/js/main.abc.js'] }, fetchImpl } = opts;

  const listeners = [];
  const handlers = {};
  /** every URL written to Cache Storage, by any route */
  const written = [];
  const caches_ = new Map();

  const makeCache = (name) => ({
    add: async (u) => {
      written.push(String(u));
      caches_.get(name).set(String(u), { url: String(u) });
    },
    put: async (req, res) => {
      const u = typeof req === 'string' ? req : req.url;
      written.push(String(u));
      caches_.get(name).set(String(u), res);
    },
    match: async (req) => caches_.get(name).get(typeof req === 'string' ? req : req.url),
    keys: async () => [...caches_.get(name).keys()].map((u) => ({ url: u })),
    delete: async (req) => caches_.get(name).delete(typeof req === 'string' ? req : req.url),
  });

  const sandbox = {
    self: {
      addEventListener: (evt, fn) => { listeners.push(evt); handlers[evt] = fn; },
      skipWaiting: () => { sandbox.__skipWaitingCalled = true; },
      clients: { claim: async () => { sandbox.__claimCalled = true; }, matchAll: async () => [] },
      registration: {},
      location: { origin: ORIGIN },
    },
    caches: {
      open: async (name) => {
        if (!caches_.has(name)) caches_.set(name, new Map());
        return makeCache(name);
      },
      keys: async () => [...caches_.keys()],
      delete: async (name) => caches_.delete(name),
      match: async () => undefined,
    },
    fetch: fetchImpl || (async (url) => {
      const u = typeof url === 'string' ? url : url.url;
      if (String(u).includes('asset-manifest.json')) {
        return {
          ok: assetManifest !== null,
          status: assetManifest !== null ? 200 : 404,
          json: async () => assetManifest,
        };
      }
      return { ok: true, status: 200, type: 'basic', url: String(u), clone() { return this; } };
    }),
    URL,
    console: { log() {}, warn() {}, error() {} },
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(swSource, sandbox, { timeout: 5000 });

  return {
    sandbox,
    listeners,
    handlers,
    written,
    caches_,
    policy: sandbox.cachePolicyForUrl,
    precache: sandbox.precacheUrlsFrom,
  };
}

let policy = null;
let swListeners = [];

if (swSource) {
  try {
    const loaded = loadServiceWorker();
    check('service-worker.js evaluates cleanly', true);
    policy = loaded.policy;
    swListeners = loaded.listeners;
  } catch (err) {
    check('service-worker.js evaluates cleanly', false, err.message);
  }
}

check('service worker exposes cachePolicyForUrl()', typeof policy === 'function');
check('service worker registers an install handler', swListeners.includes('install'));
check('service worker registers an activate handler', swListeners.includes('activate'));
check('service worker registers a fetch handler', swListeners.includes('fetch'));
check('service worker registers a message handler (skip-waiting)', swListeners.includes('message'));

const origin = 'https://portal.example.com';

if (typeof policy === 'function') {
  // --- P1: message-bearing endpoints must NEVER be written to Cache Storage.
  const p1Urls = [
    `${origin}/api/podium/inbox?resource=messages&conversationId=abc`,
    `${origin}/api/podium/inbox?resource=poll&since=2026-07-20T00:00:00Z`,
    `${origin}/api/podium/inbox?resource=conversation&id=abc`,
    `${origin}/api/podium/inbox?resource=note`,
    `${origin}/api/podium/inbox?resource=compose`,
    `${origin}/api/podium/inbox?resource=conversations`,
    `${origin}/api/podium/contact?conversationId=abc`,
    `${origin}/api/podium/webhook`,
  ];
  for (const u of p1Urls) {
    eq(`P1 network-only: ${u.replace(origin, '')}`, policy(u), 'network-only');
  }

  // --- Every API response is treated as never-cacheable, not just Podium's.
  // Authenticated PII (customers, users, leads, workorders) must not land on disk either.
  const apiUrls = [
    `${origin}/api/customers/26/journey`,
    `${origin}/api/users`,
    `${origin}/api/leads`,
    `${origin}/api/workorder?id=1`,
    `${origin}/api/logistics?resource=awaiting-workorder`,
    `${origin}/api/integrations?resource=sync-log`,
  ];
  for (const u of apiUrls) {
    eq(`API never cached: ${u.replace(origin, '')}`, policy(u), 'network-only');
  }

  // --- Static app shell SHOULD be cacheable, or offline cold-load fails.
  const shellUrls = [
    `${origin}/static/js/main.10f2dfe9.js`,
    `${origin}/static/css/main.abc123.css`,
    `${origin}/icons/icon-192.png`,
    `${origin}/manifest.json`,
    `${origin}/favicon.ico`,
  ];
  for (const u of shellUrls) {
    eq(`shell cacheable: ${u.replace(origin, '')}`, policy(u), 'cacheable');
  }

  // --- Navigations are their own mode (app-shell fallback), never plain cacheable.
  eq('navigation policy for /inbox', policy(`${origin}/inbox`), 'navigate');
  eq('navigation policy for root', policy(`${origin}/`), 'navigate');

  // --- Cross-origin must never be cached by us.
  eq('cross-origin is network-only', policy('https://api.podium.com/v4/conversations'), 'network-only');

  // --- Guard against a lazy `startsWith('/api')` style bug: a static asset whose
  // name merely contains "api" must still cache, and a nested podium path must not.
  eq('static asset containing the substring "api" still caches', policy(`${origin}/static/js/apiClient.chunk.js`), 'cacheable');
  eq('nested podium api path is network-only', policy(`${origin}/api/podium/oauth/start`), 'network-only');
  eq('bare /api is network-only', policy(`${origin}/api`), 'network-only');

  // --- Fail CLOSED: anything we cannot parse must not be cached. Without this
  // the unparseable branch could default to 'cacheable' and nothing would notice.
  eq('unparseable url fails closed', policy('not a url at all'), 'network-only');
  eq('empty string fails closed', policy(''), 'network-only');

  // --- A cache-busting query must not turn an asset into a route (or vice versa).
  eq('static asset with a query still caches', policy(`${origin}/static/js/main.abc.js?v=2`), 'cacheable');
  eq('route with a query is still a navigation', policy(`${origin}/leads?stage=Quoted`), 'navigate');
}

// --- Precache completeness -------------------------------------------------
// REGRESSION GUARD (found by real offline verification, 20 Jul 2026): the SW
// precached '/index.html' but NOT the content-hashed bundle it loads, because
// hashed filenames cannot be known when this file is written. Result: the first
// offline launch after install served the shell and rendered a BLANK PAGE.
// The hashed names must be derived from CRA's asset-manifest.json at install.
// Pull the function straight out of the evaluated SW.
let precache = null;
try {
  precache = loadServiceWorker().precache;
} catch (err) {
  /* already reported above */
}

check('service worker exposes precacheUrlsFrom()', typeof precache === 'function');

if (typeof precache === 'function') {
  const craManifest = {
    files: {
      'main.css': '/static/css/main.64d4437c.css',
      'main.js': '/static/js/main.4a0f0f18.js',
      'index.html': '/index.html',
    },
    entrypoints: ['static/css/main.64d4437c.css', 'static/js/main.4a0f0f18.js'],
  };

  const list = precache(craManifest);
  check('precache includes the hashed JS entrypoint', list.includes('/static/js/main.4a0f0f18.js'),
    'without this the first offline launch is a blank page');
  check('precache includes the hashed CSS entrypoint', list.includes('/static/css/main.64d4437c.css'));
  check('precache still includes the app shell html', list.includes('/index.html'));
  check('precache still includes the root url', list.includes('/'));
  check('precache still includes the manifest', list.includes('/manifest.json'));
  check('precache still includes the 192 icon', list.includes('/icons/icon-192.png'));

  // Entrypoints are emitted without a leading slash; they must be normalised.
  check('precache normalises entrypoints to absolute paths',
    list.every((u) => u.startsWith('/')), JSON.stringify(list.filter((u) => !u.startsWith('/'))));

  check('precache list has no duplicates', new Set(list).size === list.length);

  // An already-absolute entrypoint must not gain a second slash.
  const abs = precache({ entrypoints: ['/static/js/x.js'] });
  check('precache does not double the leading slash', abs.includes('/static/js/x.js') && !abs.includes('//static/js/x.js'));

  // Install must never hard-fail on a missing/odd manifest — a broken precache
  // is far better than a service worker that refuses to install at all.
  for (const [label, bad] of [
    ['null', null],
    ['undefined', undefined],
    ['empty object', {}],
    ['entrypoints not an array', { entrypoints: 'nope' }],
    ['entrypoints with junk', { entrypoints: [null, 42, '', 'static/js/ok.js'] }],
  ]) {
    let out;
    let threw = false;
    try { out = precache(bad); } catch (err) { threw = true; }
    check(`precache survives a ${label} manifest`, !threw && Array.isArray(out), 'must not throw');
    if (!threw && Array.isArray(out)) {
      check(`precache still returns the shell for a ${label} manifest`, out.includes('/index.html'));
    }
  }
  const junk = precache({ entrypoints: [null, 42, '', 'static/js/ok.js'] });
  check('precache keeps the valid entry and drops the junk',
    junk.includes('/static/js/ok.js') && !junk.some((u) => u === '/' + null || u === '/42'));
}

// The install handler must actually consult the asset manifest.
check('install handler reads asset-manifest.json', /asset-manifest\.json/.test(swSource),
  'hashed bundle names can only come from there');

if (typeof precache === 'function') {
  // --- P1 defence in depth: the precache list is policy-gated too ------------
  // Without this, one '/api/...' line in PRECACHE_URLS — or a stale/hostile
  // asset-manifest.json, which is fetched over the network — writes an API
  // response to disk at install.
  const poisoned = precache({
    entrypoints: ['/api/podium/inbox?resource=messages', 'static/js/ok.js'],
    files: { bad: '/api/users.js', good: '/static/js/chunk.js' },
  });
  check('precache refuses an api entrypoint', !poisoned.some((u) => u.startsWith('/api')),
    JSON.stringify(poisoned.filter((u) => u.startsWith('/api'))));
  check('precache keeps the legitimate entries alongside the rejected one',
    poisoned.includes('/static/js/ok.js') && poisoned.includes('/static/js/chunk.js'));

  // --- lazy chunks must be precached, or /scan's camera dies offline --------
  const withChunks = precache({
    entrypoints: ['static/js/main.abc.js'],
    files: {
      'main.js': '/static/js/main.abc.js',
      'static/js/490.zxing.chunk.js': '/static/js/490.zxing.chunk.js',
      'index.html': '/index.html',
      'someImage': '/static/media/pic.png',
    },
  });
  check('precache includes code-split chunks from files{}',
    withChunks.includes('/static/js/490.zxing.chunk.js'),
    '/scan camera scanner is a lazy chunk; without it the scanner never loads offline');
  check('precache does not hoover up non-js/css assets',
    !withChunks.includes('/static/media/pic.png'));
  check('precache still de-duplicates across entrypoints and files',
    withChunks.filter((u) => u === '/static/js/main.abc.js').length === 1);
}

// ---------------------------------------------------------------------------
// 3c. Per-build cache version (the update flow depends on it)
// ---------------------------------------------------------------------------
const stampPath = path.join(repo, 'scripts', 'stamp-service-worker.mjs');
check('scripts/stamp-service-worker.mjs exists', existsSync(stampPath));

let stamp = {};
try {
  stamp = await import(pathToFileURL(stampPath).href);
} catch (err) {
  check('stamp-service-worker imports cleanly', false, err.message);
}

if (typeof stamp.stampVersion === 'function') {
  const { source: stamped, replaced } = stamp.stampVersion(swSource, 'abc123def456');
  check('stamper replaces the CACHE_VERSION literal in the real SW source', replaced === true,
    'if this stops matching, every deploy ships a byte-identical worker and the update toast never fires again');
  check('stamped source carries the new version', /const CACHE_VERSION = 'abc123def456';/.test(stamped));
  check('stamped source no longer carries the placeholder', !/const CACHE_VERSION = 'v1';/.test(stamped));

  const missing = stamp.stampVersion('const NOTHING = 1;', 'x');
  check('stamper reports when it cannot find the literal', missing.replaced === false);
}

if (typeof stamp.versionFromAssets === 'function') {
  const a = stamp.versionFromAssets('{"entrypoints":["a.js"]}');
  const b = stamp.versionFromAssets('{"entrypoints":["b.js"]}');
  check('version is stable for identical assets', a === stamp.versionFromAssets('{"entrypoints":["a.js"]}'));
  check('version changes when the assets change', a !== b);
  check('version is a short hex token', /^[0-9a-f]{12}$/.test(a));
}

// package.json must actually run the stamper, or none of the above happens.
const pkg = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
check('package.json runs the stamper on postbuild',
  /stamp-service-worker/.test((pkg.scripts && pkg.scripts.postbuild) || ''),
  'without postbuild the SW bytes never change between deploys');
check('package.json exposes the pwa smoke', Boolean(pkg.scripts && pkg.scripts['smoke:pwa']));

// ---------------------------------------------------------------------------
// 3b. BEHAVIOURAL P1 — drive the real install + fetch handlers.
//
// Classifying a URL correctly is not the same as never writing it. These tests
// run the actual handlers against a recording cache and assert on what was
// WRITTEN. Without them, adding an /api/ path to PRECACHE_URLS, or replacing
// the gated cache.put with an unconditional one, passes every other check here.
// ---------------------------------------------------------------------------

const P1_URLS = [
  `${ORIGIN}/api/podium/inbox?resource=messages&conversationId=abc`,
  `${ORIGIN}/api/podium/inbox?resource=poll&since=2026-07-20T00:00:00Z`,
  `${ORIGIN}/api/podium/inbox?resource=conversation&id=abc`,
  `${ORIGIN}/api/podium/inbox?resource=note`,
  `${ORIGIN}/api/podium/contact?conversationId=abc`,
  `${ORIGIN}/api/customers/26/journey`,
  `${ORIGIN}/api/users`,
];

/** Run the fetch handler for one URL and report whether it intercepted. */
async function driveFetch(sw, url, { method = 'GET', mode = 'cors' } = {}) {
  let responded = false;
  const event = {
    request: { url, method, mode, clone() { return this; } },
    respondWith: (p) => { responded = true; return Promise.resolve(p).catch(() => undefined); },
    waitUntil: (p) => Promise.resolve(p).catch(() => undefined),
  };
  const out = sw.handlers.fetch ? sw.handlers.fetch(event) : undefined;
  await Promise.resolve(out).catch(() => undefined);
  // Let any respondWith chain settle so a deferred cache.put is recorded.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  return responded;
}

if (swSource && typeof policy === 'function') {
  // --- install must never precache anything API-shaped -----------------------
  {
    const sw = loadServiceWorker();
    let installed = Promise.resolve();
    const event = { waitUntil: (p) => { installed = Promise.resolve(p).catch(() => undefined); } };
    if (sw.handlers.install) sw.handlers.install(event);
    await installed;

    const apiWrites = sw.written.filter((u) => u.includes('/api'));
    check('install writes nothing API-shaped to Cache Storage', apiWrites.length === 0, JSON.stringify(apiWrites));
    check('install precaches the app shell', sw.written.includes('/index.html'), JSON.stringify(sw.written));
    check('install precaches the hashed bundle from asset-manifest',
      sw.written.includes('/static/js/main.abc.js'), JSON.stringify(sw.written));
    check('install does NOT call skipWaiting (no swap under an open tab)', !sw.sandbox.__skipWaitingCalled);
  }

  // --- install must survive a missing asset-manifest -------------------------
  {
    const sw = loadServiceWorker({ assetManifest: null });
    let installed = Promise.resolve();
    if (sw.handlers.install) sw.handlers.install({ waitUntil: (p) => { installed = Promise.resolve(p).catch(() => undefined); } });
    let threw = false;
    try { await installed; } catch (err) { threw = true; }
    check('install survives a 404 asset-manifest', !threw);
    check('install still precaches the shell without a manifest', sw.written.includes('/index.html'));
  }

  // --- P1: the fetch handler must not touch, or cache, any API response ------
  {
    const sw = loadServiceWorker();
    for (const u of P1_URLS) {
      // eslint-disable-next-line no-await-in-loop
      const responded = await driveFetch(sw, u);
      check(`fetch does not intercept ${u.replace(ORIGIN, '')}`, responded === false,
        'network-only must fall through untouched');
    }
    const apiWrites = sw.written.filter((w) => w.includes('/api'));
    check('fetch handler writes NO api response to Cache Storage', apiWrites.length === 0, JSON.stringify(apiWrites));
    check('fetch handler wrote nothing at all for api urls', sw.written.length === 0, JSON.stringify(sw.written));
  }

  // --- a static asset SHOULD be intercepted and cached ----------------------
  {
    const sw = loadServiceWorker();
    const responded = await driveFetch(sw, `${ORIGIN}/static/js/main.abc.js`);
    check('fetch intercepts a static asset', responded === true);
    check('fetch caches the static asset', sw.written.some((u) => u.includes('/static/js/main.abc.js')),
      JSON.stringify(sw.written));
  }

  // --- a redirect that lands on an API path must not be cached ---------------
  {
    const sw = loadServiceWorker({
      fetchImpl: async (url) => {
        const u = typeof url === 'string' ? url : url.url;
        if (String(u).includes('asset-manifest')) return { ok: false, status: 404, json: async () => null };
        // Requested an asset; the response actually came from an API path.
        return {
          ok: true, status: 200, type: 'basic',
          url: `${ORIGIN}/api/podium/inbox?resource=messages`,
          clone() { return this; },
        };
      },
    });
    await driveFetch(sw, `${ORIGIN}/static/js/redirected.js`);
    const leaked = sw.written.filter((u) => u.includes('/api'));
    check('a response redirected to an API url is not cached', leaked.length === 0, JSON.stringify(leaked));
  }

  // --- opaque (cross-origin, no-cors) responses must not be cached -----------
  {
    const sw = loadServiceWorker({
      fetchImpl: async (url) => {
        const u = typeof url === 'string' ? url : url.url;
        if (String(u).includes('asset-manifest')) return { ok: false, status: 404, json: async () => null };
        return { ok: true, status: 200, type: 'opaque', url: '', clone() { return this; } };
      },
    });
    await driveFetch(sw, `${ORIGIN}/static/js/opaque.js`);
    check('an opaque response is not cached', sw.written.length === 0, JSON.stringify(sw.written));
  }

  // --- non-GET must never be intercepted ------------------------------------
  {
    const sw = loadServiceWorker();
    const responded = await driveFetch(sw, `${ORIGIN}/static/js/main.abc.js`, { method: 'POST' });
    check('a POST is never intercepted', responded === false);
    check('a POST writes nothing', sw.written.length === 0);
  }

  // --- activate evicts only our own stale caches ----------------------------
  {
    const sw = loadServiceWorker();
    sw.caches_.set('grays-portal-shell-OLD', new Map());
    sw.caches_.set('some-other-app-cache', new Map());
    let done = Promise.resolve();
    if (sw.handlers.activate) sw.handlers.activate({ waitUntil: (p) => { done = Promise.resolve(p).catch(() => undefined); } });
    await done;
    check('activate evicts the stale shell cache', !sw.caches_.has('grays-portal-shell-OLD'));
    check('activate leaves unrelated caches alone', sw.caches_.has('some-other-app-cache'));
    check('activate claims clients', sw.sandbox.__claimCalled === true);
  }

  // --- skip-waiting only on the explicit message ----------------------------
  {
    const sw = loadServiceWorker();
    if (sw.handlers.message) sw.handlers.message({ data: { type: 'SOMETHING_ELSE' } });
    check('an unrelated message does not skipWaiting', !sw.sandbox.__skipWaitingCalled);
    if (sw.handlers.message) sw.handlers.message({ data: { type: 'SKIP_WAITING' } });
    check('SKIP_WAITING message calls skipWaiting', sw.sandbox.__skipWaitingCalled === true);
  }
}

// ---------------------------------------------------------------------------
// 4. Install UI decision logic (src/utils/pwa.js)
// ---------------------------------------------------------------------------
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const IPADOS_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';

let pwa;
try {
  pwa = await import(pathToFileURL(path.join(repo, 'src', 'utils', 'pwa.js')).href);
  check('src/utils/pwa.js imports without JSX/React', true);
} catch (err) {
  check('src/utils/pwa.js imports without JSX/React', false, err.message);
  pwa = {};
}

if (typeof pwa.isIosWebkit === 'function') {
  check('detects iPhone Safari', pwa.isIosWebkit(IOS_UA, false) === true);
  check('does not flag Android as iOS', pwa.isIosWebkit(ANDROID_UA, false) === false);
  check('does not flag desktop Chrome as iOS', pwa.isIosWebkit(DESKTOP_UA, false) === false);
  // iPadOS 13+ reports a desktop Mac UA; the touch-points hint is what distinguishes it.
  check('detects iPadOS via touch hint', pwa.isIosWebkit(IPADOS_UA, true) === true);
  check('plain Mac Safari is not iOS', pwa.isIosWebkit(IPADOS_UA, false) === false);
} else {
  check('pwa.isIosWebkit is exported', false);
}

if (typeof pwa.installUiState === 'function') {
  eq('android with a captured prompt shows the install button',
    pwa.installUiState({ userAgent: ANDROID_UA, standalone: false, deferredPrompt: {}, installed: false }), 'android-install');

  eq('android without a prompt yet shows nothing',
    pwa.installUiState({ userAgent: ANDROID_UA, standalone: false, deferredPrompt: null, installed: false }), 'hidden');

  eq('ios shows the add-to-home-screen hint (no beforeinstallprompt on iOS)',
    pwa.installUiState({ userAgent: IOS_UA, standalone: false, deferredPrompt: null, installed: false }), 'ios-hint');

  eq('already-installed standalone shows nothing',
    pwa.installUiState({ userAgent: ANDROID_UA, standalone: true, deferredPrompt: {}, installed: false }), 'hidden');

  eq('ios in standalone shows nothing',
    pwa.installUiState({ userAgent: IOS_UA, standalone: true, deferredPrompt: null, installed: false }), 'hidden');

  eq('after appinstalled fires, the button goes away even if the prompt is still held',
    pwa.installUiState({ userAgent: ANDROID_UA, standalone: false, deferredPrompt: {}, installed: true }), 'hidden');

  eq('desktop chrome with a prompt may still install',
    pwa.installUiState({ userAgent: DESKTOP_UA, standalone: false, deferredPrompt: {}, installed: false }), 'android-install');
} else {
  check('pwa.installUiState is exported', false);
}

if (typeof pwa.isStandalone === 'function') {
  check('isStandalone true for display-mode standalone',
    pwa.isStandalone({ matchMedia: (q) => ({ matches: q.includes('standalone') }), navigator: {} }) === true);
  check('isStandalone true for iOS navigator.standalone',
    pwa.isStandalone({ matchMedia: () => ({ matches: false }), navigator: { standalone: true } }) === true);
  check('isStandalone false in a normal browser tab',
    pwa.isStandalone({ matchMedia: () => ({ matches: false }), navigator: { standalone: false } }) === false);
  check('isStandalone survives a missing matchMedia',
    pwa.isStandalone({ navigator: {} }) === false);
} else {
  check('pwa.isStandalone is exported', false);
}

// The iOS steps are shown to Chrome/Edge-on-iOS users too, so they must not
// name Safari specifically.
if (Array.isArray(pwa.IOS_INSTALL_STEPS)) {
  check('iOS steps do not name a specific browser',
    !pwa.IOS_INSTALL_STEPS.some((s) => /safari/i.test(s)),
    'Chrome/Edge on iOS reach the same Add-to-Home-Screen flow');
  check('iOS steps mention Add to Home Screen',
    pwa.IOS_INSTALL_STEPS.some((s) => /Add to Home Screen/i.test(s)));
} else {
  check('pwa.IOS_INSTALL_STEPS is exported', false);
}

// The kiosk display and the one-handed warehouse scan page must never get a
// floating overlay: the kiosk never reloads, so it could never be dismissed.
const promptsSrc = existsSync(path.join(repo, 'src', 'components', 'PwaPrompts.js'))
  ? readFileSync(path.join(repo, 'src', 'components', 'PwaPrompts.js'), 'utf8')
  : '';
check('install prompt is suppressed on /workshop', /'\/workshop'/.test(promptsSrc));
check('install prompt is suppressed on /scan', /'\/scan'/.test(promptsSrc));

// ---------------------------------------------------------------------------
// 5. Registration wiring
// ---------------------------------------------------------------------------
const regPath = path.join(repo, 'src', 'serviceWorkerRegistration.js');
check('src/serviceWorkerRegistration.js exists', existsSync(regPath));
const regSrc = existsSync(regPath) ? readFileSync(regPath, 'utf8') : '';
check('registration guards on serviceWorker support', /'serviceWorker'\s+in\s+navigator|"serviceWorker"\s+in\s+navigator/.test(regSrc));
check('registration points at /service-worker.js', /service-worker\.js/.test(regSrc));
check('registration exposes an update callback', /onUpdate/.test(regSrc));

const indexSrc = existsSync(path.join(repo, 'src', 'index.js'))
  ? readFileSync(path.join(repo, 'src', 'index.js'), 'utf8')
  : '';
check('src/index.js registers the service worker', /serviceWorkerRegistration/.test(indexSrc) && /register\s*\(/.test(indexSrc));

// ---------------------------------------------------------------------------
console.log(`\nPWA smoke: ${pass} passed, ${fail} failed\n`);
if (fail) {
  console.error('Failures:');
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
