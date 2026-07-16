// scripts/podium-review-smoke.mjs — offline smoke for F8c review-request automation.
//
// Exercises lib/reviewNotify.js with an INJECTED fake pg client and (mostly) an injected
// fake sender, so there is NO network, NO database, NO secrets:
//
//   node scripts/podium-review-smoke.mjs
//
// Covers: the no-op guards; the completed+paid eligibility gate (and that an INELIGIBLE
// workorder is never claimed, so a later genuine completion can still fire); the invite +
// integration_sync_log audit (ON CONFLICT idempotency claim, review_request:<id>
// reference_id, envelope-only payload); the already-claimed → skip path; contact
// resolution (podium_contact_id preferred, phone fallback, neither → skip); the 42P01
// (bare-DB) degrade; the BEST-EFFORT guarantee (a throwing sender is caught, counted
// failed, never propagates); the post-send bookkeeping failure; and one end-to-end pass
// through the REAL requestReview in PODIUM_MOCK mode.

process.env.PODIUM_MOCK = 'true'; // real requestReview short-circuits to the typed mock

const { notifyReviewRequest } = await import('../lib/reviewNotify.js');

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

const SELECT_RE = /FROM workorder wo/i;
const CLAIM_RE = /INSERT INTO integration_sync_log/i;
const LOG_UPD_RE = /UPDATE integration_sync_log/i;

const eligibleRow = (over = {}) => ({
  workorder_id: 42,
  status: 'Completed',
  outstanding_balance: 0,
  customer_id: 26,
  customer_name: 'Demo Customer',
  customer_phone: '0400000000',
  podium_contact_id: 'pod_con_abc',
  ...over,
});

// A fresh-claim client: lookup returns the row; the audit INSERT returns an id (no conflict).
function okClient(rows) {
  return makeClient([
    { match: SELECT_RE, result: { rowCount: rows.length, rows } },
    { match: CLAIM_RE, result: { rowCount: 1, rows: [{ id: 91 }] } },
    { match: LOG_UPD_RE, result: { rowCount: 1, rows: [] } },
  ]);
}

console.log('Review request on completed + paid (F8c) smoke — fake client, no DB\n');

console.log('no-op guards:');
{
  const client = makeClient();
  const out = await notifyReviewRequest(client, null);
  check('no workorder id → no-op, no DB calls', out.notified === 0 && out.skipped === 0 && out.failed === 0 && client.calls.length === 0);

  const missing = makeClient([{ match: SELECT_RE, result: { rowCount: 0, rows: [] } }]);
  const out2 = await notifyReviewRequest(missing, 999);
  check('workorder not found → no-op, no claim', out2.notified === 0 && !missing.calls.some((c) => CLAIM_RE.test(c.sql)));
}

console.log('\nhappy path (invite + audit):');
{
  const sent = [];
  const client = okClient([eligibleRow()]);
  const out = await notifyReviewRequest(client, 42, { send: async (m) => { sent.push(m); return { status: 'sent' }; } });
  check('one review invite sent', out.notified === 1 && out.skipped === 0 && out.failed === 0, JSON.stringify(out));
  check('invite targets the podium contact uid', sent.length === 1 && sent[0].contactUid === 'pod_con_abc');
  const claim = client.calls.find((c) => CLAIM_RE.test(c.sql));
  check('audit claim uses ON CONFLICT DO NOTHING', !!claim && /ON CONFLICT/i.test(claim.sql) && /DO NOTHING/i.test(claim.sql));
  check('audit reference_id is per-workorder', !!claim && (claim.params || []).includes('review_request:42'));
  check('audit payload carries envelope only (no customer name)', !!claim && /"workorder_id"/.test(claim.params?.[1] || '') && !/Demo Customer/.test(claim.params?.[1] || ''));
  check('log marked sent', client.calls.some((c) => LOG_UPD_RE.test(c.sql) && /'sent'/i.test(c.sql)));
}

