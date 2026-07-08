// scripts/podium-contact-smoke.mjs — offline smoke for the F4 contact↔customer bridge.
//
// Exercises the pure/mock-safe logic added in F4: the lib/podiumContact.js helpers
// (normalizeContact, phoneKey, matchCustomer, linkContactToCustomer,
// createCustomerFromContact, open workorders/deliveries/lead, buildCustomerPanel) with
// INJECTED fake pg clients + the mock Podium service, plus the lib/podiumRoutes/contact.js
// auth/validation gates that run BEFORE any DB access. NO network, NO database, NO secrets:
//
//   node scripts/podium-contact-smoke.mjs
//
// The DB-touching happy paths (real match/create/link + 360 gather) are validated
// separately against the Neon dev branch — see the F4 report. getClientWithTimezone()'s
// pool is lazy, so importing the endpoint here opens no connection while we only hit its
// pre-DB branches.

process.env.PODIUM_MOCK = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'smoke_secret';
process.env.PODIUM_API_VERSION = process.env.PODIUM_API_VERSION || '2021-04-01';

const jwt = (await import('jsonwebtoken')).default;
const C = await import('../lib/podiumContact.js');
const contactHandler = (await import('../lib/podiumRoutes/contact.js')).default;

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ---- Fake pg client: records queries, returns the first matching scripted result ----
function makeClient(scripts = []) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const s of scripts) {
        if (typeof s.match === 'function' ? s.match(sql) : true) {
          if (s.throws) throw s.throws;
          return s.result ?? { rowCount: 0, rows: [] };
        }
      }
      return { rowCount: 0, rows: [] };
    },
  };
}
function pgErr(code) { const e = new Error(code); e.code = code; return e; }

