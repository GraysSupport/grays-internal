// scripts/ops-tech-checklist-smoke.mjs — offline smoke for G16 (Nick, 19 Oct 2026): the
// technician "Screen & Electronics Checklist" for a scanned lot.
//
//   GET /api/lots?resource=tech-checklist&lot_number=L00042   order details + checklist
//   PUT /api/lots?resource=tech-checklist                     save checklist / serials / sign-off
//
// Exercises lib/techChecklist.js with a fake pg client that behaves like the tables it touches
// — no network, no database, no secrets.
//
//   node scripts/ops-tech-checklist-smoke.mjs

process.env.JWT_SECRET = process.env.JWT_SECRET || 'smoke_secret';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const jwt = (await import('jsonwebtoken')).default;
const server = await import('../lib/techChecklist.js');
const client = await import('../src/utils/techChecklist.js');
const {
  handleTechChecklist, CHECK_ITEMS, AUDIO_SUBS, TECH_CHECKLIST_ROLES, WORKSHOP_ACCOUNT_ID,
  splitSerial, combineSerial, unansweredItems,
} = server;

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const USERS = { ED: 'Eden', BR: 'Brodie', GS: 'Nick Enrique Wijaya', WK: 'Workshop' };

const LOT_ASSIGNED = {
  lot_id: 42, lot_number: 'L00042', status: 'Assigned', serial_number: null, product_sku: 'LF-95X',
  product_name: 'Life Fitness 95X Elliptical', product_brand: 'Life Fitness',
  workorder_items_id: 2001, workorder_id: 19422, invoice_id: 'INV-19422', workorder_status: 'Work Ordered',
  estimated_completion: '2026-10-24', item_status: 'In Workshop',
  delivery_suburb: 'Altona North', delivery_state: 'VIC', technician_id: 'ED', item_sn: 'DEC83B18000051 & CONSOLE AZB06195052',
};
const LOT_STOCK = {
  lot_id: 7, lot_number: 'L00007', status: 'In Stock', serial_number: 'OLD-SN', product_sku: 'LF-95T',
  product_name: 'Life Fitness 95T Treadmill', product_brand: 'Life Fitness',
  workorder_items_id: null, workorder_id: null, invoice_id: null, workorder_status: null,
  estimated_completion: null, item_status: null, delivery_suburb: null, delivery_state: null,
  technician_id: null, item_sn: null,
};

const allYes = () => Object.fromEntries(CHECK_ITEMS.map((i) => [i.key, { v: 'yes', note: '' }]));

