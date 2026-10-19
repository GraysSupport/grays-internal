// scripts/ops-workshop-lockdown-smoke.mjs — offline smoke for G17 (Nick, 19 Oct 2026):
// technicians, the workshop role and the WK kiosk see the job, not the money.
//
//   - no balances / delivery money / customer contact details in what the server sends them
//   - workorder saves limited to item status (never Canceled) + serials
//   - no creating / deleting workorders, no delivery edits, no customer endpoints
//   - WK (an admin login) loses the admin-only Lot Tracker, Temp Run, board-note + run-order edits
//
// Fake pg clients only — no network, no database, no secrets.
//
//   node scripts/ops-workshop-lockdown-smoke.mjs

process.env.JWT_SECRET = process.env.JWT_SECRET || 'smoke_secret';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const jwt = (await import('jsonwebtoken')).default;
const access = await import('../lib/workshopAccess.js');
const clientAccess = await import('../src/utils/workshopAccess.js');
const workorderHandler = (await import('../lib/handlers/workorder.js')).default;
const deliveryHandler = (await import('../lib/handlers/delivery.js')).default;
const {
  isWorkshopRestricted, resolveWorkshopActor, workshopPutViolations, refuseWorkshop,
  WORKSHOP_ROLES, FULL_ACCESS_ROLES, WORKSHOP_ACCOUNT_ID, WORKSHOP_ITEM_STATUSES,
} = access;

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// users table as prod has it (19 Oct 2026): technicians, WK = admin, GA = admin, GS = superadmin.
const USERS = {
  ED: { access: 'technician', roles: ['technician'] },
  TB: { access: 'technician', roles: ['technician'] },
  WS: { access: 'staff', roles: ['workshop'] },
  WK: { access: 'admin', roles: ['admin'] },
  GA: { access: 'admin', roles: ['admin'] },
  GS: { access: 'superadmin', roles: ['superadmin'] },
  MX: { access: 'technician', roles: ['technician', 'logistics'] },
};

const token = (id, roles, opts = {}) => jwt.sign({ id, email: `${id}@graysfitness.com.au`, roles }, process.env.JWT_SECRET, { expiresIn: '1h', ...opts });
const expiredToken = (id, roles) => jwt.sign({ id, roles, exp: Math.floor(Date.now() / 1000) - 60 }, process.env.JWT_SECRET);
function reqAs({ id, roles, header = true, tokenToo = true, method = 'GET', query = {}, body = {}, expired = false } = {}) {
  const headers = {};
  if (id && header) headers['x-user-id'] = id;
  if (id && tokenToo) headers.authorization = `Bearer ${expired ? expiredToken(id, roles) : token(id, roles)}`;
  return { method, query, body, headers };
}

const WO = {
  workorder_id: 41, invoice_id: 'INV-41', customer_id: 7, salesperson: 'GA', status: 'Work Ordered',
  delivery_suburb: 'Altona North', delivery_state: 'VIC', estimated_completion: '2026-10-24', notes: 'Paint frame',
  outstanding_balance: '1795.00', delivery_charged: '150', installation_cost: '80', cash_to_removalist: true,
  free_delivery: false, delivery_type: 'Standard', important_flag: false, ecommerce: false,
  customer_name: 'Dana Customer', customer_email: 'dana@example.com', customer_phone: '0400 000 000',
};
const ITEMS = [
  { workorder_items_id: 2001, workorder_id: 41, product_id: 'LF-95X', product_name: 'Life Fitness 95X', quantity: 1, condition: 'Refurbished', technician_id: 'ED', status: 'In Workshop', item_sn: 'SN1', is_custom: false, selling_price: '4995' },
];
const LOGS = [
  { id: 1, event_type: 'PAYMENT_UPDATED', notes_log: 'Balance 1795 → 0', user_id: 'GA' },
  { id: 2, event_type: 'NOTE_ADDED', notes_log: 'Paint frame', user_id: 'GA' },
];

