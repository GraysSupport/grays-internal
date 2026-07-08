// scripts/podium-webhook-smoke.mjs — offline smoke for the F2 webhook receiver.
//
// Exercises the security-critical + CRM logic in lib/podiumWebhook.js with NO network,
// NO database, and NO real secrets, plus the api/podium/webhook.js pre-DB gates:
//
//   node scripts/podium-webhook-smoke.mjs
//
// Coverage:
//   • Signature verify — valid / tampered body / wrong secret / missing headers /
//     stale timestamp / future-within-tolerance / sha256= prefix / no secret.
//   • Envelope parse — safe fields only; P1: `body` never appears in the parsed
//     envelope or the sync-log payload, even when the event carries data.body.
//   • Event classification.
//   • Routing with injected fake pg clients — P12 lead auto-create, touch-existing,
//     assignment mirror, message.failed status, dedupe short-circuit, error rollback.
//   • Endpoint gates reached BEFORE any DB access (405 / 503 / 401).
//
// The DB happy paths are additionally validated against the Neon dev branch (real
// INSERT + dedupe round-trip) — see the F2 report. getClientWithTimezone()'s pool is
// lazy, so importing the handler here opens no connection while we hit pre-DB branches.

process.env.PODIUM_MOCK = 'true';
process.env.PODIUM_API_VERSION = process.env.PODIUM_API_VERSION || '2021-04-01';

const crypto = (await import('crypto')).default;
const wh = await import('../lib/podiumWebhook.js');
const webhookHandler = (await import('../api/podium/webhook.js')).default;

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const SECRET = 'whsec_test_123';
function sign(rawBody, timestamp, secret = SECRET) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
}

// ---- Fake pg client (records queries, returns scripted results) ---------------
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
const has = (re) => (sql) => re.test(sql);

console.log('Podium webhook (F2) smoke (PODIUM_MOCK=true)\n');

// ============================================================================
// 1. Signature verification
// ============================================================================
{
  const body = JSON.stringify({ metadata: { eventUid: 'e1', eventType: 'message.received' } });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = sign(body, ts);

  check('sig: valid signature passes', wh.verifySignature({ rawBody: body, signature: sig, timestamp: ts, secret: SECRET }).ok === true);

  check('sig: tampered body fails', wh.verifySignature({ rawBody: body + ' ', signature: sig, timestamp: ts, secret: SECRET }).reason === 'bad_signature');

  check('sig: wrong secret fails', wh.verifySignature({ rawBody: body, signature: sig, timestamp: ts, secret: 'other' }).reason === 'bad_signature');

  check('sig: missing signature → missing_headers', wh.verifySignature({ rawBody: body, timestamp: ts, secret: SECRET }).reason === 'missing_headers');

  check('sig: missing timestamp → missing_headers', wh.verifySignature({ rawBody: body, signature: sig, secret: SECRET }).reason === 'missing_headers');

  check('sig: no secret configured → no_secret', wh.verifySignature({ rawBody: body, signature: sig, timestamp: ts, secret: '' }).reason === 'no_secret');

  const staleTs = String(Math.floor(Date.now() / 1000) - 3600);
  check('sig: stale timestamp rejected (replay guard)', wh.verifySignature({ rawBody: body, signature: sign(body, staleTs), timestamp: staleTs, secret: SECRET }).reason === 'stale_timestamp');

  const futureTs = String(Math.floor(Date.now() / 1000) + 60);
  check('sig: small future skew within tolerance passes', wh.verifySignature({ rawBody: body, signature: sign(body, futureTs), timestamp: futureTs, secret: SECRET }).ok === true);

  check('sig: sha256= prefix tolerated', wh.verifySignature({ rawBody: body, signature: `sha256=${sig}`, timestamp: ts, secret: SECRET }).ok === true);

  check('sig: safeEqual false on length mismatch (no throw)', wh.safeEqual('abc', 'abcd') === false);

  check('sig: parseTimestampMs handles seconds', wh.parseTimestampMs('1700000000') === 1700000000000);
  check('sig: parseTimestampMs handles millis', wh.parseTimestampMs('1700000000000') === 1700000000000);
  check('sig: parseTimestampMs handles ISO', wh.parseTimestampMs('2026-07-06T00:00:00Z') === Date.parse('2026-07-06T00:00:00Z'));
}

