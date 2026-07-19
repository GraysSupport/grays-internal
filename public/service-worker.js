/* eslint-disable no-restricted-globals */
/**
 * Grays Internal Portal — service worker (F19 incr 1).
 *
 * Hand-rolled rather than Workbox: the repo has no workbox dependency, and the
 * P1 constraint below is important enough to be readable in one file rather
 * than inferred from a generated config.
 *
 * ⚠️ P1 HARD CONSTRAINT — NO CHAT MESSAGE BODY MAY EVER REACH CACHE STORAGE.
 * Podium is the sole system of record for message content. A service worker
 * that cached an API response would write chat text to disk on every rep's
 * phone, where it would survive logout and outlive the conversation.
 *
 * The rule enforced here is deliberately WIDER than P1 requires: **no /api/
 * response is ever cached at all** — not Podium's, not the portal's. Beyond
 * message bodies, those responses carry customer PII, prices and auth-scoped
 * data that has no business on a device's disk. Only the static app shell is
 * cached, which is exactly what offline cold-load actually needs.
 *
 * cachePolicyForUrl() is the single decision point. Every cache write in this
 * file is gated on it, and it is unit-tested directly out of this source file
 * by scripts/podium-pwa-smoke.mjs (loaded via node:vm) so the test can never
 * drift from the shipped policy.
 */

const CACHE_VERSION = 'v1';
const CACHE_NAME = `grays-portal-shell-${CACHE_VERSION}`;

// The static half of the app shell — paths known at author time.
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.ico',
  '/favicon-32x32.webp',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-512-maskable.png',
  '/icons/apple-touch-icon-180.png',
];

/**
 * The other half of the shell is the JS/CSS bundle, whose filenames are
 * content-hashed at build time and therefore CANNOT be listed above.
 *
 * Precaching index.html without them is worse than useless: the first offline
 * launch renders the shell and then a blank page, because React never loads.
 * (Observed on 20 Jul 2026 before this existed.) The runtime cache does not
 * save us — on a first visit the worker is not yet controlling the page, so the
 * bundle request never passes through this worker at all.
 *
 * CRA emits build/asset-manifest.json with an `entrypoints` array listing
 * exactly the files index.html loads, so we read the hashed names from there
 * at install time.
 *
 * Fails soft on purpose: a missing or malformed manifest degrades the offline
 * experience, but must never stop the worker installing.
 *
 * @param {{entrypoints?: string[]}|null|undefined} assetManifest
 * @returns {string[]} absolute, de-duplicated paths to precache
 */
function precacheUrlsFrom(assetManifest) {
  const urls = PRECACHE_URLS.slice();

  const entrypoints = assetManifest && Array.isArray(assetManifest.entrypoints)
    ? assetManifest.entrypoints
    : [];

  for (const entry of entrypoints) {
    if (typeof entry !== 'string' || entry === '') continue;
    urls.push(entry.startsWith('/') ? entry : `/${entry}`);
  }

  // Lazy-loaded chunks are not entrypoints, but a warehouse phone that installs
  // the app and then goes offline still needs them — /scan's camera scanner is
  // a ~120 kB dynamic import, and without this it simply never loads offline.
  const files = assetManifest && assetManifest.files && typeof assetManifest.files === 'object'
    ? Object.values(assetManifest.files)
    : [];
  for (const f of files) {
    if (typeof f !== 'string') continue;
    if (!/\.(js|css)$/.test(f)) continue;
    urls.push(f.startsWith('/') ? f : `/${f}`);
  }

  // De-duplicate: '/index.html' can appear in both halves.
  const deduped = urls.filter((u, i) => urls.indexOf(u) === i);

  // P1 DEFENCE IN DEPTH: every cache write in this file is gated on the policy,
  // and that has to include the precache. Without this line, one '/api/...'
  // path added to PRECACHE_URLS (or arriving via a stale/hostile
  // asset-manifest.json, which is fetched over the network) would write an API
  // response — possibly a chat body — to disk on every install.
  return deduped.filter(
    (u) => cachePolicyForUrl(new URL(u, self.location.origin).href) !== 'network-only',
  );
}

