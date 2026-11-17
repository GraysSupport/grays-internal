// scripts/woo-stock-smoke.mjs — offline smoke for G25 (workorder → website stock).
//
// Covers the pure decision table (lib/wooStock.js planWebsiteChange), the WooCommerce update
// payload (sold-out treatment), the in-transaction queue and the after-commit sync against
// the typed WooCommerce mock. No network, no database.
//
//   node scripts/woo-stock-smoke.mjs

import {
  isWooStockSyncEnabled,
  isWooStockDryRun,
  isSkippedSku,
  planWebsiteChange,
  buildWooUpdate,
  queueWooStock,
  syncWorkorderWebsiteStock,
} from '../lib/wooStock.js';
import { createMockWoo } from '../lib/woocommerce.mock.js';
import { createWooClient, wooConfigured } from '../lib/woocommerce.js';

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const ON = { FEATURE_WOO_STOCK_SYNC: 'true', WOO_STOCK_SYNC_DRY_RUN: 'false' };
const site = (stock, extra = {}) => ({ id: 101, sku: 'TEC-TR600', stock_quantity: stock, manage_stock: true, ...extra });

console.log('switches');
check('feature is OFF when the variable is absent', isWooStockSyncEnabled({}) === false);
check('feature is ON only for "true"', isWooStockSyncEnabled({ FEATURE_WOO_STOCK_SYNC: 'true' }) === true);
check('dry run is the DEFAULT (absent = dry run)', isWooStockDryRun({}) === true);
check('dry run is off only for "false"', isWooStockDryRun({ WOO_STOCK_SYNC_DRY_RUN: 'false' }) === false);

console.log('skip list (owner decision 17 Nov 2026)');
check('Masterkraft third-party stock is skipped', isSkippedSku('MSK-FA3452', {}));
check('per-kg dumbbells are skipped', isSkippedSku('FW-93', {}));
check('consignment InBody is skipped', isSkippedSku('INB-BS01', {}));
check('any package (PKG in SKU) is skipped', isSkippedSku('TEC-SELPKG', {}));
check('extra SKUs can be added by env', isSkippedSku('ABC-1', { WOO_SKIP_SKUS: 'XYZ, abc-1' }));
check('a normal refurbished machine is not skipped', !isSkippedSku('TEC-TR600', {}));

console.log('decision table');
let p = planWebsiteChange({ salesperson: 'JS', qty: 1, website: site(6), env: ON });
check('not WB, stock left → decrease 6 → 5', p.action === 'decrease' && p.before === 6 && p.after === 5, JSON.stringify(p));
p = planWebsiteChange({ salesperson: 'JS', qty: 2, website: site(2), env: ON });
check('not WB, reaches 0 → sold out', p.action === 'soldout' && p.after === 0 && !p.check, JSON.stringify(p));
p = planWebsiteChange({ salesperson: 'JS', qty: 3, website: site(1), env: ON });
check('not WB, website shows less than sold → 0 + sold out + human check', p.action === 'soldout' && p.after === 0 && p.check === true, JSON.stringify(p));
p = planWebsiteChange({ salesperson: 'WB', qty: 1, website: site(4), env: ON });
check('WB with stock left → nothing to send', p.action === 'none', JSON.stringify(p));
p = planWebsiteChange({ salesperson: 'WB', qty: 1, website: site(0), env: ON });
check('WB and website at 0 → sold-out treatment only', p.action === 'soldout_only' && p.after === 0, JSON.stringify(p));
p = planWebsiteChange({ salesperson: 'JS', qty: 1, website: null, env: ON });
check('SKU not on website → needs a human', p.action === 'needs_human' && /not on the website/i.test(p.reason));
p = planWebsiteChange({ salesperson: 'JS', qty: 1, website: site(null, { manage_stock: false }), env: ON });
check('website does not track stock → needs a human', p.action === 'needs_human' && /track stock/i.test(p.reason));
p = planWebsiteChange({ salesperson: 'JS', qty: 1, sku: 'MSK-FA3452', website: site(118), env: ON });
check('skip-list SKU → needs a human, never sent', p.action === 'needs_human' && /do-not-sync/i.test(p.reason));