// ============================================================================
// 2. Envelope parse — P1: never leak data.body
// ============================================================================
{
  const payload = {
    metadata: { eventUid: 'evt_9', eventType: 'message.received', version: '2', occurredAt: '2026-07-06T10:00:00+10:00' },
    data: {
      body: 'SECRET MESSAGE TEXT that must never be persisted', // P1: must be dropped
      conversation: {
        uid: 'pod_cnv_00003',
        channel: { type: 'phone', identifier: '+61400333444' },
        assignedUser: { uid: 'pod_usr_amELia' },
      },
      contact: { uid: 'pod_con_toMH20', name: 'Tom Harris' }, // deprecated hint
      location: { uid: 'pod_loc_GRAYSHQ', organizationUid: 'pod_org_GRAYS' },
    },
  };
  const env = wh.parseEnvelope(payload);
  check('envelope: eventUid extracted', env.eventUid === 'evt_9');
  check('envelope: eventType extracted', env.eventType === 'message.received');
  check('envelope: conversationUid extracted', env.conversationUid === 'pod_cnv_00003');
  check('envelope: channel type + identifier extracted', env.channelType === 'phone' && env.channelIdentifier === '+61400333444');
  check('envelope: assignedUserUid extracted', env.assignedUserUid === 'pod_usr_amELia');
  check('envelope: contactUid extracted (id only, from hint)', env.contactUid === 'pod_con_toMH20');
  check('envelope: location + org extracted', env.locationUid === 'pod_loc_GRAYSHQ' && env.orgUid === 'pod_org_GRAYS');

  const envJson = JSON.stringify(env);
  check('P1: parsed envelope contains NO message body', !/SECRET MESSAGE TEXT/.test(envJson) && env.body === undefined);
  check('P1: envelope has no "body" key at all', !Object.prototype.hasOwnProperty.call(env, 'body'));

  const syncPayload = wh.buildSyncPayload(env);
  check('P1: sync-log payload contains NO message body', !/SECRET MESSAGE TEXT/.test(JSON.stringify(syncPayload)) && syncPayload.body === undefined);
  check('sync payload: keeps conversation + channel + assignee', syncPayload.conversationUid === 'pod_cnv_00003' && syncPayload.channel === 'phone' && syncPayload.assignedUserUid === 'pod_usr_amELia');

  // Reply-advance fields (message.sent): sender + automated flag.
  check('envelope: senderUserUid null when absent', env.senderUserUid === null);
  check('envelope: automated defaults false', env.automated === false);
  const outEnv = wh.parseEnvelope({ metadata: { eventType: 'message.sent' }, data: { sender: { uid: 'pod_usr_amELia' }, author: { type: 'bot' } } });
  check('envelope: senderUserUid extracted from data.sender', outEnv.senderUserUid === 'pod_usr_amELia');
  check('envelope: automated true when author.type != user (Jerry/AI)', outEnv.automated === true);
}

// ============================================================================
// 3. Event classification
// ============================================================================
{
  check('classify: message.received', wh.classifyEvent('message.received') === 'message.received');
  check('classify: message.sent', wh.classifyEvent('message.sent') === 'message.sent');
  check('classify: message.failed', wh.classifyEvent('message.failed') === 'message.failed');
  check('classify: assignment (liberal match)', wh.classifyEvent('conversation.assignee.updated') === 'assignment');
  check('classify: contact', wh.classifyEvent('contact.created') === 'contact');
  check('classify: unknown', wh.classifyEvent('something.weird') === 'unknown');
}