// One fake that answers the handler's queries by pattern and records every statement.
function fakeClient({ wo = WO, items = ITEMS, list = [WO], deliveries = null, itemStatus = { 2001: 'In Workshop' } } = {}) {
  const log = [];
  const client = {
    log, released: false,
    async query(sql, params = []) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      log.push({ sql: text, params });
      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(text)) return { rows: [], rowCount: 0 };
      if (/FROM users u LEFT JOIN user_roles/i.test(text)) {
        const u = USERS[params[0]];
        return { rows: u ? [{ access: u.access, roles: u.roles }] : [], rowCount: u ? 1 : 0 };
      }
      if (/SELECT access FROM users WHERE id/i.test(text)) {
        const u = USERS[params[0]];
        return { rows: u ? [{ access: u.access }] : [], rowCount: u ? 1 : 0 };
      }
      // G17 review: the pre-transaction check of the items a workshop login is changing.
      if (/SELECT workorder_items_id, status FROM workorder_items WHERE workorder_id = \$1 AND workorder_items_id = ANY/i.test(text)) {
        const rows = params[1].filter((x) => x in itemStatus).map((x) => ({ workorder_items_id: x, status: itemStatus[x] }));
        return { rows, rowCount: rows.length };
      }
      if (/^SELECT status FROM workorder WHERE workorder_id = \$1$/i.test(text)) return { rows: wo ? [{ status: wo.status }] : [], rowCount: wo ? 1 : 0 };
      if (/WITH base AS/i.test(text)) return { rows: wo ? [{ ...wo }] : [], rowCount: wo ? 1 : 0 };
      if (/FROM workorder_items wi LEFT JOIN product p ON p\.sku = wi\.product_id WHERE wi\.workorder_id = \$1/i.test(text)) {
        return { rows: items.map((i) => ({ ...i })), rowCount: items.length };
      }
      if (/FROM workorder_logs l/i.test(text)) return { rows: LOGS.map((l) => ({ ...l })), rowCount: LOGS.length };
      if (/SELECT \* FROM workorder WHERE workorder_id/i.test(text)) return { rows: [{ ...wo }], rowCount: 1 };
      if (/FROM workorder wo/i.test(text) && /GROUP BY/i.test(text)) {
        return { rows: list.map((r) => ({ ...r, items: ITEMS.map((i) => ({ ...i })) })), rowCount: list.length };
      }
      if (/FROM delivery d/i.test(text) && deliveries) return { rows: deliveries.map((d) => ({ ...d })), rowCount: deliveries.length };
      if (/COUNT\(\*\) FILTER/i.test(text)) return { rows: [{ done: '0', total: '1' }], rowCount: 1 };
      if (/SELECT workorder_items_id, status, technician_id, in_workshop/i.test(text)) {
        return { rows: [{ ...ITEMS[0] }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() { client.released = true; },
  };
  return client;
}
function fakeRes() {
  const res = { statusCode: null, payload: null, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.payload = p; return res; };
  res.end = () => res;
  res.setHeader = (k, v) => { res.headers[k] = v; };
  return res;
}
async function wo(req, clientOpts) {
  const client = fakeClient(clientOpts);
  const res = fakeRes();
  await workorderHandler(req, res, [], { getClient: async () => client });
  return { client, res };
}
async function dl(req, clientOpts) {
  const client = fakeClient(clientOpts);
  const res = fakeRes();
  await deliveryHandler(req, res, [], { getClient: async () => client });
  return { client, res };
}
const writes = (client) => client.log.filter((q) => /^(INSERT|UPDATE|DELETE)/i.test(q.sql));
const MONEY_AND_CONTACT = ['outstanding_balance', 'delivery_charged', 'installation_cost', 'cash_to_removalist', 'free_delivery', 'customer_id', 'customer_email', 'customer_phone', 'selling_price', 'custom_unit_price', 'delivery_quoted'];
const leaked = (obj) => MONEY_AND_CONTACT.filter((k) => JSON.stringify(obj).includes(`"${k}"`));

console.log('G17 workshop lockdown smoke — fake clients, no DB\n');

console.log('who is restricted:');
check('workshop roles = technician, workshop', WORKSHOP_ROLES.join() === 'technician,workshop');
check('full-access roles = superadmin, admin, logistics, sales, staff', FULL_ACCESS_ROLES.join() === 'superadmin,admin,logistics,sales,staff');
check('the WK kiosk account id', WORKSHOP_ACCOUNT_ID === 'WK');
check('technician → restricted', isWorkshopRestricted({ id: 'ED', roles: ['technician'] }));
check('workshop role → restricted', isWorkshopRestricted({ id: 'WS', roles: ['workshop'] }));
check('WK (an admin login) → restricted by id', isWorkshopRestricted({ id: 'WK', roles: ['admin'] }) && isWorkshopRestricted({ id: 'wk', roles: [] }));
check('technician who is also logistics → full access', !isWorkshopRestricted({ id: 'MX', roles: ['technician', 'logistics'] }));
for (const r of ['admin', 'superadmin', 'staff', 'sales', 'logistics']) check(`${r} → full access`, !isWorkshopRestricted({ id: 'GA', roles: [r] }));
check('nobody (no id, no roles) → not restricted by this rule', !isWorkshopRestricted({}));
check('item statuses a workshop login may set', WORKSHOP_ITEM_STATUSES.join() === 'Not in Workshop,In Workshop,Completed');
check('client mirror matches the server', JSON.stringify(clientAccess.WORKSHOP_ROLES) === JSON.stringify(WORKSHOP_ROLES)
  && JSON.stringify(clientAccess.FULL_ACCESS_ROLES) === JSON.stringify(FULL_ACCESS_ROLES)
  && clientAccess.WORKSHOP_ACCOUNT_ID === WORKSHOP_ACCOUNT_ID
  && JSON.stringify(clientAccess.WORKSHOP_ITEM_STATUSES) === JSON.stringify(WORKSHOP_ITEM_STATUSES));
check('client rule: WK by stored user id', clientAccess.isWorkshopRestricted({ id: 'WK', access: 'admin' }, ['admin']) && !clientAccess.isWorkshopRestricted({ id: 'GA', access: 'admin' }, ['admin']));

console.log('\nresolving the caller:');
{
  const c = fakeClient();
  check('technician token → restricted', (await resolveWorkshopActor(reqAs({ id: 'ED', roles: ['technician'], header: false }), c)).restricted);
  check('…without a DB lookup', c.log.length === 0);
  check('technician by X-User-Id only (no token) → restricted', (await resolveWorkshopActor(reqAs({ id: 'ED', roles: [], tokenToo: false }), fakeClient())).restricted);
  check('technician by body.user_id → restricted', (await resolveWorkshopActor({ method: 'PUT', headers: {}, query: {}, body: { user_id: 'TB' } }, fakeClient())).restricted);
  check('expired kiosk token + X-User-Id WK → STILL restricted', (await resolveWorkshopActor(reqAs({ id: 'WK', roles: ['admin'], expired: true }), fakeClient())).restricted);
  check('admin token + header → not restricted', !(await resolveWorkshopActor(reqAs({ id: 'GA', roles: ['admin'] }), fakeClient())).restricted);
  check('admin token but X-User-Id of a technician → restricted (either says so)', (await resolveWorkshopActor({ method: 'GET', query: {}, body: {}, headers: { authorization: `Bearer ${token('GA', ['admin'])}`, 'x-user-id': 'ED' } }, fakeClient())).restricted);
  check('multi-role technician + logistics by header → not restricted', !(await resolveWorkshopActor(reqAs({ id: 'MX', roles: [], tokenToo: false }), fakeClient())).restricted);
  check('unknown claimed id → not restricted (no record to restrict)', !(await resolveWorkshopActor(reqAs({ id: 'ZZ', roles: [], tokenToo: false }), fakeClient())).restricted);
  const noRolesTable = {
    log: [],
    async query(sql, params) {
      this.log.push(sql);
      if (/user_roles/.test(sql)) throw Object.assign(new Error('relation "user_roles" does not exist'), { code: '42P01' });
      if (/SELECT access FROM users WHERE id = \$1/.test(sql)) return { rows: [{ access: USERS[params[0]]?.access }] };
      return { rows: [] };
    },
  };
  check('no user_roles table (42P01) → falls back to users.access', (await resolveWorkshopActor(reqAs({ id: 'ED', roles: [], tokenToo: false }), noRolesTable)).restricted);
  check('no identity at all → not restricted (today\'s open behaviour, proposal P7)', !(await resolveWorkshopActor({ method: 'GET', headers: {}, query: {}, body: {} }, fakeClient())).restricted);
}

console.log('\nworkorder reads:');
{
  const { res } = await wo(reqAs({ id: 'ED', roles: ['technician'], query: { id: '41' } }));
  check('technician gets the workorder', res.statusCode === 200 && res.payload.workorder_id === 41);
  check('…with customer name + suburb/state, salesperson, target, notes', res.payload.customer_name === 'Dana Customer' && res.payload.delivery_suburb === 'Altona North' && res.payload.delivery_state === 'VIC' && res.payload.salesperson === 'GA' && res.payload.estimated_completion === '2026-10-24' && res.payload.notes === 'Paint frame');
  check('…and NO balance, delivery money or customer contact anywhere', leaked(res.payload).length === 0, leaked(res.payload).join(', '));
  check('…items still carry status + serial', res.payload.items[0].status === 'In Workshop' && res.payload.items[0].item_sn === 'SN1');
  const pay = res.payload.activity.find((l) => l.event_type === 'PAYMENT_UPDATED');
  check('…payment log rows keep the event but lose any note text', pay && pay.notes_log === null);
  check('…other log notes are kept', res.payload.activity.find((l) => l.event_type === 'NOTE_ADDED').notes_log === 'Paint frame');
}
{
  const { res } = await wo(reqAs({ id: 'WK', roles: ['admin'], expired: true, query: { id: '41' } }));
  check('WK with an expired token is still redacted', res.statusCode === 200 && leaked(res.payload).length === 0);
}
{
  const { res } = await wo(reqAs({ id: 'GA', roles: ['admin'], query: { id: '41' } }));
  check('admin still sees the balance + contact (unchanged)', res.payload.outstanding_balance === '1795.00' && res.payload.customer_phone === '0400 000 000' && res.payload.customer_id === 7);
}
{
  const { res } = await wo(reqAs({ id: 'ED', roles: ['technician'], query: { status: 'Work Ordered' } }));
  check('workorder list for a technician: rows returned', Array.isArray(res.payload) && res.payload.length === 1);
  check('…with no money or contact fields', leaked(res.payload).length === 0, leaked(res.payload).join(', '));
  const admin = await wo(reqAs({ id: 'GA', roles: ['admin'], query: { status: 'Work Ordered' } }));
  check('…admin list unchanged', admin.res.payload[0].outstanding_balance === '1795.00');
}

console.log('\nworkorder saves:');
{
  const body = { items: [{ workorder_items_id: 2001, status: 'Completed', item_sn: 'SN-NEW' }] };
  const { res, client } = await wo(reqAs({ id: 'ED', roles: ['technician'], method: 'PUT', query: { id: '41' }, body }));
  check('technician may set item status + serial', res.statusCode === 200);
  check('…and it is committed', client.log.some((q) => q.sql === 'COMMIT'));
  check('…the re-read is redacted too', leaked(res.payload).length === 0);
}
for (const [name, body] of [
  ['salesperson', { salesperson: 'GS' }],
  ['target completion', { estimated_completion: '2026-12-01' }],
  ['outstanding balance', { outstanding_balance: 0 }],
  ['notes', { notes: 'x' }],
  ['important flag', { important_flag: true }],
  ['delivery charged', { delivery_charged: 0 }],
  ['delivery type', { delivery_type: 'Pickup' }],
  ['installation / cash / free delivery', { installation_cost: 0, cash_to_removalist: false, free_delivery: true }],
  ['reopen / status', { status: 'Completed' }],
  ['ecommerce check', { ecommerce: true }],
  ['adding products', { add_items: [{ product_id: 'X', quantity: 1 }] }],
  ['removing products', { delete_item_ids: [2001] }],
  ['cancelling an item', { items: [{ workorder_items_id: 2001, status: 'Canceled' }] }],
  ['reassigning the technician', { items: [{ workorder_items_id: 2001, technician_id: 'TB' }] }],
  ['an item selling price', { items: [{ workorder_items_id: 2001, selling_price: 1 }] }],
]) {
  const { res, client } = await wo(reqAs({ id: 'ED', roles: ['technician'], method: 'PUT', query: { id: '41' }, body }));
  check(`403 for ${name} — before any write or transaction`, res.statusCode === 403 && writes(client).length === 0 && !client.log.some((q) => q.sql === 'BEGIN'), JSON.stringify(res.payload));
}
{
  const { res } = await wo(reqAs({ id: 'ED', roles: ['technician'], method: 'PUT', query: { id: '41' }, body: { salesperson: 'GS', notes: 'x' } }));
  check('the 403 names what was refused', /salesperson/.test(res.payload.error) && /notes/.test(res.payload.error));
}
{
  const { res } = await wo(reqAs({ id: 'WK', roles: ['admin'], method: 'PUT', query: { id: '41' }, body: { salesperson: 'GS' } }));
  check('WK cannot change the salesperson either', res.statusCode === 403);
  const okWk = await wo(reqAs({ id: 'WK', roles: ['admin'], method: 'PUT', query: { id: '41' }, body: { items: [{ workorder_items_id: 2001, status: 'In Workshop' }] } }));
  check('…but can move an item into the workshop', okWk.res.statusCode === 200);
}
{
  const { res } = await wo(reqAs({ id: 'GA', roles: ['admin'], method: 'PUT', query: { id: '41' }, body: { salesperson: 'GS', notes: 'x' } }));
  check('admin can still change salesperson + notes (unchanged)', res.statusCode === 200);
}
console.log('\nreview fixes (19 Oct 2026):');
{
  // Finding 2: a cancelled item may not be brought back (that re-adds a product + takes stock).
  const r = await wo(reqAs({ id: 'ED', roles: ['technician'], method: 'PUT', query: { id: '41' }, body: { items: [{ workorder_items_id: 2001, status: 'Not in Workshop' }] } }), { itemStatus: { 2001: 'Canceled' } });
  check('reviving a Canceled item → 403, before any write or transaction', r.res.statusCode === 403 && writes(r.client).length === 0 && !r.client.log.some((q) => q.sql === 'BEGIN'), JSON.stringify(r.res.payload));
  const r2 = await wo(reqAs({ id: 'ED', roles: ['technician'], method: 'PUT', query: { id: '41' }, body: { items: [{ workorder_items_id: 9999, status: 'Completed' }] } }));
  check('an item that is not on this workorder → 403', r2.res.statusCode === 403 && writes(r2.client).length === 0);
  // Finding 3: changing items on a COMPLETED workorder re-triggers delivery creation.
  const r3 = await wo(reqAs({ id: 'WK', roles: ['admin'], method: 'PUT', query: { id: '41' }, body: { items: [{ workorder_items_id: 2001, status: 'In Workshop' }] } }), { wo: { ...WO, status: 'Completed' } });
  check('item changes on a Completed workorder → 403 for workshop logins (no duplicate delivery)', r3.res.statusCode === 403 && writes(r3.client).length === 0 && /completed/i.test(r3.res.payload.error));
  const adminOnDone = await wo(reqAs({ id: 'GA', roles: ['admin'], method: 'PUT', query: { id: '41' }, body: { items: [{ workorder_items_id: 2001, status: 'In Workshop' }] } }), { wo: { ...WO, status: 'Completed' } });
  check('…admins are unaffected', adminOnDone.res.statusCode === 200);
  // Log attribution: a technician's token decides who the change is logged as.
  const r4 = await wo(reqAs({ id: 'ED', roles: ['technician'], header: false, method: 'PUT', query: { id: '41' }, body: { user_id: 'GA', items: [{ workorder_items_id: 2001, status: 'Completed' }] } }));
  const logged = r4.client.log.filter((q) => /INSERT INTO workorder_logs/i.test(q.sql)).map((q) => q.params[3]);
  check('changes by a technician token are logged as that technician, not a claimed id', r4.res.statusCode === 200 && logged.length > 0 && logged.every((u) => u === 'ED'), JSON.stringify(logged));
  // Minor: the ?payment= filter would reveal who has paid.
  const r5 = await wo(reqAs({ id: 'ED', roles: ['technician'], query: { status: 'Work Ordered', payment: 'due' } }));
  check('?payment= filter is ignored for workshop logins', !r5.client.log.some((q) => /outstanding_balance\s*[>=]/.test(q.sql)));
  const r6 = await wo(reqAs({ id: 'GA', roles: ['admin'], query: { status: 'Work Ordered', payment: 'due' } }));
  check('…and still works for admins', r6.client.log.some((q) => /outstanding_balance > 0/.test(q.sql)));
  // Minor: delivery notes are written by logistics and can hold contact / access details.
  check('delivery notes are redacted', !('notes' in access.redactDelivery({ notes: 'Call 0400…', delivery_id: 1 })));
  // Finding 1: the waitlist carries customer email + phone.
  const src = read('../api/[...path].js');
  const wl = src.slice(src.indexOf('async function handleWaitlist'));
  check('handleWaitlist refuses workshop logins before anything else', /refuseWorkshop\(/.test(wl) && wl.indexOf('refuseWorkshop(') < wl.indexOf("if (method === 'GET')"));
}

check('workshopPutViolations: allowed body → none', workshopPutViolations({ user_id: 'ED', items: [{ workorder_items_id: 1, status: 'In Workshop', item_sn: 'A' }] }).length === 0);
check('workshopPutViolations: empty body → none', workshopPutViolations({}).length === 0 && workshopPutViolations(null).length === 0);
check('workshopPutViolations: items not an array → refused', workshopPutViolations({ items: 'x' }).length > 0);
{
  const post = await wo(reqAs({ id: 'ED', roles: ['technician'], method: 'POST', body: { customer_id: 7 } }));
  check('technician cannot create a workorder', post.res.statusCode === 403 && writes(post.client).length === 0);
  const del = await wo(reqAs({ id: 'TB', roles: ['technician'], method: 'DELETE', query: { id: '41' } }));
  check('technician cannot delete a workorder', del.res.statusCode === 403 && writes(del.client).length === 0);
  const techList = await wo(reqAs({ id: 'ED', roles: ['technician'], query: { technicians: '1' } }));
  check('the technicians list still loads', techList.res.statusCode === 200);
}

console.log('\ndeliveries:');
{
  const D = { delivery_id: 9, workorder_id: 41, invoice_id: 'INV-41', customer_id: 7, customer_name: 'Dana Customer', customer_email: 'dana@example.com', customer_phone: '0400', delivery_suburb: 'Altona North', delivery_state: 'VIC', delivery_charged: '150', delivery_quoted: '150', installation_cost: '0', cash_to_removalist: false, free_delivery: false, outstanding_balance: '0', delivery_status: 'Booked for Delivery', items_text: '1 × 95X' };
  const list = await dl(reqAs({ id: 'ED', roles: ['technician'] }), { deliveries: [D] });
  check('delivery list for a technician: no money or contact', list.res.statusCode === 200 && leaked(list.res.payload).length === 0, leaked(list.res.payload).join(', '));
  check('…still shows name, suburb, status, items', list.res.payload[0].customer_name === 'Dana Customer' && list.res.payload[0].items_text === '1 × 95X');
  const one = await dl(reqAs({ id: 'WK', roles: ['admin'], query: { id: '9' } }), { deliveries: [D] });
  check('single delivery for WK: no money or contact', one.res.statusCode === 200 && leaked(one.res.payload).length === 0);
  const admin = await dl(reqAs({ id: 'GA', roles: ['admin'] }), { deliveries: [D] });
  check('admin delivery list unchanged', admin.res.payload[0].outstanding_balance === '0' && admin.res.payload[0].delivery_charged === '150');
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const r = await dl(reqAs({ id: 'ED', roles: ['technician'], method, query: { id: '9' }, body: { delivery_status: 'Delivery Completed' } }), { deliveries: [D] });
    check(`technician ${method} on a delivery → 403, nothing written`, r.res.statusCode === 403 && writes(r.client).length === 0);
  }
}

console.log('\ncustomers:');
{
  const c = fakeClient();
  const res = fakeRes();
  const refused = await refuseWorkshop(reqAs({ id: 'ED', roles: ['technician'] }), res, c, 'Customer details are not available to workshop logins');
  check('refuseWorkshop answers 403 for a technician', refused === true && res.statusCode === 403 && /Customer details/.test(res.payload.error));
  const res2 = fakeRes();
  check('…and lets an admin through untouched', (await refuseWorkshop(reqAs({ id: 'GA', roles: ['admin'] }), res2, fakeClient(), 'x')) === false && res2.statusCode === null);
  const src = read('../api/[...path].js');
  const fn = src.slice(src.indexOf('async function handleCustomers'));
  check('handleCustomers refuses workshop logins before anything else (incl. the journey)', /refuseWorkshop\(/.test(fn) && fn.indexOf('refuseWorkshop(') < fn.indexOf('wantsJourney'));
}

console.log('\nWK loses the admin-only extras:');
{
  const wkReq = (method, query, body = {}) => ({ method, query, body, headers: { authorization: `Bearer ${token('WK', ['admin'])}` } });
  const { handleLotJourney } = await import('../lib/lotJourney.js');
  const r1 = fakeRes();
  await handleLotJourney(wkReq('GET', { resource: 'journey', lot_number: 'L00001' }), r1, fakeClient());
  check('Lot Tracker → 403 for WK', r1.statusCode === 403);
  const { handleBoardNotes } = await import('../lib/deliveryBoardNotes.js');
  const r2 = fakeRes();
  await handleBoardNotes(wkReq('PUT', { resource: 'board-notes' }, { body: 'x', base_version: 0 }), r2, fakeClient());
  check('board-note edit → 403 for WK', r2.statusCode === 403);
  const runOrder = read('../lib/deliveryRunOrder.js');
  check('run-order save refuses workshop logins', /isWorkshopRestricted\(gate\.auth\)/.test(runOrder));
  const logistics = read('../lib/handlers/logistics.js');
  check('Temp Run refuses workshop logins', /isWorkshopRestricted\(/.test(logistics));
  const r3 = fakeRes();
  await handleLotJourney({ method: 'GET', query: { resource: 'journey', lot_number: 'L00001' }, body: {}, headers: { authorization: `Bearer ${token('GA', ['admin'])}` } }, r3, fakeClient());
  check('…an ordinary admin still reaches the Lot Tracker gate (not 401/403)', r3.statusCode !== 403 && r3.statusCode !== 401);
}

console.log(`\n✅ G17 workshop lockdown smoke: ${passed} checks passed`);
