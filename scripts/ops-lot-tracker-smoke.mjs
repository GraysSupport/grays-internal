// scripts/ops-lot-tracker-smoke.mjs — offline smoke for G11 (Nick, 1 Oct 2026): the Lot Tracker.
//
//   GET /api/lots?resource=journey&lot_number=L00042   admin + superadmin — one lot's journey
//   GET /api/lots?resource=journey-search&q=…          admin + superadmin — find lots
//
// Exercises lib/lotJourney.js with a fake pg client. The tracker is READ-ONLY and must stay
// separate from the PUBLIC lookup (GET /api/lots?lot_number=), which shows no customer data.
//
//   node scripts/ops-lot-tracker-smoke.mjs

process.env.JWT_SECRET = process.env.JWT_SECRET || 'smoke_secret';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const jwt = (await import('jsonwebtoken')).default;
const { handleLotJourney, LOT_TRACKER_ROLES, LOT_SEARCH_LIMIT } = await import('../lib/lotJourney.js');

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const LOT_ROW = {
  lot_id: 1, lot_number: 'L00001', product_sku: '2609', status: 'Assigned', serial_number: null, unit_cost: '450.00',
  collection_id: 12, workorder_items_id: 2001, created_by: 'GS', created_at: new Date('2026-07-10T02:00:00Z'), updated_at: new Date('2026-08-18T04:00:00Z'),
  created_by_name: 'Nick Enrique Wijaya', product_name: 'Life Fitness 95T Treadmill', product_brand: 'Life Fitness',
  collection_name: 'Anytime Fitness Geelong', collection_suburb: 'Geelong', collection_state: 'VIC',
  collection_description: 'Full gym strip-out', collection_notes: 'Rear dock', collection_date: '2026-07-10', collection_status: 'Completed',
  collection_carrier: 'Nelson Removals',
  workorder_id: 883, item_status: 'Completed', item_condition: 'Refurbished', technician_id: 'ED', technician_name: 'Eden',
  in_workshop: new Date('2026-08-18T04:54:01Z'), item_sn: 'SN-12345',
  invoice_id: 'INV-883', workorder_status: 'Completed', workorder_created: new Date('2026-08-18T03:00:00Z'),
  salesperson: 'GS', delivery_suburb: 'Altona North', delivery_state: 'VIC', customer_id: 26, customer_name: 'Dana Customer',
};
const LOGS = [
  { id: 1, event_type: 'WORKORDER_CREATED', item_status: null, user_id: 'GS', created_at: new Date('2026-08-18T03:00:00Z'), user_name: 'Nick Enrique Wijaya' },
  { id: 2, event_type: 'ITEM_STATUS_CHANGED', item_status: 'In Workshop', user_id: 'ED', created_at: new Date('2026-08-18T04:54:00Z'), user_name: 'Eden' },
  { id: 3, event_type: 'ITEM_STATUS_CHANGED', item_status: 'Completed', user_id: 'ED', created_at: new Date('2026-08-19T01:00:00Z'), user_name: 'Eden' },
  { id: 4, event_type: 'DELIVERY_BOOKED', item_status: null, user_id: 'GL', created_at: new Date('2026-08-19T02:00:00Z'), user_name: 'Shaun Cronin' },
  { id: 5, event_type: 'ORDER_DISPATCHED', item_status: null, user_id: 'GL', created_at: new Date('2026-08-25T00:30:00Z'), user_name: 'Shaun Cronin' },
];
const DELIVERIES = [
  { delivery_id: 700, delivery_date: '2026-08-21', delivery_status: 'Delivery Completed', delivery_type: 'Delivery', delivery_suburb: 'Altona North', delivery_state: 'VIC', date_created: new Date('2026-08-18T05:00:00Z'), carrier: 'Cobbs Transport' },
];