// ============================================================================
// 4. Handlers with fake pg clients
// ============================================================================
// 4a. P12 — new conversation, no open lead → create lead + stage log, assignee resolved
{
  const client = makeClient([
    { match: has(/SELECT lead_id FROM leads/i), result: { rowCount: 0, rows: [] } },
    { match: has(/SELECT id FROM users/i), result: { rowCount: 1, rows: [{ id: 'AM' }] } },
    { match: has(/SELECT id FROM customers/i), result: { rowCount: 0, rows: [] } },
    { match: has(/INSERT INTO leads/i), result: { rowCount: 1, rows: [{ lead_id: 501 }] } },
    { match: has(/INSERT INTO lead_stage_log/i), result: { rowCount: 1 } },
  ]);
  const env = { conversationUid: 'pod_cnv_new', channelType: 'phone', assignedUserUid: 'pod_usr_amELia', contactUid: 'pod_con_toMH20' };
  const r = await wh.handleMessageReceived(client, env);
  check('P12: creates a lead when none open', r.action === 'created_lead' && r.leadId === 501);
  const leadInsert = client.calls.find((c) => /INSERT INTO leads/i.test(c.sql));
  check('P12: lead inserted at stage New with conversation id', leadInsert && leadInsert.params[1] === 'pod_cnv_new');
  check('P12: lead assigned to resolved portal user', leadInsert && leadInsert.params[4] === 'AM');
  check('P12: stage log written (from NULL → New)', client.calls.some((c) => /INSERT INTO lead_stage_log/i.test(c.sql)));
}

// 4b. P12 idempotent — existing open lead → touch, no new lead
{
  const client = makeClient([
    { match: has(/SELECT lead_id FROM leads/i), result: { rowCount: 1, rows: [{ lead_id: 777 }] } },
    { match: has(/UPDATE leads SET last_contact_at/i), result: { rowCount: 1 } },
  ]);
  const r = await wh.handleMessageReceived(client, { conversationUid: 'pod_cnv_open' });
  check('P12: touches existing open lead', r.action === 'touched_lead' && r.leadId === 777);
  check('P12: does NOT insert a second lead', !client.calls.some((c) => /INSERT INTO leads/i.test(c.sql)));
}

// 4c. P12 — no conversation uid → skipped
{
  const r = await wh.handleMessageReceived(makeClient(), { conversationUid: null });
  check('P12: skipped when no conversation uid', r.action === 'skipped_no_conversation');
}

// 4d. P12 — unassigned conversation → lead created unassigned
{
  const client = makeClient([
    { match: has(/SELECT lead_id FROM leads/i), result: { rowCount: 0, rows: [] } },
    { match: has(/SELECT id FROM users/i), result: { rowCount: 0, rows: [] } },
    { match: has(/INSERT INTO leads/i), result: { rowCount: 1, rows: [{ lead_id: 502 }] } },
  ]);
  await wh.handleMessageReceived(client, { conversationUid: 'pod_cnv_un', assignedUserUid: null });
  const leadInsert = client.calls.find((c) => /INSERT INTO leads/i.test(c.sql));
  check('P12: unassigned conversation → assigned_to NULL', leadInsert && leadInsert.params[4] === null);
}

// 4e. Assignment (F1b inbound half) — resolve assignee → mirror to lead
{
  const client = makeClient([
    { match: has(/SELECT id FROM users/i), result: { rowCount: 1, rows: [{ id: 'BN' }] } },
    { match: has(/UPDATE leads/i), result: { rowCount: 1 } },
  ]);
  const r = await wh.handleAssignment(client, { conversationUid: 'pod_cnv_00001', assignedUserUid: 'pod_usr_bENjin' });
  check('assignment: resolves Podium uid → portal user', r.portalUserId === 'BN');
  check('assignment: mirrors owner onto the lead', r.action === 'mirrored_assignment');
  const upd = client.calls.find((c) => /UPDATE leads/i.test(c.sql));
  check('assignment: UPDATE leads sets owner from resolved user', upd && upd.params[0] === 'BN' && upd.params[1] === 'pod_cnv_00001');
}

// 4f. portalUserForPodiumUid — 42703 (column absent) → null, not a throw
{
  const client = makeClient([{ match: has(/SELECT id FROM users/i), throws: Object.assign(new Error('col'), { code: '42703' }) }]);
  const id = await wh.portalUserForPodiumUid(client, 'pod_usr_x');
  check('resolve: null (not error) when podium_user_id column absent (42703)', id === null);
}

