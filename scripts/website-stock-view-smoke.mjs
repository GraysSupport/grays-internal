// scripts/website-stock-view-smoke.mjs — offline smoke for G25c (owner chose "G25 follow-ups",
// 18 Nov 2026): the Products page "Website stock" column and the weekly drift report.
// No network, no database. The website is only ever READ — this suite proves it.
//
//   node scripts/website-stock-view-smoke.mjs

import {
  WOO_SKU_BATCH,
  chunkSkus,
  fetchWebsiteStock,
  compareWithWebsite,
  isDriftDay,
  runWeeklyDriftReport,
  handleWebsiteStock,
  handleWebsiteStockDrift,
  mockWebsiteFromPortal,
} from '../lib/websiteStockView.js';
import { createWooClient } from '../lib/woocommerce.js';
import { createMockWoo } from '../lib/woocommerce.mock.js';
import { handleWebsiteStockCron } from '../lib/wooStockRetry.js';
import jwt from 'jsonwebtoken';

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

process.env.JWT_SECRET = 'smoke-secret';
const tokenFor = (id, roles) => jwt.sign({ id, roles }, process.env.JWT_SECRET);

// --- fake fetch that records every request, answering like WooCommerce REST v3 ------------
function recordingFetch(catalogue) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), method: String(init.method || 'GET').toUpperCase() });
    const u = new URL(String(url));
    const wanted = (u.searchParams.get('sku') || '').split(',').filter(Boolean).map((s) => s.toUpperCase());
    const rows = catalogue.filter((p) => wanted.includes(String(p.sku).toUpperCase()));
    return { ok: true, status: 200, json: async () => rows };
  };
  f.calls = calls;
  return f;
}
const ENV = { WOO_BASE_URL: 'https://staging.example.test', WOO_CONSUMER_KEY: 'ck_x', WOO_CONSUMER_SECRET: 'cs_x' };

