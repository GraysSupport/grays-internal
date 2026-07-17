// scripts/podium-delivery-notify-smoke.mjs — offline smoke for F8b delivery-booked SMS.
//
//   node scripts/podium-delivery-notify-smoke.mjs
//
// Exercises lib/deliveryNotify.js with an INJECTED fake pg client and (mostly) an injected
// fake sender — no network, no DB, no secrets. Covers: copy (with/without date); invalid id
// no-op; not-found no-op; not-booked → skip; send + audit-sent + envelope-only payload; the
// ON CONFLICT idempotency claim + reference_id; no-phone → skip; conflict → skip; 42P01
// degrade; best-effort throw; post-send-bookkeeping-fail → still notified; real mock send.

process.env.PODIUM_MOCK = 'true';

const {
  notifyDeliveryBooked,
  deliveryBookedMessage,
  previewDeliveryBookedSms,
  declineDeliveryBookedSms,
} = await import('../lib/deliveryNotify.js');

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

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

const SELECT_RE = /FROM delivery d/i;
const CLAIM_RE  = /INSERT INTO integration_sync_log/i;
const LOG_UPD_RE = /UPDATE integration_sync_log/i;

const bookedRow = (over = {}) => ({
  delivery_id: 42, customer_id: 26, invoice_id: 'INV-900',
  delivery_status: 'Booked for Delivery', delivery_date: '20 Jul 2026',
  customer_name: 'Demo Customer', customer_phone: '0400000000',
  ...over,
});

function okClient(row) {
  return makeClient([
    { match: SELECT_RE, result: { rowCount: row ? 1 : 0, rows: row ? [row] : [] } },
    { match: CLAIM_RE, result: { rowCount: 1, rows: [{ id: 55 }] } },
    { match: LOG_UPD_RE, result: { rowCount: 1, rows: [] } },
  ]);
}

console.log('Delivery-booked (F8b) smoke — fake client, no DB\n');

console.log('copy + guards:');
{
  check('copy names the delivery date', deliveryBookedMessage({ invoiceId: 'INV-900', deliveryDate: '20 Jul 2026' }).includes('20 Jul 2026'));
  check('copy without a date says we\'ll be in touch', /in touch/i.test(deliveryBookedMessage({ invoiceId: 'INV-900' })));
  check('copy carries the sales phone', deliveryBookedMessage({}).includes('1300 769 556'));
  const c1 = makeClient();
  check('invalid id → no-op', (await notifyDeliveryBooked(c1, 'nope')).notified === 0 && c1.calls.length === 0);
  const c2 = okClient(null);
  const out2 = await notifyDeliveryBooked(c2, 42);
  check('not found → no-op', out2.notified === 0 && out2.skipped === 0);
  const c3 = okClient(bookedRow({ delivery_status: 'To Be Booked' }));
  const out3 = await notifyDeliveryBooked(c3, 42);
  check('not booked → skipped, no send', out3.skipped === 1 && out3.notified === 0 && !c3.calls.some((c) => CLAIM_RE.test(c.sql)));
}

console.log('\nhappy path:');
{
  const sent = [];
  const client = okClient(bookedRow());
  const out = await notifyDeliveryBooked(client, 42, { send: async (m) => { sent.push(m); return { status: 'sent' }; } });
  check('one notified', out.notified === 1 && out.skipped === 0 && out.failed === 0, JSON.stringify(out));
  check('SMS to the customer phone with the booked copy', sent.length === 1 && sent[0].to === '0400000000' && /booked for delivery/i.test(sent[0].body));
  const sel = client.calls.find((c) => SELECT_RE.test(c.sql));
  check('lookup joins delivery + customer', !!sel && /JOIN customers c/i.test(sel.sql));
  const claim = client.calls.find((c) => CLAIM_RE.test(c.sql));
  // The claim is an upsert, NOT DO NOTHING: a declined text was never sent, so it must
  // stay sendable — while an already-'sent' row can never be reopened. See the
  // confirmation-panel section below.
  check('claim reclaims anything not already sent', !!claim && /ON CONFLICT/i.test(claim.sql) && /DO UPDATE/i.test(claim.sql) && /status <> 'sent'/i.test(claim.sql));
  check('reference_id is per-delivery', !!claim && (claim.params || []).includes('delivery_booked:42'));
  check('payload is envelope-only (no body)', !!claim && /"invoice_id"/.test(claim.params?.[1] || '') && !/booked for delivery/i.test(claim.params?.[1] || ''));
  check('marked sent', client.calls.some((c) => LOG_UPD_RE.test(c.sql) && /'sent'/i.test(c.sql)));
}

