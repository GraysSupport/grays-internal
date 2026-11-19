// scripts/woo-restock-smoke.mjs — offline smoke for G25e1 (owner's back-in-stock rules,
// 19 Nov 2026): a cancelled workorder item adds its quantity back to the website — but only
// what the website actually lost — with the back-in-stock treatment, and a reopen takes it
// again exactly once. Plan: feature-plan-stock-sync-2026-11-06.md § G25e / G25e1 (E-D1–E-D4).
//
// Drives lib/wooRestock.js (queue, inside the workorder transaction), lib/wooStock.js (the
// after-commit sync) and lib/wooStockRetry.js against a small STATEFUL fake database and the
// typed WooCommerce mock. No network, no database.
//
//   node scripts/woo-restock-smoke.mjs

import {
  planWebsiteIncrease,
  buildWooUpdate,
  syncWorkorderWebsiteStock,
  queueWooStock,
} from '../lib/wooStock.js';
import { queueWebsiteAddBack, retakeWebsiteStock } from '../lib/wooRestock.js';
import { runWebsiteStockRetryJob, retryWorkorderWebsiteStock, reopenWebsiteStockRows, getWebsiteStockRows } from '../lib/wooStockRetry.js';
import { createMockWoo } from '../lib/woocommerce.mock.js';
import { createWooClient } from '../lib/woocommerce.js';

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const ON = { FEATURE_WOO_STOCK_SYNC: 'true', WOO_STOCK_SYNC_DRY_RUN: 'false' };
const DRY = { FEATURE_WOO_STOCK_SYNC: 'true' };
const now = new Date('2026-11-20T03:00:00Z');
const site = (stock, extra = {}) => ({ id: 101, sku: 'TEC-TR600', stock_quantity: stock, manage_stock: true, ...extra });

console.log('back-in-stock decision (pure)');
let p = planWebsiteIncrease({ qty: 1, sku: 'TEC-TR600', website: site(2, { sold: false }), env: ON });
check('stock left and not Sold → only the quantity goes up (2 → 3)', p.action === 'increase' && p.before === 2 && p.after === 3, JSON.stringify(p));
p = planWebsiteIncrease({ qty: 1, sku: 'TEC-TR600', website: site(0, { sold: true }), env: ON });
check('Sold and 0 → back on sale (0 → 1)', p.action === 'restock' && p.after === 1 && p.wasSold === true, JSON.stringify(p));
p = planWebsiteIncrease({ qty: 2, sku: 'TEC-TR600', website: site(0, { sold: false }), env: ON });
check('stock 0 without Sold also counts as sold out (default)', p.action === 'restock' && p.after === 2, JSON.stringify(p));
p = planWebsiteIncrease({ qty: 1, sku: 'TEC-TR600', website: site(-1, { sold: false }), env: ON });
check('negative website stock → treated as 0, then + qty', p.action === 'restock' && p.after === 1, JSON.stringify(p));
p = planWebsiteIncrease({ qty: 1, sku: 'TEC-TR600', website: site(3, { sold: true }), env: ON });
check('Sold ticked with stock showing → back-on-sale treatment too', p.action === 'restock' && p.after === 4, JSON.stringify(p));
p = planWebsiteIncrease({ qty: 1, sku: 'NOPE', website: null, env: ON });
check('SKU not on the website → needs a human', p.action === 'needs_human' && /not on the website/i.test(p.reason));
p = planWebsiteIncrease({ qty: 1, sku: 'TEC-TR600', website: site(null, { manage_stock: false }), env: ON });
check('website not tracking stock → needs a human', p.action === 'needs_human');
p = planWebsiteIncrease({ qty: 1, sku: 'MSK-FA3452', website: site(5), env: ON });
check('skip-list SKU → needs a human, never sent', p.action === 'needs_human' && /do-not-sync/i.test(p.reason));

console.log('back-in-stock payload');
let body = buildWooUpdate({ action: 'increase', after: 3 }, now);
check('increase only sets stock_quantity', JSON.stringify(body) === JSON.stringify({ stock_quantity: 3 }), JSON.stringify(body));
body = buildWooUpdate({ action: 'restock', after: 1 }, now);
const meta = Object.fromEntries((body.meta_data || []).map((m) => [m.key, m.value]));
check('restock sets the stock', body.stock_quantity === 1);
check('restock sets the publish date to NOW (GMT)', body.date_created_gmt === '2026-11-20T03:00:00', body.date_created_gmt);
check('restock unticks Sold and turns Add to Cart + Enquire back on', meta.sold === '0' && meta.add_to_cart_button === '1' && meta.enquire_button === '1', JSON.stringify(meta));
check('never touches price, title, description, images or backorders',
  ['regular_price', 'sale_price', 'price', 'name', 'description', 'short_description', 'images', 'backorders'].every((k) => !(k in body)));