// 4g. Reply-advances-lead (message.sent) — hybrid funnel automation
// A human reply on an open 'New' lead → advance to 'Contacted' (+ stage log).
{
  const client = makeClient([
    { match: has(/SELECT lead_id, stage FROM leads/i), result: { rowCount: 1, rows: [{ lead_id: 810, stage: 'New' }] } },
    { match: has(/SELECT id FROM users/i), result: { rowCount: 1, rows: [{ id: 'AM' }] } },
    { match: has(/UPDATE leads SET stage = 'Contacted'/i), result: { rowCount: 1 } },
    { match: has(/INSERT INTO lead_stage_log/i), result: { rowCount: 1 } },
  ]);
  const r = await wh.handleMessageSent(client, { conversationUid: 'pod_cnv_a', senderUserUid: 'pod_usr_amELia', channelType: 'phone' });
  check('reply: advances an open New lead → Contacted', r.action === 'advanced_lead' && r.leadId === 810);
  const log = client.calls.find((c) => /INSERT INTO lead_stage_log/i.test(c.sql));
  check('reply: writes a New→Contacted stage log by the replying rep', log && /'New', 'Contacted'/.test(log.sql) && log.params[1] === 'AM');
}
// A reply on a lead already past New → touch only (no regress, no duplicate log).
{
  const client = makeClient([
    { match: has(/SELECT lead_id, stage FROM leads/i), result: { rowCount: 1, rows: [{ lead_id: 811, stage: 'Contacted' }] } },
    { match: has(/SELECT id FROM users/i), result: { rowCount: 1, rows: [{ id: 'AM' }] } },
    { match: has(/UPDATE leads SET last_contact_at/i), result: { rowCount: 1 } },
  ]);
  const r = await wh.handleMessageSent(client, { conversationUid: 'pod_cnv_b', senderUserUid: 'pod_usr_amELia' });
  check('reply: already-engaged lead is only touched', r.action === 'touched_lead' && r.leadId === 811);
  check('reply: no stage log + no stage change when already past New', !client.calls.some((c) => /INSERT INTO lead_stage_log/i.test(c.sql)) && !client.calls.some((c) => /SET stage =/i.test(c.sql)));
}
// A reply with NO open lead (rep-initiated outreach) → create one at Contacted.
{
  const client = makeClient([
    { match: has(/SELECT lead_id, stage FROM leads/i), result: { rowCount: 0, rows: [] } },
    { match: has(/SELECT id FROM users/i), result: { rowCount: 1, rows: [{ id: 'AM' }] } },
    { match: has(/SELECT id FROM customers/i), result: { rowCount: 0, rows: [] } },
    { match: has(/INSERT INTO leads/i), result: { rowCount: 1, rows: [{ lead_id: 812 }] } },
    { match: has(/INSERT INTO lead_stage_log/i), result: { rowCount: 1 } },
  ]);
  const r = await wh.handleMessageSent(client, { conversationUid: 'pod_cnv_c', senderUserUid: 'pod_usr_amELia', channelType: 'sms' });
  check('reply: creates a lead at Contacted when none open (rep-initiated)', r.action === 'created_lead' && r.leadId === 812);
  const ins = client.calls.find((c) => /INSERT INTO leads/i.test(c.sql));
  check('reply: new lead is Contacted, on the conversation, owned by the rep', ins && /'Contacted'/.test(ins.sql) && ins.params[1] === 'pod_cnv_c' && ins.params[4] === 'AM');
}
// Automated/AI reply (Jerry, F16) → never advances the funnel.
{
  const client = makeClient();
  const r = await wh.handleMessageSent(client, { conversationUid: 'pod_cnv_d', automated: true });
  check('reply: automated/AI send is skipped (no funnel change)', r.action === 'skipped_automated' && client.calls.length === 0);
}
// No conversation uid → skipped.
{
  const r = await wh.handleMessageSent(makeClient(), { conversationUid: null });
  check('reply: skipped when no conversation uid', r.action === 'skipped_no_conversation');
}
// Sender absent → fall back to the conversation assignee as the actor.
{
  const client = makeClient([
    { match: has(/SELECT lead_id, stage FROM leads/i), result: { rowCount: 1, rows: [{ lead_id: 813, stage: 'New' }] } },
    { match: has(/SELECT id FROM users/i), result: { rowCount: 1, rows: [{ id: 'BN' }] } },
    { match: has(/UPDATE leads SET stage = 'Contacted'/i), result: { rowCount: 1 } },
    { match: has(/INSERT INTO lead_stage_log/i), result: { rowCount: 1 } },
  ]);
  const r = await wh.handleMessageSent(client, { conversationUid: 'pod_cnv_e', senderUserUid: null, assignedUserUid: 'pod_usr_bENjin' });
  check('reply: actor falls back to the assignee when no sender uid', r.action === 'advanced_lead');
  const log = client.calls.find((c) => /INSERT INTO lead_stage_log/i.test(c.sql));
  check('reply: stage log attributed to the fallback assignee', log && log.params[1] === 'BN');
}