function makeClient({ lot = LOT_ROW, logs = LOGS, deliveries = DELIVERIES, search = [] } = {}) {
  const calls = [];
  return {
    calls,
    async query(text, params = []) {
      calls.push({ text, params });
      const sql = text.replace(/\s+/g, ' ').trim();
      if (/FROM product_lots pl .* WHERE pl\.lot_number = \$1$/i.test(sql)) return { rows: lot && params[0] === lot.lot_number ? [lot] : [] };
      if (/FROM workorder_logs l/i.test(sql)) return { rows: logs };
      if (/FROM delivery d/i.test(sql)) return { rows: deliveries };
      if (/WHERE pl\.lot_number ILIKE \$1/i.test(sql)) return { rows: search };
      throw new Error(`unexpected SQL in smoke: ${sql.slice(0, 120)}`);
    },
  };
}
function makeReq({ method = 'GET', roles = ['admin'], query = { resource: 'journey', lot_number: 'L00001' }, noAuth = false } = {}) {
  const headers = {};
  if (!noAuth) headers.authorization = `Bearer ${jwt.sign({ id: 'GL', email: 'x@graysfitness.com.au', roles }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
  return { method, headers, query, body: {} };
}
function makeRes() {
  return {
    statusCode: 0, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
  };
}
async function run(client, reqOpts) {
  const res = makeRes();
  await handleLotJourney(makeReq(reqOpts), res, client);
  return res;
}
const isWrite = (c) => /\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/i.test(c.text);

console.log('G11 lot-tracker smoke — fake client, no DB\n');

console.log('who may use it — admin + superadmin only:');
check('roles = admin, superadmin', LOT_TRACKER_ROLES.join(',') === 'admin,superadmin');
{
  const client = makeClient();
  const res = await run(client, { noAuth: true });
  check('401 without a token — and no query ran', res.statusCode === 401 && client.calls.length === 0);
}
for (const role of ['logistics', 'technician', 'staff', 'sales', 'workshop']) {
  for (const resource of ['journey', 'journey-search']) {
    const client = makeClient();
    const res = await run(client, { roles: [role], query: { resource, lot_number: 'L00001', q: 'tread' } });
    check(`403 for ${role} on ${resource} — and no query ran`, res.statusCode === 403 && client.calls.length === 0);
  }
}
for (const role of LOT_TRACKER_ROLES) {
  const res = await run(makeClient(), { roles: [role] });
  check(`200 for ${role}`, res.statusCode === 200 && res.body.lot.lot_number === 'L00001');
}

console.log('\nthe journey Nick asked for:');
{
  const client = makeClient();
  const res = await run(client);
  const j = res.body;
  check('where it came from (extraction): job, place, date, carrier', j.origin.name === 'Anytime Fitness Geelong' && j.origin.suburb === 'Geelong' && j.origin.state === 'VIC' && j.origin.collection_date === '2026-07-10' && j.origin.carrier === 'Nelson Removals' && j.origin.description === 'Full gym strip-out');
  check('where it is assigned: workorder, invoice, customer', j.assignment.workorder_id === 883 && j.assignment.invoice_id === 'INV-883' && j.assignment.customer_name === 'Dana Customer');
  check('when it went to the workshop + who did it', j.workshop.in_workshop === '2026-08-18T04:54:01.000Z' && j.workshop.technician_id === 'ED' && j.workshop.technician_name === 'Eden' && j.workshop.item_status === 'Completed');
  check('the details: serial number (from the item when the lot has none)', j.lot.serial_number === 'SN-12345' && j.workshop.serial_number === 'SN-12345');
  check('when it was delivered + by who', j.deliveries.length === 1 && j.deliveries[0].delivery_date === '2026-08-21' && j.deliveries[0].carrier === 'Cobbs Transport' && j.deliveries[0].delivery_status === 'Delivery Completed');
  check('product', j.product.sku === '2609' && j.product.name === 'Life Fitness 95T Treadmill' && j.product.brand === 'Life Fitness');

  const titles = j.timeline.map((e) => e.title);
  check('timeline is oldest-first and reads as a story', titles.join(' > ') === [
    'Collected (extraction)', 'Lot number issued', 'Workorder created', 'Went into the workshop',
    'Workshop completed', 'Delivery booked', 'Delivered', 'Order dispatched',
  ].join(' > '), titles.join(' > '));
  const by = Object.fromEntries(j.timeline.map((e) => [e.title, e.by_name]));
  check('every step names who did it', by['Collected (extraction)'] === 'Nelson Removals' && by['Lot number issued'] === 'Nick Enrique Wijaya' && by['Went into the workshop'] === 'Eden' && by['Delivery booked'] === 'Shaun Cronin' && by['Delivered'] === 'Cobbs Transport');
  check('date-only steps are marked so the page does not invent a time', j.timeline.filter((e) => e.date_only).map((e) => e.title).join(',') === 'Collected (extraction),Delivered');

  check('exactly THREE statements, all SELECTs', client.calls.length === 3 && !client.calls.some(isWrite) && client.calls.every((c) => /^\s*SELECT/i.test(c.text)));
  check('the lot number is upper-cased and passed as a parameter', client.calls[0].params[0] === 'L00001');
  check('note text and payment/flag events are not pulled into the journey', !/notes_log/.test(client.calls[1].text) && !/PAYMENT_UPDATED|NOTE_ADDED|WORKORDER_FLAG_CHANGED/.test(client.calls[1].text));
}
{
  const res = await run(makeClient(), { query: { resource: 'journey', lot_number: '  l00001 ' } });
  check('a scanned/typed code is trimmed + upper-cased', res.statusCode === 200);
}

console.log('\ncost is superadmin-only:');
{
  const admin = await run(makeClient(), { roles: ['admin'] });
  check('admin: no unit_cost anywhere in the response', !JSON.stringify(admin.body).includes('unit_cost') && !JSON.stringify(admin.body).includes('450'));
  const sa = await run(makeClient(), { roles: ['superadmin'] });
  check('superadmin: unit_cost present', sa.body.lot.unit_cost === 450);
  check('no selling price / purchase price / avg cost is selected at all', !/selling_price|purchase_price|avg_cost|custom_unit_price/.test(readFileSync(fileURLToPath(new URL('../lib/lotJourney.js', import.meta.url)), 'utf8')));
}

console.log('\nlots that have not got that far yet:');
{
  const inStock = { ...LOT_ROW, status: 'In Stock', workorder_items_id: null, workorder_id: null, item_sn: null, technician_id: null, technician_name: null, in_workshop: null };
  const client = makeClient({ lot: inStock });
  const res = await run(client);
  check('In Stock lot: origin shown, no assignment / workshop / delivery', res.statusCode === 200 && res.body.origin && res.body.assignment === null && res.body.workshop === null && res.body.deliveries.length === 0);
  check('…and only ONE statement ran', client.calls.length === 1);
  check('…timeline = collected, lot issued', res.body.timeline.map((e) => e.title).join(',') === 'Collected (extraction),Lot number issued');
}
{
  const noOrigin = { ...LOT_ROW, collection_id: null, collection_name: null, collection_date: null, collection_carrier: null };
  const res = await run(makeClient({ lot: noOrigin }));
  check('a lot with no collection: origin is null, the rest still works', res.statusCode === 200 && res.body.origin === null && res.body.timeline[0].title === 'Lot number issued');
}
{
  const booked = [{ ...DELIVERIES[0], delivery_status: 'Booked for Delivery' }];
  const res = await run(makeClient({ deliveries: booked }));
  check('a delivery that is only booked is listed but NOT reported as "Delivered"', res.body.deliveries[0].delivery_status === 'Booked for Delivery' && !res.body.timeline.some((e) => e.title === 'Delivered'));
}

console.log('\nlookups that fail cleanly:');
{
  const client = makeClient();
  const res = await run(client, { query: { resource: 'journey', lot_number: 'L99999' } });
  check('404 for an unknown lot', res.statusCode === 404 && /L99999/.test(res.body.error));
  const none = await run(makeClient(), { query: { resource: 'journey' } });
  check('400 with no lot number', none.statusCode === 400);
  const long = makeClient();
  const longRes = await run(long, { query: { resource: 'journey', lot_number: 'L'.repeat(40) } });
  check('400 for something that is not a lot number — and no query ran', longRes.statusCode === 400 && long.calls.length === 0);
}
for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
  const client = makeClient();
  const res = await run(client, { method });
  check(`405 for ${method} — and no query ran`, res.statusCode === 405 && client.calls.length === 0);
}

console.log('\nsearch:');
{
  const hits = [{ lot_number: 'L00001', status: 'Assigned', product_sku: '2609', serial_number: null, product_name: 'Life Fitness 95T Treadmill', invoice_id: 'INV-883' }];
  const client = makeClient({ search: hits });
  const res = await run(client, { query: { resource: 'journey-search', q: ' tread ' } });
  check('returns matching lots', res.statusCode === 200 && res.body.results.length === 1 && res.body.limit === LOT_SEARCH_LIMIT);
  check('one SELECT, the text passed as a %…% parameter', client.calls.length === 1 && client.calls[0].params[0] === '%tread%' && !isWrite(client.calls[0]));
  check('searches lot number, serial (lot + item), SKU, product name, invoice', ['pl.lot_number', 'pl.serial_number', 'wi.item_sn', 'pl.product_sku', 'p.name', 'w.invoice_id'].every((c) => client.calls[0].text.includes(`${c} ILIKE $1`)));
  check('is capped', new RegExp(`LIMIT ${LOT_SEARCH_LIMIT}`).test(client.calls[0].text));
}
{
  const client = makeClient();
  await run(client, { query: { resource: 'journey-search', q: '50%_off' } });
  check('LIKE wildcards in the search text are escaped', client.calls[0].params[0] === '%50\\%\\_off%');
  const short = makeClient();
  const res = await run(short, { query: { resource: 'journey-search', q: 'a' } });
  check('400 for a 1-character search — and no query ran', res.statusCode === 400 && short.calls.length === 0);
  const long = makeClient();
  const res2 = await run(long, { query: { resource: 'journey-search', q: 'x'.repeat(61) } });
  check('400 for an over-long search — and no query ran', res2.statusCode === 400 && long.calls.length === 0);
}

console.log('\nwiring — and the public scan is left alone:');
{
  const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
  const handler = read('../lib/handlers/lots.js');
  const at = handler.indexOf('handleLotJourney(req, res, client)');
  check('lots handler routes resource=journey / journey-search to handleLotJourney', at > 0 && /resource === 'journey' \|\| resource === 'journey-search'/.test(handler));
  check('…BEFORE the public lot_number lookup', at < handler.indexOf('if (query.lot_number)'));
  const publicBlock = handler.slice(handler.indexOf('if (query.lot_number)'), handler.indexOf('if (query.collection_id)'));
  check('the public lookup still selects no customer, cost or technician data', !/cust\.|customer|unit_cost|technician|created_by/.test(publicBlock.replace(/\/\/.*$/gm, '')));
  const util = read('../src/utils/lotTracker.js');
  const clientRoles = /export const LOT_TRACKER_ROLES = \[([^\]]*)\]/.exec(util)?.[1].replace(/['\s]/g, '');
  check('client LOT_TRACKER_ROLES matches the server list', clientRoles === LOT_TRACKER_ROLES.join(','), clientRoles);
  const nav = read('../src/utils/nav.js');
  check('side panel has a Lot Tracker item gated on those roles', /key: 'lot-tracker', label: 'Lot Tracker', to: '\/lot-tracker'/.test(nav) && /hasAnyRole\(effectiveRoles, LOT_TRACKER_ROLES\)/.test(nav));
  check('the route exists', /path="\/lot-tracker"/.test(read('../src/App.js')));
}

console.log(`\n✅ G11 lot-tracker smoke: ${passed} checks passed`);