console.log('WooCommerce payload');
const now = new Date('2026-11-17T03:00:00Z'); // 2:00 pm Melbourne (AEDT, UTC+11)
let body = buildWooUpdate({ action: 'decrease', after: 5 }, now);
check('decrease only sets stock_quantity', JSON.stringify(body) === JSON.stringify({ stock_quantity: 5 }), JSON.stringify(body));
body = buildWooUpdate({ action: 'soldout', after: 0 }, now);
check('sold out sets stock 0', body.stock_quantity === 0);
check('sold out backdates publish date one year (sent as GMT)', body.date_created_gmt === '2025-11-17T03:00:00', body.date_created_gmt);
const meta = Object.fromEntries(body.meta_data.map((m) => [m.key, m.value]));
check('sold out turns Add to Cart off', meta.add_to_cart_button === '0');
check('sold out turns Enquire off', meta.enquire_button === '0');
check('sold out ticks Sold', meta.sold === '1');
check('never touches price, name or images', !('regular_price' in body) && !('name' in body) && !('images' in body));
body = buildWooUpdate({ action: 'soldout_only', after: 0 }, now);
check('sold-out-only does the same treatment', body.stock_quantity === 0 && body.meta_data.length === 3);

// --- fake pg client with an in-memory outbox ------------------------------------------
function fakeDb({ salesperson = 'JS', outboxExists = true } = {}) {
  const outbox = [];
  const logs = [];
  const syncLog = [];
  let ecommerce = false;
  let nextId = 1;
  const client = {
    outbox, logs, syncLog,
    get ecommerce() { return ecommerce; },
    async query(sql, params = []) {
      const t = String(sql).replace(/\s+/g, ' ').trim();
      if (/to_regclass\('public\.woo_stock_outbox'\)/i.test(t)) return { rows: [{ t: outboxExists ? 'woo_stock_outbox' : null }], rowCount: 1 };
      if (/^INSERT INTO woo_stock_outbox/i.test(t)) {
        outbox.push({ id: nextId++, workorder_id: params[0], sku: params[1], qty: params[2], status: 'pending', attempts: 0, result: null, last_error: null });
        return { rows: [], rowCount: 1 };
      }
      if (/^SELECT salesperson FROM workorder/i.test(t)) return { rows: [{ salesperson }], rowCount: 1 };
      if (/^SELECT .* FROM woo_stock_outbox WHERE workorder_id = \$1 AND status IN/i.test(t)) {
        if (client.failSelect) throw new Error('select blip');
        const rows = outbox.filter((r) => r.workorder_id === params[0] && ['pending', 'failed'].includes(r.status));
        return { rows, rowCount: rows.length };
      }
      if (/^UPDATE woo_stock_outbox SET status = 'sending'/i.test(t)) {
        const r = outbox.find((x) => x.id === params[0] && ['pending', 'failed'].includes(x.status));
        if (!r) return { rows: [], rowCount: 0 };
        r.status = 'sending';
        return { rows: [{ id: r.id }], rowCount: 1 };
      }
      if (/^UPDATE woo_stock_outbox SET/i.test(t)) {
        if (client.failMarkSent && params[1] === 'sent') throw new Error('db blip');
        const r = outbox.find((x) => x.id === params[0]);
        r.status = params[1]; r.result = params[2]; r.last_error = params[3]; r.attempts += 1;
        return { rows: [], rowCount: 1 };
      }
      if (/^SELECT status, result FROM woo_stock_outbox WHERE workorder_id/i.test(t)) {
        const rows = outbox.filter((r) => r.workorder_id === params[0]);
        return { rows, rowCount: rows.length };
      }
      if (/^UPDATE workorder SET ecommerce = TRUE/i.test(t)) { ecommerce = true; return { rows: [], rowCount: 1 }; }
      if (/^INSERT INTO workorder_logs/i.test(t)) { logs.push({ event_type: params[1], user_id: params[2], notes: params[3] }); return { rows: [], rowCount: 1 }; }
      if (/^INSERT INTO integration_sync_log/i.test(t)) { syncLog.push(params); return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    },
  };
  return client;
}

console.log('queue (inside the workorder transaction)');
{
  const db = fakeDb();
  const n = await queueWooStock(db, { workorderId: 7, items: [{ product_id: 'TEC-TR600', quantity: 1 }, { product_id: 'X', quantity: 1, is_custom: true }] }, { env: ON });
  check('queues one row per non-custom item', n === 1 && db.outbox.length === 1 && db.outbox[0].sku === 'TEC-TR600');
  const off = fakeDb();
  const n2 = await queueWooStock(off, { workorderId: 7, items: [{ product_id: 'TEC-TR600', quantity: 1 }] }, { env: {} });
  check('feature OFF → writes nothing (portal behaves exactly as before)', n2 === 0 && off.outbox.length === 0);
  const pre = fakeDb({ outboxExists: false });
  const n3 = await queueWooStock(pre, { workorderId: 7, items: [{ product_id: 'TEC-TR600', quantity: 1 }] }, { env: ON });
  check('table not migrated yet → writes nothing, no error', n3 === 0 && pre.outbox.length === 0);
}

console.log('after-commit sync (mock WooCommerce)');
{
  const db = fakeDb();
  const woo = createMockWoo([{ id: 101, sku: 'TEC-TR600', stock_quantity: 6, manage_stock: true }, { id: 102, sku: 'LFT-BN1', stock_quantity: 1, manage_stock: true }]);
  await queueWooStock(db, { workorderId: 7, items: [{ product_id: 'TEC-TR600', quantity: 1 }, { product_id: 'LFT-BN1', quantity: 1 }] }, { env: ON });
  const s = await syncWorkorderWebsiteStock(db, 7, { woo, env: ON, now });
  check('both items sent', s.sent === 2 && db.outbox.every((r) => r.status === 'sent'), JSON.stringify(s));
  check('website stock 6 → 5', woo.products.get(101).stock_quantity === 5);
  check('last unit → website product marked sold', woo.products.get(102).stock_quantity === 0 && woo.products.get(102).meta.sold === '1');
  check('E-Commerce flag ticked automatically', db.ecommerce === true && s.ticked === true);
  check('workorder log says what changed', db.logs.some((l) => /TEC-TR600 6 → 5/.test(l.notes)), JSON.stringify(db.logs));
  check('logged as the Website user', db.logs.every((l) => l.user_id === 'WB'));
  check('sync recorded in integration_sync_log', db.syncLog.length === 2);
}
{
  const db = fakeDb();
  const woo = createMockWoo([{ id: 101, sku: 'TEC-TR600', stock_quantity: 6, manage_stock: true }]);
  await queueWooStock(db, { workorderId: 8, items: [{ product_id: 'TEC-TR600', quantity: 1 }] }, { env: ON });
  const s = await syncWorkorderWebsiteStock(db, 8, { woo, env: { FEATURE_WOO_STOCK_SYNC: 'true' }, now });
  check('dry run writes nothing to the website', woo.products.get(101).stock_quantity === 6 && woo.writes === 0);
  check('dry run records "would set"', db.outbox[0].status === 'dry_run' && db.logs.some((l) => /would set TEC-TR600 6 → 5/.test(l.notes)), JSON.stringify(db.logs));
  check('dry run never ticks the E-Commerce flag', db.ecommerce === false && s.ticked === false);
}
{
  const db = fakeDb();
  const woo = createMockWoo([{ id: 101, sku: 'TEC-TR600', stock_quantity: 6, manage_stock: true }], { failLookups: true });
  await queueWooStock(db, { workorderId: 9, items: [{ product_id: 'TEC-TR600', quantity: 1 }] }, { env: ON });
  const s = await syncWorkorderWebsiteStock(db, 9, { woo, env: ON, now });
  check('website unreachable before any change → row failed (safe to retry), nothing thrown', db.outbox[0].status === 'failed' && /not reachable/i.test(db.outbox[0].last_error) && s.failed === 1);
  check('failure leaves E-Commerce flag unticked for GS', db.ecommerce === false);
  const again = await syncWorkorderWebsiteStock(db, 9, { woo: createMockWoo([{ id: 101, sku: 'TEC-TR600', stock_quantity: 6, manage_stock: true }]), env: ON, now });
  check('a retry picks the failed row up and succeeds', again.sent === 1 && db.ecommerce === true);
}
{
  const db = fakeDb();
  const woo = createMockWoo([]);
  await queueWooStock(db, { workorderId: 10, items: [{ product_id: 'NOPE-1', quantity: 1 }] }, { env: ON });
  await syncWorkorderWebsiteStock(db, 10, { woo, env: ON, now });
  check('SKU missing on website → needs_human, flag unticked', db.outbox[0].status === 'needs_human' && db.ecommerce === false);
}
{
  const db = fakeDb({ salesperson: 'WB' });
  const woo = createMockWoo([{ id: 101, sku: 'TEC-TR600', stock_quantity: 3, manage_stock: true }]);
  await queueWooStock(db, { workorderId: 11, items: [{ product_id: 'TEC-TR600', quantity: 1 }] }, { env: ON });
  await syncWorkorderWebsiteStock(db, 11, { woo, env: ON, now });
  check('WB order: website untouched but flag ticked', woo.writes === 0 && db.outbox[0].status === 'sent' && db.ecommerce === true);
}
{
  const db = fakeDb();
  const products = Array.from({ length: 11 }, (_, i) => ({ id: 200 + i, sku: `S-${i}`, stock_quantity: 5, manage_stock: true }));
  const woo = createMockWoo(products);
  await queueWooStock(db, { workorderId: 12, items: products.map((x) => ({ product_id: x.sku, quantity: 1 })) }, { env: ON });
  await syncWorkorderWebsiteStock(db, 12, { woo, env: ON, now });
  check('more than 10 products on one workorder → nothing sent, all need a human', woo.writes === 0 && db.outbox.every((r) => r.status === 'needs_human'));
}
{
  const db = fakeDb();
  const woo = createMockWoo([{ id: 101, sku: 'TEC-TR600', stock_quantity: 6, manage_stock: true }]);
  const s = await syncWorkorderWebsiteStock(db, 13, { woo, env: {}, now });
  check('feature OFF → sync does nothing', s.skipped === true && woo.writes === 0);
}

console.log('no double-send (review fixes)');
{
  const db = fakeDb();
  const woo = createMockWoo([{ id: 101, sku: 'TEC-TR600', stock_quantity: 6, manage_stock: true }], { failUpdates: true });
  await queueWooStock(db, { workorderId: 20, items: [{ product_id: 'TEC-TR600', quantity: 1 }] }, { env: ON });
  await syncWorkorderWebsiteStock(db, 20, { woo, env: ON, now });
  check('website times out DURING the update → needs a human, never auto-retried', db.outbox[0].status === 'needs_human' && /didn't confirm/i.test(db.outbox[0].last_error), db.outbox[0].status);
}
{
  const db = fakeDb();
  const woo = createMockWoo([{ id: 101, sku: 'TEC-TR600', stock_quantity: 6, manage_stock: true }], { updateError: 'Website returned 400: Invalid parameter' });
  await queueWooStock(db, { workorderId: 21, items: [{ product_id: 'TEC-TR600', quantity: 1 }] }, { env: ON });
  await syncWorkorderWebsiteStock(db, 21, { woo, env: ON, now });
  check('website REFUSES the update (4xx) → failed, safe to retry', db.outbox[0].status === 'failed');
}
{
  const db = fakeDb();
  db.failMarkSent = true;
  const woo = createMockWoo([{ id: 101, sku: 'TEC-TR600', stock_quantity: 6, manage_stock: true }]);
  await queueWooStock(db, { workorderId: 22, items: [{ product_id: 'TEC-TR600', quantity: 1 }] }, { env: ON });
  await syncWorkorderWebsiteStock(db, 22, { woo, env: ON, now });
  db.failMarkSent = false;
  await syncWorkorderWebsiteStock(db, 22, { woo, env: ON, now });
  check('sent but bookkeeping failed → NOT sent again on retry', woo.writes === 1 && woo.products.get(101).stock_quantity === 5, `writes=${woo.writes}`);
}
{
  const db = fakeDb();
  const woo = createMockWoo([{ id: 101, sku: 'TEC-TR600', stock_quantity: 6, manage_stock: true }]);
  await queueWooStock(db, { workorderId: 23, items: [{ product_id: 'TEC-TR600', quantity: 1 }] }, { env: ON });
  await Promise.all([syncWorkorderWebsiteStock(db, 23, { woo, env: ON, now }), syncWorkorderWebsiteStock(db, 23, { woo, env: ON, now })]);
  check('two syncs at once (save + retry) → the row is sent once', woo.writes === 1, `writes=${woo.writes}`);
}
{
  const db = fakeDb();
  const woo = createMockWoo([{ id: 101, sku: 'TEC-TR600', stock_quantity: 6, manage_stock: true }]);
  await queueWooStock(db, { workorderId: 24, items: [{ product_id: 'TEC-TR600', quantity: 1 }] }, { env: ON });
  await syncWorkorderWebsiteStock(db, 24, { woo, env: ON, now, budgetMs: 0 });
  check('time budget used up → row left pending for the retry, request not held', db.outbox[0].status === 'pending' && woo.writes === 0);
}
{
  const db = fakeDb();
  db.failSelect = true;
  let threw = false;
  try { await syncWorkorderWebsiteStock(db, 25, { woo: createMockWoo([]), env: ON, now }); } catch { threw = true; }
  check('database error after the commit never throws', threw === false);
}
{
  const db = fakeDb();
  const n = await queueWooStock(db, { workorderId: 26, items: [{ product_id: 'FW-93', quantity: 2.5 }] }, { env: ON });
  check('decimal quantity (per-kg) is queued without error', n === 1 && db.outbox[0].qty === 2.5);
}

console.log('live adapter');
check('not configured without base URL + key + secret', wooConfigured({ WOO_BASE_URL: 'https://x' }) === false);
{
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (/products\?sku=/.test(url)) return { ok: true, status: 200, json: async () => [{ id: 5, sku: 'A', stock_quantity: 2, manage_stock: true }] };
    return { ok: true, status: 200, json: async () => ({ id: 5 }) };
  };
  const live = createWooClient({ env: { WOO_BASE_URL: 'https://staging.example.test/', WOO_CONSUMER_KEY: 'ck', WOO_CONSUMER_SECRET: 'cs' }, fetch });
  const prod = await live.findProductBySku('A B');
  check('looks a product up by SKU (URL-encoded)', prod.id === 5 && /\/wp-json\/wc\/v3\/products\?sku=A%20B/.test(calls[0].url), calls[0].url);
  check('uses Basic auth, never puts keys in the URL', /^Basic /.test(calls[0].init.headers.Authorization) && !/ck|cs/.test(calls[0].url));
  await live.updateProduct(5, { stock_quantity: 1 });
  check('updates with PUT /products/{id}', calls[1].init.method === 'PUT' && /\/products\/5$/.test(calls[1].url) && JSON.parse(calls[1].init.body).stock_quantity === 1);
}

console.log('workorder handler wiring');
{
  const { default: handler } = await import('../lib/handlers/workorder.js');
  function wiringClient() {
    const log = [];
    return {
      log,
      async query(sql, params) {
        const t = String(sql).replace(/\s+/g, ' ').trim();
        log.push(t);
        if (/to_regclass\('public\.woo_stock_outbox'\)/i.test(t)) return { rows: [{ t: 'woo_stock_outbox' }], rowCount: 1 };
        if (/SELECT access FROM users/i.test(t)) return { rows: [{ access: 'staff' }], rowCount: 1 };
        if (/SELECT stock FROM product WHERE sku = \$1 FOR UPDATE/i.test(t)) return { rows: [{ stock: 5 }], rowCount: 1 };
        if (/AS d$/i.test(t)) return { rows: [{ d: '2026-12-01' }], rowCount: 1 };
        if (/INSERT INTO workorder \(/i.test(t)) return { rows: [{ workorder_id: 42 }], rowCount: 1 };
        if (/SELECT \* FROM workorder WHERE workorder_id = \$1 FOR UPDATE/i.test(t)) return { rows: [{ workorder_id: 42, status: 'Work Ordered', ecommerce: false }], rowCount: 1 };
        if (/COUNT\(\*\) FILTER \(WHERE status = 'Completed'\)/i.test(t)) return { rows: [{ done: '0', total: '2' }], rowCount: 1 };
        if (/INSERT INTO workorder_items/i.test(t)) return { rows: [{ workorder_items_id: 9 }], rowCount: 1 };
        if (/WITH base AS/i.test(t)) return { rows: [{ workorder_id: 42 }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
  }
  const res = () => { const r = { statusCode: null, payload: null }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (p) => { r.payload = p; return r; }; r.end = () => r; r.setHeader = () => {}; return r; };

  const c1 = wiringClient();
  const synced = [];
  const deps = { getClient: async () => c1, env: ON, syncWebsiteStock: async (cl, id) => { synced.push({ id, at: c1.log.length }); return { sent: 1 }; } };
  const r1 = res();
  await handler({ method: 'POST', query: {}, headers: { 'x-user-id': 'JS' }, body: {
    invoice_id: 'INV1', customer_id: 1, salesperson: 'JS', delivery_state: 'VIC', lead_time: '2 weeks', outstanding_balance: 0,
    items: [{ product_id: 'TEC-TR600', quantity: 1, technician_id: 'TT' }, { product_id: 'X', quantity: 1, technician_id: 'TT', is_custom: true, custom_description: 'Cable' }],
  } }, r1, [], deps);
  const iOut = c1.log.findIndex((s) => /^INSERT INTO woo_stock_outbox/i.test(s));
  const iCommit = c1.log.findIndex((s) => /^COMMIT$/i.test(s));
  check('create: workorder still created (201)', r1.statusCode === 201, JSON.stringify(r1.payload));
  check('create: outbox row written INSIDE the transaction', iOut > -1 && iOut < iCommit);
  check('create: custom items are not queued', c1.log.filter((s) => /^INSERT INTO woo_stock_outbox/i.test(s)).length === 1);
  check('create: website sync runs AFTER the commit', synced.length === 1 && synced[0].id === 42 && synced[0].at > iCommit);

  const c2 = wiringClient();
  const synced2 = [];
  const r2 = res();
  await handler({ method: 'PUT', query: { id: 42 }, headers: { 'x-user-id': 'JS' }, body: {
    add_items: [{ product_id: 'TEC-TR600', quantity: 1, condition: 'Refurbished', technician_id: 'TT' }],
  } }, r2, [], { getClient: async () => c2, env: ON, syncWebsiteStock: async (cl, id) => { synced2.push(id); return {}; } });
  const j = c2.log.findIndex((s) => /^INSERT INTO woo_stock_outbox/i.test(s));
  const k = c2.log.findIndex((s) => /^COMMIT$/i.test(s));
  check('add items: outbox row written inside the transaction', j > -1 && j < k);
  check('add items: website sync runs after the commit', synced2.length === 1 && Number(synced2[0]) === 42);

  const c3 = wiringClient();
  const synced3 = [];
  const r3 = res();
  await handler({ method: 'PUT', query: { id: 42 }, headers: { 'x-user-id': 'JS' }, body: { notes: 'hello' } }, r3, [], { getClient: async () => c3, env: ON, syncWebsiteStock: async () => { synced3.push(1); return {}; } });
  check('a save with no new items does not call the website', synced3.length === 0);

  const c4 = wiringClient();
  const synced4 = [];
  await handler({ method: 'POST', query: {}, headers: { 'x-user-id': 'JS' }, body: {
    invoice_id: 'INV1', customer_id: 1, salesperson: 'JS', delivery_state: 'VIC', lead_time: '2 weeks', outstanding_balance: 0,
    items: [{ product_id: 'TEC-TR600', quantity: 1, technician_id: 'TT' }],
  } }, res(), [], { getClient: async () => c4, env: {}, syncWebsiteStock: async () => { synced4.push(1); return {}; } });
  check('feature OFF: no outbox write and no website call', !c4.log.some((s) => /woo_stock_outbox/i.test(s)) && synced4.length === 0);
}

console.log('who sees website-stock notes (owner, 17 Nov 2026: superadmin, GS and the marketing lead only)');
{
  const { default: handler } = await import('../lib/handlers/workorder.js');
  const { default: jwt } = await import('jsonwebtoken');
  const { canSeeWebsiteStockLog } = await import('../lib/wooStock.js');
  const { __JOURNEY_SQL } = await import('../lib/customerJourney.js');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'smoke-secret';
  const tok = (id, roles) => `Bearer ${jwt.sign({ id, roles }, process.env.JWT_SECRET)}`;
  const logs = [
    { id: 1, event_type: 'WORKORDER_CREATED', notes_log: null },
    { id: 2, event_type: 'WEBSITE_STOCK_SYNC', notes_log: 'Website stock updated automatically: FW-129 3 → 2' },
    { id: 3, event_type: 'NOTE_ADDED', notes_log: 'Call first' },
  ];
  const getClient = () => ({
    async query(sql) {
      const t = String(sql).replace(/\s+/g, ' ').trim();
      if (/WITH base AS/i.test(t)) return { rows: [{ workorder_id: 755, status: 'Work Ordered' }], rowCount: 1 };
      if (/FROM workorder_logs l/i.test(t)) return { rows: logs.map((l) => ({ ...l })), rowCount: logs.length };
      if (/SELECT access FROM users/i.test(t)) return { rows: [{ access: 'admin' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  });
  const view = async (authorization) => {
    const r = { statusCode: null, payload: null };
    r.status = (c) => { r.statusCode = c; return r; }; r.json = (p) => { r.payload = p; return r; }; r.end = () => r; r.setHeader = () => {};
    await handler({ method: 'GET', query: { id: 755 }, headers: authorization ? { authorization } : {} }, r, [], { getClient: async () => getClient(), env: {} });
    return (r.payload?.activity || []).map((l) => l.event_type);
  };
  check('a superadmin sees the website-stock notes', (await view(tok('JG', ['superadmin']))).includes('WEBSITE_STOCK_SYNC'));
  check('GS sees them', (await view(tok('GS', ['superadmin', 'sales']))).includes('WEBSITE_STOCK_SYNC'));
  check('the marketing lead (GM, admin) sees them', (await view(tok('GM', ['admin']))).includes('WEBSITE_STOCK_SYNC'));
  const other = await view(tok('KM', ['admin', 'sales']));
  check('another admin/sales login does NOT get them', !other.includes('WEBSITE_STOCK_SYNC') && other.includes('NOTE_ADDED') && other.includes('WORKORDER_CREATED'), other.join(','));
  check('no login → not shown', !(await view(null)).includes('WEBSITE_STOCK_SYNC'));
  check('a forged X-User-Id header does not unlock them', !canSeeWebsiteStockLog(null, {}) );
  check('extra viewers can be set by env', canSeeWebsiteStockLog({ id: 'KM', roles: ['admin'] }, { WOO_STOCK_LOG_VIEWERS: 'KM' }));
  check('the customer journey timeline never includes them', /WEBSITE_STOCK_SYNC/.test(__JOURNEY_SQL));
}

console.log(`\n✅ woo-stock smoke: ${passed} checks passed`);
