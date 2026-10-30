// scripts/ops-workorder-cancel-smoke.mjs — G23 (owner, 30 Oct 2026): workorders can be Cancelled.
//
// Owner decisions: cancelling cancels every live item, returns its stock and frees its lots;
// reopening puts the items back (stock taken again). Only superadmin / admin / logistics / sales
// may cancel or reopen a cancelled workorder. Drives lib/handlers/workorder.js end to end against
// a small STATEFUL fake database (transactions modelled: ROLLBACK restores the snapshot).
//
//   node scripts/ops-workorder-cancel-smoke.mjs

import { readFileSync } from 'node:fs';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'g23-smoke-secret';
const { default: handler } = await import('../lib/handlers/workorder.js');

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const token = (id, roles) => `Bearer ${jwt.sign({ id, email: `${id}@x`, roles }, process.env.JWT_SECRET)}`;
const AS = {
  superadmin: ['GS', ['superadmin']],
  admin: ['GA', ['admin']],
  logistics: ['LG', ['logistics']],
  sales: ['BR', ['sales']],
  staff: ['SF', ['staff']],
  technician: ['TE', ['technician']],
};

// --- a stateful fake ---------------------------------------------------------------------
function makeDb({ deliveries = [], stock = {}, status = 'Work Ordered', preMigration = false } = {}) {
  const state = {
    workorder: {
      workorder_id: 41, invoice_id: 'INV-41', customer_id: 7, status, outstanding_balance: 500,
      delivery_state: 'VIC', delivery_suburb: 'Altona North', delivery_charged: 150, notes: null,
      delivery_type: 'Standard', free_delivery: false, cash_to_removalist: false, installation_cost: null,
    },
    items: [
      { workorder_items_id: 1, product_id: 'TREAD', quantity: 1, is_custom: false, status: 'In Workshop', status_before_cancel: null },
      { workorder_items_id: 2, product_id: 'BIKE', quantity: 2, is_custom: false, status: 'Completed', status_before_cancel: null },
      { workorder_items_id: 3, product_id: 'CUSTOM', quantity: 1, is_custom: true, status: 'Not in Workshop', status_before_cancel: null },
      { workorder_items_id: 4, product_id: 'ROWER', quantity: 1, is_custom: false, status: 'Canceled', status_before_cancel: null }, // removed earlier
    ],
    stock: { TREAD: 5, BIKE: 3, ROWER: 2, ...stock },
    lots: [
      { lot_number: 'L-100', workorder_items_id: 1, status: 'Assigned' },
      { lot_number: 'L-101', workorder_items_id: 2, status: 'Assigned' },
      { lot_number: 'L-102', workorder_items_id: 2, status: 'Void' },
      { lot_number: 'L-104', workorder_items_id: 4, status: 'Assigned' }, // left on an item removed before the cancel
      { lot_number: 'L-200', workorder_items_id: 99, status: 'Assigned' }, // another workorder
    ],
    deliveries,
    logs: [],
  };
  let snapshot = null;
  const sql = [];
  const ids = (p) => (Array.isArray(p) ? p.map(Number) : []);
  const client = {
    state, sql, released: false,
    async query(text, params = []) {
      const t = String(text).replace(/\s+/g, ' ').trim();
      sql.push(t);
      if (/^BEGIN$/i.test(t)) { snapshot = JSON.stringify(state); return { rows: [] }; }
      if (/^COMMIT$/i.test(t)) { snapshot = null; return { rows: [] }; }
      if (/^ROLLBACK$/i.test(t)) { if (snapshot) Object.assign(state, JSON.parse(snapshot)); snapshot = null; return { rows: [] }; }
      if (/SELECT access FROM users/i.test(t)) return { rows: [{ access: 'staff' }], rowCount: 1 };
      if (/^SELECT \* FROM workorder WHERE workorder_id/i.test(t)) return { rows: [{ ...state.workorder }], rowCount: 1 };
      if (/WITH base AS/i.test(t)) return { rows: [{ ...state.workorder }], rowCount: 1 }; // the closing GET re-read
      if (/SELECT status FROM workorder WHERE workorder_id/i.test(t)) return { rows: [{ status: state.workorder.status }], rowCount: 1 };
      if (/COUNT\(\*\) FILTER \(WHERE status = 'Completed'\)/i.test(t)) {
        const live = state.items.filter((i) => i.status !== 'Canceled');
        return { rows: [{ done: String(live.filter((i) => i.status === 'Completed').length), total: String(live.length) }] };
      }
      if (/FROM delivery WHERE workorder_id/i.test(t)) return { rows: state.deliveries.map((d) => ({ ...d })), rowCount: state.deliveries.length };
      if (/FROM workorder_items WHERE workorder_id = \$1 AND status <> 'Canceled'/i.test(t)) {
        const rows = state.items.filter((i) => i.status !== 'Canceled').map((i) => ({ ...i }));
        return { rows, rowCount: rows.length };
      }
      if (/FROM workorder_items WHERE workorder_id = \$1 AND status = 'Canceled' AND status_before_cancel IS NOT NULL/i.test(t)) {
        const rows = state.items.filter((i) => i.status === 'Canceled' && i.status_before_cancel).map((i) => ({ ...i }));
        return { rows, rowCount: rows.length };
      }
      if (/FROM workorder_items WHERE workorder_items_id = \$1 AND workorder_id = \$2/i.test(t)) { // the per-item edit path
        const i = state.items.find((x) => x.workorder_items_id === Number(params[0]));
        return i ? { rows: [{ ...i, technician_id: 'TE', item_sn: null, selling_price: null }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (/SELECT stock FROM product WHERE sku/i.test(t)) {
        const s = state.stock[params[0]];
        return s == null ? { rows: [], rowCount: 0 } : { rows: [{ stock: s }], rowCount: 1 };
      }
      if (/UPDATE product SET stock/i.test(t)) { state.stock[params[1]] = Number(params[0]); return { rows: [], rowCount: 1 }; }
      if (/UPDATE workorder_items SET status_before_cancel = status, status = 'Canceled'/i.test(t)) {
        if (preMigration) throw Object.assign(new Error('column "status_before_cancel" of relation "workorder_items" does not exist'), { code: '42703' });
        const want = ids(params[0]);
        for (const i of state.items) if (want.includes(i.workorder_items_id)) { i.status_before_cancel = i.status; i.status = 'Canceled'; }
        return { rows: [], rowCount: want.length };
      }
      if (/UPDATE workorder_items SET status = status_before_cancel, status_before_cancel = NULL/i.test(t)) {
        const want = ids(params[0]);
        for (const i of state.items) if (want.includes(i.workorder_items_id)) { i.status = i.status_before_cancel; i.status_before_cancel = null; }
        return { rows: [], rowCount: want.length };
      }
      if (/UPDATE product_lots SET status = 'In Stock', workorder_items_id = NULL/i.test(t)) {
        const want = /IN \(SELECT workorder_items_id FROM workorder_items WHERE workorder_id = \$1\)/i.test(t)
          ? (Number(params[0]) === 41 ? state.items.map((i) => i.workorder_items_id) : [])
          : ids(params[0]);
        const only = (t.match(/AND status = '([^']+)'/) || [])[1]; // honour the SQL, so a wrong predicate fails
        const hit = state.lots.filter((l) => want.includes(l.workorder_items_id) && (!only || l.status === only));
        for (const l of hit) { l.status = 'In Stock'; l.workorder_items_id = null; }
        return { rows: hit.map((l) => ({ lot_number: l.lot_number })), rowCount: hit.length };
      }
      if (/^UPDATE workorder SET status = /i.test(t)) {
        const m = t.match(/SET status = '([^']+)'/);
        state.workorder.status = m ? m[1] : params[0];
        return { rows: [], rowCount: 1 };
      }
      if (/^UPDATE workorder SET /i.test(t)) {
        if (/notes = \$1/.test(t)) state.workorder.notes = params[0];
        return { rows: [], rowCount: 1 };
      }
      if (/INSERT INTO workorder_logs/i.test(t)) {
        state.logs.push({ workorder_items_id: params[1], event_type: params[2], user_id: params[3], item_status: params[4], notes_log: params[5] });
        return { rows: [], rowCount: 1 };
      }
      if (/INSERT INTO delivery/i.test(t)) { state.deliveries.push({ delivery_id: 900 }); return { rows: [], rowCount: 1 }; }
      if (/INSERT INTO workorder_items/i.test(t)) { state.items.push({ workorder_items_id: 50, status: 'Not in Workshop' }); return { rows: [{ workorder_items_id: 50 }], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    },
    release() { client.released = true; },
  };
  return client;
}

function fakeRes() {
  const res = { statusCode: 200, payload: null, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.payload = p; return res; };
  res.end = () => res;
  res.setHeader = (k, v) => { res.headers[k] = v; };
  return res;
}

// The first response (the PUT's own answer) is what counts; the closing GET re-read writes again.
async function put(db, who, body, { claimId } = {}) {
  const [id, roles] = who || [];
  const headers = id ? { 'x-user-id': claimId || id, authorization: token(id, roles) } : { 'x-user-id': 'GA' };
  const res = fakeRes();
  let first = null;
  const status = res.status;
  res.status = (c) => { if (first === null) first = c; return status(c); };
  await handler({ method: 'PUT', query: { id: '41' }, body, headers }, res, [], { getClient: async () => db });
  return { code: first ?? 200, body: res.payload };
}
const item = (db, n) => db.state.items.find((i) => i.workorder_items_id === n);
const lot = (db, n) => db.state.lots.find((l) => l.lot_number === n);
const events = (db, type) => db.state.logs.filter((l) => l.event_type === type);

console.log('G23 — cancelling a workorder');
{
  const db = makeDb();
  const r = await put(db, AS.sales, { status: 'Cancelled' });
  check('a sales login cancels → 200', r.code === 200, JSON.stringify(r.body));
  check('workorder is Cancelled', db.state.workorder.status === 'Cancelled');
  check('every live item is Canceled', [1, 2, 3].every((n) => item(db, n).status === 'Canceled'));
  check('…and remembers what it was', item(db, 1).status_before_cancel === 'In Workshop' && item(db, 2).status_before_cancel === 'Completed' && item(db, 3).status_before_cancel === 'Not in Workshop');
  check('an item removed earlier is left alone (stays removed on reopen)', item(db, 4).status === 'Canceled' && item(db, 4).status_before_cancel === null);
  check('stock returned for each live stocked item', db.state.stock.TREAD === 6 && db.state.stock.BIKE === 5);
  check('…not for the removed item (already returned) or the custom item', db.state.stock.ROWER === 2 && db.state.stock.CUSTOM === undefined);
  check('assigned lots on this workorder are freed', lot(db, 'L-100').status === 'In Stock' && lot(db, 'L-100').workorder_items_id === null && lot(db, 'L-101').status === 'In Stock');
  check('a lot left on an item removed earlier is freed too', lot(db, 'L-104').status === 'In Stock' && lot(db, 'L-104').workorder_items_id === null);
  check('a Void lot and another workorder\'s lot are untouched', lot(db, 'L-102').status === 'Void' && lot(db, 'L-200').status === 'Assigned' && lot(db, 'L-200').workorder_items_id === 99);
  check('one item log per cancelled item', events(db, 'ITEM_STATUS_CHANGED').filter((l) => l.item_status === 'Canceled').length === 3);
  const wo = events(db, 'WORKORDER_STATUS_CHANGED');
  check('one workorder log naming the cancel, the stock and the freed lots', wo.length === 1 && /cancelled/i.test(wo[0].notes_log) && /L-100/.test(wo[0].notes_log) && /L-101/.test(wo[0].notes_log), JSON.stringify(wo));
  check('no completion and no delivery', events(db, 'WORKORDER_COMPLETED').length === 0 && db.state.deliveries.length === 0);
  check('the client is released', db.released === true);
  check('the save locks the workorder row first', db.sql.some((q) => /^SELECT \* FROM workorder WHERE workorder_id = \$1 FOR UPDATE$/i.test(q)));

  const again = await put(db, AS.sales, { status: 'Cancelled' });
  check('cancelling again changes nothing', again.code === 200 && db.state.stock.TREAD === 6 && events(db, 'WORKORDER_STATUS_CHANGED').length === 1);
}

console.log('G23 — who may cancel');
for (const who of ['superadmin', 'admin', 'logistics']) {
  const db = makeDb();
  const r = await put(db, AS[who], { status: 'Cancelled' });
  check(`${who} may cancel`, r.code === 200 && db.state.workorder.status === 'Cancelled');
}
{
  const db = makeDb();
  const r = await put(db, null, { status: 'Cancelled' });
  check('a claimed id with no login token → 401 (log in again), nothing changed', r.code === 401 && db.state.workorder.status === 'Work Ordered' && db.state.stock.TREAD === 5);
}
{
  const db = makeDb();
  await put(db, AS.sales, { status: 'Cancelled' }, { claimId: 'GS' });
  check('the cancel is logged as the signed login, not a claimed id', events(db, 'WORKORDER_STATUS_CHANGED')[0]?.user_id === 'BR' && events(db, 'ITEM_STATUS_CHANGED').every((l) => l.user_id === 'BR'));
}
for (const [who, as] of [['staff', AS.staff]]) {
  const db = makeDb();
  const r = await put(db, as, { status: 'Cancelled' });
  check(`${who} → 403 with a plain reason, nothing changed`,
    r.code === 403 && /superadmin, admin, logistics or sales/i.test(r.body?.error) && db.state.workorder.status === 'Work Ordered' && db.state.stock.TREAD === 5 && lot(db, 'L-100').status === 'Assigned',
    JSON.stringify(r.body));
}
{
  const db = makeDb();
  const r = await put(db, AS.technician, { status: 'Cancelled' });
  check('a workshop login → 403 (workshop rule), nothing changed', r.code === 403 && db.state.workorder.status === 'Work Ordered');
}

console.log('G23 — a workorder with a delivery');
{
  const db = makeDb({ deliveries: [{ delivery_id: 7, delivery_status: 'To Be Booked' }] });
  const r = await put(db, AS.admin, { status: 'Cancelled', notes: 'customer pulled out' });
  check('→ 409 asking for the delivery to be removed first', r.code === 409 && /delivery/i.test(r.body?.error), JSON.stringify(r.body));
  check('…and nothing changed (rolled back, notes included)', db.state.workorder.status === 'Work Ordered' && db.state.workorder.notes === null && db.state.stock.TREAD === 5 && item(db, 1).status === 'In Workshop');
}

console.log('G23 — what cannot be cancelled');
{
  const db = makeDb({ status: 'Completed' });
  const r = await put(db, AS.admin, { status: 'Cancelled' });
  check('a Completed workorder → 409 (set it back to Work Ordered first), nothing changed', r.code === 409 && /completed/i.test(r.body?.error) && db.state.workorder.status === 'Completed' && db.state.stock.BIKE === 3, JSON.stringify(r.body));
}
{
  const db = makeDb();
  const r = await put(db, AS.admin, { status: 'Cancelled', items: [{ workorder_items_id: 1, status: 'Completed' }] });
  check('a cancel carrying item changes → 409, nothing changed', r.code === 409 && db.state.workorder.status === 'Work Ordered' && item(db, 1).status === 'In Workshop');
}
{
  const db = makeDb({ preMigration: true });
  const r = await put(db, AS.admin, { status: 'Cancelled' });
  check('before migration 0012 → a plain 409, not a 500; nothing changed', r.code === 409 && /0012/.test(r.body?.error) && db.state.workorder.status === 'Work Ordered' && db.state.stock.TREAD === 5, JSON.stringify(r.body));
}

console.log('G23 — a cancelled workorder');
{
  const db = makeDb();
  await put(db, AS.admin, { status: 'Cancelled' });
  let r = await put(db, AS.admin, { add_items: [{ product_id: 'TREAD', quantity: 1 }] });
  check('adding an item → 409 (reopen first)', r.code === 409 && /reopen/i.test(r.body?.error) && db.state.items.length === 4);
  r = await put(db, AS.admin, { items: [{ workorder_items_id: 1, status: 'In Workshop' }] });
  check('changing an item → 409 (reopen first)', r.code === 409 && item(db, 1).status === 'Canceled');
  r = await put(db, AS.admin, { notes: 'x', items: [{ workorder_items_id: 1, status: 'Canceled', technician_id: 'ZZ', item_sn: 'SN-9' }] });
  check('any item edit on a cancelled workorder → 409 (nothing silently dropped)', r.code === 409 && db.state.workorder.notes === null);
  const before = db.sql.length;
  r = await put(db, AS.admin, { notes: 'refund issued', items: [] });
  check('a notes-only save leaves its items untouched', !db.sql.slice(before).some((q) => /^UPDATE workorder_items/i.test(q)));
  check('notes can still be edited', r.code === 200 && db.state.workorder.notes === 'refund issued' && db.state.workorder.status === 'Cancelled');
  r = await put(db, AS.admin, { status: 'Completed' });
  check('a cancelled workorder cannot jump to Completed', r.code === 409 && db.state.workorder.status === 'Cancelled');
  r = await put(db, AS.admin, { status: 'Work Ordered', notes: 'stale page' });
  check('a stale page saving "Work Ordered" does NOT reopen it → 409 reload', r.code === 409 && /reload/i.test(r.body?.error) && db.state.workorder.status === 'Cancelled' && item(db, 1).status === 'Canceled' && db.state.stock.TREAD === 6, JSON.stringify(r.body));
  r = await put(db, AS.staff, { status: 'Work Ordered', reopen: true });
  check('staff cannot reopen it', r.code === 403 && db.state.workorder.status === 'Cancelled');
}

console.log('G23 — reopening');
{
  const db = makeDb();
  await put(db, AS.sales, { status: 'Cancelled' });
  const r = await put(db, AS.logistics, { status: 'Work Ordered', reopen: true });
  check('logistics reopens → 200, Work Ordered', r.code === 200 && db.state.workorder.status === 'Work Ordered', JSON.stringify(r.body));
  check('items are back where they were', item(db, 1).status === 'In Workshop' && item(db, 2).status === 'Completed' && item(db, 3).status === 'Not in Workshop');
  check('…markers cleared', [1, 2, 3].every((n) => item(db, n).status_before_cancel === null));
  check('the item removed before the cancel stays removed', item(db, 4).status === 'Canceled');
  check('stock taken again', db.state.stock.TREAD === 5 && db.state.stock.BIKE === 3 && db.state.stock.ROWER === 2);
  check('freed lots are NOT re-assigned (re-assign by hand)', lot(db, 'L-100').status === 'In Stock');
  const wo = events(db, 'WORKORDER_STATUS_CHANGED');
  check('the reopen is logged and says lots need re-assigning', wo.length === 2 && /reopened/i.test(wo[1].notes_log) && /lot/i.test(wo[1].notes_log), JSON.stringify(wo));
  check('reopening does not complete or create a delivery', events(db, 'WORKORDER_COMPLETED').length === 0 && db.state.deliveries.length === 0);
}
{
  const db = makeDb();
  await put(db, AS.sales, { status: 'Cancelled' });
  db.state.stock.BIKE = 1; // sold elsewhere meanwhile; item 2 needs 2
  const r = await put(db, AS.admin, { status: 'Work Ordered', reopen: true });
  check('not enough stock to reopen → 409, nothing restored', r.code === 409 && /insufficient stock/i.test(r.body?.error) && db.state.workorder.status === 'Cancelled' && item(db, 1).status === 'Canceled' && db.state.stock.TREAD === 6, JSON.stringify(r.body));
}

console.log('G23 — nothing new attaches to a cancelled workorder');
{
  const { default: lotsHandler } = await import('../lib/handlers/lots.js');
  const { default: deliveryHandler } = await import('../lib/handlers/delivery.js');
  // A minimal client: answers the guard's lookup, records everything else.
  const tiny = (row) => {
    const sql = [];
    return {
      sql, release() {},
      async query(text) {
        const t = String(text).replace(/\s+/g, ' ').trim();
        sql.push(t);
        if (/FROM product_lots pl JOIN workorder_items wi/i.test(t)) return { rows: [row], rowCount: 1 };
        if (/SELECT status::text AS status FROM workorder WHERE workorder_id = \$1 FOR UPDATE/i.test(t)) return { rows: [row], rowCount: 1 };
        if (/INSERT INTO delivery/i.test(t)) return { rows: [{ delivery_id: 1, workorder_id: 41, delivery_status: 'To Be Booked' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    };
  };
  const assign = { method: 'POST', query: { action: 'assign' }, body: { lot_id: 5, workorder_items_id: 1 }, headers: {} };
  const lotRow = { lot_sku: 'TREAD', lot_status: 'In Stock', wi_sku: 'TREAD' };
  for (const [label, extra] of [['a cancelled item', { wi_status: 'Canceled', wo_status: 'Work Ordered' }], ['an item on a cancelled workorder', { wi_status: 'In Workshop', wo_status: 'Cancelled' }]]) {
    const c = tiny({ ...lotRow, ...extra });
    const res = fakeRes();
    await lotsHandler(assign, res, [], { getClient: async () => c });
    check(`assigning a lot to ${label} → 409, nothing written`, res.statusCode === 409 && !c.sql.some((q) => /^UPDATE product_lots/i.test(q)), JSON.stringify(res.payload));
  }
  {
    const c = tiny({ ...lotRow, wi_status: 'In Workshop', wo_status: 'Work Ordered' });
    const res = fakeRes();
    await lotsHandler(assign, res, [], { getClient: async () => c });
    check('…a live item still takes the lot', res.statusCode === 200 && c.sql.some((q) => /^UPDATE product_lots SET status='Assigned'/i.test(q)));
    check('…and the guard locks the item as well as the lot', c.sql.some((q) => /FOR UPDATE OF pl, wi/i.test(q)));
  }
  const newDelivery = { method: 'POST', query: {}, body: { invoice_id: 'INV-41', customer_id: 7, delivery_state: 'VIC', workorder_id: 41 }, headers: { 'x-user-id': 'GA' } };
  {
    const c = tiny({ status: 'Cancelled' });
    const res = fakeRes();
    await deliveryHandler(newDelivery, res, [], { getClient: async () => c });
    check('a delivery for a cancelled workorder → 409, nothing inserted', res.statusCode === 409 && /cancelled/i.test(res.payload?.error) && !c.sql.some((q) => /INSERT INTO delivery/i.test(q)), JSON.stringify(res.payload));
  }
  {
    const c = tiny({ status: 'Work Ordered' });
    const res = fakeRes();
    await deliveryHandler(newDelivery, res, [], { getClient: async () => c });
    check('…a live workorder still gets its delivery', c.sql.some((q) => /INSERT INTO delivery/i.test(q)));
  }
}

console.log('G23 — the Cancelled list');
{
  const db = makeDb();
  const res = fakeRes();
  await handler({ method: 'GET', query: { status: 'Cancelled' }, headers: { 'x-user-id': 'GA' } }, res, [], { getClient: async () => db });
  const listSql = db.sql.find((q) => /FROM workorder wo JOIN customers c/i.test(q)) || '';
  check('status=Cancelled is accepted', res.statusCode === 200, JSON.stringify(res.payload));
  check('…compared as text (works before migration 0012 too)', /wo\.status::text = \$1/.test(listSql));
  check('…and lists the items the cancel took off it', /wi\.status_before_cancel IS NOT NULL/.test(listSql));
}

console.log('G23 — status validation');
{
  const db = makeDb();
  const r = await put(db, AS.admin, { status: 'Canceled' });
  check('the item spelling is not a workorder status → 400', r.code === 400);
}

console.log('G23 — migration 0012');
{
  const up = readFileSync(new URL('../db/migrations/0012_status_options.sql', import.meta.url), 'utf8');
  const down = readFileSync(new URL('../db/migrations/0012_status_options_down.sql', import.meta.url), 'utf8');
  check('adds Cancelled idempotently', /ADD VALUE IF NOT EXISTS 'Cancelled'/.test(up));
  check('renames Sold to Written Off only when needed (schema-aware)', /RENAME VALUE 'Sold' TO 'Written Off'/.test(up) && /current_schema\(\)/.test(up) && /NOT EXISTS/.test(up));
  check('adds status_before_cancel idempotently', /ADD COLUMN IF NOT EXISTS status_before_cancel item_status_enum/.test(up));
  check('down refuses while a workorder is Cancelled', /status::text = 'Cancelled'/.test(down) && /RAISE EXCEPTION/.test(down));
  check('down restores the Sold label and drops the column', /RENAME VALUE 'Written Off' TO 'Sold'/.test(down) && /DROP COLUMN IF EXISTS status_before_cancel/.test(down));
}

console.log(`\n✅ ops-workorder-cancel smoke: ${passed} checks passed`);
