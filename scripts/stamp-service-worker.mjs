#!/usr/bin/env node
/**
 * Stamps a per-build cache version into build/service-worker.js. Runs as
 * `postbuild`, so it happens on every `npm run build` including Vercel's.
 *
 * WHY THIS IS NOT OPTIONAL:
 * a browser only re-installs a service worker when the worker's BYTES change.
 * public/service-worker.js is copied verbatim into build/ by CRA, and nothing
 * else in it varies per deploy — so without this step the file is byte-identical
 * forever and the browser never runs `install` or `activate` again. That means:
 *
 *   - the "A new version is available" toast can NEVER fire (it is driven by a
 *     waiting worker, and no new worker is ever created);
 *   - old shell caches are never evicted;
 *   - an installed user's offline shell is frozen at the build they installed.
 *
 * The kiosk account (workshop@graysfitness.com.au) never logs out and never
 * reloads, so a stale worker there would be permanent.
 *
 * The version is derived from a hash of asset-manifest.json rather than a
 * timestamp, so it changes exactly when the app's assets change — a rebuild of
 * identical code does not force every installed client to re-download the shell.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.join(here, '..', 'build');

/**
 * Replace the CACHE_VERSION literal in a service-worker source.
 * Pure + exported so the smoke can test it without running a build.
 *
 * @param {string} source service worker source
 * @param {string} version the version token to stamp in
 * @returns {{source: string, replaced: boolean}}
 */
export function stampVersion(source, version) {
  const re = /const CACHE_VERSION = ['"][^'"]*['"];/;
  if (!re.test(source)) return { source, replaced: false };
  return {
    source: source.replace(re, `const CACHE_VERSION = '${version}';`),
    replaced: true,
  };
}

/** Short, stable version token derived from the built assets. */
export function versionFromAssets(assetManifestJson) {
  return createHash('sha256').update(assetManifestJson).digest('hex').slice(0, 12);
}

// Only run the side-effecting part when invoked directly, not when imported.
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const swPath = path.join(buildDir, 'service-worker.js');
  const manifestPath = path.join(buildDir, 'asset-manifest.json');

  if (!existsSync(swPath)) {
    console.error('stamp-service-worker: build/service-worker.js not found — skipping.');
    process.exit(0);
  }

  const manifestJson = existsSync(manifestPath)
    ? readFileSync(manifestPath, 'utf8')
    : String(Date.now());

  const version = versionFromAssets(manifestJson);
  const { source, replaced } = stampVersion(readFileSync(swPath, 'utf8'), version);

  if (!replaced) {
    // Fail loudly: silently shipping an unstamped worker reintroduces the exact
    // bug this script exists to prevent, and it would look fine.
    console.error('stamp-service-worker: CACHE_VERSION literal not found in build/service-worker.js.');
    process.exit(1);
  }

  writeFileSync(swPath, source);
  console.log(`stamp-service-worker: CACHE_VERSION = '${version}'`);
}
