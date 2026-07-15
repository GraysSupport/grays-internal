// scripts/podium-waitlist-smoke.mjs — offline smoke for F8a waitlist back-in-stock SMS.
//
// Exercises lib/waitlistNotify.js with an INJECTED fake pg client and (mostly) an injected
// fake sender, so there is NO network, NO database, NO secrets:
//
//   node scripts/podium-waitlist-smoke.mjs
//
// Covers: no-SKU no-op; the Active-only + SKU-filtered lookup; the send + Notified flip +
// integration_sync_log audit (with the ON CONFLICT idempotency claim and the
// waitlist_back_in_stock:<id> reference_id); the already-claimed (conflict) → skip path;
// the no-phone → skip path; the 42P01 (bare-DB) degrade; the BEST-EFFORT guarantee (a
// throwing sender is caught, counted failed, and never propagates); SKU de-dup/uppercasing;
// and one end-to-end pass through the REAL sendSystemSms in PODIUM_MOCK mode.

process.env.PODIUM_MOCK = 'true'; // real sendSystemSms short-circuits to the typed mock

const { notifyWaitlistBackInStock, backInStockMessage } = await import('../lib/waitlistNotify.js');

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ---- Fake pg client (records queries, returns scripted results) ---------------
function makeClient(scripts = []) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const s of scripts) {
        if (typeof s.match === 'function' ? s.match(sql) : s.match.test(sql)) {
          if (s.throws) throw s.throws;
          return s.result ?? { rowCount: 0, rows: [] };
        }
      }
      return { rowCount: 0, rows: [] };
    },
  };
}

const SELECT_RE = /FROM waitlist w/i;
const CLAIM_RE  = /INSERT INTO integration_sync_log/i;
const LOG_UPD_RE = /UPDATE integration_sync_log/i;
const WL_UPD_RE  = /UPDATE waitlist SET status = 'Notified'/i;

const activeRow = (over = {}) => ({
  waitlist_id: 1, customer_id: 26, product_sku: 'TM-95T',
  customer_name: 'Demo Customer', customer_phone: '0400000000', product_name: '95T Treadmill',
  ...over,
});

// A fresh-claim client: lookup returns rows; the audit INSERT returns an id (not a conflict).
function okClient(rows) {
  return makeClient([
    { match: SELECT_RE, result: { rowCount: rows.length, rows } },
    { match: CLAIM_RE, result: { rowCount: 1, rows: [{ id: 77 }] } },
    { match: LOG_UPD_RE, result: { rowCount: 1, rows: [] } },
    { match: WL_UPD_RE, result: { rowCount: 1, rows: [] } },
  ]);
}

console.log('Waitlist back-in-stock (F8a) smoke — fake client, no DB\n');

console.log('copy + no-op:');
{
  check('message names the product', backInStockMessage('95T Treadmill').includes('95T Treadmill'));
  check('message falls back when no product name', /item you were waiting for/i.test(backInStockMessage('')));
  check('message carries the sales phone 1300 769 556', backInStockMessage('X').includes('1300 769 556'));
  const client = makeClient();
  const out = await notifyWaitlistBackInStock(client, []);
  check('no SKUs → no-op, no DB calls', out.notified === 0 && out.skipped === 0 && out.failed === 0 && client.calls.length === 0);
}

