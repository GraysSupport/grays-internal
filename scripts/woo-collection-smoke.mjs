// scripts/woo-collection-smoke.mjs — offline smoke for G25e2 (owner's back-in-stock rules,
// 19 Nov 2026, Part 2): the collection page's "Apply Stock to Website" button.
// Plan: feature-plan-stock-sync-2026-11-06.md § G25e2 (defaults E-D5–E-D9).
//
// What was already sent is recorded per collection + SKU in woo_stock_outbox (collection_id),
// NOT on collection_items: "Save Collection" deletes and re-inserts every item, which would wipe
// a per-item counter and send the stock twice.
//
//   node scripts/woo-collection-smoke.mjs

import {
  collectionWebsiteItems,
  planCollectionSend,
  getCollectionWebsite,
  applyCollectionToWebsite,
  syncCollectionWebsiteStock,
  wpAdminLink,
} from '../lib/wooCollection.js';
import { runWebsiteStockRetryJob } from '../lib/wooStockRetry.js';
import { labelCollectionGap } from '../lib/websiteStockView.js';
import { createMockWoo } from '../lib/woocommerce.mock.js';
import { createWooClient } from '../lib/woocommerce.js';

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}
const ON = { FEATURE_WOO_STOCK_SYNC: 'true', WOO_STOCK_SYNC_DRY_RUN: 'false', WOO_BASE_URL: 'https://staging.example.com' };
const DRY = { FEATURE_WOO_STOCK_SYNC: 'true', WOO_BASE_URL: 'https://staging.example.com' };
const now = new Date('2026-11-20T03:00:00Z');

const ITEMS = [
  { collection_items_id: 1, product_sku: 'TEC-TR600', quantity: 2, name: 'Technogym Run 600' },
  { collection_items_id: 2, product_sku: 'LFT-BN1', quantity: 1, name: 'Life Fitness Bench' },
  { collection_items_id: 3, product_sku: 'OTHER', quantity: 4, custom_description: 'mats' },
  { collection_items_id: 4, product_sku: 'MSK-FA3452', quantity: 1, name: 'Masterkraft rack' },
  { collection_items_id: 5, product_sku: 'TEC-TR600', quantity: 1, name: 'Technogym Run 600' },
  { collection_items_id: 6, product_sku: 'NEW-SKU1', quantity: 3, name: 'Brand-new rower' },
];

console.log('what the dialog lists (pure)');
{
  const list = collectionWebsiteItems(ITEMS, new Map([['TEC-TR600', 2]]), ON);
  check('OTHER is never listed (E-D6)', !list.some((x) => x.sku === 'OTHER'));
  const skip = list.find((x) => x.sku === 'MSK-FA3452');
  check('skip-list SKU listed greyed out as "not synced" (E-D6b)', skip && skip.state === 'skip' && skip.remaining === 0);
  const a = list.find((x) => x.collection_items_id === 1);
  const b = list.find((x) => x.collection_items_id === 5);
  check('already-sent quantity is spread over the SKU\'s lines in order', a.applied === 2 && a.remaining === 0 && b.applied === 0 && b.remaining === 1, JSON.stringify([a, b]));
  check('a line with nothing sent yet has all of it remaining', list.find((x) => x.collection_items_id === 6).remaining === 3);
  const over = collectionWebsiteItems(ITEMS, new Map([['LFT-BN1', 5]]), ON).find((x) => x.sku === 'LFT-BN1');
  check('more sent than counted (quantity reduced later) → remaining 0, never negative', over.remaining === 0 && over.applied === 1);
}
{
  const list = collectionWebsiteItems(ITEMS, new Map(), ON);
  let p = planCollectionSend(list, { all: true });
  check('All remaining → one send per SKU, OTHER and skip list left out', JSON.stringify(p.bySku) === JSON.stringify({ 'TEC-TR600': 3, 'LFT-BN1': 1, 'NEW-SKU1': 3 }), JSON.stringify(p));
  check('…with the item count and total quantity for the confirmation', p.items === 4 && p.units === 7);
  p = planCollectionSend(list, { itemIds: [5, 4, 3, 999] });
  check('ticked items only; ticked OTHER / skip / unknown ids are ignored', JSON.stringify(p.bySku) === JSON.stringify({ 'TEC-TR600': 1 }) && p.items === 1, JSON.stringify(p));
  const sentList = collectionWebsiteItems(ITEMS, new Map([['TEC-TR600', 3], ['LFT-BN1', 1], ['NEW-SKU1', 3]]), ON);
  check('everything sent → nothing left to send', planCollectionSend(sentList, { all: true }).items === 0);
}
check('wp-admin link from the website base URL', wpAdminLink(321, ON) === 'https://staging.example.com/wp-admin/post.php?post=321&action=edit');
check('no base URL → no link', wpAdminLink(321, {}) === null);