// --- fake pg client ----------------------------------------------------------------------
function fakeDb(products, { noLogTable = false } = {}) {
  const inserted = [];
  const client = {
    inserted,
    released: false,
    release() { client.released = true; },
    async query(sql, params = []) {
      const t = String(sql).replace(/\s+/g, ' ').trim();
      if (/^SELECT sku, name, brand, stock FROM product/i.test(t)) return { rows: products, rowCount: products.length };
      if (/to_regclass\('public\.integration_sync_log'\)/i.test(t)) return { rows: [{ t: noLogTable ? null : 'integration_sync_log' }], rowCount: 1 };
      if (/^INSERT INTO integration_sync_log/i.test(t)) { inserted.push({ sql: t, params }); return { rows: [], rowCount: 1 }; }
      if (/^SELECT .* FROM integration_sync_log/i.test(t)) {
        const last = inserted[inserted.length - 1];
        return last ? { rows: [{ created_at: new Date('2026-11-16T21:00:00Z'), status: last.params[1], payload: JSON.parse(last.params[2]), error: last.params[3] }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      throw new Error(`unexpected SQL: ${t}`);
    },
  };
  return client;
}

function fakeRes() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  return res;
}

const PORTAL = [
  { sku: 'TEC-TR600', name: 'Treadmill', brand: 'Technogym', stock: 5 },
  { sku: 'LFT-TRSE3HD', name: 'Life Fitness', brand: 'LF', stock: 6 },
  { sku: 'G25-NOWEB', name: 'Not on site', brand: 'GEN', stock: 2 },
  { sku: 'FW-93', name: 'Per kg', brand: 'GEN', stock: 100 },       // skip-listed: never "drift"
  { sku: 'ZERO-NOWEB', name: 'Gone', brand: 'GEN', stock: 0 },
];
const SITE = [
  { id: 1, sku: 'TEC-TR600', stock_quantity: 4, manage_stock: true, status: 'publish' },
  { id: 2, sku: 'lft-trse3hd', stock_quantity: 6, manage_stock: true, status: 'publish' },
  { id: 3, sku: 'FW-93', stock_quantity: 1, manage_stock: true, status: 'publish' },
];

async function main() {
  console.log('G25c website stock column + drift report');

  // 1. batching
  const many = Array.from({ length: 250 }, (_, i) => `SKU-${i}`);
  const batches = chunkSkus(many);
  // 25 Nov 2026: 100 SKUs per call timed out on the live website (765 / 969 unread) → 50.
  check('batch size is 50 SKUs per REST call', WOO_SKU_BATCH === 50 && batches.length === 5 && batches[0].length === 50 && batches[4].length === 50);
  check('blank / comma SKUs are never sent (a comma would split the filter)', chunkSkus(['A', '', null, 'B,C', ' D ']).flat().join('|') === 'A|D');
  check('duplicate SKUs (any case) are sent once', chunkSkus(['A', 'a', 'A']).flat().length === 1);

  // 2. the adapter's batch read is GET-only, ≤100 SKUs per call
  const f = recordingFetch(SITE);
  const woo = createWooClient({ env: ENV, fetch: f });
  check('adapter has a batch read', typeof woo.findProductsBySkus === 'function');
  const found = await woo.findProductsBySkus(['TEC-TR600', 'LFT-TRSE3HD']);
  check('batch read returns the products', found.length === 2);
  check('batch read is one GET with comma-separated SKUs + per_page=100', f.calls.length === 1 && f.calls[0].method === 'GET' && /sku=TEC-TR600%2CLFT-TRSE3HD/.test(f.calls[0].url) && /per_page=100/.test(f.calls[0].url), f.calls[0]?.url);

  const f2 = recordingFetch(SITE);
  const site = await fetchWebsiteStock(createWooClient({ env: ENV, fetch: f2 }), many.concat(PORTAL.map((p) => p.sku)));
  check('255 SKUs → 6 REST calls, never one per row', f2.calls.length === 6, String(f2.calls.length));
  check('website map is keyed case-insensitively', site.map.get('LFT-TRSE3HD')?.stock === 6);
  check('missing SKU is absent from the map', !site.map.has('G25-NOWEB'));

  // a failing batch is reported, not thrown, and its SKUs are "unknown" (not "not on website")
  const flaky = { async findProductsBySkus(list) { if (list.includes('SKU-0')) throw new Error('Website returned 500'); return []; } };
  const part = await fetchWebsiteStock(flaky, many);
  check('a failed batch is reported, other batches still read', part.errors.length === 1 && part.unknown.has('SKU-0') && !part.unknown.has('SKU-200'));

  // 25 Nov 2026 (owner: "969 couldn't be read — Website timed out"):
  // a timed-out batch is split in two and read again, so a slow website still gets read.
  const bigSlow = { calls: [], async findProductsBySkus(list, opts) { bigSlow.calls.push({ n: list.length, t: opts?.timeoutMs }); if (list.length > 25) throw new Error('Website timed out'); return list.map((s, i) => ({ id: i, sku: s, stock_quantity: 1, manage_stock: true, status: 'publish' })); } };
  const healed = await fetchWebsiteStock(bigSlow, many, { deadline: Date.now() + 20000 });
  check('timed-out batches are split and read again → nothing left unread', healed.unknown.size === 0 && healed.map.size === 250 && healed.errors.length === 0, JSON.stringify({ unknown: healed.unknown.size, errors: healed.errors }));
  check('bulk reads get the longer read timeout (≤ 15 s), never the 5 s single-lookup one', bigSlow.calls.every((c) => c.t > 5000 && c.t <= 15000), JSON.stringify(bigSlow.calls.slice(0, 3)));
  const refused = { calls: 0, async findProductsBySkus() { refused.calls += 1; throw new Error('Website returned 401'); } };
  await fetchWebsiteStock(refused, many.slice(0, 50));
  check('a refusal (not a timeout) is not retried', refused.calls === 1);
  const always = { async findProductsBySkus() { throw new Error('Website timed out'); } };
  const down = await fetchWebsiteStock(always, many, { deadline: Date.now() + 20000 });
  check('website down → every SKU unknown, errors summarised (not one line per batch)', down.unknown.size === 250 && down.errors.length <= 2, JSON.stringify(down.errors));
  const nearEnd = { calls: [], async findProductsBySkus(list, opts) { nearEnd.calls.push(opts?.timeoutMs); return []; } };
  await fetchWebsiteStock(nearEnd, many.slice(0, 50), { deadline: Date.now() + 8000 });
  check('a read never waits past the deadline (timeout trimmed to the time left)', nearEnd.calls.length === 1 && nearEnd.calls[0] <= 8000, JSON.stringify(nearEnd.calls));

  // 3. comparison
  const rows = compareWithWebsite(PORTAL, site);
  const by = Object.fromEntries(rows.map((r) => [r.sku, r]));
  check('mismatch flagged with portal and website numbers', by['TEC-TR600'].state === 'mismatch' && by['TEC-TR600'].portal === 5 && by['TEC-TR600'].website === 4);
  check('equal stock = match', by['LFT-TRSE3HD'].state === 'match');
  check('SKU missing on the website = not_on_website', by['G25-NOWEB'].state === 'not_on_website');
  check('skip-listed SKU (per kg) is never drift', by['FW-93'].state === 'skipped');
  check('an unread SKU is unknown, never "not on website"', compareWithWebsite([{ sku: 'SKU-0', stock: 1 }], part)[0].state === 'unknown');

  // 4. Monday (Melbourne) detection
  check('Mon 07:00 Melbourne (Sun 20:00 UTC) is drift day', isDriftDay(new Date('2026-11-22T20:00:00Z')) === true);
  check('Tue 07:00 Melbourne is not', isDriftDay(new Date('2026-11-23T20:00:00Z')) === false);

  // 5. weekly report stores mismatches only, read-only toward the website
  const f3 = recordingFetch(SITE);
  const db = fakeDb(PORTAL);
  const rep = await runWeeklyDriftReport(db, { env: ENV, woo: createWooClient({ env: ENV, fetch: f3 }) });
  check('weekly report counts mismatches + not-on-website', rep.ok && rep.mismatches === 1 && rep.notOnWebsite === 1, JSON.stringify(rep));
  const stored = db.inserted[0] && JSON.parse(db.inserted[0].params[2]);
  check('stored payload holds mismatches only (no matching SKUs)', stored && stored.rows.length === 2 && !stored.rows.some((r) => r.sku === 'LFT-TRSE3HD'));
  check('zero-stock SKU missing on the website is not drift', !stored.rows.some((r) => r.sku === 'ZERO-NOWEB'));
  check('report logged as woocommerce / stock_drift_report', /integration_sync_log/.test(db.inserted[0].sql) && db.inserted[0].params[0] === 'stock_drift_report');
  check('no table yet (42P01-safe) → skipped, nothing thrown', (await runWeeklyDriftReport(fakeDb(PORTAL, { noLogTable: true }), { env: ENV, woo: createMockWoo([]) })).skipped === true);
  check('website not set up → skipped', (await runWeeklyDriftReport(fakeDb(PORTAL), { env: {} })).skipped === true);

  // 6. the API: who may see it
  const getClient = async () => fakeDb(PORTAL);
  const call = async (q, token, env = ENV, wooArg) => {
    const res = fakeRes();
    await handleWebsiteStock({ method: 'GET', query: q, headers: token ? { authorization: `Bearer ${token}` } : {} }, res, { getClient, env, woo: wooArg !== undefined ? wooArg : (env.WOO_BASE_URL ? createWooClient({ env, fetch: recordingFetch(SITE) }) : undefined) });
    return res;
  };
  check('no login → 401', (await call({ resource: 'column' })).statusCode === 401);
  check('staff → 403', (await call({ resource: 'column' }, tokenFor('JS', ['staff']))).statusCode === 403);
  check('workshop (WK kiosk, admin) → 403 (G17)', (await call({ resource: 'column' }, tokenFor('WK', ['admin']))).statusCode === 403);
  check('technician → 403', (await call({ resource: 'column' }, tokenFor('TT', ['technician']))).statusCode === 403);
  const col = await call({ resource: 'column' }, tokenFor('GS', ['superadmin']));
  check('superadmin (GS) gets the column', col.statusCode === 200 && col.body.items['TEC-TR600'].website === 4 && col.body.items['G25-NOWEB'].state === 'not_on_website', JSON.stringify(col.body));
  check('marketing lead (GM, admin) gets the column', (await call({ resource: 'column' }, tokenFor('GM', ['admin']))).statusCode === 200);
  check('GM is NOT given the drift report (superadmin view)', (await call({ resource: 'drift' }, tokenFor('GM', ['admin']))).statusCode === 403);
  const drift = await call({ resource: 'drift' }, tokenFor('GS', ['superadmin']));
  check('superadmin live drift check = mismatches only', drift.statusCode === 200 && drift.body.rows.length === 2 && drift.body.counts.mismatches === 1);
  const last = await call({ resource: 'report' }, tokenFor('GS', ['superadmin']));
  check('latest weekly report: none yet → report null', last.statusCode === 200 && last.body.report === null);
  check('website not set up → available:false, never an error', (await call({ resource: 'column' }, tokenFor('GS', ['superadmin']), {})).body.available === false);
  check('unknown resource → 400', (await call({ resource: 'nope' }, tokenFor('GS', ['superadmin']))).statusCode === 400);
  const post = fakeRes();
  await handleWebsiteStock({ method: 'POST', query: { resource: 'column' }, headers: { authorization: `Bearer ${tokenFor('GS', ['superadmin'])}` } }, post, { getClient, env: ENV });
  check('POST → 405 (read-only API)', post.statusCode === 405);

  // 7. mock (Preview without WooCommerce keys): sample data, clearly labelled
  const mockCol = await call({ resource: 'column' }, tokenFor('GS', ['superadmin']), { WOO_MOCK: 'true' }, null);
  check('WOO_MOCK → source "mock" with sample website data', mockCol.statusCode === 200 && mockCol.body.source === 'mock' && Object.keys(mockCol.body.items).length === PORTAL.length);
  const sample = mockWebsiteFromPortal(PORTAL);
  check('mock sample is deterministic', JSON.stringify(sample) === JSON.stringify(mockWebsiteFromPortal(PORTAL)));

  // 8. cron: the drift path is CRON_SECRET-checked; the daily job runs the report on Mondays
  const dres = fakeRes();
  await handleWebsiteStockDrift({ method: 'GET', headers: {} }, dres, { getClient, env: { ...ENV, CRON_SECRET: 's3' } });
  check('drift cron path without the secret → 401', dres.statusCode === 401);
  const dres2 = fakeRes();
  await handleWebsiteStockDrift({ method: 'GET', headers: { authorization: 'Bearer s3' } }, dres2, { getClient, env: { ...ENV, CRON_SECRET: 's3' }, report: async () => ({ ok: true, mismatches: 0 }) });
  check('drift cron path with the secret → 200', dres2.statusCode === 200 && dres2.body.ok === true);
  const dres3 = fakeRes();
  await handleWebsiteStockDrift({ method: 'GET', headers: { authorization: 'Bearer x' } }, dres3, { getClient, env: ENV });
  check('no CRON_SECRET configured → 503', dres3.statusCode === 503);

  let reportRan = 0;
  const cronRes = fakeRes();
  await handleWebsiteStockCron({ method: 'GET', headers: { authorization: 'Bearer s3' } }, cronRes, {
    getClient, env: { CRON_SECRET: 's3' }, run: async () => ({ skipped: true }),
    now: new Date('2026-11-22T20:00:00Z'), driftReport: async () => { reportRan += 1; return { ok: true }; },
  });
  check('daily job runs the drift report on Monday', reportRan === 1 && cronRes.body.drift?.ok === true, JSON.stringify(cronRes.body));
  await handleWebsiteStockCron({ method: 'GET', headers: { authorization: 'Bearer s3' } }, fakeRes(), {
    getClient, env: { CRON_SECRET: 's3' }, run: async () => ({ skipped: true }),
    now: new Date('2026-11-23T20:00:00Z'), driftReport: async () => { reportRan += 1; return { ok: true }; },
  });
  check('… and not on other days', reportRan === 1);

  // 10. review fixes (19 Nov 2026)
  const slow = { calls: 0, async findProductsBySkus(list) { slow.calls += 1; return []; } };
  const late = await fetchWebsiteStock(slow, many, { deadline: Date.now() - 1 });
  check('past the deadline no batch starts; SKUs become "unknown", report notes it', slow.calls === 0 && late.unknown.size === 250 && late.errors.some((e) => /out of time/i.test(e)));
  const commaSite = await fetchWebsiteStock(createMockWoo([]), ['A,B']);
  check('a SKU with a comma is "unknown", never a false "not on website"', compareWithWebsite([{ sku: 'A,B', stock: 2 }], commaSite)[0].state === 'unknown');
  const draftSite = await fetchWebsiteStock(createMockWoo([{ id: 9, sku: 'DRAFT-1', stock_quantity: 2, manage_stock: true, status: 'draft' }]), ['DRAFT-1']);
  check('a draft / private product is flagged as not published', compareWithWebsite([{ sku: 'DRAFT-1', stock: 2 }], draftSite)[0].published === false);

  const order = [];
  const cronRes2 = fakeRes();
  await handleWebsiteStockCron({ method: 'GET', headers: { authorization: 'Bearer s3' } }, cronRes2, {
    getClient, env: { CRON_SECRET: 's3' }, now: new Date('2026-11-22T20:00:00Z'),
    run: async (c, opts) => { order.push(['run', opts.budgetMs]); return { ok: true }; },
    driftReport: async (c, opts) => { order.push(['drift', opts.deadline]); return { ok: true }; },
  });
  // 25 Nov 2026: with the full 45 s the report was left ~10 s (765 / 965 unread) — Mondays cap retries at 20 s.
  check('Monday: stock retries run FIRST (capped at 20 s), the report after', order[0]?.[0] === 'run' && order[0][1] === 20000 && order[1]?.[0] === 'drift', JSON.stringify(order));
  check('… and the report deadline is measured from the start, inside the 60 s limit', typeof order[1]?.[1] === 'number' && order[1][1] <= Date.now() + 52000);
  const tue = [];
  await handleWebsiteStockCron({ method: 'GET', headers: { authorization: 'Bearer s3' } }, fakeRes(), {
    getClient, env: { CRON_SECRET: 's3' }, now: new Date('2026-11-23T20:00:00Z'),
    run: async (c, opts) => { tue.push(opts.budgetMs); return { ok: true }; },
    driftReport: async () => ({ ok: true }),
  });
  check('other days: retries keep the full 45 s', tue[0] === 45000, JSON.stringify(tue));

  // review 25 Nov 2026: a timeout while the body downloads is still "Website timed out" (→ split + retry)
  const bodyTimeout = async () => ({ ok: true, status: 200, json: async () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; } });
  let bodyMsg = '';
  try { await createWooClient({ env: ENV, fetch: bodyTimeout }).findProductsBySkus(['A']); } catch (e) { bodyMsg = e.message; }
  check('timeout during the body download → "Website timed out"', bodyMsg === 'Website timed out', bodyMsg);

  let releasedBeforeRead = null;
  const db2 = fakeDb(PORTAL);
  const watching = { async findProductsBySkus() { releasedBeforeRead = db2.released; return []; } };
  await handleWebsiteStock({ method: 'GET', query: { resource: 'column' }, headers: { authorization: `Bearer ${tokenFor('GS', ['superadmin'])}` } }, fakeRes(), { getClient: async () => db2, env: ENV, woo: watching });
  check('the column releases its database connection before reading the website', releasedBeforeRead === true);

  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../lib/websiteStockView.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
  check('websiteStockView.js never calls a write (no updateProduct / PUT / POST)', !/updateProduct|['"]PUT['"]|['"]POST['"]|method:/.test(src));

  // 9. READ-ONLY proof: everything above, through the real adapter, made GET requests only
  const all = [...f.calls, ...f2.calls, ...f3.calls];
  check('every website request was a GET (no PUT/POST/PATCH/DELETE)', all.length > 0 && all.every((c) => c.method === 'GET'), all.map((c) => c.method).join(','));
  const m = createMockWoo(SITE.map((p) => ({ ...p })));
  await runWeeklyDriftReport(fakeDb(PORTAL), { env: ENV, woo: m });
  await fetchWebsiteStock(m, PORTAL.map((p) => p.sku));
  check('mock website saw zero writes', m.writes === 0);

  console.log(`\n${passed} checks passed`);
}

main().catch((err) => { console.error(err.message || err); process.exit(1); });