console.log('\nhappy path (send + Notified + audit):');
{
  const sent = [];
  const client = okClient([activeRow()]);
  const out = await notifyWaitlistBackInStock(client, ['tm-95t'], { collectionId: 12, send: async (m) => { sent.push(m); return { status: 'sent' }; } });
  check('one row notified', out.notified === 1 && out.skipped === 0 && out.failed === 0, JSON.stringify(out));
  check('SMS sent to the customer phone', sent.length === 1 && sent[0].to === '0400000000');
  check('SMS body is the back-in-stock copy', /back in stock/i.test(sent[0].body));
  const sel = client.calls.find((c) => SELECT_RE.test(c.sql));
  check('lookup filters status = Active', !!sel && /w\.status = 'Active'/i.test(sel.sql));
  check('lookup passes the uppercased SKU list', !!sel && Array.isArray(sel.params?.[0]) && sel.params[0].includes('TM-95T'));
  const claim = client.calls.find((c) => CLAIM_RE.test(c.sql));
  check('audit claim uses ON CONFLICT DO NOTHING', !!claim && /ON CONFLICT/i.test(claim.sql) && /DO NOTHING/i.test(claim.sql));
  check('audit reference_id is per-waitlist-row', !!claim && (claim.params || []).includes('waitlist_back_in_stock:1'));
  check('audit payload carries envelope only (no body)', !!claim && /"sku"/.test(claim.params?.[1] || '') && !/back in stock/i.test(claim.params?.[1] || ''));
  check('log marked sent', client.calls.some((c) => LOG_UPD_RE.test(c.sql) && /'sent'/i.test(c.sql)));
  check('waitlist row flipped to Notified', client.calls.some((c) => WL_UPD_RE.test(c.sql)));
}

console.log('\nde-dup + multiple rows:');
{
  const sent = [];
  const client = okClient([activeRow({ waitlist_id: 1 }), activeRow({ waitlist_id: 2, customer_id: 27 })]);
  const out = await notifyWaitlistBackInStock(client, ['TM-95T', 'tm-95t', ''], { send: async (m) => { sent.push(m); return {}; } });
  check('two rows notified, duplicate/blank SKUs collapsed', out.notified === 2 && sent.length === 2);
  const sel = client.calls.find((c) => SELECT_RE.test(c.sql));
  check('SKU list de-duped to one entry', sel.params[0].length === 1);
}

console.log('\nidempotency (already claimed):');
{
  const sent = [];
  const client = makeClient([
    { match: SELECT_RE, result: { rowCount: 1, rows: [activeRow()] } },
    { match: CLAIM_RE, result: { rowCount: 0, rows: [] } }, // conflict → already handled
  ]);
  const out = await notifyWaitlistBackInStock(client, ['TM-95T'], { send: async (m) => { sent.push(m); return {}; } });
  check('conflicting claim → skipped, no send', out.skipped === 1 && out.notified === 0 && sent.length === 0);
}

console.log('\nno phone on customer:');
{
  const sent = [];
  const client = okClient([activeRow({ customer_phone: null })]);
  const out = await notifyWaitlistBackInStock(client, ['TM-95T'], { send: async (m) => { sent.push(m); return {}; } });
  check('no-phone row → skipped, no send', out.skipped === 1 && out.notified === 0 && sent.length === 0);
  check('log marked skipped with a reason', client.calls.some((c) => LOG_UPD_RE.test(c.sql) && /'skipped'/i.test(c.sql)));
}

console.log('\nbare-DB degrade (42P01):');
{
  const err = new Error('relation "waitlist" does not exist'); err.code = '42P01';
  const client = makeClient([{ match: SELECT_RE, throws: err }]);
  const out = await notifyWaitlistBackInStock(client, ['TM-95T']);
  check('missing table → {0,0,0}, no throw', out.notified === 0 && out.skipped === 0 && out.failed === 0);
}

console.log('\nbest-effort (sender throws):');
{
  const client = okClient([activeRow()]);
  const out = await notifyWaitlistBackInStock(client, ['TM-95T'], {
    send: async () => { throw new Error('Podium 503'); },
  });
  check('send failure → counted failed, never throws', out.failed === 1 && out.notified === 0);
  check('failure recorded on the audit row', client.calls.some((c) => LOG_UPD_RE.test(c.sql) && /'failed'/i.test(c.sql)));
}

console.log('\nend-to-end through the REAL sendSystemSms (mock mode):');
{
  const client = okClient([activeRow()]);
  const out = await notifyWaitlistBackInStock(client, ['TM-95T']); // no injected send → real mock
  check('real mock send path notifies without error', out.notified === 1 && out.failed === 0);
}

console.log(`\n✅ waitlist smoke: ${passed} checks passed`);