console.log('WooCommerce draft for a SKU not on the website (E-D8)');
{
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ id: 777, status: 'draft' }) }; };
  const c = createWooClient({ env: { WOO_BASE_URL: 'https://staging.example.com', WOO_CONSUMER_KEY: 'k', WOO_CONSUMER_SECRET: 's' }, fetch });
  const r = await c.createDraftProduct({ sku: 'NEW-SKU1', name: 'Brand-new rower', stock: 3 });
  const body = JSON.parse(calls[0].init.body);
  check('POST /products', /\/wp-json\/wc\/v3\/products$/.test(calls[0].url) && calls[0].init.method === 'POST' && r.id === 777);
  check('draft carries SKU, portal name, manage_stock and stock — and nothing else',
    JSON.stringify(Object.keys(body).sort()) === JSON.stringify(['manage_stock', 'name', 'sku', 'status', 'stock_quantity']) && body.status === 'draft' && body.manage_stock === true && body.stock_quantity === 3, JSON.stringify(body));
}

// --- stateful fake database ------------------------------------------------------------
function fakeDb({ hasCollection = true, status = 'Completed', items = ITEMS, inventoryApplied = false } = {}) {
  const st = { outbox: [], items: items.map((x) => ({ ...x })), coll: { id: 30, name: 'Fernwood Box Hill', status, inventory_applied_at: inventoryApplied ? new Date() : null }, syncLog: [], nextId: 1, tx: [] };
  const res = (rows) => ({ rows, rowCount: rows.length });
  const json = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
  const client = {
    st,
    async query(sql, params = []) {
      const t = String(sql).replace(/\s+/g, ' ').trim();
      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(t)) { st.tx.push(t); return res([]); }
      if (/to_regclass\('public\.woo_stock_outbox'\)/i.test(t)) return res([{ t: 'woo_stock_outbox' }]);
      if (/attname = 'collection_id'/i.test(t)) return res([{ has: hasCollection }]);
      if (/attname = 'kind'/i.test(t)) return res([{ has: true }]);
      if (/attname = 'claimed_at'/i.test(t)) return res([{ has: false }]);
      if (/g25e2:collection/.test(t)) return res(params[0] === 30 ? [{ ...st.coll }] : []);
      if (/g25e2:items/.test(t)) return res(st.items.map((x) => ({ ...x })));
      if (/g25e2:sent-by-sku/.test(t)) {
        const m = new Map();
        for (const o of st.outbox) if (o.collection_id === params[0] && o.status !== 'cancelled') m.set(o.sku, (m.get(o.sku) || 0) + Number(o.qty));
        return res([...m].map(([sku, qty]) => ({ sku, qty })));
      }
      if (/g25e2:rows/.test(t)) return res(st.outbox.filter((o) => o.collection_id === params[0]).map((o) => ({ ...o })));
      if (/g25e2:insert/.test(t)) {
        st.outbox.push({ id: st.nextId++, workorder_id: null, collection_id: params[0], sku: params[1], qty: params[2], kind: 'increase', status: 'pending', attempts: 0, result: json(params[3]), last_error: null, created_at: new Date(0) });
        return res([]);
      }
      if (/g25e2:reopen-lookups/.test(t)) {
        const hit = st.outbox.filter((o) => o.collection_id === params[0] && o.status === 'needs_human' && json(o.result)?.action === 'needs_human');
        for (const o of hit) o.status = 'failed';
        return res(hit.map((o) => ({ id: o.id })));
      }
      if (/g25e2:open/.test(t)) return res(st.outbox.filter((o) => o.collection_id === params[0] && ['pending', 'failed'].includes(o.status)).map((o) => ({ ...o, name: st.items.find((i) => i.product_sku === o.sku)?.name ?? null })));
      if (/g25e2:claim/.test(t)) {
        const o = st.outbox.find((x) => x.id === params[0] && ['pending', 'failed'].includes(x.status));
        if (!o) return res([]);
        o.status = 'sending';
        return res([{ id: o.id }]);
      }
      if (/g25e2:mark/.test(t)) {
        const o = st.outbox.find((x) => x.id === params[0]);
        o.status = params[1]; o.result = json(params[2]); o.last_error = params[3]; o.attempts += 1;
        return res([]);
      }
      if (/g25e2:due-collections/.test(t)) {
        const ids = [...new Set(st.outbox.filter((o) => o.collection_id && ['pending', 'failed'].includes(o.status)).map((o) => o.collection_id))];
        return res(ids.map((id) => ({ collection_id: id })));
      }
      if (/^INSERT INTO integration_sync_log/i.test(t)) { st.syncLog.push(params); return res([]); }
      if (/^INSERT INTO workorder_logs/i.test(t)) throw new Error('collections never write workorder logs');
      // the daily job's workorder sweeps — record the SQL so the orphan sweep can be checked
      if (/^UPDATE woo_stock_outbox o SET status = 'cancelled'/i.test(t) && /NOT EXISTS \(SELECT 1 FROM workorder/i.test(t)) {
        const guarded = /o\.workorder_id IS NOT NULL/i.test(t);
        const hit = st.outbox.filter((o) => ['pending', 'failed'].includes(o.status) && (guarded ? o.workorder_id != null : true));
        for (const o of hit) o.status = 'cancelled';
        return res(hit.map((o) => ({ id: o.id, workorder_id: o.workorder_id, sku: o.sku })));
      }
      return res([]);
    },
  };
  return client;
}
const site = (extra = []) => createMockWoo([
  { id: 101, sku: 'TEC-TR600', stock_quantity: 0, manage_stock: true, meta: { sold: '1' }, price: '1795', name: 'Run 600' },
  { id: 102, sku: 'LFT-BN1', stock_quantity: 2, manage_stock: true, meta: { sold: '0' } },
  ...extra,
]);

