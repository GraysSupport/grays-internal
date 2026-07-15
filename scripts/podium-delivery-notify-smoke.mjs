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

const { notifyDeliveryBooked, deliveryBookedMessage } = await import('../lib/deliveryNotify.js');

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
  check('claim uses ON CONFLICT DO NOTHING', !!claim && /ON CONFLICT/i.test(claim.sql) && /DO NOTHING/i.test(claim.sql));
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
  check('conflict → skipped, no send (idempotent)', out.skipped === 1 && sent.length === 0);
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

console.log(`\n✅ delivery-booked smoke: ${passed} checks passed`);