// ============================================================================
// 5. processEvent — dedupe, commit, rollback
// ============================================================================
// 5a. fresh message.received → BEGIN, insert log, route, mark, COMMIT
{
  const client = makeClient([
    { match: has(/INSERT INTO integration_sync_log/i), result: { rowCount: 1, rows: [{ id: 99 }] } },
    { match: has(/SELECT lead_id FROM leads/i), result: { rowCount: 0, rows: [] } },
    { match: has(/SELECT id FROM users/i), result: { rowCount: 1, rows: [{ id: 'AM' }] } },
    { match: has(/SELECT id FROM customers/i), result: { rowCount: 0, rows: [] } },
    { match: has(/INSERT INTO leads/i), result: { rowCount: 1, rows: [{ lead_id: 601 }] } },
    { match: has(/INSERT INTO lead_stage_log/i), result: { rowCount: 1 } },
    { match: has(/UPDATE integration_sync_log/i), result: { rowCount: 1 } },
  ]);
  const env = { eventUid: 'evt_fresh', eventType: 'message.received', conversationUid: 'pod_cnv_z', channelType: 'sms', assignedUserUid: 'pod_usr_amELia' };
  const r = await wh.processEvent(client, env);
  check('processEvent: fresh event is processed (not deduped)', r.deduped === false && r.action === 'created_lead');
  check('processEvent: wrapped in a transaction (BEGIN + COMMIT)', client.calls.some((c) => /^BEGIN/i.test(c.sql)) && client.calls.some((c) => /^COMMIT/i.test(c.sql)));
  check('processEvent: marks sync-log status processed', client.calls.some((c) => /UPDATE integration_sync_log/i.test(c.sql)));
}

// 5b. duplicate eventUid → insert returns 0 rows → deduped, no routing, COMMIT
{
  const client = makeClient([
    { match: has(/INSERT INTO integration_sync_log/i), result: { rowCount: 0, rows: [] } },
  ]);
  const r = await wh.processEvent(client, { eventUid: 'evt_dupe', eventType: 'message.received', conversationUid: 'pod_cnv_z' });
  check('processEvent: duplicate short-circuits (deduped)', r.deduped === true);
  check('processEvent: duplicate does NOT route (no lead queries)', !client.calls.some((c) => /FROM leads|INTO leads/i.test(c.sql)));
}

// 5c. message.failed → status 'failed', no lead mutation
{
  const client = makeClient([
    { match: has(/INSERT INTO integration_sync_log/i), result: { rowCount: 1, rows: [{ id: 42 }] } },
    { match: has(/UPDATE integration_sync_log/i), result: { rowCount: 1 } },
  ]);
  const r = await wh.processEvent(client, { eventUid: 'evt_fail', eventType: 'message.failed', conversationUid: 'pod_cnv_z', failureReason: 'landline' });
  check('processEvent: message.failed routes to failed status', r.status === 'failed' && r.action === 'recorded_failure');
  const mark = client.calls.find((c) => /UPDATE integration_sync_log/i.test(c.sql));
  check('processEvent: sync-log marked failed', mark && mark.params[0] === 'failed');
}

