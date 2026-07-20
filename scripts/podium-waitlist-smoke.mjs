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

// ⛔ F8a is DISABLED BY DEFAULT (Nick, 20 Jul 2026) — see the kill-switch block at the
// bottom of this file. Every test above that block is about what happens when sending is
// switched ON, so opt in explicitly here. If this line is deleted, those tests fail
// loudly rather than silently asserting nothing.
process.env.WAITLIST_SMS_ENABLED = 'true';

const {
  notifyWaitlistBackInStock,
  backInStockMessage,
  isWaitlistSmsEnabled,
} = await import('../lib/waitlistNotify.js');

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

console.log('\npost-send bookkeeping failure (SMS already away):');
{
  // Send succeeds, but the follow-up "mark sent" UPDATE throws. The customer WAS texted,
  // so it must count as notified (not failed) and the claim row still blocks any re-send.
  const client = makeClient([
    { match: SELECT_RE, result: { rowCount: 1, rows: [activeRow()] } },
    { match: CLAIM_RE, result: { rowCount: 1, rows: [{ id: 5 }] } },
    { match: /status = 'sent'/i, throws: new Error('db blip after send') },
  ]);
  const out = await notifyWaitlistBackInStock(client, ['TM-95T'], { send: async () => ({ status: 'sent' }) });
  check('counts as notified, not failed', out.notified === 1 && out.failed === 0, JSON.stringify(out));
}

console.log('\nend-to-end through the REAL sendSystemSms (mock mode):');
{
  const client = okClient([activeRow()]);
  const out = await notifyWaitlistBackInStock(client, ['TM-95T']); // no injected send → real mock
  check('real mock send path notifies without error', out.notified === 1 && out.failed === 0);
}

// ---------------------------------------------------------------------------
// ⛔ KILL SWITCH — F8a sends NOTHING unless WAITLIST_SMS_ENABLED === 'true'
//
// WHY: F8a is the only customer-facing automation with NO human in the loop. F8b asks
// logistics to confirm; F8a fires straight off an apply-inventory. On 20 Jul 2026 we
// found PODIUM_MOCK=false on Production, which means the next restock of a waitlisted
// SKU would have texted real customers using copy nobody had signed off.
//
// A role gate is the wrong instrument here — the trigger is a routine warehouse action,
// not a "send text" button — so the control is a flag that defaults to OFF.
//
// The critical property: suppression must leave NO trace that would block a later
// legitimate send. No claim row (the claim is the at-most-once gate, so claiming now
// would permanently silence that customer) and no Active → Notified flip.
//
// ⚠️ Note what these tests do NOT claim: suppressed is not DEFERRED. The trigger is a
// one-shot 0 → positive stock edge, so a suppressed restock is not re-sent when the
// switch is armed — those customers need a phone call. See lib/waitlistNotify.js.
// ---------------------------------------------------------------------------
console.log('\nkill switch (F8a is off unless explicitly enabled):');
{
  const saved = process.env.WAITLIST_SMS_ENABLED;

  check('exported flag reader exists', typeof isWaitlistSmsEnabled === 'function');

  delete process.env.WAITLIST_SMS_ENABLED;
  check('unset ⇒ disabled (safe default)', isWaitlistSmsEnabled() === false);
  process.env.WAITLIST_SMS_ENABLED = 'false';
  check("'false' ⇒ disabled", isWaitlistSmsEnabled() === false);
  process.env.WAITLIST_SMS_ENABLED = 'yes';
  check("'yes' ⇒ disabled (only the exact word 'true' arms it)", isWaitlistSmsEnabled() === false);
  process.env.WAITLIST_SMS_ENABLED = '1';
  check("'1' ⇒ disabled", isWaitlistSmsEnabled() === false);
  process.env.WAITLIST_SMS_ENABLED = 'TRUE';
  check("'TRUE' ⇒ enabled (case-insensitive)", isWaitlistSmsEnabled() === true);
  process.env.WAITLIST_SMS_ENABLED = ' true ';
  check("' true ' ⇒ enabled (whitespace tolerated)", isWaitlistSmsEnabled() === true);

  // --- behaviour when disabled -------------------------------------------------
  delete process.env.WAITLIST_SMS_ENABLED;
  {
    let sendCalls = 0;
    const client = okClient([activeRow(), activeRow({ waitlist_id: 2, customer_id: 77 })]);
    const out = await notifyWaitlistBackInStock(client, ['TM-95T'], {
      send: async () => { sendCalls += 1; return { status: 'sent' }; },
    });

    check('disabled ⇒ NOTHING is sent', sendCalls === 0);
    check('disabled ⇒ nobody counted as notified', out.notified === 0, JSON.stringify(out));
    check('disabled ⇒ reports how many were suppressed', out.suppressed === 2, JSON.stringify(out));

    const sql = client.calls.map((c) => c.sql).join('\n');
    check('disabled ⇒ NO claim row is written (a claim would silence them permanently)',
      !/INSERT INTO integration_sync_log/i.test(sql), sql);
    check('disabled ⇒ waitlist rows stay Active (they must still be notifiable later)',
      !/UPDATE waitlist/i.test(sql), sql);
    check('disabled ⇒ the read-only lookup still runs, so the count is real',
      /FROM waitlist/i.test(sql));

    // STRICTLY STRONGER than the two negative regexes above, and the reason they are not
    // enough on their own: a code reviewer silenced every suppressed customer by writing
    // the real claim row with a QUOTED identifier ("integration_sync_log"), which slips
    // past a /INSERT INTO integration_sync_log/i text match — 41/41 still passed while the
    // catastrophe this design exists to prevent was happening. Counting queries closes the
    // whole class: any write at all, under any spelling, fails this.
    check('disabled ⇒ EXACTLY one query total (the read-only lookup) — no writes, any spelling',
      client.calls.length === 1, `got ${client.calls.length}: ${sql}`);
  }

  // --- and the switch genuinely re-arms it -------------------------------------
  process.env.WAITLIST_SMS_ENABLED = 'true';
  {
    let sendCalls = 0;
    const client = okClient([activeRow()]);
    const out = await notifyWaitlistBackInStock(client, ['TM-95T'], {
      send: async () => { sendCalls += 1; return { status: 'sent' }; },
    });
    check('enabled ⇒ sends again', sendCalls === 1 && out.notified === 1, JSON.stringify(out));
    check('enabled ⇒ suppressed count is zero', !out.suppressed);
  }

  // A disabled run must not be mistaken for "everyone already notified".
  delete process.env.WAITLIST_SMS_ENABLED;
  {
    const client = okClient([activeRow()]);
    const out = await notifyWaitlistBackInStock(client, ['TM-95T'], { send: async () => ({ status: 'sent' }) });
    check('disabled ⇒ not counted as skipped (skipped means already-claimed/no-phone)',
      out.skipped === 0, JSON.stringify(out));
    check('disabled ⇒ not counted as failed', out.failed === 0, JSON.stringify(out));
  }

  if (saved === undefined) delete process.env.WAITLIST_SMS_ENABLED;
  else process.env.WAITLIST_SMS_ENABLED = saved;
}

console.log(`\n✅ waitlist smoke: ${passed} checks passed`);
