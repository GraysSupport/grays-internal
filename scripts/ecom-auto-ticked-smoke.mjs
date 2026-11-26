// scripts/ecom-auto-ticked-smoke.mjs — offline smoke for the GS one-time popup (owner,
// 26 Nov 2026): once the dry run is off, a successful website update ticks the E-Commerce flag
// by itself; GS still needs to open each of those workorders ONCE to enter the sold items'
// values. lib/ecomAutoTicked.js lists them and remembers when GS opened each one.
//
//   node scripts/ecom-auto-ticked-smoke.mjs

import { canSeeEcomAutoPopup, listEcomAutoTicked, markEcomAutoSeen } from '../lib/ecomAutoTicked.js';

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const missingColumn = () => Object.assign(new Error('column "ecommerce_auto_ticked_at" does not exist'), { code: '42703' });

// In-memory workorders. Only what the module reads/writes.
function fakeDb({ migrated = true } = {}) {
  const wos = [
    { workorder_id: 1, invoice_id: 'INV-1', status: 'Work Ordered', ecommerce: true, ecommerce_auto_ticked_at: '2026-11-27T01:00:00Z', ecommerce_auto_seen_at: null, customer_name: 'A', items: [{ product_name: 'Treadmill', quantity: 1 }] },
    { workorder_id: 2, invoice_id: 'INV-2', status: 'Completed', ecommerce: true, ecommerce_auto_ticked_at: '2026-11-27T02:00:00Z', ecommerce_auto_seen_at: null, customer_name: 'B', items: [] },
    { workorder_id: 3, invoice_id: 'INV-3', status: 'Work Ordered', ecommerce: true, ecommerce_auto_ticked_at: '2026-11-27T03:00:00Z', ecommerce_auto_seen_at: '2026-11-27T04:00:00Z', customer_name: 'C', items: [] },
    { workorder_id: 4, invoice_id: 'INV-4', status: 'Work Ordered', ecommerce: true, ecommerce_auto_ticked_at: null, ecommerce_auto_seen_at: null, customer_name: 'D', items: [] },
    { workorder_id: 5, invoice_id: 'INV-5', status: 'Cancelled', ecommerce: false, ecommerce_auto_ticked_at: '2026-11-27T05:00:00Z', ecommerce_auto_seen_at: null, customer_name: 'E', items: [] },
  ];
  const sql = [];
  return {
    wos, sql,
    async query(text, params = []) {
      const t = String(text).replace(/\s+/g, ' ').trim();
      sql.push(t);
      if (!migrated && /ecommerce_auto_/i.test(t)) throw missingColumn();
      if (/^SELECT/i.test(t) && /ecommerce_auto_ticked_at IS NOT NULL/i.test(t)) {
        // The module must filter on: ticked automatically, not yet opened, still ticked, not cancelled.
        const ok = /ecommerce_auto_seen_at IS NULL/i.test(t) && /ecommerce IS TRUE/i.test(t) && /<> \$1/.test(t);
        if (!ok) return { rows: wos, rowCount: wos.length }; // wrong filter → test will notice
        const rows = wos.filter((w) => w.ecommerce_auto_ticked_at && !w.ecommerce_auto_seen_at && w.ecommerce === true && w.status !== params[0]);
        return { rows, rowCount: rows.length };
      }
      if (/^UPDATE workorder SET ecommerce_auto_seen_at = NOW\(\)/i.test(t)) {
        const w = wos.find((x) => x.workorder_id === Number(params[0]) && x.ecommerce_auto_ticked_at && !x.ecommerce_auto_seen_at);
        if (!w) return { rows: [], rowCount: 0 };
        w.ecommerce_auto_seen_at = 'now';
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

console.log('who sees the popup');
check('GS sees it', canSeeEcomAutoPopup({ id: 'GS', roles: ['superadmin'] }));
check('GS id is matched case-insensitively', canSeeEcomAutoPopup({ id: 'gs', roles: [] }));
check('another superadmin does not (GS view only)', !canSeeEcomAutoPopup({ id: 'NB', roles: ['superadmin'] }));
check('no login → no popup', !canSeeEcomAutoPopup(null));

console.log('list');
{
  const db = fakeDb();
  const r = await listEcomAutoTicked(db);
  const ids = r.rows.map((w) => w.workorder_id).sort();
  check('available after migration', r.available === true);
  check('lists ticked-automatically workorders GS has not opened (any status but Cancelled)', JSON.stringify(ids) === '[1,2]', JSON.stringify(ids));
  check('rows carry invoice, customer, items and when it was ticked', r.rows.find((w) => w.workorder_id === 1)?.items?.[0]?.product_name === 'Treadmill' && r.rows[0].ecommerce_auto_ticked_at);
  check('list query passes the Cancelled status as a parameter', db.sql.some((s) => /<> \$1/.test(s)));
}
{
  const r = await listEcomAutoTicked(fakeDb({ migrated: false }));
  check('before migration 0018 → empty, not an error', r.available === false && r.rows.length === 0);
}

console.log('opened once → never again');
{
  const db = fakeDb();
  const first = await markEcomAutoSeen(db, 1);
  check('opening marks it seen', first.ok === true && first.marked === true);
  const again = await markEcomAutoSeen(db, 1);
  check('opening again changes nothing (first opening time kept)', again.ok === true && again.marked === false);
  const r = await listEcomAutoTicked(db);
  check('an opened workorder no longer pops up', !r.rows.some((w) => w.workorder_id === 1) && r.rows.some((w) => w.workorder_id === 2));
  const plain = await markEcomAutoSeen(db, 4);
  check('a hand-ticked workorder is never marked (nothing to pop up)', plain.marked === false);
  const bad = await markEcomAutoSeen(db, 'abc');
  check('a non-numeric id is refused', bad.ok === false && bad.status === 400);
  const pre = await markEcomAutoSeen(fakeDb({ migrated: false }), 1);
  check('before migration 0018 → ok, nothing marked, no error', pre.ok === true && pre.marked === false && pre.available === false);
}

console.log('workorder handler routes');
{
  const { default: handler } = await import('../lib/handlers/workorder.js');
  const { default: jwt } = await import('jsonwebtoken');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'smoke-secret';
  const tok = (id, roles) => `Bearer ${jwt.sign({ id, roles }, process.env.JWT_SECRET)}`;
  const res = () => { const r = { statusCode: null, payload: null }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (p) => { r.payload = p; return r; }; r.end = () => r; r.setHeader = () => {}; return r; };
  const db = fakeDb();
  const deps = { getClient: async () => Object.assign(db, { release() {} }), env: {} };

  let r = res();
  await handler({ method: 'GET', query: { resource: 'ecommerce-auto-ticked' }, headers: { authorization: tok('GS', ['superadmin']) } }, r, [], deps);
  check('GS gets the list', r.statusCode === 200 && Array.isArray(r.payload?.rows) && r.payload.rows.length === 2, JSON.stringify(r));
  r = res();
  await handler({ method: 'GET', query: { resource: 'ecommerce-auto-ticked' }, headers: { authorization: tok('NB', ['superadmin']) } }, r, [], deps);
  check('anyone else → 403', r.statusCode === 403);
  r = res();
  await handler({ method: 'GET', query: { resource: 'ecommerce-auto-ticked' }, headers: { 'x-user-id': 'GS' } }, r, [], deps);
  check('a claimed X-User-Id GS without a login token → 403 (token decides)', r.statusCode === 403);
  r = res();
  await handler({ method: 'POST', query: { resource: 'ecommerce-auto-seen', id: '2' }, headers: { authorization: tok('GS', ['superadmin']) }, body: {} }, r, [], deps);
  check('GS opening a workorder marks it seen', r.statusCode === 200 && r.payload?.marked === true && db.wos[1].ecommerce_auto_seen_at === 'now', JSON.stringify(r));
  r = res();
  await handler({ method: 'POST', query: { resource: 'ecommerce-auto-seen', id: '1' }, headers: { authorization: tok('KM', ['admin']) }, body: {} }, r, [], deps);
  r = res();
  await handler({ method: 'POST', query: { resource: 'ecommerce-auto-seen' }, headers: { authorization: tok('GS', ['superadmin']) }, body: {} }, r, [], deps);
  check('GS POST without a workorder id → 400', r.statusCode === 400);
  r = res();
  await handler({ method: 'POST', query: { resource: 'ecommerce-auto-seen', id: '1' }, headers: { authorization: tok('KM', ['admin']) }, body: {} }, r, [], deps);
  check('someone else opening it does not mark it seen', r.statusCode === 403 && db.wos[0].ecommerce_auto_seen_at === null);
}

console.log(`\necom-auto-ticked smoke: ${passed} passed`);