// 5d. routing throws → ROLLBACK + rethrow (dedupe claim released for retry)
{
  const client = makeClient([
    { match: has(/INSERT INTO integration_sync_log/i), result: { rowCount: 1, rows: [{ id: 7 }] } },
    { match: has(/SELECT lead_id FROM leads/i), throws: Object.assign(new Error('boom'), { code: 'XX000' }) },
  ]);
  let threw = false;
  try {
    await wh.processEvent(client, { eventUid: 'evt_err', eventType: 'message.received', conversationUid: 'pod_cnv_z' });
  } catch { threw = true; }
  check('processEvent: rethrows on handler failure', threw === true);
  check('processEvent: ROLLBACK issued on failure (releases dedupe row)', client.calls.some((c) => /^ROLLBACK/i.test(c.sql)));
  check('processEvent: did NOT COMMIT on failure', !client.calls.some((c) => /^COMMIT/i.test(c.sql)));
}

// ============================================================================
// 6. Endpoint gates (all reached BEFORE any DB access → offline-safe)
// ============================================================================
function makeRes() {
  return {
    statusCode: 0, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
  };
}
// A minimal Vercel-style req that is also async-iterable (raw body stream).
function makeReq({ method = 'POST', headers = {}, raw = '' } = {}) {
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() { if (raw) yield Buffer.from(raw, 'utf8'); },
  };
}

{
  const res = makeRes();
  await webhookHandler(makeReq({ method: 'GET' }), res);
  check('endpoint: GET → 405', res.statusCode === 405 && res.headers.Allow === 'POST');
}
{
  const prev = process.env.PODIUM_WEBHOOK_SECRET;
  delete process.env.PODIUM_WEBHOOK_SECRET;
  const res = makeRes();
  await webhookHandler(makeReq({ method: 'POST', raw: '{}' }), res);
  check('endpoint: POST without secret configured → 503', res.statusCode === 503);
  if (prev !== undefined) process.env.PODIUM_WEBHOOK_SECRET = prev;
}
{
  process.env.PODIUM_WEBHOOK_SECRET = SECRET;
  const res = makeRes();
  const raw = JSON.stringify({ metadata: { eventUid: 'x', eventType: 'message.received' } });
  const ts = String(Math.floor(Date.now() / 1000));
  // Wrong signature → 401 (reached before DB)
  await webhookHandler(makeReq({ method: 'POST', raw, headers: { 'podium-signature': 'deadbeef', 'podium-timestamp': ts } }), res);
  check('endpoint: POST bad signature → 401', res.statusCode === 401 && res.body?.reason === 'bad_signature');
}
{
  process.env.PODIUM_WEBHOOK_SECRET = SECRET;
  const res = makeRes();
  const raw = JSON.stringify({ metadata: { eventUid: 'x', eventType: 'message.received' } });
  // Missing headers → 401 missing_headers (reached before DB)
  await webhookHandler(makeReq({ method: 'POST', raw }), res);
  check('endpoint: POST missing signature headers → 401', res.statusCode === 401 && res.body?.reason === 'missing_headers');
}

// 5e. fresh message.sent → routes to reply-advance, marks processed, COMMIT
{
  const client = makeClient([
    { match: has(/INSERT INTO integration_sync_log/i), result: { rowCount: 1, rows: [{ id: 71 }] } },
    { match: has(/SELECT lead_id, stage FROM leads/i), result: { rowCount: 1, rows: [{ lead_id: 900, stage: 'New' }] } },
    { match: has(/SELECT id FROM users/i), result: { rowCount: 1, rows: [{ id: 'AM' }] } },
    { match: has(/UPDATE leads SET stage = 'Contacted'/i), result: { rowCount: 1 } },
    { match: has(/INSERT INTO lead_stage_log/i), result: { rowCount: 1 } },
    { match: has(/UPDATE integration_sync_log/i), result: { rowCount: 1 } },
  ]);
  const r = await wh.processEvent(client, { eventUid: 'evt_sent', eventType: 'message.sent', conversationUid: 'pod_cnv_z', senderUserUid: 'pod_usr_amELia' });
  check('processEvent: message.sent advances the lead (not deduped)', r.deduped === false && r.action === 'advanced_lead');
  check('processEvent: message.sent commits', client.calls.some((c) => /^COMMIT/i.test(c.sql)));
}

console.log(`\nAll ${passed} checks passed ✅`);
