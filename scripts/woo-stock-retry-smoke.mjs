// scripts/woo-stock-retry-smoke.mjs — offline smoke for G25 increment 2 (owner, 17 Nov 2026):
// the "Retry website update" button, the daily retry job, the cron gate, and the website
// status the workorder page / GS popup show. No network, no database.
//
//   node scripts/woo-stock-retry-smoke.mjs

import {
  RETRY_MAX_ATTEMPTS,
  getWebsiteStockRows,
  retryWorkorderWebsiteStock,
  runWebsiteStockRetryJob,
  handleWebsiteStockCron,
} from '../lib/wooStockRetry.js';
import { queueWooStock, syncWorkorderWebsiteStock } from '../lib/wooStock.js';
import { createMockWoo } from '../lib/woocommerce.mock.js';

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const ON = { FEATURE_WOO_STOCK_SYNC: 'true', WOO_STOCK_SYNC_DRY_RUN: 'false' };
const now = new Date('2026-11-18T03:00:00Z');
const minsAgo = (m) => new Date(Date.now() - m * 60000);

// --- fake pg client: in-memory outbox + workorders --------------------------------------
function fakeDb({ workorders = {} } = {}) {
  const outbox = [];
  const logs = [];
  const wos = new Map(Object.entries(workorders).map(([k, v]) => [Number(k), { status: 'Work Ordered', salesperson: 'JS', ecommerce: false, ...v }]));
  let nextId = 1;
  const wo = (id) => wos.get(Number(id)) || { status: 'Work Ordered', salesperson: 'JS', ecommerce: false };
  const add = (r) => { const row = { id: nextId++, status: 'pending', attempts: 0, result: null, last_error: null, created_at: minsAgo(60 * 24), sent_at: null, ...r }; outbox.push(row); return row; };
  const client = {
    outbox, logs, wos, add, deleted: new Set(), removed: new Set(), claimSql: [], hasClaimedAt: false,
    async query(sql, params = []) {
      const t = String(sql).replace(/\s+/g, ' ').trim();
      if (/to_regclass\('public\.woo_stock_outbox'\)/i.test(t)) return { rows: [{ t: client.noTable ? null : 'woo_stock_outbox' }], rowCount: 1 };
      if (/^INSERT INTO woo_stock_outbox/i.test(t)) { add({ workorder_id: params[0], sku: params[1], qty: params[2], created_at: new Date() }); return { rows: [], rowCount: 1 }; }
      if (/^SELECT salesperson, status::text AS status FROM workorder WHERE workorder_id = \$1/i.test(t)) {
        if (client.deleted.has(Number(params[0]))) return { rows: [], rowCount: 0 };
        return { rows: [{ salesperson: wo(params[0]).salesperson, status: wo(params[0]).status }], rowCount: 1 };
      }
      if (/^SELECT 1 FROM workorder_items WHERE workorder_id = \$1 AND product_id = \$2 AND status <> 'Canceled'/i.test(t)) {
        return client.removed.has(`${Number(params[0])}:${params[1]}`) ? { rows: [], rowCount: 0 } : { rows: [{ x: 1 }], rowCount: 1 };
      }
      if (/^UPDATE woo_stock_outbox SET status = 'cancelled', last_error = \$2 WHERE id = \$1 AND status IN \('pending', 'failed'\)/i.test(t)) {
        const r = outbox.find((x) => x.id === params[0] && ['pending', 'failed'].includes(x.status));
        if (!r) return { rows: [], rowCount: 0 };
        r.status = 'cancelled'; r.last_error = params[1];
        return { rows: [], rowCount: 1 };
      }
      if (/^UPDATE woo_stock_outbox SET status = 'needs_human', result = \$2::jsonb, last_error = \$3 WHERE id = \$1 AND status IN \('pending', 'failed'\)/i.test(t)) {
        const r = outbox.find((x) => x.id === params[0] && ['pending', 'failed'].includes(x.status));
        if (!r) return { rows: [], rowCount: 0 };
        r.status = 'needs_human'; r.result = JSON.parse(params[1]); r.last_error = params[2];
        return { rows: [], rowCount: 1 };
      }
      if (/^UPDATE woo_stock_outbox SET status = 'pending', last_error = NULL WHERE workorder_id = \$1 AND status = 'cancelled'/i.test(t)) {
        const rows = outbox.filter((r) => r.workorder_id === Number(params[0]) && r.status === 'cancelled');
        rows.forEach((r) => { r.status = 'pending'; r.last_error = null; });
        return { rows: [], rowCount: rows.length };
      }
      if (/^UPDATE woo_stock_outbox o SET status = 'cancelled', last_error = \$1 WHERE o\.status IN \('pending', 'failed'\) AND o.workorder_id IS NOT NULL AND NOT EXISTS \(SELECT 1 FROM workorder w WHERE w\.workorder_id = o\.workorder_id\)/i.test(t)) {
        const rows = outbox.filter((r) => client.deleted.has(r.workorder_id) && ['pending', 'failed'].includes(r.status));
        rows.forEach((r) => { r.status = 'cancelled'; r.last_error = params[0]; });
        return { rows: rows.map((r) => ({ id: r.id, workorder_id: r.workorder_id, sku: r.sku })), rowCount: rows.length };
      }
      if (/^SELECT status::text AS status FROM workorder WHERE workorder_id = \$1/i.test(t)) {
        return wos.has(Number(params[0])) || !client.missingWo ? { rows: [{ status: wo(params[0]).status }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      // sync: open rows of one workorder
      if (/^SELECT id, sku, qty, attempts FROM woo_stock_outbox WHERE workorder_id = \$1 AND status IN/i.test(t)) {
        const rows = outbox.filter((r) => r.workorder_id === Number(params[0]) && ['pending', 'failed'].includes(r.status));
        return { rows, rowCount: rows.length };
      }
      // G25d: is migration 0015 (claimed_at) applied?
      // Resolved like the statements themselves (search_path), not via current_schema().
      if (/pg_attribute/i.test(t) && /to_regclass\('woo_stock_outbox'\)/i.test(t) && /attname = 'claimed_at'/i.test(t)) {
        client.columnChecks = (client.columnChecks || 0) + 1;
        if (client.columnCheckFails) throw new Error('column check blip');
        return { rows: [{ has: Boolean(client.hasClaimedAt) }], rowCount: 1 };
      }
      if (/^UPDATE woo_stock_outbox SET status = 'sending'/i.test(t)) {
        client.claimSql.push(t);
        if (/claimed_at/i.test(t) && !client.hasClaimedAt) throw Object.assign(new Error('column "claimed_at" does not exist'), { code: '42703' });
        const r = outbox.find((x) => x.id === params[0] && ['pending', 'failed'].includes(x.status));
        if (!r) return { rows: [], rowCount: 0 };
        r.status = 'sending';
        if (/claimed_at = NOW\(\)/i.test(t)) r.claimed_at = new Date();
        return { rows: [{ id: r.id }], rowCount: 1 };
      }
      // retry: reopen rows where nothing was sent (a lookup said "needs a human")
      if (/^UPDATE woo_stock_outbox SET status = 'failed' WHERE workorder_id = \$1 AND status = 'needs_human' AND result->>'action' = 'needs_human'/i.test(t)) {
        const rows = outbox.filter((r) => r.workorder_id === Number(params[0]) && r.status === 'needs_human' && r.result && r.result.action === 'needs_human');
        rows.forEach((r) => { r.status = 'failed'; });
        return { rows: rows.map((r) => ({ id: r.id, sku: r.sku })), rowCount: rows.length };
      }
      if (/^SELECT COUNT\(\*\)::int AS n FROM woo_stock_outbox WHERE workorder_id = \$1 AND status IN \('pending', 'failed'\)/i.test(t)) {
        return { rows: [{ n: outbox.filter((r) => r.workorder_id === Number(params[0]) && ['pending', 'failed'].includes(r.status)).length }], rowCount: 1 };
      }
      // job: stuck 'sending' — G25d form (claimed_at, falling back to created_at for old rows)
      if (/^UPDATE woo_stock_outbox SET status = 'needs_human', result = NULL, last_error = \$1 WHERE status = 'sending' AND COALESCE\(claimed_at, created_at\) < NOW\(\) - make_interval\(mins => \$2\)/i.test(t)) {
        if (!client.hasClaimedAt) throw Object.assign(new Error('column "claimed_at" does not exist'), { code: '42703' });
        const rows = outbox.filter((r) => r.status === 'sending' && (r.claimed_at ?? r.created_at) < minsAgo(params[1]));
        rows.forEach((r) => { r.status = 'needs_human'; r.result = null; r.last_error = params[0]; });
        return { rows: rows.map((r) => ({ id: r.id, workorder_id: r.workorder_id, sku: r.sku })), rowCount: rows.length };
      }
      // job: stuck 'sending' (before migration 0015)
      if (/^UPDATE woo_stock_outbox SET status = 'needs_human', result = NULL, last_error = \$1 WHERE status = 'sending' AND created_at < NOW\(\) - make_interval\(mins => \$2\)/i.test(t)) {
        const rows = outbox.filter((r) => r.status === 'sending' && r.created_at < minsAgo(params[1]));
        rows.forEach((r) => { r.status = 'needs_human'; r.result = null; r.last_error = params[0]; });
        return { rows: rows.map((r) => ({ id: r.id, workorder_id: r.workorder_id, sku: r.sku })), rowCount: rows.length };
      }
      // job: cancelled workorders
      if (/^UPDATE woo_stock_outbox o SET status = 'cancelled', last_error = \$1 FROM workorder w WHERE w\.workorder_id = o\.workorder_id AND w\.status::text = \$2 AND o\.status IN \('pending', 'failed'\)/i.test(t)) {
        const rows = outbox.filter((r) => wo(r.workorder_id).status === params[1] && ['pending', 'failed'].includes(r.status));
        rows.forEach((r) => { r.status = 'cancelled'; r.last_error = params[0]; });
        return { rows: rows.map((r) => ({ id: r.id, workorder_id: r.workorder_id, sku: r.sku })), rowCount: rows.length };
      }
      // job: give up after N refusals
      if (/^UPDATE woo_stock_outbox SET status = 'needs_human', result = \$3::jsonb, last_error = CASE WHEN last_error LIKE 'Gave up after%' THEN last_error ELSE \$1 \|\| COALESCE\(last_error, ''\) END WHERE status = 'failed' AND attempts >= \$2/i.test(t)) {
        const rows = outbox.filter((r) => r.status === 'failed' && r.attempts >= params[1]);
        rows.forEach((r) => { r.status = 'needs_human'; r.result = JSON.parse(params[2]); r.last_error = /^Gave up after/.test(r.last_error || '') ? r.last_error : params[0] + (r.last_error || ''); });
        return { rows: rows.map((r) => ({ id: r.id, workorder_id: r.workorder_id, sku: r.sku })), rowCount: rows.length };
      }
      // job: workorders due a retry
      if (/^SELECT o\.workorder_id FROM woo_stock_outbox o JOIN workorder w ON w\.workorder_id = o\.workorder_id WHERE o\.status IN \('pending', 'failed'\) AND w\.status::text <> \$3 AND o\.created_at < NOW\(\) - make_interval\(mins => \$1\) GROUP BY o\.workorder_id ORDER BY MIN\(o\.id\) LIMIT \$2/i.test(t)) {
        const ids = [...new Set(outbox.filter((r) => !client.deleted.has(r.workorder_id) && wo(r.workorder_id).status !== params[2] && ['pending', 'failed'].includes(r.status) && r.created_at < minsAgo(params[0])).map((r) => r.workorder_id))].slice(0, params[1]);
        return { rows: ids.map((workorder_id) => ({ workorder_id })), rowCount: ids.length };
      }
      // status rows for the UI
      if (/^SELECT workorder_id, id, sku, qty, status, attempts, last_error, result, created_at, sent_at FROM woo_stock_outbox WHERE workorder_id = ANY\(\$1::int\[\]\) ORDER BY id/i.test(t)) {
        const ids = params[0].map(Number);
        const rows = outbox.filter((r) => ids.includes(r.workorder_id));
        return { rows, rowCount: rows.length };
      }
      if (/^UPDATE woo_stock_outbox SET/i.test(t)) {
        const r = outbox.find((x) => x.id === params[0]);
        r.status = params[1]; r.result = JSON.parse(params[2]); r.last_error = params[3]; r.attempts += 1;
        return { rows: [], rowCount: 1 };
      }
      if (/^SELECT status, result FROM woo_stock_outbox WHERE workorder_id = \$1 AND status <> 'cancelled'/i.test(t)) {
        const rows = outbox.filter((r) => r.workorder_id === Number(params[0]) && r.status !== 'cancelled');
        return { rows, rowCount: rows.length };
      }
      if (/^UPDATE workorder SET ecommerce = TRUE/i.test(t)) { wo(params[0]).ecommerce = true; if (!wos.has(Number(params[0]))) wos.set(Number(params[0]), wo(params[0])); wos.get(Number(params[0])).ecommerce = true; return { rows: [], rowCount: 1 }; }
      if (/^INSERT INTO workorder_logs/i.test(t)) { logs.push({ workorder_id: Number(params[0]), event_type: params[1], user_id: params[2], notes: params[3] }); return { rows: [], rowCount: 1 }; }
      if (/^INSERT INTO integration_sync_log/i.test(t)) return { rows: [], rowCount: 1 };
      throw new Error(`fake db: unexpected SQL: ${t.slice(0, 160)}`);
    },
    release() { client.released = true; },
  };
  return client;
}
const product = (stock = 6, extra = {}) => ({ id: 101, sku: 'TEC-TR600', stock_quantity: stock, manage_stock: true, ...extra });

console.log('status rows for the workorder page / GS popup');
{
  const db = fakeDb();
  db.add({ workorder_id: 7, sku: 'A', qty: 1, status: 'sent' });
  db.add({ workorder_id: 8, sku: 'B', qty: 1, status: 'failed' });
  db.add({ workorder_id: 9, sku: 'C', qty: 1 });
  const m = await getWebsiteStockRows(db, [7, 8]);
  check('rows grouped by workorder', m.get(7)?.length === 1 && m.get(8)?.[0].sku === 'B' && !m.has(9));
  check('a workorder with no rows is absent (not synced)', !m.has(11));
  db.noTable = true;
  check('before migration 0014 → empty, no error', (await getWebsiteStockRows(db, [7])).size === 0);
  check('no ids → empty', (await getWebsiteStockRows(fakeDb(), [])).size === 0);
}

console.log('Retry website update (button)');
{
  const db = fakeDb();
  const woo = createMockWoo([product(6)], { failLookups: true });
  await queueWooStock(db, { workorderId: 30, items: [{ product_id: 'TEC-TR600', quantity: 1 }] }, { env: ON });
  await syncWorkorderWebsiteStock(db, 30, { woo, env: ON, now });
  check('setup: website unreachable → failed', db.outbox[0].status === 'failed');
  const sync = (c, id) => syncWorkorderWebsiteStock(c, id, { woo: createMockWoo([product(6)]), env: ON, now });
  const r = await retryWorkorderWebsiteStock(db, 30, { env: ON, actorId: 'GS', sync });
  check('retry sends the failed row', r.ok && r.summary.sent === 1 && db.outbox[0].status === 'sent', JSON.stringify(r));
  check('retry ticks the E-Commerce flag when all done', db.wos.get(30)?.ecommerce === true);
  check('retry is logged with who asked', db.logs.some((l) => l.workorder_id === 30 && /Retry website update requested by GS/.test(l.notes)), JSON.stringify(db.logs));
}
{
  const db = fakeDb();
  await queueWooStock(db, { workorderId: 31, items: [{ product_id: 'NEW-SKU', quantity: 1 }] }, { env: ON });
  await syncWorkorderWebsiteStock(db, 31, { woo: createMockWoo([]), env: ON, now });
  check('setup: SKU not on website → needs a human', db.outbox[0].status === 'needs_human');
  const fixed = createMockWoo([{ id: 300, sku: 'NEW-SKU', stock_quantity: 2, manage_stock: true }]);
  const r = await retryWorkorderWebsiteStock(db, 31, { env: ON, actorId: 'GS', sync: (c, id) => syncWorkorderWebsiteStock(c, id, { woo: fixed, env: ON, now }) });
  check('after GS adds the SKU to the website, Retry sends it (nothing had been sent before)', r.ok && db.outbox[0].status === 'sent' && fixed.products.get(300).stock_quantity === 1, JSON.stringify(db.outbox[0]));
}
{
  const db = fakeDb();
  const woo = createMockWoo([product(6)], { failUpdates: true });
  await queueWooStock(db, { workorderId: 32, items: [{ product_id: 'TEC-TR600', quantity: 1 }] }, { env: ON });
  await syncWorkorderWebsiteStock(db, 32, { woo, env: ON, now });
  check('setup: timeout DURING the update → needs a human (maybe applied)', db.outbox[0].status === 'needs_human');
  const good = createMockWoo([product(6)]);
  const r = await retryWorkorderWebsiteStock(db, 32, { env: ON, actorId: 'GS', sync: (c, id) => syncWorkorderWebsiteStock(c, id, { woo: good, env: ON, now }) });
  check('Retry NEVER re-sends an update the website may already have applied', good.writes === 0 && db.outbox[0].status === 'needs_human' && r.nothingToRetry === true, JSON.stringify(r));
}
{
  const db = fakeDb();
  db.add({ workorder_id: 33, sku: 'A', qty: 1, status: 'dry_run', result: { action: 'decrease', before: 3, after: 2 } });
  let called = 0;
  const r = await retryWorkorderWebsiteStock(db, 33, { env: ON, actorId: 'GS', sync: async () => { called += 1; return {}; } });
  check('dry-run rows are never re-sent by Retry (GS did those by hand)', r.ok && r.nothingToRetry === true && called === 0 && db.outbox[0].status === 'dry_run');
}
{
  const db = fakeDb({ workorders: { 34: { status: 'Cancelled' } } });
  db.add({ workorder_id: 34, sku: 'A', qty: 1, status: 'failed' });
  let called = 0;
  const r = await retryWorkorderWebsiteStock(db, 34, { env: ON, actorId: 'GS', sync: async () => { called += 1; return {}; } });
  check('a cancelled workorder is refused (nothing to take off the website)', !r.ok && r.status === 409 && called === 0, JSON.stringify(r));
}
{
  const db = fakeDb();
  const r = await retryWorkorderWebsiteStock(db, 35, { env: {}, actorId: 'GS', sync: async () => ({}) });
  check('feature OFF → refused with a clear reason', !r.ok && r.status === 409 && /switched off/i.test(r.error));
  db.noTable = true;
  const r2 = await retryWorkorderWebsiteStock(db, 35, { env: ON, actorId: 'GS', sync: async () => ({}) });
  check('table missing → refused, no error', !r2.ok && r2.status === 409);
}
{
  const db = fakeDb();
  db.missingWo = true;
  const r = await retryWorkorderWebsiteStock(db, 999, { env: ON, actorId: 'GS', sync: async () => ({}) });
  check('unknown workorder → 404', !r.ok && r.status === 404);
}

console.log('daily retry job');
{
  const db = fakeDb();
  db.add({ workorder_id: 40, sku: 'TEC-TR600', qty: 1, status: 'failed', attempts: 1, last_error: 'Website not reachable' });
  db.add({ workorder_id: 41, sku: 'LFT-BN1', qty: 1, status: 'pending' });
  db.add({ workorder_id: 42, sku: 'X-NEW', qty: 1, status: 'pending', created_at: new Date() }); // just saved — leave it to the save
  const woo = createMockWoo([product(6), { id: 102, sku: 'LFT-BN1', stock_quantity: 3, manage_stock: true }]);
  const synced = [];
  const s = await runWebsiteStockRetryJob(db, { env: ON, sync: async (c, id, opts) => { synced.push(id); return syncWorkorderWebsiteStock(c, id, { woo, env: ON, now, budgetMs: opts?.budgetMs }); } });
  check('retries every workorder with failed / pending rows', synced.includes(40) && synced.includes(41), JSON.stringify(synced));
  check('leaves rows saved in the last few minutes to the save itself', !synced.includes(42));
  check('the retried rows are sent', db.outbox[0].status === 'sent' && db.outbox[1].status === 'sent');
  check('summary counts', s.workorders === 2 && s.sent === 2, JSON.stringify(s));
}
{
  const db = fakeDb();
  db.add({ workorder_id: 43, sku: 'A', qty: 1, status: 'failed', attempts: RETRY_MAX_ATTEMPTS, last_error: 'Website returned 400: bad' });
  const s = await runWebsiteStockRetryJob(db, { env: ON, sync: async () => ({}) });
  check(`gives up after ${RETRY_MAX_ATTEMPTS} refusals → needs a human`, db.outbox[0].status === 'needs_human' && /after 5 tries/i.test(db.outbox[0].last_error) && s.gaveUp === 1, JSON.stringify(db.outbox[0]));
  check('…with a log line GS can see', db.logs.some((l) => l.workorder_id === 43 && /NOT updated for A/.test(l.notes) && /update by hand/.test(l.notes)));
  check('…and the Retry button can still reopen it (nothing was ever applied)', db.outbox[0].result?.action === 'needs_human');
}
{
  const db = fakeDb();
  db.add({ workorder_id: 44, sku: 'A', qty: 1, status: 'sending', created_at: minsAgo(180) });
  db.add({ workorder_id: 44, sku: 'B', qty: 1, status: 'sending', created_at: new Date() });
  const s = await runWebsiteStockRetryJob(db, { env: ON, sync: async () => ({}) });
  check('a row stuck mid-send for over an hour → needs a human, never re-sent', db.outbox[0].status === 'needs_human' && db.outbox[0].result === null && s.stuck === 1);
  check('a row being sent right now is left alone', db.outbox[1].status === 'sending');
  check('stuck row is logged for GS to check', db.logs.some((l) => /check the stock by hand/.test(l.notes)));
}
{
  const db = fakeDb({ workorders: { 45: { status: 'Cancelled' } } });
  db.add({ workorder_id: 45, sku: 'A', qty: 1, status: 'failed', attempts: 1 });
  let called = 0;
  const s = await runWebsiteStockRetryJob(db, { env: ON, sync: async () => { called += 1; return {}; } });
  check('cancelled workorder → its unsent rows are closed, never sent', db.outbox[0].status === 'cancelled' && called === 0 && s.cancelled === 1);
}
{
  const db = fakeDb();
  db.add({ workorder_id: 46, sku: 'A', qty: 1, status: 'pending' });
  db.add({ workorder_id: 47, sku: 'B', qty: 1, status: 'pending' });
  const synced = [];
  const s = await runWebsiteStockRetryJob(db, { env: ON, budgetMs: 0, sync: async (c, id) => { synced.push(id); return {}; } });
  check('time budget used up → stops, the rest wait for tomorrow', synced.length === 0 && s.leftForTomorrow === true, JSON.stringify(s));
}
{
  const db = fakeDb();
  db.add({ workorder_id: 48, sku: 'A', qty: 1, status: 'pending' });
  let called = 0;
  const s = await runWebsiteStockRetryJob(db, { env: {}, sync: async () => { called += 1; return {}; } });
  check('feature OFF → the job does nothing', s.skipped === true && called === 0 && db.outbox[0].status === 'pending');
}
{
  const db = fakeDb();
  db.add({ workorder_id: 49, sku: 'A', qty: 1, status: 'pending' });
  db.add({ workorder_id: 50, sku: 'B', qty: 1, status: 'pending' });
  const synced = [];
  const s = await runWebsiteStockRetryJob(db, { env: ON, sync: async (c, id) => { synced.push(id); if (id === 49) throw new Error('boom'); return { sent: 1 }; } });
  check('one workorder blowing up does not stop the others', synced.includes(50) && s.errors === 1, JSON.stringify(s));
}

console.log('code-review fixes: removed items, deleted / reopened workorders, gave-up message, budget');
{
  const db = fakeDb();
  db.add({ workorder_id: 60, sku: 'TEC-TR600', qty: 1, status: 'failed', attempts: 1 });
  db.removed.add('60:TEC-TR600');
  const woo = createMockWoo([product(6)]);
  await runWebsiteStockRetryJob(db, { env: ON, sync: (c, id, o) => syncWorkorderWebsiteStock(c, id, { woo, env: ON, now, budgetMs: o?.budgetMs }) });
  check('item removed from the workorder → never sent, row closed', woo.writes === 0 && db.outbox[0].status === 'cancelled', JSON.stringify(db.outbox[0]));
  check('…and GS can see why', db.logs.some((l) => /item was removed/.test(l.notes)));
  check('…a workorder whose only row was removed is not auto-ticked', db.wos.get(60)?.ecommerce !== true);
}
{
  const db = fakeDb();
  db.add({ workorder_id: 61, sku: 'TEC-TR600', qty: 1, status: 'failed', attempts: 1 });
  db.deleted.add(61);
  const woo = createMockWoo([product(6)]);
  const s = await runWebsiteStockRetryJob(db, { env: ON, sync: (c, id, o) => syncWorkorderWebsiteStock(c, id, { woo, env: ON, now, budgetMs: o?.budgetMs }) });
  check('deleted workorder → its rows are closed, never sent', woo.writes === 0 && db.outbox[0].status === 'cancelled' && s.cancelled === 1, JSON.stringify(s));
  db.outbox[0].status = 'failed';
  const direct = await syncWorkorderWebsiteStock(db, 61, { woo, env: ON, now });
  check('a sync of a deleted workorder sends nothing', direct.skipped === true && woo.writes === 0);
}
{
  const db = fakeDb({ workorders: { 62: { status: 'Cancelled' } } });
  db.add({ workorder_id: 62, sku: 'TEC-TR600', qty: 1, status: 'pending' });
  const woo = createMockWoo([product(6)]);
  const s1 = await syncWorkorderWebsiteStock(db, 62, { woo, env: ON, now });
  check('a sync of a cancelled workorder sends nothing', s1.skipped === true && woo.writes === 0);
  await runWebsiteStockRetryJob(db, { env: ON, sync: async () => ({}) });
  check('setup: the daily job closed it', db.outbox[0].status === 'cancelled');
  const { reopenWebsiteStockRows } = await import('../lib/wooStockRetry.js');
  db.wos.get(62).status = 'Work Ordered';
  const n = await reopenWebsiteStockRows(db, 62, { env: ON });
  check('reopening the workorder puts its website update back in the queue', n === 1 && db.outbox[0].status === 'pending');
  await syncWorkorderWebsiteStock(db, 62, { woo, env: ON, now });
  check('…and it is sent', woo.writes === 1 && woo.products.get(101).stock_quantity === 5);
  check('reopen with the feature OFF does nothing', (await reopenWebsiteStockRows(fakeDb(), 62, { env: {} })) === 0);
}
{
  const db = fakeDb();
  db.add({ workorder_id: 63, sku: 'A', qty: 1, status: 'failed', attempts: RETRY_MAX_ATTEMPTS, last_error: 'Gave up after 5 tries: Website returned 400' });
  await runWebsiteStockRetryJob(db, { env: ON, sync: async () => ({}) });
  check('a re-opened row giving up again does not stack "Gave up after…"', (db.outbox[0].last_error.match(/Gave up/g) || []).length === 1, db.outbox[0].last_error);
}
{
  const db = fakeDb();
  db.add({ workorder_id: 64, sku: 'A', qty: 1, status: 'pending' });
  db.add({ workorder_id: 65, sku: 'B', qty: 1, status: 'pending' });
  const budgets = [];
  await runWebsiteStockRetryJob(db, { env: ON, budgetMs: 15000, sync: async (c, id, o) => { budgets.push(o.budgetMs); return {}; } });
  check('each workorder keeps ~11 s in reserve for a row already started', budgets.length === 2 && budgets.every((b) => b <= 4000), JSON.stringify(budgets));
  const none = [];
  const s = await runWebsiteStockRetryJob(db, { env: ON, budgetMs: 11500, sync: async (c, id, o) => { none.push(o.budgetMs); return {}; } });
  check('no new workorder starts without that reserve (never cut off mid-send)', none.length === 0 && s.leftForTomorrow === true);
}
{
  const db = fakeDb();
  const products = Array.from({ length: 11 }, (_, i) => ({ id: 200 + i, sku: `S-${i}`, stock_quantity: 5, manage_stock: true }));
  products.forEach((p) => db.add({ workorder_id: 66, sku: p.sku, qty: 1 }));
  db.outbox[0].status = 'sent';
  db.outbox[1].status = 'failed';
  // Another sync claims row 2 between this sync's SELECT and its guard.
  const orig = db.query.bind(db);
  db.query = async (sql, params) => {
    const r = await orig(sql, params);
    if (/^SELECT id, sku, qty, attempts FROM woo_stock_outbox/i.test(String(sql).replace(/\s+/g, ' ').trim())) db.outbox[1].status = 'sending';
    return r;
  };
  await syncWorkorderWebsiteStock(db, 66, { woo: createMockWoo(products), env: ON, now });
  check('the 10-product guard never overwrites a row another sync has claimed', db.outbox[1].status === 'sending' && db.outbox[0].status === 'sent');
}

console.log('cron endpoint gate');
{
  const res = () => { const r = { statusCode: null, payload: null }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (p) => { r.payload = p; return r; }; r.setHeader = () => {}; return r; };
  let ran = 0;
  const db = fakeDb();
  const deps = (env) => ({ env, getClient: async () => db, run: async () => { ran += 1; return { workorders: 0 }; } });
  let r = res();
  await handleWebsiteStockCron({ method: 'GET', headers: {} }, r, deps({ ...ON }));
  check('no CRON_SECRET configured → refused (fails closed)', r.statusCode === 503 && ran === 0, JSON.stringify(r));
  r = res();
  await handleWebsiteStockCron({ method: 'GET', headers: { authorization: 'Bearer wrong' } }, r, deps({ ...ON, CRON_SECRET: 's3cret-value' }));
  check('wrong secret → 401', r.statusCode === 401 && ran === 0);
  r = res();
  await handleWebsiteStockCron({ method: 'GET', headers: {} }, r, deps({ ...ON, CRON_SECRET: 's3cret-value' }));
  check('no Authorization header → 401', r.statusCode === 401 && ran === 0);
  r = res();
  await handleWebsiteStockCron({ method: 'POST', headers: { authorization: 'Bearer s3cret-value' } }, r, deps({ ...ON, CRON_SECRET: 's3cret-value' }));
  check('only GET (what Vercel Cron sends)', r.statusCode === 405 && ran === 0);
  r = res();
  await handleWebsiteStockCron({ method: 'GET', headers: { authorization: 'Bearer s3cret-value' } }, r, deps({ ...ON, CRON_SECRET: 's3cret-value' }));
  check('correct secret → runs the job, 200', r.statusCode === 200 && ran === 1 && r.payload?.ok === true);
  check('releases the database connection', db.released === true);
}

console.log('routing + vercel.json');
{
  const fs = await import('node:fs');
  const cfg = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  // ONE path segment: on this Vercel setup /api/a/b never reaches api/[...path].js (found on the
  // PR #130 Preview, 17 Nov 2026: /api/cron/website-stock → platform 404, /api/cron → the router).
  const cron = (cfg.crons || []).find((c) => c.path === '/api/website-stock-cron');
  check('every cron path is a single /api/<segment> (no sub-path, no query)', (cfg.crons || []).every((c) => /^\/api\/[a-z0-9-]+$/.test(c.path)), JSON.stringify(cfg.crons));
  check('vercel.json schedules the daily retry', Boolean(cron), JSON.stringify(cfg));
  check('runs once a day (Vercel Hobby limit)', cron && /^\d+ \d+ \* \* \*$/.test(cron.schedule), cron?.schedule);
  check('vercel.json adds no rewrites / routes / builds (CRA routing untouched)', Object.keys(cfg).every((k) => ['$schema', 'crons', 'functions'].includes(k)), Object.keys(cfg).join(','));
  check('only the existing API function gets a longer time limit (no new function, Hobby max 60 s)', JSON.stringify(Object.keys(cfg.functions || {})) === '["api/[...path].js"]' && cfg.functions['api/[...path].js'].maxDuration <= 60);
  const router = fs.readFileSync(new URL('../api/[...path].js', import.meta.url), 'utf8');
  check('router sends /api/website-stock-cron to the cron handler', /case 'website-stock-cron':\s*\n\s*return handleWebsiteStockCron/.test(router));
  const { LOGIN_REQUIRED_ROOTS } = await import('../lib/apiLogin.js');
  check('cron route is not behind the staff login (it has its own secret)', !LOGIN_REQUIRED_ROOTS.includes('website-stock-cron'));
  {
    // Through the real router: no secret configured → 503 from OUR handler (not a platform 404).
    const { default: api } = await import('../api/[...path].js');
    const saved = process.env.CRON_SECRET; delete process.env.CRON_SECRET;
    const x = { statusCode: null, payload: null }; x.status = (c) => { x.statusCode = c; return x; }; x.json = (p) => { x.payload = p; return x; }; x.setHeader = () => {};
    await api({ method: 'GET', url: '/api/website-stock-cron', query: {}, headers: {} }, x);
    if (saved !== undefined) process.env.CRON_SECRET = saved;
    check('the router hands /api/website-stock-cron to the cron handler (503 without a secret)', x.statusCode === 503, JSON.stringify(x));
  }
}

console.log('workorder handler: Retry route + status for viewers');
{
  const { default: handler } = await import('../lib/handlers/workorder.js');
  const { default: jwt } = await import('jsonwebtoken');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'smoke-secret';
  const tok = (id, roles) => `Bearer ${jwt.sign({ id, roles }, process.env.JWT_SECRET)}`;
  const res = () => { const r = { statusCode: null, payload: null }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (p) => { r.payload = p; return r; }; r.end = () => r; r.setHeader = () => {}; return r; };
  const outboxRows = [{ workorder_id: 755, id: 1, sku: 'FW-129', qty: 1, status: 'failed', attempts: 1, last_error: 'x', result: null }];
  const getClient = async () => ({
    async query(sql) {
      const t = String(sql).replace(/\s+/g, ' ').trim();
      if (/to_regclass\('public\.woo_stock_outbox'\)/i.test(t)) return { rows: [{ t: 'woo_stock_outbox' }], rowCount: 1 };
      if (/WITH base AS/i.test(t)) return { rows: [{ workorder_id: 755, status: 'Work Ordered', ecommerce: false }], rowCount: 1 };
      if (/FROM woo_stock_outbox WHERE workorder_id = ANY/i.test(t)) return { rows: outboxRows, rowCount: 1 };
      if (/FROM workorder wo JOIN customers c ON wo\.customer_id = c\.id/i.test(t)) return { rows: [{ workorder_id: 755, ecommerce: false }, { workorder_id: 756, ecommerce: true }], rowCount: 2 };
      if (/SELECT access FROM users/i.test(t)) return { rows: [{ access: 'admin' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  });
  const retried = [];
  const deps = { getClient, env: ON, retryWebsiteStock: async (c, id, opts) => { retried.push({ id: Number(id), actor: opts.actorId }); return { ok: true, summary: { sent: 1 } }; } };

  let r = res();
  await handler({ method: 'POST', query: { id: 755, resource: 'website-retry' }, headers: { authorization: tok('KM', ['admin', 'sales']) }, body: {} }, r, [], deps);
  check('Retry refused for a login that cannot see website stock (403)', r.statusCode === 403 && retried.length === 0, JSON.stringify(r.payload));
  r = res();
  await handler({ method: 'POST', query: { id: 755, resource: 'website-retry' }, headers: { authorization: tok('GS', ['superadmin']) }, body: {} }, r, [], deps);
  check('GS can press Retry', r.statusCode === 200 && retried.length === 1 && retried[0].id === 755 && retried[0].actor === 'GS', JSON.stringify(r.payload));
  r = res();
  await handler({ method: 'POST', query: { id: 755, resource: 'website-retry' }, headers: { authorization: tok('GM', ['admin']) }, body: {} }, r, [], deps);
  check('the marketing lead (GM) can press Retry', r.statusCode === 200 && retried.length === 2);
  r = res();
  await handler({ method: 'POST', query: { resource: 'website-retry' }, headers: { authorization: tok('GS', ['superadmin']) }, body: {} }, r, [], deps);
  check('Retry without a workorder id → 400', r.statusCode === 400);

  const view = async (authorization) => { const x = res(); await handler({ method: 'GET', query: { id: 755 }, headers: authorization ? { authorization } : {} }, x, [], deps); return x.payload; };
  check('GS gets the website status rows on the workorder', Array.isArray((await view(tok('GS', ['superadmin']))).website_stock));
  check('other logins do not get them', !('website_stock' in (await view(tok('KM', ['admin', 'sales'])))));

  const list = async (authorization) => { const x = res(); await handler({ method: 'GET', query: { status: 'Work Ordered' }, headers: { authorization } }, x, [], deps); return x.payload; };
  const gsList = await list(tok('GS', ['superadmin']));
  check('GS popup list: unticked workorders carry their website status', Array.isArray(gsList.find((w) => w.workorder_id === 755)?.website_stock), JSON.stringify(gsList));
  check('GS popup list: ticked workorders carry nothing extra', !('website_stock' in gsList.find((w) => w.workorder_id === 756)));
  const kmList = await list(tok('KM', ['admin', 'sales']));
  check('other logins: list unchanged', kmList.every((w) => !('website_stock' in w)));
}

// --- G25d: claimed_at (migration 0015) -------------------------------------------------
{
  const { readFileSync } = await import('node:fs');
  const up = readFileSync(new URL('../db/migrations/0015_woo_outbox_claimed_at.sql', import.meta.url), 'utf8');
  const down = readFileSync(new URL('../db/migrations/0015_woo_outbox_claimed_at_down.sql', import.meta.url), 'utf8');
  const code = (sql) => sql.replace(/--.*$/gm, '');
  check('0015 up: additive, idempotent claimed_at timestamptz NULL', /ALTER TABLE woo_stock_outbox\s+ADD COLUMN IF NOT EXISTS claimed_at timestamptz/i.test(code(up)) && !/NOT NULL|DROP/i.test(code(up)));
  check('0015 down: drops only that column, idempotently', /DROP COLUMN IF EXISTS claimed_at/i.test(code(down)) && !/DROP TABLE/i.test(code(down)));
}
{
  // After migration: a row created days ago but claimed a moment ago is NOT "stuck" (the old
  // created_at guess logged a false "didn't finish" for a slow-but-successful send).
  const db = fakeDb();
  db.hasClaimedAt = true;
  db.add({ workorder_id: 60, sku: 'OLD-BUT-FRESH', qty: 1, status: 'sending', created_at: minsAgo(2 * 24 * 60), claimed_at: minsAgo(5) });
  db.add({ workorder_id: 60, sku: 'REALLY-STUCK', qty: 1, status: 'sending', created_at: minsAgo(2 * 24 * 60), claimed_at: minsAgo(120) });
  db.add({ workorder_id: 60, sku: 'LEGACY', qty: 1, status: 'sending', created_at: minsAgo(180), claimed_at: null });
  const s = await runWebsiteStockRetryJob(db, { env: ON, sync: async () => ({}) });
  check('claimed 5 min ago (created 2 days ago) → left alone, no false "didn\'t finish"', db.outbox[0].status === 'sending' && !db.logs.some((l) => /OLD-BUT-FRESH/.test(l.notes)));
  check('claimed 2 h ago → needs a human', db.outbox[1].status === 'needs_human' && db.outbox[1].result === null);
  check('claimed before the migration (claimed_at NULL) → falls back to created_at', db.outbox[2].status === 'needs_human' && s.stuck === 2, JSON.stringify(s));
}
{
  // Before migration (prod until the owner migrates): the old sweep, no 42703.
  const db = fakeDb();
  db.add({ workorder_id: 61, sku: 'A', qty: 1, status: 'sending', created_at: minsAgo(180) });
  const s = await runWebsiteStockRetryJob(db, { env: ON, sync: async () => ({}) });
  check('pre-0015 database: old sweep still works, no error', s.stuck === 1 && s.errors === 0, JSON.stringify(s));
  const db2 = fakeDb();
  db2.columnCheckFails = true;
  db2.add({ workorder_id: 62, sku: 'A', qty: 1, status: 'sending', created_at: minsAgo(180) });
  const s2 = await runWebsiteStockRetryJob(db2, { env: ON, sync: async () => ({}) });
  check('column check fails → treated as not migrated, sweep still runs', s2.stuck === 1 && s2.errors === 0, JSON.stringify(s2));
}
{
  // The claim stamps claimed_at after the migration, and never mentions it before.
  const woo = createMockWoo([{ id: 7, sku: 'CL-1', stock_quantity: 3, manage_stock: true }]);
  const db = fakeDb({ workorders: { 63: {} } });
  db.hasClaimedAt = true;
  db.add({ workorder_id: 63, sku: 'CL-1', qty: 1 });
  await syncWorkorderWebsiteStock(db, 63, { env: ON, woo, now });
  check('claim stamps claimed_at = NOW() once 0015 is applied', /claimed_at = NOW\(\)/i.test(db.claimSql[0] || '') && db.outbox[0].claimed_at instanceof Date && db.outbox[0].status === 'sent', JSON.stringify(db.outbox[0]));

  const woo2 = createMockWoo([{ id: 8, sku: 'CL-2', stock_quantity: 3, manage_stock: true }]);
  const db2 = fakeDb({ workorders: { 64: {} } });
  db2.add({ workorder_id: 64, sku: 'CL-2', qty: 1 });
  await syncWorkorderWebsiteStock(db2, 64, { env: ON, woo: woo2, now });
  check('pre-0015: the claim never mentions claimed_at (42703-safe) and the send still works', !/claimed_at/i.test(db2.claimSql[0] || '') && db2.outbox[0].status === 'sent', JSON.stringify(db2.outbox[0]));

  // A failed row claimed again gets a FRESH claimed_at (the sweep must not see the old one).
  const woo3 = createMockWoo([{ id: 9, sku: 'CL-3', stock_quantity: 3, manage_stock: true }]);
  const db3 = fakeDb({ workorders: { 65: {} } });
  db3.hasClaimedAt = true;
  const old = minsAgo(3 * 24 * 60);
  db3.add({ workorder_id: 65, sku: 'CL-3', qty: 1, status: 'failed', claimed_at: old });
  await syncWorkorderWebsiteStock(db3, 65, { env: ON, woo: woo3, now });
  check('re-claiming a failed row refreshes claimed_at', db3.outbox[0].claimed_at > old && db3.outbox[0].status === 'sent');
}
{
  // The daily job checks for the column ONCE and hands the answer to every sync it runs.
  const woo = createMockWoo([{ id: 10, sku: 'J-1', stock_quantity: 5, manage_stock: true }, { id: 11, sku: 'J-2', stock_quantity: 5, manage_stock: true }]);
  const db = fakeDb({ workorders: { 66: {}, 67: {} } });
  db.hasClaimedAt = true;
  db.add({ workorder_id: 66, sku: 'J-1', qty: 1, status: 'failed', created_at: minsAgo(120) });
  db.add({ workorder_id: 67, sku: 'J-2', qty: 1, status: 'failed', created_at: minsAgo(120) });
  await runWebsiteStockRetryJob(db, { env: ON, sync: (c, id, opts) => syncWorkorderWebsiteStock(c, id, { env: ON, woo, now, ...opts }) });
  check('job: one column check for the whole run, claims still stamped', db.columnChecks === 1 && db.outbox.every((r) => r.status === 'sent' && r.claimed_at instanceof Date), `${db.columnChecks} ${JSON.stringify(db.outbox)}`);
}

console.log(`\n✅ woo-stock retry smoke: ${passed} checks passed`);