// ---- req/res doubles (Vercel Node handler shape) ------------------------------
function makeReq({ method = 'GET', roles = ['sales'], id = 'AM', email = 'amelia@graysfitness.com.au', query = {}, body = {}, noAuth = false } = {}) {
  const headers = {};
  if (!noAuth) headers.authorization = `Bearer ${jwt.sign({ id, email, roles }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
  return { method, headers, query, body };
}
function makeRes() {
  return {
    statusCode: 0, body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
  };
}

// Query matchers
const isSelPodium = (s) => /FROM customers WHERE podium_contact_id = \$1/.test(s);
const isSelEmail = (s) => /WHERE LOWER\(email\) = \$1/.test(s);
const isSelPhone = (s) => /right\(regexp_replace\(phone/.test(s);
const isLinkUpd = (s) => /UPDATE customers SET podium_contact_id/.test(s);
const isInsCust = (s) => /INSERT INTO customers/.test(s);
const isSelWO = (s) => /FROM workorder\b/.test(s);
const isSelDel = (s) => /FROM delivery\b/.test(s);
const isSelLead = (s) => /FROM leads\b/.test(s);

const CUST = { id: 7, name: 'Maria Papadopoulos', email: 'maria@example.com', phone: '+61400111222', address: null, notes: null, podium_contact_id: null, myob_uid: null, woo_customer_id: null };

console.log('Podium contact↔customer bridge (F4) smoke (PODIUM_MOCK=true)\n');

// 1. phoneKey — last-8-digits, format-agnostic
check('phoneKey: strips formatting to last 8', C.phoneKey('+61 400 111 222') === '00111222');
check('phoneKey: short numbers pass through', C.phoneKey('12345') === '12345');
check('phoneKey: empty → empty', C.phoneKey(null) === '');

// 2. normalizeContact — maps Podium fields → compact shape
{
  const n = C.normalizeContact({ uid: 'pod_con_x', name: 'X', phoneNumber: '+61400999888', email: 'x@e.com', channels: ['phone'] });
  check('normalizeContact: maps phoneNumber→phone', n.phone === '+61400999888');
  check('normalizeContact: carries uid/name/email', n.uid === 'pod_con_x' && n.name === 'X' && n.email === 'x@e.com');
  check('normalizeContact: null when nothing given', C.normalizeContact(null) === null);
}

// 3. resolveContact — conversation → contact.uid → getContact (mock)
{
  const contact = await C.resolveContact('AM', { conversationId: 'pod_cnv_00001', client: makeClient() });
  check('resolveContact: resolves the mock conversation contact', contact?.uid === 'pod_con_maRIA1', `got ${contact?.uid}`);
  check('resolveContact: pulls email from the Contacts API', contact?.email === 'maria@example.com');
}
{
  const contact = await C.resolveContact('AM', { contactId: 'pod_con_jaKE44', client: makeClient() });
  check('resolveContact: direct contactId path', contact?.uid === 'pod_con_jaKE44' && contact?.name === 'Jake Wilson');
}

// 4. matchCustomer — tier 1: podium_contact_id
{
  const client = makeClient([{ match: isSelPodium, result: { rowCount: 1, rows: [{ ...CUST, podium_contact_id: 'pod_con_maRIA1' }] } }]);
  const { customer, matchedBy } = await C.matchCustomer(client, { uid: 'pod_con_maRIA1', email: 'maria@example.com' });
  check('match: tier1 podium_contact_id hit', matchedBy === 'podium_contact_id' && customer.id === 7);
  check('match: tier1 stops after one query', client.calls.length === 1);
}
// 4b. matchCustomer — tier 2: email (podium miss → email hit)
{
  const client = makeClient([{ match: isSelEmail, result: { rowCount: 1, rows: [CUST] } }]);
  const { matchedBy } = await C.matchCustomer(client, { uid: 'pod_con_new', email: 'maria@example.com', phone: null });
  check('match: tier2 email hit after podium miss', matchedBy === 'email');
  check('match: tier2 issued podium+email queries', client.calls.length === 2);
}
// 4c. matchCustomer — tier 3: phone
{
  const client = makeClient([{ match: isSelPhone, result: { rowCount: 1, rows: [CUST] } }]);
  const { matchedBy } = await C.matchCustomer(client, { uid: 'pod_con_new', email: null, phone: '+61400111222' });
  check('match: tier3 phone hit', matchedBy === 'phone');
  const phoneCall = client.calls.find((c) => isSelPhone(c.sql));
  check('match: tier3 uses last-8-digits param', phoneCall && phoneCall.params[0] === '00111222');
}
// 4d. matchCustomer — none
{
  const { customer, matchedBy } = await C.matchCustomer(makeClient(), { uid: 'x', email: 'nobody@nowhere.com', phone: '+61000000000' });
  check('match: none when no tier hits', customer === null && matchedBy === 'none');
}

// 5. linkContactToCustomer — only writes when slot empty
{
  const client = makeClient([{ match: isLinkUpd, result: { rowCount: 1 } }]);
  const linked = await C.linkContactToCustomer(client, 7, 'pod_con_maRIA1');
  const call = client.calls.find((c) => isLinkUpd(c.sql));
  check('link: returns true when a row was written', linked === true);
  check('link: guards against clobber (WHERE ... IS NULL/empty)', /podium_contact_id IS NULL OR podium_contact_id = ''/.test(call.sql));
  check('link: no-op params guard (missing ids → false, no query)', (await C.linkContactToCustomer(makeClient(), null, 'x')) === false);
}

// 6. createCustomerFromContact — email required; success path
{
  let threw = null;
  try { await C.createCustomerFromContact(makeClient(), { uid: 'pod_con_liNDA3', name: 'Linda', email: null }); }
  catch (e) { threw = e; }
  check('create: throws EMAIL_REQUIRED when no email anywhere', threw?.code === 'EMAIL_REQUIRED');
}
{
  const client = makeClient([{ match: isInsCust, result: { rowCount: 1, rows: [{ ...CUST, id: 42, podium_contact_id: 'pod_con_liNDA3', email: 'linda@new.com' }] } }]);
  const created = await C.createCustomerFromContact(client, { uid: 'pod_con_liNDA3', name: 'Linda', email: null }, { email: 'linda@new.com' });
  const call = client.calls.find((c) => isInsCust(c.sql));
  check('create: overrides supply the missing email', created.id === 42 && created.email === 'linda@new.com');
  check('create: INSERT sets podium_contact_id from the contact', call.params[4] === 'pod_con_liNDA3');
  check('create: name defaults from the contact', call.params[0] === 'Linda');
}

// 7. open workorders / active deliveries — filter to not-yet-done
{
  const client = makeClient([{ match: isSelWO, result: { rowCount: 1, rows: [{ workorder_id: 100, status: 'In Workshop' }] } }]);
  const wo = await C.openWorkordersForCustomer(client, 7);
  const call = client.calls.find((c) => isSelWO(c.sql));
  check('workorders: returns rows', wo.length === 1 && wo[0].workorder_id === 100);
  check("workorders: excludes Completed (status <> 'Completed')", /status <> 'Completed'/.test(call.sql));
  check('workorders: empty for no customer', (await C.openWorkordersForCustomer(client, null)).length === 0);
}
{
  const client = makeClient([{ match: isSelDel, result: { rowCount: 1, rows: [{ delivery_id: 200, delivery_status: 'To Be Booked' }] } }]);
  const del = await C.activeDeliveriesForCustomer(client, 7);
  const call = client.calls.find((c) => isSelDel(c.sql));
  check('deliveries: returns rows', del.length === 1 && del[0].delivery_id === 200);
  check("deliveries: excludes 'Delivery Completed'", /delivery_status <> 'Delivery Completed'/.test(call.sql));
}

// 8. latestLeadFor — defensive against a DB without the leads table (42P01)
{
  const client = makeClient([{ match: isSelLead, result: { rowCount: 1, rows: [{ lead_id: 5, stage: 'Contacted' }] } }]);
  const lead = await C.latestLeadFor(client, { customerId: 7, contactUid: 'pod_con_maRIA1', conversationId: 'pod_cnv_00001' });
  check('lead: returns the latest lead', lead?.stage === 'Contacted');
}
{
  const client = makeClient([{ match: isSelLead, throws: pgErr('42P01') }]);
  const lead = await C.latestLeadFor(client, { customerId: 7 });
  check('lead: null (not throw) when leads table absent (42P01)', lead === null);
  check('lead: null with no identifiers, no query', (await C.latestLeadFor(makeClient(), {})) === null);
}

// 9. buildCustomerPanel — end-to-end (mock contact + fake DB): email match → backfill → 360
{
  const client = makeClient([
    { match: isSelPodium, result: { rowCount: 0, rows: [] } },              // no strong link yet
    { match: isSelEmail, result: { rowCount: 1, rows: [CUST] } },           // matched by email
    { match: isLinkUpd, result: { rowCount: 1 } },                          // backfilled the link
    { match: isSelWO, result: { rowCount: 1, rows: [{ workorder_id: 100, status: 'In Workshop' }] } },
    { match: isSelDel, result: { rowCount: 1, rows: [{ delivery_id: 200, delivery_status: 'To Be Booked' }] } },
    { match: isSelLead, result: { rowCount: 1, rows: [{ lead_id: 5, stage: 'Contacted' }] } },
  ]);
  const panel = await C.buildCustomerPanel(client, 'AM', { conversationId: 'pod_cnv_00001' });
  check('panel: contact resolved', panel.contact?.uid === 'pod_con_maRIA1');
  check('panel: matched by email', panel.matchedBy === 'email' && panel.customer?.id === 7);
  check('panel: backfilled the contact link', panel.linked === true && panel.customer.podium_contact_id === 'pod_con_maRIA1');
  check('panel: gathered open workorders', panel.workorders.length === 1);
  check('panel: gathered active deliveries', panel.deliveries.length === 1);
  check('panel: surfaced the open lead (funnel stage)', panel.lead?.stage === 'Contacted');
}
// 9b. buildCustomerPanel — unmatched contact → customer:null (UI offers "create")
{
  const client = makeClient(); // every SELECT returns 0 rows
  const panel = await C.buildCustomerPanel(client, 'AM', { conversationId: 'pod_cnv_00003' }); // Tom, unmatched
  check('panel: unmatched → customer null, matchedBy none', panel.customer === null && panel.matchedBy === 'none');
  check('panel: unmatched → empty 360 collections', panel.workorders.length === 0 && panel.deliveries.length === 0);
  check('panel: contact still resolved for the UI', panel.contact?.uid === 'pod_con_toMH20');
}

// 10. endpoint gates (all reached BEFORE any DB access → offline-safe)
{
  const res = makeRes();
  await contactHandler(makeReq({ noAuth: true }), res);
  check('endpoint: 401 when unauthenticated', res.statusCode === 401);
}
{
  const res = makeRes();
  await contactHandler(makeReq({ roles: ['technician'] }), res);
  check('endpoint: 403 without sales/superadmin', res.statusCode === 403);
}
{
  const res = makeRes();
  await contactHandler(makeReq({ method: 'DELETE', roles: ['sales'] }), res);
  check('endpoint: 405 on unsupported method', res.statusCode === 405);
}
{
  const res = makeRes();
  await contactHandler(makeReq({ method: 'GET', roles: ['sales'], query: {} }), res);
  check('endpoint: GET 400 without conversationId/contactId', res.statusCode === 400);
}
{
  const res = makeRes();
  await contactHandler(makeReq({ method: 'POST', roles: ['superadmin'], body: { action: 'link' } }), res);
  check('endpoint: POST 400 without conversationId/contactId', res.statusCode === 400);
}
{
  const res = makeRes();
  await contactHandler(makeReq({ method: 'POST', roles: ['sales'], body: { conversationId: 'pod_cnv_00001', action: 'frobnicate' } }), res);
  check('endpoint: POST 400 on invalid action', res.statusCode === 400);
}

console.log(`\nAll ${passed} checks passed ✅`);
