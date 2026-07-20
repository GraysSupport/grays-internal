// scripts/podium-workorder-smoke.mjs — offline smoke for lib/handlers/workorder.js (F21).
//
// The workorder handler is the busiest write path in the portal (890 lines: inventory,
// per-item status, auto-completion, delivery creation, append-only logs) and until now it
// had ZERO test cover, because it built its own pg client and so could not be driven
// offline. F21 injects deps.getClient; this suite is what that buys.
//
// Its focus is the COMPLETION LOGIC — the part other features hang off (F6's Customer-360
// journey reads workorder_logs; F7c creates the shell; the scrapped F8c hung its review
// request here) and the part where the F8c review already found one real bug.
//
// These are CHARACTERIZATION tests: they pin down what the handler does TODAY, including
// the §4 inconsistency that F22 is a decision about. Where behaviour looks wrong, the test
// says so in its name rather than asserting the behaviour someone might prefer — F21 is a
// pure test-enablement refactor and must not change behaviour.
//
//   node scripts/podium-workorder-smoke.mjs

import handler from '../lib/handlers/workorder.js';

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// --- fakes ---------------------------------------------------------------------------
// A pg-shaped client that answers by SQL pattern and RECORDS every statement, so a test
// can assert on what the handler actually wrote (which log rows, which INSERTs) rather
// than only on the response body.
//
// KNOWN LIMITS of this fake (so nobody over-trusts a green run):
//  • ONE client object is shared with the recursive GET re-read, where production checks
//    out a second pool client — so a leak in that path is invisible here.
//  • Transactions are NOT modelled: ROLLBACK does not un-record statements. Asserting
//    "wrote nothing" is only meaningful when the ROLLBACK precedes every write, as it
//    does in the guard cases below.
//  • Unmatched SQL returns an empty result rather than failing, so a newly added query
//    will read as "no rows" instead of erroring.
function fakeClient({ workorder, itemCountsBefore, itemCountsAfter }) {
  const log = [];
  let countCalls = 0;
  const client = {
    log,
    released: false,
    async query(sql, params) {
      const text = String(sql);
      log.push({ sql: text.replace(/\s+/g, ' ').trim(), params });

      if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i.test(text)) return { rows: [], rowCount: 0 };
      if (/SELECT access FROM users/i.test(text)) return { rows: [{ access: 'staff' }], rowCount: 1 };
      if (/SELECT \* FROM workorder WHERE workorder_id/i.test(text)) {
        return workorder ? { rows: [workorder], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      // The same counts query runs before and after the item updates.
      if (/COUNT\(\*\) FILTER \(WHERE status = 'Completed'\)/i.test(text)) {
        countCalls += 1;
        const c = countCalls === 1 ? itemCountsBefore : itemCountsAfter;
        return { rows: [{ done: String(c.done), total: String(c.total) }], rowCount: 1 };
      }
      if (/SELECT status FROM workorder WHERE workorder_id/i.test(text)) {
        return { rows: [{ status: workorder?.status ?? null }], rowCount: workorder ? 1 : 0 };
      }
      // The PUT ends by re-reading the resource through the GET branch.
      if (/WITH base AS/i.test(text)) return { rows: [{ workorder_id: workorder.workorder_id }], rowCount: 1 };
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

const WO = {
  workorder_id: 41,
  invoice_id: 'INV-41',
  customer_id: 7,
  status: 'Work Ordered',
  outstanding_balance: 500,
  delivery_state: 'VIC',
  delivery_suburb: 'Altona North',
  delivery_charged: 150,
  notes: null,
  delivery_type: 'Standard',
  free_delivery: false,
  cash_to_removalist: false,
  installation_cost: null,
};

function events(client) {
  return client.log
    .filter((q) => /INSERT INTO workorder_logs/i.test(q.sql))
    .map((q) => q.params[2]);
}
function deliveryInserts(client) {
  return client.log.filter((q) => /INSERT INTO delivery/i.test(q.sql));
}

async function runPut(body, counts, wo = WO) {
  const client = fakeClient({
    workorder: { ...wo },
    itemCountsBefore: counts.before,
    itemCountsAfter: counts.after,
  });
  const req = { method: 'PUT', query: { id: '41' }, body, headers: { 'x-user-id': 'GA' } };
  const res = fakeRes();
  await handler(req, res, [], { getClient: async () => client });
  return { client, res };
}

console.log('F21 workorder handler smoke — no DB, no network\n');

console.log('dependency injection (the refactor itself):');
{
  const { client } = await runPut({ notes: 'hello' }, { before: { done: 0, total: 2 }, after: { done: 0, total: 2 } });
  check('the handler runs entirely against an injected client', client.log.length > 0);
  check('the injected client is released', client.released === true);
  check('work is committed, not left open', client.log.some((q) => /^COMMIT$/i.test(q.sql)));
  // If deps were dropped by the recursive GET re-read, that call would build a REAL pool
  // client and this suite would hit the network instead of failing loudly.
  check('the closing re-read also uses the injected client (deps survive recursion)',
    client.log.some((q) => /WITH base AS/i.test(q.sql)));
}

console.log('\nitem-driven completion (§3) — the normal workshop path:');
{
  const { client } = await runPut({}, { before: { done: 1, total: 2 }, after: { done: 2, total: 2 } });
  const ev = events(client);
  check('the workorder is auto-completed', client.log.some((q) => /UPDATE workorder SET status = 'Completed'/i.test(q.sql)));
  check('WORKORDER_COMPLETED is logged', ev.includes('WORKORDER_COMPLETED'));
  check('WORKORDER_STATUS_CHANGED is logged alongside it', ev.includes('WORKORDER_STATUS_CHANGED'));
  check('a delivery is created', deliveryInserts(client).length === 1);
  check('DELIVERY_ORDER_CREATED is logged', ev.includes('DELIVERY_ORDER_CREATED'));
  check('the delivery carries the workorder id', deliveryInserts(client)[0].params.includes(41));
}

console.log('\nalready-complete edit — must not fire the transition twice:');
{
  const { client } = await runPut({ notes: 'late note' },
    { before: { done: 2, total: 2 }, after: { done: 2, total: 2 } },
    { ...WO, status: 'Completed' });
  const ev = events(client);
  check('WORKORDER_COMPLETED is NOT logged again', !ev.includes('WORKORDER_COMPLETED'));
  check('no second delivery is created', deliveryInserts(client).length === 0);
}

console.log('\nexplicit completion (§4) — F22, characterized not corrected:');
{
  // status='Completed' set directly while items are NOT all complete.
  const { client } = await runPut({ status: 'Completed' },
    { before: { done: 0, total: 2 }, after: { done: 0, total: 2 } });
  const ev = events(client);
  check('the status IS applied', client.log.some((q) => /UPDATE workorder SET status = \$1/i.test(q.sql)));
  check('WORKORDER_STATUS_CHANGED is logged', ev.includes('WORKORDER_STATUS_CHANGED'));
  // ⚠️ Both of these are the F22 gap. They pass because they assert TODAY'S behaviour.
  check('⚠️ F22: WORKORDER_COMPLETED is NOT logged (journey under-reports)', !ev.includes('WORKORDER_COMPLETED'));
  check('⚠️ F22: NO delivery is created (a completed order never reaches To Be Booked)',
    deliveryInserts(client).length === 0);
}

console.log('\nexplicit completion WITH all items done — §3 covers for §4:');
{
  const { client } = await runPut({ status: 'Completed' },
    { before: { done: 1, total: 2 }, after: { done: 2, total: 2 } });
  const ev = events(client);
  check('WORKORDER_COMPLETED IS logged (via §3)', ev.includes('WORKORDER_COMPLETED'));
  check('a delivery IS created', deliveryInserts(client).length === 1);
}

console.log('\nexplicit completion as the SOLE cause of the delivery (§3 override):');
{
  // Items were ALREADY all complete before this request, so transitionedToCompletedViaItems
  // is false and `explicitCompletedNow` is the only thing that can create the delivery.
  // Without this case that override can be deleted with every other check still passing —
  // and it is precisely the branch F22's decision is about.
  const { client } = await runPut({ status: 'Completed' },
    { before: { done: 2, total: 2 }, after: { done: 2, total: 2 } },
    { ...WO, status: 'Work Ordered' });
  check('the explicit override alone creates the delivery', deliveryInserts(client).length === 1);
  check('DELIVERY_ORDER_CREATED is logged on that path', events(client).includes('DELIVERY_ORDER_CREATED'));
  // Characterization, same F22 family: §3 logs the status change, then §4's condition is
  // STILL true ('Completed' !== 'Work Ordered'), so it updates and logs a SECOND time.
  check('⚠️ F22: WORKORDER_STATUS_CHANGED is logged TWICE (§3 then §4)',
    events(client).filter((e) => e === 'WORKORDER_STATUS_CHANGED').length === 2);
}

console.log('\nempty workorder — the totalAfter > 0 guard:');
{
  // Cancelling the last item leaves done=0,total=0. Without the guard 0 === 0 reads as
  // "all complete", so an EMPTY workorder would auto-complete and drop a phantom delivery
  // into To Be Booked for logistics to try to book.
  const { client } = await runPut({}, { before: { done: 0, total: 1 }, after: { done: 0, total: 0 } });
  check('an empty workorder is NOT auto-completed',
    !client.log.some((q) => /UPDATE workorder SET status = 'Completed'/i.test(q.sql)));
  check('and creates no delivery', deliveryInserts(client).length === 0);
  check('and logs no completion', !events(client).includes('WORKORDER_COMPLETED'));
}

console.log('\nno-op status write — must not pollute the append-only log:');
{
  // Same status in as out. workorder_logs is append-only, so a spurious row can't be undone.
  const { client } = await runPut({ status: 'Work Ordered' },
    { before: { done: 0, total: 2 }, after: { done: 0, total: 2 } });
  check('no redundant UPDATE is issued', !client.log.some((q) => /UPDATE workorder SET status = \$1/i.test(q.sql)));
  check('no spurious WORKORDER_STATUS_CHANGED row', !events(client).includes('WORKORDER_STATUS_CHANGED'));
}

console.log('\nguards:');
{
  const client = fakeClient({ workorder: null, itemCountsBefore: { done: 0, total: 0 }, itemCountsAfter: { done: 0, total: 0 } });
  const res = fakeRes();
  await handler({ method: 'PUT', query: { id: '999' }, body: {}, headers: {} }, res, [], { getClient: async () => client });
  check('an unknown workorder is 404', res.statusCode === 404);
  check('and is rolled back, not left in a transaction', client.log.some((q) => /^ROLLBACK$/i.test(q.sql)));

  const bad = await runPut({ status: 'Banana' }, { before: { done: 0, total: 1 }, after: { done: 0, total: 1 } });
  check('an invalid status is 400', bad.res.statusCode === 400);
  check('and writes nothing', !bad.client.log.some((q) => /UPDATE workorder SET status/i.test(q.sql)));
}

console.log(`\n✅ workorder smoke: ${passed} checks passed`);
