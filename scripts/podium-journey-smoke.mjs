// scripts/podium-journey-smoke.mjs — offline checks for the Customer-360 journey (F6).
//
// No DB, no network: exercises the pure labelEvent mapping and buildJourney's merge/shape
// via an injected fake pg client. Run: `node scripts/podium-journey-smoke.mjs`.

import { labelEvent, buildJourney, __JOURNEY_SQL } from '../lib/customerJourney.js';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; } else { fail++; console.error('  ✗', msg); }
}

// ---- 1. labelEvent: lead created (NULL→New) -------------------------------------------
{
  const e = labelEvent({ event_time: '2026-07-01T00:00:00Z', category: 'lead', code: 'LEAD_CREATED',
    from_val: null, to_val: 'New', note: 'Added to funnel from inbox', actor: 'GA', ref_type: 'lead', ref_id: 3, actor_name: 'Grace' });
  ok(e.title === 'Lead created — New', 'lead created title');
  ok(e.detail === 'Added to funnel from inbox', 'lead created detail = note');
  ok(e.category === 'lead' && e.ref_id === 3, 'lead created passthrough');
  ok(e.actor_name === 'Grace', 'actor_name preserved');
}

// ---- 2. labelEvent: lead stage transition ---------------------------------------------
{
  const e = labelEvent({ category: 'lead', code: 'LEAD_STAGE', from_val: 'Contacted', to_val: 'Quoted', note: null, ref_type: 'lead', ref_id: 3 });
  ok(e.title === 'Contacted → Quoted', 'stage transition title');
  ok(e.detail === null, 'stage transition no note → null detail');
}

// ---- 3. labelEvent: workorder created (status in detail) ------------------------------
{
  const e = labelEvent({ category: 'workorder', code: 'WORKORDER_CREATED', from_val: null, to_val: 'Work Ordered',
    note: 'Invoice INV-1001 · Altona', actor: 'BR', ref_type: 'workorder', ref_id: 42 });
  ok(e.title === 'Workorder created', 'WO created title');
  ok(e.detail === 'Status: Work Ordered · Invoice INV-1001 · Altona', 'WO created detail combines status + note');
}

// ---- 4. labelEvent: item + delivery events -------------------------------------------
{
  const item = labelEvent({ category: 'workorder', code: 'ITEM_IN_WORKSHOP', to_val: 'In Workshop', note: 'Treadmill', ref_type: 'workorder', ref_id: 42 });
  ok(item.title === 'Item moved to workshop', 'item-in-workshop title');
  ok(item.detail === 'In Workshop · Treadmill', 'item status + note detail');

  const del = labelEvent({ category: 'delivery', code: 'DELIVERY_RECORD', to_val: 'Booked for Delivery', note: 'Booked 12 Jul 2026 · Richmond', ref_type: 'delivery', ref_id: 7 });
  ok(del.title === 'Delivery — Booked for Delivery', 'delivery title uses status');
  ok(del.detail === 'Booked 12 Jul 2026 · Richmond', 'delivery detail = note');

  const unknown = labelEvent({ category: 'workorder', code: 'SOMETHING_NEW', to_val: null, note: null, ref_type: 'workorder', ref_id: 9 });
  ok(unknown.title === 'SOMETHING_NEW', 'unknown code falls back to raw code');
}

// ---- 5. buildJourney: merge + shape via a fake client --------------------------------
{
  const custRow = { id: 26, name: 'Adhal Iqbal', email: 'a@x.com', phone: '0400000000', address: 'Altona', customer_type: 'Individual', podium_contact_id: null };
  const unionRows = [
    { event_time: '2026-07-01T00:00:00Z', category: 'lead', code: 'LEAD_CREATED', from_val: null, to_val: 'New', note: null, actor: 'GA', ref_type: 'lead', ref_id: 3, actor_name: 'Grace' },
    { event_time: '2026-07-03T00:00:00Z', category: 'workorder', code: 'WORKORDER_CREATED', from_val: null, to_val: 'Work Ordered', note: 'Invoice INV-1', actor: 'BR', ref_type: 'workorder', ref_id: 42, actor_name: 'Ben' },
    { event_time: '2026-07-05T00:00:00Z', category: 'delivery', code: 'DELIVERY_RECORD', from_val: null, to_val: 'Delivery Completed', note: 'Richmond', actor: null, ref_type: 'delivery', ref_id: 7, actor_name: null },
  ];
  let queries = 0;
  let released = false;
  const fakeClient = {
    async query(sql) {
      queries++;
      if (/FROM customers WHERE id/i.test(sql)) return { rowCount: 1, rows: [custRow] };
      return { rowCount: unionRows.length, rows: unionRows };
    },
    release() { released = true; },
  };
  const result = await buildJourney(26, { getClient: async () => fakeClient });
  ok(result && result.customer.id === 26, 'buildJourney returns the customer');
  ok(result.events.length === 3, 'buildJourney maps all union rows');
  ok(result.events.every((e) => 'title' in e && 'detail' in e && 'event_time' in e), 'events are normalized');
  ok(result.events[0].category === 'lead' && result.events[2].category === 'delivery', 'order preserved from SQL');
  ok(queries === 2, 'two queries run (customer + journey)');
  ok(released === true, 'client released');

  // Missing customer → null
  const none = await buildJourney(99999, { getClient: async () => ({
    async query() { return { rowCount: 0, rows: [] }; }, release() {},
  }) });
  ok(none === null, 'unknown customer → null');
}

// ---- 6. SQL sanity: unions all three sources + excludes duplicate WO-created log ------
{
  ok(/FROM lead_stage_log/.test(__JOURNEY_SQL), 'SQL reads lead_stage_log');
  ok(/FROM workorder_logs/.test(__JOURNEY_SQL), 'SQL reads workorder_logs');
  ok(/FROM delivery/.test(__JOURNEY_SQL), 'SQL reads delivery');
  ok(/event_type\s*<>\s*'WORKORDER_CREATED'/.test(__JOURNEY_SQL), 'SQL excludes the WORKORDER_CREATED log row (no dup)');
  ok(/ORDER BY ev\.event_time ASC/.test(__JOURNEY_SQL), 'SQL orders oldest → newest');
  ok(!/data\.body|message|conversation/i.test(__JOURNEY_SQL), 'P1: journey SQL never touches message/conversation bodies');
}

console.log(`\npodium-journey-smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