console.log('GET — the dialog data');
{
  const db = fakeDb({ status: 'In Transit' });
  const r = await getCollectionWebsite(db, 30, { env: ON });
  check('available when the switch is on and migration 0017 is applied', r.available === true && r.enabled === true);
  check('warns when the collection is not Completed yet (E-D5)', r.completed === false);
  check('"N items not on the website yet" reminder (E-D7)', r.notOnWebsite === 4, JSON.stringify(r.notOnWebsite));
  const off = await getCollectionWebsite(fakeDb(), 30, { env: {} });
  check('switch off → shown but not available, with the reason', off.available === false && /switched off/i.test(off.reason));
  const pre = await getCollectionWebsite(fakeDb({ hasCollection: false }), 30, { env: ON });
  check('before migration 0017 → not available (button hidden)', pre.available === false && pre.ready === false);
}

console.log('POST — Apply Stock to Website');
{
  const db = fakeDb();
  const woo = site();
  const r = await applyCollectionToWebsite(db, 30, { all: true, actorId: 'GS', env: ON, woo, now });
  check('queued one row per SKU inside a transaction', db.st.tx[0] === 'BEGIN' && db.st.tx.includes('COMMIT') && db.st.outbox.length === 3, JSON.stringify(db.st.outbox.map((o) => [o.sku, o.qty])));
  check('rows belong to the collection, not a workorder', db.st.outbox.every((o) => o.collection_id === 30 && o.workorder_id === null && o.kind === 'increase'));
  check('who pressed it is recorded', db.st.outbox.every((o) => o.result?.by === 'GS'));
  const w101 = woo.products.get(101);
  check('Sold product back on sale: 0 → 3, Sold off, Add to Cart + Enquire on, publish date now', w101.stock_quantity === 3 && w101.meta.sold === '0' && w101.meta.add_to_cart_button === '1' && w101.meta.enquire_button === '1' && w101.date_created_gmt === '2026-11-20T03:00:00', JSON.stringify(w101));
  check('price and title untouched', w101.price === '1795' && w101.name === 'Run 600');
  check('in-stock product: quantity only (2 → 3)', woo.products.get(102).stock_quantity === 3 && woo.products.get(102).date_created_gmt === undefined);
  const draft = [...woo.products.values()].find((p) => p.sku === 'NEW-SKU1');
  check('SKU not on the website → a DRAFT is created with stock 3', draft && draft.status === 'draft' && draft.stock_quantity === 3 && draft.manage_stock === true && draft.name === 'Brand-new rower', JSON.stringify(draft));
  check('draft has no price, images or description', !('price' in draft) && !('regular_price' in draft) && !('images' in draft) && !('description' in draft));
  check('summary counts', r.ok === true && r.queued === 3 && r.summary.sent === 2 && r.summary.drafts === 1, JSON.stringify(r));
  const again = await applyCollectionToWebsite(db, 30, { all: true, actorId: 'GS', env: ON, woo, now });
  check('pressing it again sends nothing twice', again.queued === 0 && db.st.outbox.length === 3 && woo.products.get(102).stock_quantity === 3);
  const view = await getCollectionWebsite(db, 30, { env: ON });
  const nw = view.items.find((x) => x.sku === 'NEW-SKU1');
  check('item note: draft created + wp-admin link', /draft created/i.test(nw.note) && nw.adminUrl === `https://staging.example.com/wp-admin/post.php?post=${draft.id}&action=edit`, JSON.stringify(nw));
  check('reminder goes to 0 once everything is sent', view.notOnWebsite === 0);
  // "Save Collection" deletes and re-inserts every line (new ids) — nothing may be resent.
  db.st.items = ITEMS.map((x, i) => ({ ...x, collection_items_id: 100 + i }));
  const afterSave = await applyCollectionToWebsite(db, 30, { all: true, actorId: 'GS', env: ON, woo, now });
  check('after Save Collection re-creates the lines, nothing is sent twice', afterSave.queued === 0 && db.st.outbox.length === 3);
  db.st.items.push({ collection_items_id: 200, product_sku: 'LFT-BN1', quantity: 2, name: 'Life Fitness Bench' });
  const more = await applyCollectionToWebsite(db, 30, { all: true, actorId: 'GS', env: ON, woo, now });
  check('a line added later sends only the new quantity', more.queued === 1 && db.st.outbox.at(-1).sku === 'LFT-BN1' && Number(db.st.outbox.at(-1).qty) === 2 && woo.products.get(102).stock_quantity === 5);
}
{
  const db = fakeDb();
  const woo = site();
  await applyCollectionToWebsite(db, 30, { itemIds: [2], actorId: 'GM', env: ON, woo, now });
  check('ticked items only', db.st.outbox.length === 1 && db.st.outbox[0].sku === 'LFT-BN1' && woo.products.get(101).stock_quantity === 0);
}
{
  const db = fakeDb();
  const woo = site();
  await applyCollectionToWebsite(db, 30, { all: true, actorId: 'GS', env: DRY, woo, now });
  check('dry run: nothing written to the website, no draft created', woo.writes === 0 && [...woo.products.values()].length === 2);
  check('dry run: rows recorded as dry_run ("would …")', db.st.outbox.every((o) => o.status === 'dry_run') && db.st.outbox.find((o) => o.sku === 'NEW-SKU1').result.action === 'create_draft');
}
{
  const db = fakeDb();
  const r = await applyCollectionToWebsite(db, 30, { all: true, actorId: 'GS', env: {}, woo: site(), now });
  check('switch off → refused, nothing queued', r.ok === false && r.status === 409 && db.st.outbox.length === 0);
  const pre = fakeDb({ hasCollection: false });
  const r2 = await applyCollectionToWebsite(pre, 30, { all: true, actorId: 'GS', env: ON, woo: site(), now });
  check('before migration 0017 → refused', r2.ok === false && r2.status === 409);
  const none = await applyCollectionToWebsite(fakeDb(), 999, { all: true, actorId: 'GS', env: ON, woo: site(), now });
  check('unknown collection → 404', none.ok === false && none.status === 404);
}
{
  const db = fakeDb();
  const r = await applyCollectionToWebsite(db, 30, { all: true, actorId: 'GS', env: ON, woo: createMockWoo([], { failLookups: true }), now });
  check('website down → rows failed (safe to retry), still counted as sent-to-queue', db.st.outbox.every((o) => o.status === 'failed') && r.summary.failed === 3);
  const woo = site();
  const again = await applyCollectionToWebsite(db, 30, { all: true, actorId: 'GS', env: ON, woo, now });
  check('pressing Apply again retries the failed rows (no new rows)', again.queued === 0 && db.st.outbox.every((o) => o.status === 'sent') && woo.products.get(102).stock_quantity === 3);
}
{
  const db = fakeDb();
  const woo = site();
  woo.createDraftProduct = async () => { const e = new Error('Website timed out'); throw e; };
  await applyCollectionToWebsite(db, 30, { itemIds: [6], actorId: 'GS', env: ON, woo, now });
  check('draft request timed out → needs a human (never re-created automatically)', db.st.outbox[0].status === 'needs_human' && /check/i.test(db.st.outbox[0].last_error));
}