console.log('\neligibility gate (completed AND paid):');
{
  const sent = [];
  const notDone = okClient([eligibleRow({ status: 'Work Ordered' })]);
  const out = await notifyReviewRequest(notDone, 42, { send: async (m) => { sent.push(m); return {}; } });
  check('not completed → no send', out.notified === 0 && sent.length === 0);
  check('not completed → NOT claimed (a later completion must still fire)', !notDone.calls.some((c) => CLAIM_RE.test(c.sql)));

  const owing = okClient([eligibleRow({ outstanding_balance: 500 })]);
  const out2 = await notifyReviewRequest(owing, 42, { send: async (m) => { sent.push(m); return {}; } });
  check('balance outstanding → no send', out2.notified === 0 && sent.length === 0);
  check('balance outstanding → NOT claimed (a later payment must still fire)', !owing.calls.some((c) => CLAIM_RE.test(c.sql)));

  const paidLater = okClient([eligibleRow({ outstanding_balance: '0.00' })]);
  const out3 = await notifyReviewRequest(paidLater, 42, { send: async (m) => { sent.push(m); return {}; } });
  check('numeric-string balance 0.00 counts as paid', out3.notified === 1 && sent.length === 1);

  // A credit/overpayment is still "nothing owing" — the customer has paid.
  const credit = okClient([eligibleRow({ outstanding_balance: '-50.00' })]);
  const out4 = await notifyReviewRequest(credit, 42, { send: async (m) => { sent.push(m); return {}; } });
  check('credit balance (overpaid) counts as paid', out4.notified === 1, JSON.stringify(out4));

  // Defence in depth: workorder.outstanding_balance is NOT NULL today, but Number(null)
  // is 0 — a nullable balance must never read as "paid in full" and burn the claim.
  const sent5 = [];
  const nullBal = okClient([eligibleRow({ outstanding_balance: null })]);
  const out5 = await notifyReviewRequest(nullBal, 42, { send: async (m) => { sent5.push(m); return {}; } });
  check('null balance is NOT treated as paid', out5.notified === 0 && sent5.length === 0);
  check('null balance → NOT claimed', !nullBal.calls.some((c) => CLAIM_RE.test(c.sql)));
}

console.log('\nidempotency (already claimed):');
{
  const sent = [];
  const client = makeClient([
    { match: SELECT_RE, result: { rowCount: 1, rows: [eligibleRow()] } },
    { match: CLAIM_RE, result: { rowCount: 0, rows: [] } }, // conflict → already handled
  ]);
  const out = await notifyReviewRequest(client, 42, { send: async (m) => { sent.push(m); return {}; } });
  check('conflicting claim → skipped, no second invite', out.skipped === 1 && out.notified === 0 && sent.length === 0);
}

console.log('\ncontact resolution:');
{
  const sent = [];
  const phoneOnly = okClient([eligibleRow({ podium_contact_id: null })]);
  const out = await notifyReviewRequest(phoneOnly, 42, { send: async (m) => { sent.push(m); return {}; } });
  check('no contact uid but phone present → invite by phone channel', out.notified === 1 && sent[0].channel === '0400000000' && !sent[0].contactUid);
  const phoneClaim = phoneOnly.calls.find((c) => CLAIM_RE.test(c.sql));
  check('P1: phone number is not written to the audit payload', !!phoneClaim && !/0400000000/.test(phoneClaim.params?.[1] || ''));

  const sent2 = [];
  const neither = okClient([eligibleRow({ podium_contact_id: null, customer_phone: null })]);
  const out2 = await notifyReviewRequest(neither, 42, { send: async (m) => { sent2.push(m); return {}; } });
  check('no contact uid and no phone → skipped, no send', out2.skipped === 1 && out2.notified === 0 && sent2.length === 0);
  check('log marked skipped with a reason', neither.calls.some((c) => LOG_UPD_RE.test(c.sql) && /'skipped'/i.test(c.sql)));
}

console.log('\nbare-DB degrade (42P01):');
{
  const err = new Error('relation "workorder" does not exist'); err.code = '42P01';
  const client = makeClient([{ match: SELECT_RE, throws: err }]);
  const out = await notifyReviewRequest(client, 42);
  check('missing table → {0,0,0}, no throw', out.notified === 0 && out.skipped === 0 && out.failed === 0);
}

console.log('\nbest-effort (sender throws):');
{
  const client = okClient([eligibleRow()]);
  const out = await notifyReviewRequest(client, 42, { send: async () => { throw new Error('Podium 503'); } });
  check('send failure → counted failed, never throws', out.failed === 1 && out.notified === 0);
  check('failure recorded on the audit row', client.calls.some((c) => LOG_UPD_RE.test(c.sql) && /'failed'/i.test(c.sql)));
}

console.log('\npost-send bookkeeping failure (invite already away):');
{
  const client = makeClient([
    { match: SELECT_RE, result: { rowCount: 1, rows: [eligibleRow()] } },
    { match: CLAIM_RE, result: { rowCount: 1, rows: [{ id: 5 }] } },
    { match: /status = 'sent'/i, throws: new Error('db blip after send') },
  ]);
  const out = await notifyReviewRequest(client, 42, { send: async () => ({ status: 'sent' }) });
  check('counts as notified, not failed', out.notified === 1 && out.failed === 0, JSON.stringify(out));
}

console.log('\nend-to-end through the REAL requestReview (mock mode):');
{
  const client = okClient([eligibleRow()]);
  const out = await notifyReviewRequest(client, 42); // no injected send → real mock
  check('real mock invite path notifies without error', out.notified === 1 && out.failed === 0, JSON.stringify(out));
}

console.log(`\n✅ review smoke: ${passed} checks passed`);