console.log('website lookup reads the ACF Sold flag (meta_data)');
{
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    return { ok: true, json: async () => [{ id: 9, sku: 'A', stock_quantity: 0, manage_stock: true, status: 'publish', meta_data: [{ key: '_sold', value: 'field_x' }, { key: 'sold', value: '1' }] }] };
  };
  const c = createWooClient({ env: { WOO_BASE_URL: 'https://staging.example', WOO_CONSUMER_KEY: 'k', WOO_CONSUMER_SECRET: 's' }, fetch });
  const w = await c.findProductBySku('A');
  check('real client: sold = true when ACF sold is "1"', w.sold === true, JSON.stringify(w));
  const mock = createMockWoo([{ id: 1, sku: 'B', stock_quantity: 0, manage_stock: true, meta: { sold: '1' } }]);
  check('mock: sold read from meta', (await mock.findProductBySku('B')).sold === true);
}

// --- a stateful fake database ------------------------------------------------------------
function fakeDb({ hasKind = true, salesperson = 'JS', ecommerce = false, woStatus = 'Work Ordered', items = [] } = {}) {
  const st = { outbox: [], logs: [], syncLog: [], wo: { salesperson, ecommerce, status: woStatus }, items, nextId: 1 };
  const add = (r) => { const row = { id: st.nextId++, workorder_id: 7, kind: 'decrease', reverses_id: null, status: 'pending', attempts: 0, result: null, last_error: null, created_at: new Date(0), ...r }; st.outbox.push(row); return row; };
  const res = (rows) => ({ rows, rowCount: rows.length });
  const json = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
  const reversed = (id) => st.outbox.some((x) => x.reverses_id === id && x.status !== 'cancelled');
  const client = {
    st, add,
    async query(sql, params = []) {
      const t = String(sql).replace(/\s+/g, ' ').trim();
      if (/to_regclass\('public\.woo_stock_outbox'\)/i.test(t)) return res([{ t: 'woo_stock_outbox' }]);
      if (/attname = 'kind'/i.test(t)) return res([{ has: hasKind }]);
      if (/attname = 'claimed_at'/i.test(t)) return res([{ has: false }]);
      if (/^SELECT salesperson, status::text AS status FROM workorder/i.test(t)) return res([{ salesperson: st.wo.salesperson, status: st.wo.status }]);
      if (/^SELECT status::text AS status FROM workorder/i.test(t)) return res([{ status: st.wo.status }]);
      // --- G25e1 queue / retake
      if (/g25e:decrease-candidate/.test(t)) {
        const [wo, sku, qty] = params;
        const rows = st.outbox.filter((x) => x.workorder_id === wo && x.sku === sku && x.kind === 'decrease' && !reversed(x.id))
          .sort((a, b) => (a.status === 'cancelled') - (b.status === 'cancelled') || (Number(b.qty) === Number(qty)) - (Number(a.qty) === Number(qty)) || b.id - a.id);
        return res(rows.slice(0, 1).map((x) => ({ ...x })));
      }
      if (/g25e:increase-candidate/.test(t)) {
        const [wo, sku, qty] = params;
        const rows = st.outbox.filter((x) => x.workorder_id === wo && x.sku === sku && x.kind === 'increase' && x.status !== 'cancelled' && !reversed(x.id))
          .sort((a, b) => (Number(b.qty) === Number(qty)) - (Number(a.qty) === Number(qty)) || b.id - a.id);
        return res(rows.slice(0, 1).map((x) => ({ ...x })));
      }
      if (/g25e:close-row/.test(t)) {
        const r = st.outbox.find((x) => x.id === params[0] && ['pending', 'failed', ...(/needs_human/.test(t) ? ['needs_human'] : [])].includes(x.status));
        if (!r) return res([]);
        r.status = 'cancelled'; r.last_error = params[1];
        return { rows: [], rowCount: 1 };
      }
      if (/g25e:insert/.test(t)) {
        const [wo, sku, qty, kind, reverses, status, result, err] = params;
        add({ workorder_id: wo, sku, qty, kind, reverses_id: reverses, status, result: json(result), last_error: err });
        return { rows: [], rowCount: 1 };
      }
      if (/g25e:any-row/.test(t)) return res(st.outbox.filter((x) => x.workorder_id === params[0] && x.sku === params[1] && (!/kind = 'decrease'/.test(t) || x.kind === 'decrease')).slice(0, 1).map((x) => ({ id: x.id })));
      if (/g25e:legacy-sale/.test(t)) return res(st.outbox.filter((x) => x.workorder_id === params[0] && x.sku === params[1]).sort((a, b) => b.id - a.id).slice(0, 1).map((x) => ({ ...x })));
      if (/g25e:open-adds/.test(t)) {
        const n = st.outbox.filter((x) => x.workorder_id === params[0] && x.kind === 'increase'
          && (['pending', 'failed'].includes(x.status) || (x.status === 'needs_human' && json(x.result)?.action === 'needs_human'))).length;
        return res([{ n }]);
      }
      if (/g25e:reopen-sale/.test(t)) {
        const r = st.outbox.filter((x) => x.workorder_id === params[0] && x.sku === params[1] && x.kind === 'decrease' && x.status === 'cancelled').sort((a, b) => b.id - a.id)[0];
        if (!r) return res([]);
        r.status = 'pending'; r.last_error = null;
        return res([{ id: r.id }]);
      }
      if (/^INSERT INTO woo_stock_outbox \(workorder_id, sku, qty\) VALUES/i.test(t)) { add({ workorder_id: params[0], sku: params[1], qty: params[2] }); return { rows: [], rowCount: 1 }; }
      if (/g25e:untick/.test(t)) { st.wo.ecommerce = false; return { rows: [], rowCount: 1 }; }
      if (/^UPDATE woo_stock_outbox SET status = 'pending', last_error = NULL WHERE workorder_id = \$1 AND status = 'cancelled'/i.test(t)) {
        const hit = st.outbox.filter((x) => x.workorder_id === params[0] && x.status === 'cancelled' && (!/kind = 'decrease'/.test(t) || x.kind === 'decrease'));
        for (const x of hit) { x.status = 'pending'; x.last_error = null; }
        return { rows: [], rowCount: hit.length };
      }
      // --- the sync (lib/wooStock.js)
      if (!/COUNT\(/.test(t) && /^SELECT .* FROM woo_stock_outbox (o )?WHERE workorder_id = \$1 AND status IN \('pending', 'failed'\)/i.test(t)) {
        const rows = st.outbox.filter((x) => x.workorder_id === params[0] && ['pending', 'failed'].includes(x.status))
          .map((x) => ({ ...x, ...(/reverses_status/.test(t) ? { reverses_status: st.outbox.find((y) => y.id === x.reverses_id)?.status ?? null } : {}) }));
        return res(rows);
      }
      if (/^SELECT 1 FROM workorder_items WHERE workorder_id = \$1 AND product_id = \$2/i.test(t)) {
        const live = st.items.filter((i) => i.product_id === params[1] && i.status !== 'Canceled');
        return res(live.length ? [{ x: 1 }] : []);
      }
      if (/^UPDATE woo_stock_outbox SET status = 'sending'/i.test(t)) {
        const r = st.outbox.find((x) => x.id === params[0] && ['pending', 'failed'].includes(x.status));
        if (!r) return res([]);
        r.status = 'sending';
        return res([{ id: r.id }]);
      }
      if (/^UPDATE woo_stock_outbox SET status = \$2::text/i.test(t)) {
        const r = st.outbox.find((x) => x.id === params[0]);
        r.status = params[1]; r.result = json(params[2]); r.last_error = params[3]; r.attempts += 1;
        return { rows: [], rowCount: 1 };
      }
      if (/^UPDATE woo_stock_outbox SET status = 'needs_human', result = \$2::jsonb, last_error = \$3 WHERE id = \$1/i.test(t)) {
        const r = st.outbox.find((x) => x.id === params[0] && ['pending', 'failed'].includes(x.status));
        if (!r) return res([]);
        r.status = 'needs_human'; r.result = json(params[1]); r.last_error = params[2];
        return { rows: [], rowCount: 1 };
      }
      if (/^SELECT status, result FROM woo_stock_outbox WHERE workorder_id/i.test(t)) {
        const rows = st.outbox.filter((x) => x.workorder_id === params[0] && x.status !== 'cancelled');
        return res(rows);
      }
      if (/^UPDATE workorder SET ecommerce = TRUE/i.test(t)) { st.wo.ecommerce = true; return { rows: [], rowCount: 1 }; }
      if (/^INSERT INTO workorder_logs/i.test(t)) { st.logs.push(params[3]); return { rows: [], rowCount: 1 }; }
      if (/^INSERT INTO integration_sync_log/i.test(t)) { st.syncLog.push(params); return { rows: [], rowCount: 1 }; }
      // --- the daily job / retry (lib/wooStockRetry.js)
      if (/g25e:close-cancelled-wo/.test(t)) {
        const hit = st.wo.status === 'Cancelled' ? st.outbox.filter((x) => ['pending', 'failed'].includes(x.status) && x.kind === 'decrease') : [];
        for (const x of hit) { x.status = 'cancelled'; x.last_error = params[0]; }
        return res(hit.map((x) => ({ id: x.id, workorder_id: x.workorder_id, sku: x.sku })));
      }
      if (/g25e:due/.test(t)) {
        const open = st.outbox.filter((x) => ['pending', 'failed'].includes(x.status) && (st.wo.status !== 'Cancelled' || x.kind === 'increase'));
        return res(open.length ? [{ workorder_id: 7 }] : []);
      }
      if (/^SELECT COUNT\(\*\)::int AS n FROM woo_stock_outbox WHERE workorder_id = \$1 AND status IN \('pending', 'failed'\)/i.test(t)) {
        const n = st.outbox.filter((x) => x.workorder_id === params[0] && ['pending', 'failed'].includes(x.status) && (!/kind = 'increase'/.test(t) || x.kind === 'increase')).length;
        return res([{ n }]);
      }
      if (/^SELECT workorder_id, id, sku, qty, status/i.test(t)) return res(st.outbox.map((x) => ({ ...x })));
      return { rows: [], rowCount: 0 };
    },
  };
  return client;
}
const product = (stock, sold = false, sku = 'TEC-TR600', id = 101) => ({ id, sku, stock_quantity: stock, manage_stock: true, meta: { sold: sold ? '1' : '0', add_to_cart_button: sold ? '0' : '1', enquire_button: sold ? '0' : '1' } });
const cancelItem = (db, extra = {}) => queueWebsiteAddBack(db, { workorderId: 7, items: [{ product_id: 'TEC-TR600', quantity: 1, is_custom: false }], salesperson: db.st.wo.salesperson, ecommerce: db.st.wo.ecommerce, ...extra }, { env: ON });
const incs = (db) => db.st.outbox.filter((x) => x.kind === 'increase');

console.log('E-D1 — only give back what the website actually lost');
{
  const db = fakeDb();
  db.add({ sku: 'TEC-TR600', qty: 1, status: 'sent', result: { action: 'decrease', before: 3, after: 2 } });
  const n = await cancelItem(db);
  check('decrease sent → one add-back queued, linked to that decrease', n === 1 && incs(db).length === 1 && incs(db)[0].reverses_id === 1 && incs(db)[0].status === 'pending', JSON.stringify(db.st.outbox));
}
{
  const db = fakeDb();
  db.add({ sku: 'TEC-TR600', qty: 1, status: 'pending' });
  const n = await cancelItem(db);
  check('decrease still pending → nothing to add back, the decrease is closed off', n === 0 && incs(db).length === 0 && db.st.outbox[0].status === 'cancelled');
}
{
  const db = fakeDb();
  db.add({ sku: 'TEC-TR600', qty: 1, status: 'failed', last_error: 'Website timed out' });
  await cancelItem(db);
  check('decrease failed → nothing to add back, closed off', incs(db).length === 0 && db.st.outbox[0].status === 'cancelled');
}
{
  const db = fakeDb();
  db.add({ sku: 'TEC-TR600', qty: 1, status: 'needs_human', result: null, last_error: "The website didn't confirm" });
  const n = await cancelItem(db);
  check('decrease uncertain (needs a human) → GS flagged, never automatic', n === 0 && incs(db).length === 1 && incs(db)[0].status === 'needs_human' && JSON.stringify(incs(db)[0].result).includes('manual'));
  check('…and the add-back is in the workorder log', db.st.logs.some((l) => /by hand/i.test(l)), JSON.stringify(db.st.logs));
}
{
  const db = fakeDb({ ecommerce: true });
  db.add({ sku: 'TEC-TR600', qty: 1, status: 'needs_human', result: { action: 'needs_human' }, last_error: 'SKU not on the website' });
  await cancelItem(db);
  check('decrease lookup refused (nothing sent) → sale closed off, GS flagged in case they did it by hand (review #3)', incs(db).length === 1 && incs(db)[0].status === 'needs_human' && db.st.outbox[0].status === 'cancelled');
}
{
  const db = fakeDb({ ecommerce: true });
  db.add({ sku: 'TEC-TR600', qty: 1, status: 'sent', result: { action: 'soldout', before: 1, after: 0, check: true } });
  await cancelItem(db);
  check('decrease that needed a check (website showed less than sold) → GS flagged', incs(db).length === 1 && incs(db)[0].status === 'needs_human');
  check('a flagged add-back unticks the E-Commerce flag so GS sees it', db.st.wo.ecommerce === false);
}

console.log('E-D1b — no website record (workorder from before G25 went live)');
{
  const db = fakeDb({ ecommerce: true });
  const n = await cancelItem(db);
  check('E-Commerce ticked (GS reduced it by hand) → add back', n === 1 && incs(db).length === 1 && incs(db)[0].reverses_id == null && incs(db)[0].status === 'pending');
}
{
  const db = fakeDb({ ecommerce: false });
  const n = await cancelItem(db);
  check('E-Commerce not ticked → GS flagged "update the website by hand"', n === 0 && incs(db)[0]?.status === 'needs_human' && /by hand/i.test(incs(db)[0].last_error));
}

console.log('E-D2 — website orders (salesperson WB) are never pushed back');
{
  const db = fakeDb({ salesperson: 'WB', ecommerce: true });
  db.add({ sku: 'TEC-TR600', qty: 1, status: 'sent', result: { action: 'none', before: 3, after: 3 } });
  const n = await cancelItem(db);
  check('WB → nothing queued', n === 0 && incs(db).length === 0);
  check('…log says cancel/refund it in WooCommerce', db.st.logs.some((l) => /WooCommerce/.test(l) && /refund/i.test(l)), JSON.stringify(db.st.logs));
}
{
  const db = fakeDb({ salesperson: 'JS', ecommerce: true });
  db.add({ sku: 'TEC-TR600', qty: 1, status: 'sent', result: { action: 'soldout_only', before: 0, after: 0 } });
  const n = await cancelItem(db);
  check('decrease recorded as a website sale (soldout_only) → not pushed either', n === 0 && incs(db).length === 0);
}

console.log('custom items, switches, before migration 0016');
{
  const db = fakeDb({ ecommerce: true });
  const n = await queueWebsiteAddBack(db, { workorderId: 7, items: [{ product_id: 'CUSTOM', quantity: 1, is_custom: true }], salesperson: 'JS', ecommerce: true }, { env: ON });
  check('custom items never count', n === 0 && db.st.outbox.length === 0);
  const off = fakeDb({ ecommerce: true });
  const n2 = await queueWebsiteAddBack(off, { workorderId: 7, items: [{ product_id: 'TEC-TR600', quantity: 1 }], salesperson: 'JS', ecommerce: true }, { env: {} });
  check('feature OFF → nothing written, nothing logged', n2 === 0 && off.st.outbox.length === 0 && off.st.logs.length === 0);
  const pre = fakeDb({ hasKind: false, ecommerce: true });
  pre.add({ sku: 'TEC-TR600', qty: 1, status: 'sent', result: { action: 'decrease', before: 3, after: 2 } });
  const n3 = await cancelItem(pre);
  check('migration 0016 not applied → no add-back, GS flagged in the log', n3 === 0 && pre.st.outbox.length === 1 && pre.st.logs.some((l) => /0016/.test(l) && /by hand/i.test(l)), JSON.stringify(pre.st.logs));
}
{
  const db = fakeDb({ ecommerce: true });
  db.add({ sku: 'TEC-TR600', qty: 1, status: 'sent', result: { action: 'decrease', before: 4, after: 3 } });
  db.add({ sku: 'TEC-TR600', qty: 1, status: 'sent', result: { action: 'decrease', before: 3, after: 2 } });
  await queueWebsiteAddBack(db, { workorderId: 7, items: [{ product_id: 'TEC-TR600', quantity: 1 }, { product_id: 'TEC-TR600', quantity: 1 }], salesperson: 'JS', ecommerce: true }, { env: ON });
  const rev = incs(db).map((x) => x.reverses_id).sort();
  check('two items of the same SKU → each add-back reverses its own decrease', rev.length === 2 && rev[0] === 1 && rev[1] === 2, JSON.stringify(rev));
  const n = await cancelItem(db);
  check('…and nothing is given back a third time (every sale already reversed)', n === 0 && incs(db).length === 2, JSON.stringify(incs(db)));
}

console.log('after-commit sync of an add-back (mock WooCommerce)');
{
  // Whole workorder cancelled; the website shows the product sold out.
  const db = fakeDb({ woStatus: 'Cancelled', items: [{ product_id: 'TEC-TR600', status: 'Canceled' }] });
  db.add({ sku: 'TEC-TR600', qty: 1, status: 'sent', result: { action: 'soldout', before: 1, after: 0 } });
  await cancelItem(db);
  const woo = createMockWoo([{ ...product(0, true), price: '1795', name: 'Treadmill' }]);
  const s = await syncWorkorderWebsiteStock(db, 7, { woo, env: ON, now });
  const w = woo.products.get(101);
  check('cancelled workorder: the add-back is still sent', s.sent === 1 && incs(db)[0].status === 'sent', JSON.stringify(s));
  check('sold-out product back on sale: stock 0 → 1', w.stock_quantity === 1);
  check('Sold unticked, Add to Cart + Enquire on', w.meta.sold === '0' && w.meta.add_to_cart_button === '1' && w.meta.enquire_button === '1', JSON.stringify(w.meta));
  check('publish date = now', w.date_created_gmt === '2026-11-20T03:00:00');
  check('price and title untouched', w.price === '1795' && w.name === 'Treadmill');
  check('workorder log: "back on sale (was Sold)"', db.st.logs.some((l) => /added back/i.test(l) && /back on sale/i.test(l) && /was Sold/i.test(l)), JSON.stringify(db.st.logs));
  check('outbox result records the change', incs(db)[0].result.action === 'restock' && incs(db)[0].result.before === 0 && incs(db)[0].result.after === 1);
  check('a cancelled workorder never gets the E-Commerce flag ticked', s.ticked === false);
}
{
  const db = fakeDb({ items: [{ product_id: 'TEC-TR600', status: 'Canceled' }, { product_id: 'OTHER-1', status: 'Completed' }] });
  db.add({ sku: 'TEC-TR600', qty: 1, status: 'sent', result: { action: 'decrease', before: 3, after: 2 } });
  await cancelItem(db);
  const woo = createMockWoo([product(2, false)]);
  await syncWorkorderWebsiteStock(db, 7, { woo, env: ON, now });
  const w = woo.products.get(101);
  check('item cancelled on a live workorder: stock 2 → 3 only', w.stock_quantity === 3 && w.date_created_gmt === undefined && w.meta.sold === '0');
  check('log: "Added back … 2 → 3"', db.st.logs.some((l) => /added back/i.test(l) && /2 → 3/.test(l)), JSON.stringify(db.st.logs));
  check('the live-item check never closes an add-back (the item is cancelled on purpose)', incs(db)[0].status === 'sent');
}
{
  const db = fakeDb({ woStatus: 'Cancelled' });
  db.add({ sku: 'TEC-TR600', qty: 1, status: 'dry_run', result: { action: 'decrease', before: 3, after: 2 } });
  await cancelItem(db);
  const woo = createMockWoo([product(2, false)]);
  await syncWorkorderWebsiteStock(db, 7, { woo, env: ON, now });
  check('decrease was a dry run → the add-back is a dry run too, even when live', woo.writes === 0 && incs(db)[0].status === 'dry_run');
  check('…log says "would add 1 back"', db.st.logs.some((l) => /would add 1 back/i.test(l)), JSON.stringify(db.st.logs));
}
{
  const db = fakeDb({ woStatus: 'Cancelled' });
  db.add({ sku: 'TEC-TR600', qty: 1, status: 'sent', result: { action: 'decrease', before: 3, after: 2 } });
  await cancelItem(db);
  const woo = createMockWoo([product(2, false)]);
  await syncWorkorderWebsiteStock(db, 7, { woo, env: DRY, now });
  check('dry-run switch on → logs "would add", writes nothing', woo.writes === 0 && incs(db)[0].status === 'dry_run' && db.st.logs.some((l) => /would add 1 back/i.test(l)));
}
{
  const db = fakeDb({ woStatus: 'Cancelled' });
  db.add({ sku: 'TEC-TR600', qty: 1, status: 'sent', result: { action: 'decrease', before: 3, after: 2 } });
  await cancelItem(db);
  await syncWorkorderWebsiteStock(db, 7, { woo: createMockWoo([]), env: ON, now });
  check('SKU gone from the website → add-back needs a human', incs(db)[0].status === 'needs_human' && /not on the website/i.test(incs(db)[0].last_error));
}
{
  const db = fakeDb({ woStatus: 'Cancelled' });
  db.add({ sku: 'TEC-TR600', qty: 1, status: 'sent', result: { action: 'decrease', before: 3, after: 2 } });
  await cancelItem(db);
  await syncWorkorderWebsiteStock(db, 7, { woo: createMockWoo([product(2)], { failLookups: true }), env: ON, now });
  check('website down before any change → add-back failed (safe to retry)', incs(db)[0].status === 'failed');
}

console.log('E-D4 — reopen after an add-back takes the stock again exactly once');
{
  const db = fakeDb({ items: [{ product_id: 'TEC-TR600', status: 'In Workshop' }] });
  const woo = createMockWoo([product(3, false)]);
  // 1. sale → 3 → 2
  await queueWooStock(db, { workorderId: 7, items: [{ product_id: 'TEC-TR600', quantity: 1 }] }, { env: ON });
  db.st.outbox.forEach((x) => { x.kind = x.kind || 'decrease'; });
  await syncWorkorderWebsiteStock(db, 7, { woo, env: ON, now });
  check('sale: website 3 → 2', woo.products.get(101).stock_quantity === 2, JSON.stringify(db.st.outbox));
  // 2. cancel → 2 → 3
  db.st.wo.status = 'Cancelled'; db.st.items[0].status = 'Canceled';
  await cancelItem(db);
  await syncWorkorderWebsiteStock(db, 7, { woo, env: ON, now });
  check('cancel: website 2 → 3', woo.products.get(101).stock_quantity === 3);
  // 3. reopen → 3 → 2
  db.st.wo.status = 'Work Ordered'; db.st.items[0].status = 'In Workshop';
  const r1 = await retakeWebsiteStock(db, { workorderId: 7, items: [{ product_id: 'TEC-TR600', quantity: 1 }] }, { env: ON });
  const r2 = await retakeWebsiteStock(db, { workorderId: 7, items: [{ product_id: 'TEC-TR600', quantity: 1 }] }, { env: ON });
  check('reopen queues exactly one decrease, linked to the add-back', r1 === 1 && r2 === 0 && db.st.outbox.filter((x) => x.kind === 'decrease').length === 2 && db.st.outbox.at(-1).reverses_id === incs(db)[0].id, JSON.stringify(db.st.outbox));
  await syncWorkorderWebsiteStock(db, 7, { woo, env: ON, now });
  await syncWorkorderWebsiteStock(db, 7, { woo, env: ON, now });
  check('reopen: website 3 → 2, once', woo.products.get(101).stock_quantity === 2);
  // 4. cancel again → 2 → 3 (reverses the NEW decrease)
  db.st.wo.status = 'Cancelled'; db.st.items[0].status = 'Canceled';
  await cancelItem(db);
  await syncWorkorderWebsiteStock(db, 7, { woo, env: ON, now });
  check('second cancel: website 2 → 3 again', woo.products.get(101).stock_quantity === 3);
  check('second add-back reverses the reopen decrease', incs(db).length === 2 && incs(db)[1].reverses_id === db.st.outbox.find((x) => x.kind === 'decrease' && x.reverses_id).id);
}
{
  const db = fakeDb({ woStatus: 'Cancelled' });
  db.add({ sku: 'TEC-TR600', qty: 1, status: 'sent', result: { action: 'decrease', before: 3, after: 2 } });
  await cancelItem(db); // add-back queued, NOT sent yet
  db.st.wo.status = 'Work Ordered';
  const n = await retakeWebsiteStock(db, { workorderId: 7, items: [{ product_id: 'TEC-TR600', quantity: 1 }] }, { env: ON });
  check('reopen before the add-back was sent → add-back closed, no new decrease (the sale stands)', n === 0 && incs(db)[0].status === 'cancelled' && db.st.outbox.filter((x) => x.kind === 'decrease').length === 1);
}
{
  const db = fakeDb({ woStatus: 'Cancelled' });
  db.add({ sku: 'TEC-TR600', qty: 1, status: 'pending' });
  await cancelItem(db); // closes the unsent decrease
  db.st.wo.status = 'Work Ordered';
  const n = await reopenWebsiteStockRows(db, 7, { env: ON });
  check('reopen of a workorder whose decrease never went out → that decrease is due again', n === 1 && db.st.outbox[0].status === 'pending');
  const n2 = await retakeWebsiteStock(db, { workorderId: 7, items: [{ product_id: 'TEC-TR600', quantity: 1 }] }, { env: ON });
  check('…and the retake adds no second decrease', n2 === 0 && db.st.outbox.length === 1);
}
{
  const db = fakeDb({ woStatus: 'Cancelled', ecommerce: true });
  db.add({ sku: 'TEC-TR600', qty: 1, status: 'sent', result: { action: 'decrease', before: 3, after: 2 } });
  await cancelItem(db);
  db.st.outbox.at(-1).status = 'cancelled'; // e.g. closed by hand
  db.add({ sku: 'TEC-TR600', qty: 1, kind: 'increase', status: 'pending' }); // stray, unrelated
  const n = await reopenWebsiteStockRows(db, 7, { env: ON });
  check('the reopen re-queue never revives a closed add-back', n === 0 && db.st.outbox[1].status === 'cancelled');
}

console.log('daily job + Retry button');
{
  const db = fakeDb({ woStatus: 'Cancelled' });
  db.add({ sku: 'TEC-TR600', qty: 1, status: 'sent', result: { action: 'decrease', before: 3, after: 2 } });
  await cancelItem(db);
  incs(db)[0].status = 'failed';
  const woo = createMockWoo([product(2)]);
  const s = await runWebsiteStockRetryJob(db, { env: ON, sync: (c, id, o) => syncWorkorderWebsiteStock(c, id, { woo, env: ON, now, ...o }) });
  check('daily job does NOT close an add-back on a cancelled workorder', incs(db)[0].status !== 'cancelled', JSON.stringify(incs(db)));
  check('daily job retries it → sent', s.sent === 1 && woo.products.get(101).stock_quantity === 3, JSON.stringify(s));
}
{
  const db = fakeDb({ woStatus: 'Cancelled' });
  db.add({ sku: 'TEC-TR600', qty: 1, status: 'sent', result: { action: 'decrease', before: 3, after: 2 } });
  await cancelItem(db);
  incs(db)[0].status = 'failed';
  const woo = createMockWoo([product(2)]);
  const r = await retryWorkorderWebsiteStock(db, 7, { env: ON, actorId: 'GS', sync: (c, id) => syncWorkorderWebsiteStock(c, id, { woo, env: ON, now }) });
  check('Retry button works on a cancelled workorder with an add-back to send', r.ok === true && woo.products.get(101).stock_quantity === 3, JSON.stringify(r));
  const db2 = fakeDb({ woStatus: 'Cancelled' });
  const r2 = await retryWorkorderWebsiteStock(db2, 7, { env: ON, actorId: 'GS' });
  check('…and still refuses a cancelled workorder with nothing to add back', r2.ok === false && r2.status === 409);
}
{
  const db = fakeDb();
  db.add({ sku: 'TEC-TR600', qty: 1, kind: 'increase', reverses_id: 1, status: 'sent', result: { action: 'increase', before: 2, after: 3 } });
  const m = await getWebsiteStockRows(db, [7]);
  const row = m.get(7)?.[0];
  check('workorder page rows carry kind + reverses_id', row?.kind === 'increase' && row?.reverses_id === 1, JSON.stringify(row));
}

console.log('code review fixes (20 Nov 2026)');
{
  // #1 — a dry-run sale's add-back stays a dry run even after its result was overwritten
  //      (gave up after N refusals → GS presses Retry after go-live).
  const db = fakeDb({ woStatus: 'Cancelled' });
  db.add({ sku: 'TEC-TR600', qty: 1, status: 'dry_run', result: { action: 'decrease', before: 3, after: 2 } });
  await cancelItem(db);
  const inc = incs(db)[0];
  inc.status = 'failed'; inc.result = { action: 'needs_human', gave_up: true }; // what the daily job writes
  const woo = createMockWoo([product(2)]);
  await syncWorkorderWebsiteStock(db, 7, { woo, env: ON, now });
  check('#1 dry-run sale → its add-back is never sent live, even after the result was overwritten', woo.writes === 0 && inc.status === 'dry_run', JSON.stringify(inc));
}
{
  // #2 — cancel → restore → cancel on a workorder with no sale row (pre-G25, E-Commerce ticked).
  const db = fakeDb({ ecommerce: true });
  await cancelItem(db);                       // add-back A queued (not sent: site down)
  await retakeWebsiteStock(db, { workorderId: 7, items: [{ product_id: 'TEC-TR600', quantity: 1 }] }, { env: ON }); // closes A
  const n = await cancelItem(db);             // cancelled again
  check('#2 cancel → restore → cancel (no sale row) still adds back', n === 1 && incs(db).filter((x) => x.status === 'pending').length === 1, JSON.stringify(db.st.outbox));
  const db2 = fakeDb({ ecommerce: false });
  await cancelItem(db2);                      // flag F
  await retakeWebsiteStock(db2, { workorderId: 7, items: [{ product_id: 'TEC-TR600', quantity: 1 }] }, { env: ON }); // closes F
  await cancelItem(db2);
  check('#2 …and still flags GS when E-Commerce is not ticked', incs(db2).filter((x) => x.status === 'needs_human').length === 1, JSON.stringify(db2.st.outbox));
}
{
  // #3 — a sale GS was told to do by hand (lookup refused / typo guard / gave up): flag the add-back too.
  const db = fakeDb({ ecommerce: true });
  db.add({ sku: 'TEC-TR600', qty: 1, status: 'needs_human', result: { action: 'needs_human' }, last_error: 'More than 10 products on one workorder — check by hand' });
  await cancelItem(db);
  check('#3 sale handed to GS → closed AND GS flagged "if you reduced it by hand, add it back"',
    db.st.outbox[0].status === 'cancelled' && incs(db)[0]?.status === 'needs_human' && /by hand/i.test(incs(db)[0].last_error), JSON.stringify(db.st.outbox));
}
{
  // #4 — before migration 0016, the hand instruction depends on what the sale row says.
  const pending = fakeDb({ hasKind: false, ecommerce: true });
  pending.add({ sku: 'TEC-TR600', qty: 1, status: 'pending' });
  await cancelItem(pending);
  check('#4 pre-0016, sale never sent → no "add it back by hand" instruction', !pending.st.logs.some((l) => /by hand/i.test(l)), JSON.stringify(pending.st.logs));
  const wb = fakeDb({ hasKind: false, salesperson: 'WB', ecommerce: true });
  wb.add({ sku: 'TEC-TR600', qty: 1, status: 'sent', result: { action: 'none', before: 3, after: 3 } });
  await cancelItem(wb);
  check('#4 pre-0016, website order → the WooCommerce cancel/refund message (E-D2)', wb.st.logs.some((l) => /refund/i.test(l)) && !wb.st.logs.some((l) => /0016/.test(l)), JSON.stringify(wb.st.logs));
  const sent = fakeDb({ hasKind: false, ecommerce: true });
  sent.add({ sku: 'TEC-TR600', qty: 1, status: 'sent', result: { action: 'decrease', before: 3, after: 2 } });
  await cancelItem(sent);
  check('#4 pre-0016, sale sent → "add it back by hand"', sent.st.logs.some((l) => /by hand/i.test(l)) && sent.st.outbox.length === 1);
}
{
  // minor — Retry on a cancelled workorder whose add-back hit the typo guard (needs_human, lookup-level).
  const db = fakeDb({ woStatus: 'Cancelled' });
  db.add({ sku: 'TEC-TR600', qty: 1, kind: 'increase', status: 'needs_human', result: { action: 'needs_human' }, last_error: 'More than 10 products' });
  const r = await retryWorkorderWebsiteStock(db, 7, { env: ON, actorId: 'GS', sync: async () => ({}) });
  check('Retry is allowed for a re-openable add-back on a cancelled workorder', r.ok === true, JSON.stringify(r));
}

console.log('migration 0016 (Neon dev only, additive + reversible)');
{
  const { readFileSync } = await import('node:fs');
  const up = readFileSync(new URL('../db/migrations/0016_woo_outbox_kind.sql', import.meta.url), 'utf8');
  const down = readFileSync(new URL('../db/migrations/0016_woo_outbox_kind_down.sql', import.meta.url), 'utf8');
  check('adds kind NOT NULL DEFAULT decrease, idempotently', /ADD COLUMN IF NOT EXISTS kind VARCHAR\(20\) NOT NULL DEFAULT 'decrease'/i.test(up));
  check('adds reverses_id, idempotently', /ADD COLUMN IF NOT EXISTS reverses_id INT(EGER)? NULL/i.test(up));
  check('kind limited to decrease | increase | create_draft', /CHECK \(kind IN \('decrease', 'increase', 'create_draft'\)\)/i.test(up));
  check('index for "already given back?" lookups', /CREATE INDEX IF NOT EXISTS idx_woo_stock_outbox_reverses/i.test(up));
  check('database guarantees a row is given back at most once (unique, ignoring closed rows)', /CREATE UNIQUE INDEX IF NOT EXISTS uq_woo_stock_outbox_reverses_once\s+ON woo_stock_outbox \(reverses_id\) WHERE reverses_id IS NOT NULL AND status <> 'cancelled'/i.test(up));
  check('down drops the unique index too', /DROP INDEX IF EXISTS uq_woo_stock_outbox_reverses_once/i.test(down));
  check('no destructive statements in up', !/\bDROP\b|\bDELETE\b|\bTRUNCATE\b/i.test(up.replace(/--.*$/gm, '')));
  check('down drops both columns (and the index)', /DROP COLUMN IF EXISTS kind/i.test(down) && /DROP COLUMN IF EXISTS reverses_id/i.test(down) && /DROP INDEX IF EXISTS idx_woo_stock_outbox_reverses/i.test(down));
}

console.log(`\nwoo-restock smoke: ${passed} checks passed`);