console.log('daily job picks up collection rows');
{
  const db = fakeDb();
  db.st.outbox.push({ id: 50, workorder_id: null, collection_id: 30, sku: 'LFT-BN1', qty: 1, kind: 'increase', status: 'failed', attempts: 1, result: {}, last_error: 'x', created_at: new Date(0) });
  db.st.nextId = 51;
  const woo = site();
  const s = await runWebsiteStockRetryJob(db, { env: ON, syncCollection: (c, id, o) => syncCollectionWebsiteStock(c, id, { woo, env: ON, now, ...o }) });
  check('the "workorder deleted" sweep never closes a collection row', db.st.outbox[0].status !== 'cancelled', JSON.stringify(db.st.outbox[0]));
  check('…and the job sends it', db.st.outbox[0].status === 'sent' && woo.products.get(102).stock_quantity === 3 && s.collections === 1, JSON.stringify(s));
}

console.log('drift report label (E-D9)');
{
  const rows = [
    { sku: 'TEC-TR600', portal: 0, website: 3, state: 'mismatch' },
    { sku: 'LFT-BN1', portal: 4, website: 2, state: 'mismatch' },
    { sku: 'X-1', portal: 1, website: 1, state: 'match' },
  ];
  const out = labelCollectionGap(rows, new Map([['TEC-TR600', ['Fernwood Box Hill']], ['LFT-BN1', ['Fernwood Box Hill']]]));
  check('website ahead because a collection was sent before Apply Stock and Inventory → labelled', out[0].note === 'Collection Fernwood Box Hill sent to website, inventory not applied yet' && out[0].reason === 'collection_pending');
  check('website BEHIND the portal is still a plain mismatch', !out[1].note);
}