/**
 * Classify a URL into exactly one caching policy.
 *
 *   'network-only' — never read from or written to Cache Storage.
 *   'navigate'     — an SPA route; network-first with the cached shell as the
 *                    offline fallback. Never cached per-route.
 *   'cacheable'    — a static, non-user-specific asset.
 *
 * @param {string} urlString absolute URL
 * @returns {'network-only'|'navigate'|'cacheable'}
 */
function cachePolicyForUrl(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch (err) {
    // Unparseable means we cannot prove it is safe — refuse to cache.
    return 'network-only';
  }

  // Anything not served by us (Podium's API, third parties) is never ours to cache.
  if (url.origin !== self.location.origin) return 'network-only';

  const p = url.pathname;

  // Every backend call. Segment-matched, so a static asset merely *containing*
  // the letters "api" (e.g. /static/js/apiClient.chunk.js) is unaffected.
  if (p === '/api' || p.startsWith('/api/')) return 'network-only';

  // A path with a file extension is an asset; anything else is an SPA route.
  const lastSegment = p.slice(p.lastIndexOf('/') + 1);
  const hasExtension = lastSegment.includes('.');

  return hasExtension ? 'cacheable' : 'navigate';
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    // cache: 'no-store' so we read THIS build's manifest, not a stale copy.
    fetch('/asset-manifest.json', { cache: 'no-store' })
      .then((res) => (res && res.ok ? res.json() : null))
      .catch(() => null)
      .then((assetManifest) => caches
        .open(CACHE_NAME)
        // addAll is atomic: one 404 would reject the whole install and leave
        // the old worker in place, so add individually and tolerate misses.
        .then((cache) => Promise.all(
          precacheUrlsFrom(assetManifest).map((u) => cache.add(u).catch(() => undefined)),
        ))),
    // NOTE: no skipWaiting() here. The new worker waits until the user accepts
    // the update toast, so an open tab is never swapped underneath the user.
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(
        keys
          .filter((k) => k.startsWith('grays-portal-shell-') && k !== CACHE_NAME)
          .map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  // Sent by the update toast when the user accepts the new version.
  if (event && event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only GET is ever cacheable; POST/PUT/DELETE go straight to the network.
  if (request.method !== 'GET') return;

  const policy = cachePolicyForUrl(request.url);

  // P1: no read, no write, no interception. Let it hit the network untouched.
  if (policy === 'network-only') return;

  if (policy === 'navigate' || request.mode === 'navigate') {
    // Network-first so reps always get the live app when they have signal;
    // the cached shell is the offline fallback. The response is NOT cached per
    // route — '/index.html' from the precache serves every route.
    event.respondWith(
      fetch(request)
        // A 502/503 from the host resolves successfully, so .catch() alone
        // would hand the user an error page instead of the offline shell.
        .then((res) => {
          if (res && (res.ok || res.status === 304)) return res;
          throw new Error(`bad navigation response: ${res && res.status}`);
        })
        .catch(() => caches.open(CACHE_NAME).then((cache) => cache
          .match('/index.html')
          .then((cached) => cached || cache.match('/')))),
    );
    return;
  }

  // 'cacheable' — static asset. Cache-first (hashed filenames make these
  // immutable), falling back to the network and populating on the way.
  // Scoped to OUR cache: a bare caches.match() searches every cache on the
  // origin, so a stale or future cache could serve a response this policy never
  // approved.
  event.respondWith(
    caches.open(CACHE_NAME).then((cache) => cache.match(request)).then((cached) => {
      if (cached) return cached;

      return fetch(request).then((response) => {
        // Re-check the policy against the FINAL url: a redirect could have
        // taken us somewhere that must not be cached.
        const ok = response
          && response.status === 200
          && response.type === 'basic'
          && cachePolicyForUrl(response.url || request.url) === 'cacheable';

        if (ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