console.log('\nedge cases:');
{
  const sent = [];
  const client = okClient(bookedRow({ customer_phone: null }));
  const out = await notifyDeliveryBooked(client, 42, { send: async (m) => { sent.push(m); return {}; } });
  check('no phone → skipped, no send', out.skipped === 1 && sent.length === 0 && client.calls.some((c) => LOG_UPD_RE.test(c.sql) && /'skipped'/i.test(c.sql)));
}
{
  const sent = [];
  const client = makeClient([
    { match: SELECT_RE, result: { rowCount: 1, rows: [bookedRow()] } },
    { match: CLAIM_RE, result: { rowCount: 0, rows: [] } }, // conflict
  ]);
  const out = await notifyDeliveryBooked(client, 42, { send: async (m) => { sent.push(m); return {}; } });
  check('already-sent row → skipped, no second send (at-most-once)', out.skipped === 1 && sent.length === 0);
}
{
  const err = new Error('relation "delivery" does not exist'); err.code = '42P01';
  const client = makeClient([{ match: SELECT_RE, throws: err }]);
  const out = await notifyDeliveryBooked(client, 42);
  check('42P01 → {0,0,0}, no throw', out.notified === 0 && out.failed === 0);
}
{
  const client = okClient(bookedRow());
  const out = await notifyDeliveryBooked(client, 42, { send: async () => { throw new Error('Podium 503'); } });
  check('send failure → failed, never throws', out.failed === 1 && out.notified === 0 && client.calls.some((c) => LOG_UPD_RE.test(c.sql) && /'failed'/i.test(c.sql)));
}
{
  const client = makeClient([
    { match: SELECT_RE, result: { rowCount: 1, rows: [bookedRow()] } },
    { match: CLAIM_RE, result: { rowCount: 1, rows: [{ id: 9 }] } },
    { match: /status = 'sent'/i, throws: new Error('db blip after send') },
  ]);
  const out = await notifyDeliveryBooked(client, 42, { send: async () => ({}) });
  check('post-send bookkeeping fail → notified, not failed', out.notified === 1 && out.failed === 0, JSON.stringify(out));
}
{
  const client = okClient(bookedRow());
  const out = await notifyDeliveryBooked(client, 42); // real mock send
  check('real mock send path notifies', out.notified === 1 && out.failed === 0);
}

// ---------------------------------------------------------------------------
// Confirmation panel (Nick, 17 Jul 2026): logistics must approve the text before
// it goes. The SMS is no longer sent automatically on booking — the booking flow
// PREVIEWS it, and a human explicitly sends or declines.
// ---------------------------------------------------------------------------

console.log('\npreview (what the confirmation panel shows) — reads only, never claims:');
{
  const client = makeClient([{ match: SELECT_RE, result: { rowCount: 1, rows: [bookedRow()] } }]);
  const p = await previewDeliveryBookedSms(client, 42);
  check('eligible when booked with a phone', p.eligible === true);
  check('previews the EXACT body that will be sent', p.body === deliveryBookedMessage({ invoiceId: 'INV-900', deliveryDate: '20 Jul 2026' }));
  check('surfaces the number it would text', p.to === '0400000000');
  check('names the customer so the panel can say who', p.customer_name === 'Demo Customer');
  check('previewing NEVER claims or sends', !client.calls.some((c) => CLAIM_RE.test(c.sql)));

  const noPhone = makeClient([{ match: SELECT_RE, result: { rowCount: 1, rows: [bookedRow({ customer_phone: null })] } }]);
  const p2 = await previewDeliveryBookedSms(noPhone, 42);
  check('no phone → ineligible with a reason the panel can show', p2.eligible === false && /phone/i.test(p2.reason));

  const notBooked = makeClient([{ match: SELECT_RE, result: { rowCount: 1, rows: [bookedRow({ delivery_status: 'To Be Booked' })] } }]);
  check('not booked → ineligible', (await previewDeliveryBookedSms(notBooked, 42)).eligible === false);

  const missing = makeClient([{ match: SELECT_RE, result: { rowCount: 0, rows: [] } }]);
  check('unknown delivery → ineligible, no throw', (await previewDeliveryBookedSms(missing, 999)).eligible === false);

  const err = new Error('no table'); err.code = '42P01';
  const bare = makeClient([{ match: SELECT_RE, throws: err }]);
  check('bare DB → ineligible, no throw', (await previewDeliveryBookedSms(bare, 42)).eligible === false);
}

console.log('\ndecline ("Don\'t send") — records the decision, sends nothing:');
{
  const sent = [];
  const client = okClient(bookedRow());
  const out = await declineDeliveryBookedSms(client, 42, { actorId: 'BR', send: async (m) => { sent.push(m); } });
  check('nothing is sent', sent.length === 0 && out.skipped === 1);
  const claim = client.calls.find((c) => CLAIM_RE.test(c.sql));
  check('the decision is audited under the same reference', (claim.params || []).includes('delivery_booked:42'));
  check('recorded as skipped, attributed to the person who declined',
    client.calls.some((c) => LOG_UPD_RE.test(c.sql) && /'skipped'/i.test(c.sql) && (c.params || []).some((p) => String(p).includes('BR'))));
}

console.log('\nnever text twice — even with a human in the loop:');
{
  // The claim is now an upsert that REFUSES to reopen a row already marked 'sent'
  // (rowCount 0), so a double-click or a second confirm can't double-text.
  const sent = [];
  const client = makeClient([
    { match: SELECT_RE, result: { rowCount: 1, rows: [bookedRow()] } },
    { match: CLAIM_RE, result: { rowCount: 0, rows: [] } }, // already 'sent'
  ]);
  const out = await notifyDeliveryBooked(client, 42, { send: async (m) => { sent.push(m); } });
  check('already sent → no second text', sent.length === 0 && out.notified === 0);
  check('reports alreadySent so the UI can say so', out.alreadySent === true);

  const claim = client.calls.find((c) => CLAIM_RE.test(c.sql));
  check('claim refuses to reopen a sent row', /DO UPDATE/i.test(claim.sql) && /status <> 'sent'/i.test(claim.sql));
}

console.log('\na declined text can still be sent later (it was never sent):');
{
  const sent = [];
  const client = okClient(bookedRow()); // claim upsert succeeds (row was 'skipped')
  const out = await notifyDeliveryBooked(client, 42, { actorId: 'BR', send: async (m) => { sent.push(m); } });
  check('reclaiming a declined row sends the first text', out.notified === 1 && sent.length === 1);
  check('at-most-once still holds — the gate is "was it SENT", not "was it claimed"', out.alreadySent !== true);
}

console.log(`\n✅ delivery-booked smoke: ${passed} checks passed`);