console.log('API — /api/collections?resource=website | website-apply (who may)');
{
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'g25e2-smoke-secret';
  const jwt = (await import('jsonwebtoken')).default;
  const { default: collections } = await import('../lib/handlers/collections.js');
  const tok = (id, roles) => `Bearer ${jwt.sign({ id, email: `${id}@x`, roles }, process.env.JWT_SECRET)}`;
  const call = async (method, resource, { auth, body, idHeader } = {}) => {
    const calls = { get: [], apply: [] };
    const res = { statusCode: 200, payload: null, headers: {} };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (p) => { res.payload = p; return res; };
    res.end = () => res;
    res.setHeader = (k, v) => { res.headers[k] = v; };
    const db = { async query() { return { rows: [], rowCount: 0 }; }, release() {} };
    const headers = { ...(auth ? { authorization: auth } : {}), ...(idHeader ? { 'x-user-id': idHeader } : {}) };
    await collections({ method, query: { resource, id: '30' }, body, headers }, res, [], {
      getClient: async () => db, env: ON,
      getCollectionWebsite: async (c, id, o) => { calls.get.push({ id, o }); return { found: true, available: true, items: [] }; },
      applyCollectionToWebsite: async (c, id, o) => { calls.apply.push({ id, o }); return { ok: true, queued: 1, summary: {} }; },
    });
    return { code: res.statusCode, body: res.payload, calls };
  };
  let r = await call('GET', 'website');
  check('no login → 401', r.code === 401 && r.calls.get.length === 0);
  r = await call('GET', 'website', { auth: tok('SF', ['staff']) });
  check('ordinary staff → 403', r.code === 403 && r.calls.get.length === 0);
  r = await call('POST', 'website-apply', { auth: tok('TE', ['technician']), body: { all: true } });
  check('workshop / technician never (G17) → 403, nothing sent', r.code === 403 && r.calls.apply.length === 0);
  r = await call('POST', 'website-apply', { auth: tok('SF', ['staff']), idHeader: 'GS', body: { all: true } });
  check('a claimed GS header without the GS login → 403', r.code === 403 && r.calls.apply.length === 0);
  r = await call('GET', 'website', { auth: tok('GS', ['superadmin']) });
  check('superadmin (GS) may open the dialog', r.code === 200 && r.calls.get.length === 1 && r.calls.get[0].id === 30);
  r = await call('POST', 'website-apply', { auth: tok('GM', ['staff']), body: { item_ids: [2, '5'] } });
  check('GM (marketing lead) may send ticked items', r.code === 200 && JSON.stringify(r.calls.apply[0].o.itemIds) === '[2,5]' && r.calls.apply[0].o.all === false && r.calls.apply[0].o.actorId === 'GM');
  r = await call('POST', 'website-apply', { auth: tok('GS', ['superadmin']), body: { all: true } });
  check('superadmin sends all remaining, as the signed login', r.code === 200 && r.calls.apply[0].o.all === true && r.calls.apply[0].o.actorId === 'GS');
  r = await call('POST', 'website-apply', { auth: tok('GS', ['superadmin']), body: {} });
  check('nothing chosen → 400', r.code === 400 && r.calls.apply.length === 0);
}
{
  // E-D7: Apply Stock and Inventory never touches the website.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../lib/handlers/collections.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf("query.resource === 'apply-inventory'"), src.indexOf("query.resource === 'reset-inventory-apply'"));
  check('Apply Stock and Inventory never touches the website (E-D7)', block.length > 100 && !/woo|website|outbox/i.test(block));
}

console.log('migration 0017 (Neon dev only, additive + reversible)');
{
  const { readFileSync } = await import('node:fs');
  const up = readFileSync(new URL('../db/migrations/0017_woo_outbox_collection.sql', import.meta.url), 'utf8');
  const down = readFileSync(new URL('../db/migrations/0017_woo_outbox_collection_down.sql', import.meta.url), 'utf8');
  check('adds collection_id idempotently', /ADD COLUMN IF NOT EXISTS collection_id INTEGER NULL/i.test(up));
  check('workorder_id becomes nullable', /ALTER COLUMN workorder_id DROP NOT NULL/i.test(up));
  check('a row belongs to a workorder or a collection', /CHECK \(workorder_id IS NOT NULL OR collection_id IS NOT NULL\)/i.test(up));
  check('index on collection_id', /CREATE INDEX IF NOT EXISTS idx_woo_stock_outbox_collection/i.test(up));
  check('down refuses while collection rows exist, then restores NOT NULL', /RAISE EXCEPTION/i.test(down) && /SET NOT NULL/i.test(down) && /DROP COLUMN IF EXISTS collection_id/i.test(down));
}

console.log(`\nwoo-collection smoke: ${passed} checks passed`);