// In-memory product_lots + workorder_items + lot_checklists + workorder_logs.
// `missing: true` = prod before migration 0009 (lot_checklists does not exist).
function makeClient({ missing = false, lots = [LOT_ASSIGNED, LOT_STOCK], checklist = null } = {}) {
  const state = {
    lots: Object.fromEntries(lots.map((l) => [l.lot_number, { ...l }])),
    checklists: checklist ? { [checklist.lot_id]: { ...checklist } } : {},
    logs: [],
    tx: [],
  };
  const calls = [];
  const undefinedTable = () => Object.assign(new Error('relation "lot_checklists" does not exist'), { code: '42P01' });
  const lotById = (id) => Object.values(state.lots).find((l) => l.lot_id === id);
  return {
    state, calls,
    async query(text, params = []) {
      calls.push({ text, params });
      const sql = text.replace(/\s+/g, ' ').trim();
      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql)) { state.tx.push(sql.toUpperCase()); return { rows: [] }; }
      if (/lot_checklists/.test(sql) && missing) throw undefinedTable();

      if (/^SELECT/i.test(sql) && /FROM product_lots pl/.test(sql) && /pl\.lot_number = \$1/.test(sql)) {
        const l = state.lots[params[0]];
        if (!l) return { rows: [] };
        return { rows: [{ ...l, technician_name: USERS[l.technician_id] || null }] };
      }
      if (/^SELECT/i.test(sql) && /FROM lot_checklists c/.test(sql)) {
        const c = state.checklists[params[0]];
        if (!c) return { rows: [] };
        return { rows: [{ ...c, updated_by_name: USERS[c.updated_by] || null, approved_by_name: USERS[c.approved_by] || null }] };
      }
      if (/^SELECT .* FROM lot_checklists WHERE lot_id = \$1 FOR UPDATE$/i.test(sql)) {
        const c = state.checklists[params[0]];
        return { rows: c ? [{ ...c }] : [] };
      }
      if (/^INSERT INTO lot_checklists/i.test(sql)) {
        const [lotId, wiId, checksJson, testTag, base, cons, comments, ok, approvedBy, approvedAt, userId, baseVersion] = params;
        if (params.length !== 12) throw new Error(`smoke: upsert expects 12 params, got ${params.length}`);
        const checks = JSON.parse(checksJson);
        const row = {
          lot_id: lotId, workorder_items_id: wiId, checks, test_tag_no: testTag, base_serial: base,
          console_serial: cons, comments, ok_to_ship: ok, approved_by: approvedBy,
          approved_at: ok ? (approvedAt || new Date('2026-10-19T03:00:00Z')) : null,
          updated_by: userId, updated_at: new Date('2026-10-19T03:00:00Z'),
        };
        const cur = state.checklists[lotId];
        if (!cur) { state.checklists[lotId] = { ...row, version: 1 }; return { rows: [{ version: 1 }] }; }
        if (cur.version !== baseVersion) return { rows: [] };
        state.checklists[lotId] = { ...cur, ...row, version: cur.version + 1 };
        return { rows: [{ version: cur.version + 1 }] };
      }
      if (/^UPDATE product_lots SET serial_number = \$1/i.test(sql)) {
        const l = lotById(params[1]); if (l) l.serial_number = params[0];
        return { rows: [], rowCount: l ? 1 : 0 };
      }
      if (/^UPDATE workorder_items SET item_sn = \$1/i.test(sql)) {
        const l = Object.values(state.lots).find((x) => x.workorder_items_id === params[1]);
        if (l) l.item_sn = params[0];
        return { rows: [], rowCount: l ? 1 : 0 };
      }
      if (/^INSERT INTO workorder_logs/i.test(sql)) {
        state.logs.push(params);
        return { rows: [] };
      }
      throw new Error(`unexpected SQL in smoke: ${sql}`);
    },
  };
}

function makeReq({ method = 'GET', roles = ['technician'], id = 'ED', body = {}, noAuth = false, query } = {}) {
  const headers = {};
  if (!noAuth) headers.authorization = `Bearer ${jwt.sign({ id, email: 'x@graysfitness.com.au', roles }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
  return { method, headers, query: query || { resource: 'tech-checklist', lot_number: 'L00042' }, body };
}
function makeRes() {
  return {
    statusCode: 0, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
  };
}
async function run(c, opts) {
  const res = makeRes();
  await handleTechChecklist(makeReq(opts), res, c);
  return res;
}
const isWrite = (c) => /^\s*(INSERT|UPDATE|DELETE)/i.test(c.text);
const put = (body, extra = {}) => ({ method: 'PUT', query: { resource: 'tech-checklist' }, body: { lot_number: 'L00042', base_version: 0, ...body }, ...extra });

console.log('G16 tech-checklist smoke — fake client, no DB\n');

console.log('checklist definition:');
check('14 lines, matching the paper tag', CHECK_ITEMS.length === 14 && CHECK_ITEMS[0].label === 'Boots OK' && CHECK_ITEMS.at(-1).key === 'test_tag');
check('audio has 3.5 / BT / SPK sub-ticks', AUDIO_SUBS.map((s) => s.key).join(',') === 'jack,bt,spk');
check('client and server lists are identical', JSON.stringify(client.CHECK_ITEMS) === JSON.stringify(CHECK_ITEMS)
  && JSON.stringify(client.AUDIO_SUBS) === JSON.stringify(AUDIO_SUBS)
  && client.TECH_CHECKLIST_ROLES.join() === TECH_CHECKLIST_ROLES.join()
  && client.WORKSHOP_ACCOUNT_ID === WORKSHOP_ACCOUNT_ID);
check('client unansweredItems is the same rule', JSON.stringify(client.unansweredItems({ boots_ok: { v: 'yes' } })) === JSON.stringify(unansweredItems({ boots_ok: { v: 'yes' } })));

console.log('\nserials:');
{
  const s = splitSerial('DEC83B18000051 & CONSOLE AZB06195052');
  check('"A & CONSOLE B" → base A, console B', s.base_serial === 'DEC83B18000051' && s.console_serial === 'AZB06195052');
  const s2 = splitSerial('AKCGG1119D060 & CONSOLEAZBRE06195052');
  check('"CONSOLE" glued to the number still splits', s2.base_serial === 'AKCGG1119D060' && s2.console_serial === 'AZBRE06195052');
  const s3 = splitSerial('FCQB0015126-181 & FCQB0015157-181');
  check('two unlabelled serials stay together in base (no guessing)', s3.base_serial === 'FCQB0015126-181 & FCQB0015157-181' && s3.console_serial === '');
  check('single serial → base only', splitSerial('PMH113229').base_serial === 'PMH113229' && splitSerial('PMH113229').console_serial === '');
  check('nothing → both blank', splitSerial(null).base_serial === '' && splitSerial('  ').console_serial === '');
  check('combine base + console', combineSerial('A1', 'C2') === 'A1 & CONSOLE C2');
  check('combine base only', combineSerial('A1', '') === 'A1');
  check('combine console only', combineSerial('', 'C2') === 'CONSOLE C2');
  check('combine nothing → null (never erase)', combineSerial(' ', '') === null);
  check('round trip', combineSerial(...Object.values(splitSerial(combineSerial('X9', 'Y8')))) === 'X9 & CONSOLE Y8');
}

console.log('\nwho may use it:');
check('roles = technician, workshop, superadmin', TECH_CHECKLIST_ROLES.join(',') === 'technician,workshop,superadmin');
check('the shared workshop account is WK', WORKSHOP_ACCOUNT_ID === 'WK');
{
  const c = makeClient();
  const res = await run(c, { noAuth: true });
  check('401 without a token — and no query ran', res.statusCode === 401 && c.calls.length === 0);
}
for (const role of ['admin', 'staff', 'sales', 'logistics']) {
  for (const method of ['GET', 'PUT']) {
    const c = makeClient();
    const res = await run(c, method === 'GET' ? { roles: [role], id: 'GA' } : put({ checks: allYes() }, { roles: [role], id: 'GA' }));
    check(`403 for ${role} on ${method} — and no query ran`, res.statusCode === 403 && c.calls.length === 0);
  }
}
for (const [role, id] of [['technician', 'ED'], ['workshop', 'WS'], ['superadmin', 'GS']]) {
  const res = await run(makeClient(), { roles: [role], id });
  check(`${role} can open a lot`, res.statusCode === 200);
}
{
  const res = await run(makeClient(), { roles: ['admin'], id: 'WK' });
  check('the WK workshop account (an admin login) is allowed by id', res.statusCode === 200);
  const res2 = await run(makeClient(), put({ checks: allYes() }, { roles: ['admin'], id: 'WK' }));
  check('…and can save', res2.statusCode === 200);
}

console.log('\nreading a lot:');
{
  const c = makeClient();
  const res = await run(c);
  const b = res.body;
  check('200 with lot + product', res.statusCode === 200 && b.lot.lot_number === 'L00042' && b.lot.product_name === 'Life Fitness 95X Elliptical');
  check('order: workorder, invoice, target completion, item status', b.order.workorder_id === 19422 && b.order.invoice_id === 'INV-19422' && b.order.estimated_completion === '2026-10-24' && b.order.item_status === 'In Workshop');
  check('order: delivering to suburb + state', b.order.delivery_suburb === 'Altona North' && b.order.delivery_state === 'VIC');
  check('order: assigned technician id + name', b.order.technician_id === 'ED' && b.order.technician_name === 'Eden');
  check('no customer data anywhere in the payload', !/customer/i.test(JSON.stringify(b)));
  check('no cost in the payload', !/unit_cost/.test(JSON.stringify(b)));
  check('available, no checklist yet → null', b.available === true && b.checklist === null);
  check('serials pre-filled from the workorder item', b.prefill.base_serial === 'DEC83B18000051' && b.prefill.console_serial === 'AZB06195052');
  check('reads only — every statement is a SELECT', c.calls.length === 2 && !c.calls.some(isWrite));
  check('the lot number is upper-cased + trimmed', c.calls[0].params[0] === 'L00042');
}
{
  const res = await run(makeClient(), { query: { resource: 'tech-checklist', lot_number: ' l00007 ' } });
  check('an in-stock lot opens with order:null', res.statusCode === 200 && res.body.order === null);
  check('…pre-fill falls back to the lot serial', res.body.prefill.base_serial === 'OLD-SN');
}
{
  const c = makeClient({ checklist: {
    lot_id: 42, workorder_items_id: 2001, checks: { ...allYes(), audio: { v: 'yes', note: '', jack: 'yes', bt: 'yes', spk: 'na' } },
    test_tag_no: '555', base_serial: 'B1', console_serial: 'C1', comments: 'MyTrainer removed', ok_to_ship: true,
    approved_by: 'ED', approved_at: new Date('2026-10-18T01:00:00Z'), updated_by: 'BR', updated_at: new Date('2026-10-18T02:00:00Z'), version: 3,
  } });
  const b = (await run(c)).body;
  check('existing checklist returned with version', b.checklist.version === 3 && b.checklist.test_tag_no === '555');
  check('…with approver + last editor names', b.checklist.approved_by_name === 'Eden' && b.checklist.updated_by_name === 'Brodie');
  check('…audio sub-ticks kept', b.checklist.checks.audio.spk === 'na' && b.checklist.checks.audio.jack === 'yes');
  check('…prefill = the checklist serials', b.prefill.base_serial === 'B1' && b.prefill.console_serial === 'C1');
}
{
  const res = await run(makeClient(), { query: { resource: 'tech-checklist', lot_number: 'L99999' } });
  check('404 for an unknown lot', res.statusCode === 404);
  const c = makeClient();
  const r2 = await run(c, { query: { resource: 'tech-checklist' } });
  check('400 with no lot number — and no query ran', r2.statusCode === 400 && c.calls.length === 0);
  const c3 = makeClient();
  const r3 = await run(c3, { query: { resource: 'tech-checklist', lot_number: 'L'.repeat(13) } });
  check('400 for something that is not a lot number', r3.statusCode === 400 && c3.calls.length === 0);
}
{
  const res = await run(makeClient({ missing: true }));
  check('table not migrated (42P01) → 200 available:false, lot + order still shown', res.statusCode === 200 && res.body.available === false && res.body.order.invoice_id === 'INV-19422' && res.body.checklist === null);
}

console.log('\nsaving:');
{
  const c = makeClient();
  const res = await run(c, put({ checks: { boots_ok: { v: 'yes', note: '' }, audio: { v: 'yes', jack: 'yes', bt: 'na', spk: 'nonsense' }, bogus: { v: 'yes' } }, test_tag_no: '555', comments: '  ok  ' }));
  check('first save → 200, version 1', res.statusCode === 200 && res.body.checklist.version === 1);
  check('runs in one transaction', c.state.tx.join() === 'BEGIN,COMMIT');
  const saved = c.state.checklists[42];
  check('unknown keys are dropped', !('bogus' in saved.checks));
  check('every line is present, unanswered = null', CHECK_ITEMS.every((i) => i.key in saved.checks) && saved.checks.touch_cal.v === null);
  check('bad sub-tick value → null', saved.checks.audio.spk === null && saved.checks.audio.jack === 'yes');
  check('text is trimmed', saved.comments === 'ok' && saved.test_tag_no === '555');
  check('the workorder item is recorded', saved.workorder_items_id === 2001);
  check('stamped with who saved it', saved.updated_by === 'ED');
  check('not signed off → no approver, no log row', saved.ok_to_ship === false && saved.approved_by === null && c.state.logs.length === 0);
}
{
  const c = makeClient();
  await run(c, put({ checks: allYes(), base_serial: ' NEWBASE ', console_serial: 'NEWCON' }));
  check('serials written back to the lot', c.state.lots.L00042.serial_number === 'NEWBASE & CONSOLE NEWCON');
  check('…and to the workorder item (same format)', c.state.lots.L00042.item_sn === 'NEWBASE & CONSOLE NEWCON');
}
{
  const c = makeClient();
  await run(c, put({ checks: allYes(), base_serial: '', console_serial: '' }));
  check('blank serials never erase what is there', c.state.lots.L00042.item_sn === 'DEC83B18000051 & CONSOLE AZB06195052' && !c.calls.some((q) => /serial_number = \$1|item_sn = \$1/.test(q.text)));
}
{
  const c = makeClient();
  await run(c, put({ lot_number: 'L00007', checks: allYes(), base_serial: 'S7' }));
  check('an unassigned lot: serial goes to the lot only', c.state.lots.L00007.serial_number === 'S7' && !c.calls.some((q) => /UPDATE workorder_items/.test(q.text)));
}
{
  const c = makeClient({ checklist: { lot_id: 42, workorder_items_id: 2001, checks: allYes(), ok_to_ship: false, approved_by: null, approved_at: null, updated_by: 'BR', updated_at: new Date('2026-10-19T01:00:00Z'), version: 2 } });
  const res = await run(c, put({ checks: allYes(), base_version: 1 }));
  check('stale save → 409 naming who saved', res.statusCode === 409 && /Brodie/.test(res.body.error));
  check('…returns the current checklist', res.body.current?.checklist?.version === 2);
  check('…rolled back, nothing written', c.state.tx.join() === 'BEGIN,ROLLBACK' && c.state.checklists[42].updated_by === 'BR' && c.state.logs.length === 0);
  const ok = await run(c, put({ checks: allYes(), base_version: 2 }));
  check('saving on the version shown succeeds (overwrite)', ok.statusCode === 200 && ok.body.checklist.version === 3);
}

console.log('\nsign-off ("Screen OK to ship"):');
{
  const c = makeClient();
  const checks = allYes(); checks.heart_rate = { v: null, note: '' }; checks.fw_update = { v: '', note: '' };
  const res = await run(c, put({ checks, ok_to_ship: true }));
  check('400 when lines are unanswered — lists them', res.statusCode === 400 && /Heart Rate/.test(res.body.error) && /F\/W Update/.test(res.body.error));
  check('…and nothing ran', c.calls.length === 0);
}
{
  const c = makeClient();
  const checks = allYes(); checks.heart_rate = { v: 'na', note: 'no grips' };
  const res = await run(c, put({ checks, ok_to_ship: true }));
  check('N/A counts as answered → signed', res.statusCode === 200 && res.body.checklist.ok_to_ship === true);
  check('approver = the person who signed', c.state.checklists[42].approved_by === 'ED' && !!c.state.checklists[42].approved_at);
  check('one NOTE_ADDED log row on the workorder item', c.state.logs.length === 1 && c.state.logs[0][0] === 19422 && c.state.logs[0][1] === 2001);
  const logSql = c.calls.find((q) => /INSERT INTO workorder_logs/.test(q.text)).text;
  check('…using an existing enum label (NOTE_ADDED)', /'NOTE_ADDED'/.test(logSql));
  check('…by the signer, mentioning the lot', c.state.logs[0][2] === 'ED' && /L00042/.test(c.state.logs[0][3]) && /OK to ship/.test(c.state.logs[0][3]));
  check('item status is NOT changed', !c.calls.some((q) => /UPDATE workorder_items SET status|item_status\s*=/.test(q.text)));

  const again = await run(c, put({ checks, ok_to_ship: true, base_version: 1 }, { id: 'BR' }));
  check('editing a signed checklist keeps the original approver', again.statusCode === 200 && c.state.checklists[42].approved_by === 'ED' && c.state.checklists[42].updated_by === 'BR');
  check('…and does not log a second sign-off', c.state.logs.length === 1);

  const off = await run(c, put({ checks, ok_to_ship: false, base_version: 2 }));
  check('un-ticking clears the approver', off.statusCode === 200 && c.state.checklists[42].ok_to_ship === false && c.state.checklists[42].approved_by === null);
}
{
  const c = makeClient();
  await run(c, put({ lot_number: 'L00007', checks: allYes(), ok_to_ship: true }));
  check('signing an unassigned lot writes no workorder log', c.state.logs.length === 0 && c.state.checklists[7].ok_to_ship === true);
}

console.log('\nvalidation:');
for (const [name, body, re] of [
  ['bad answer value', { checks: { boots_ok: { v: 'maybe' } } }, /Boots OK/],
  ['note over 200', { checks: { boots_ok: { v: 'yes', note: 'x'.repeat(201) } } }, /200/],
  ['comments over 2000', { checks: {}, comments: 'x'.repeat(2001) }, /2000/],
  ['serial over 60', { checks: {}, base_serial: 'x'.repeat(61) }, /60/],
  ['test & tag over 30', { checks: {}, test_tag_no: 'x'.repeat(31) }, /30/],
  ['checks not an object', { checks: 'yes' }, /checklist/i],
  ['base_version not a whole number', { checks: {}, base_version: '1' }, /base_version/],
  ['ok_to_ship not a boolean', { checks: allYes(), ok_to_ship: 'yes' }, /ok_to_ship/],
  ['no lot number', { lot_number: '', checks: {} }, /lot number/i],
]) {
  const c = makeClient();
  const res = await run(c, put(body));
  check(`400 for ${name} — and nothing ran`, res.statusCode === 400 && re.test(res.body.error) && c.calls.length === 0, JSON.stringify(res.body));
}
{
  const c = makeClient();
  await run(c, put({ checks: { boots_ok: { v: 'yes', note: 'a\u0000b' } }, comments: 'x\u0000y' }));
  check('NUL characters are stripped, not a 500', c.state.checklists[42].checks.boots_ok.note === 'ab' && c.state.checklists[42].comments === 'xy');
}
{
  const c = makeClient();
  const res = await run(c, put({ lot_number: 'L99999', checks: {} }));
  check('404 saving an unknown lot, rolled back', res.statusCode === 404 && c.state.tx.join() === 'BEGIN,ROLLBACK');
}
{
  const c = makeClient({ missing: true });
  const res = await run(c, put({ checks: allYes() }));
  check('table not migrated → 503, rolled back, nothing written', res.statusCode === 503 && c.state.tx.join() === 'BEGIN,ROLLBACK' && c.state.lots.L00042.item_sn === LOT_ASSIGNED.item_sn);
}
for (const method of ['POST', 'DELETE', 'PATCH']) {
  const c = makeClient();
  const res = await run(c, { method });
  check(`405 for ${method} — and no query ran`, res.statusCode === 405 && c.calls.length === 0);
}

console.log('\nrouting:');
{
  const lotsSrc = readFileSync(fileURLToPath(new URL('../lib/handlers/lots.js', import.meta.url)), 'utf8');
  const routeAt = lotsSrc.indexOf("resource === 'tech-checklist'");
  check('lots.js routes resource=tech-checklist to handleTechChecklist', routeAt > 0 && /handleTechChecklist\(req, res, client\)/.test(lotsSrc));
  check('…before the PUBLIC lot_number lookup', routeAt < lotsSrc.indexOf("if (method === 'GET')"));
  check('the page route exists', /path="\/tech-checklist" element=\{<TechChecklistPage \/>\}/.test(readFileSync(fileURLToPath(new URL('../src/App.js', import.meta.url)), 'utf8')));
  check('no new serverless function', !/tech-?checklist/i.test(readFileSync(fileURLToPath(new URL('../api/[...path].js', import.meta.url)), 'utf8')));
}

console.log(`\n${passed} checks passed`);
