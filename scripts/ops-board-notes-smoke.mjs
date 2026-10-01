// scripts/ops-board-notes-smoke.mjs — offline smoke for G7 (Nick, 28 Sep 2026): the shared
// notes panel on the To-Be-Booked deliveries tab ("when drivers are coming in next").
//
//   GET /api/delivery?resource=board-notes   anyone on the tab reads the note (no token)
//   PUT /api/delivery?resource=board-notes   logistics / admin / superadmin save it
//
// Exercises lib/deliveryBoardNotes.js with a fake pg client that behaves like the one table
// it touches — no network, no database, no secrets.
//
//   node scripts/ops-board-notes-smoke.mjs

process.env.JWT_SECRET = process.env.JWT_SECRET || 'smoke_secret';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const jwt = (await import('jsonwebtoken')).default;
const { handleBoardNotes, BOARD_NOTES_EDIT_ROLES, BOARD_NOTE_MAX_LENGTH } = await import('../lib/deliveryBoardNotes.js');

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const USERS = { GS: 'Nick Enrique Wijaya', GA: 'Vincent Ly', GL: 'Shaun Cronin' };

// One in-memory delivery_board_notes table. `missing: true` = prod before the migration.
function makeClient({ missing = false, row = null } = {}) {
  const state = { row: row ? { ...row } : null };
  const calls = [];
  const undefinedTable = () => Object.assign(new Error('relation "delivery_board_notes" does not exist'), { code: '42P01' });
  const joined = () => (state.row ? [{ ...state.row, updated_by_name: USERS[state.row.updated_by] || null }] : []);
  return {
    state, calls,
    async query(text, params = []) {
      calls.push({ text, params });
      const sql = text.replace(/\s+/g, ' ').trim();
      if (!/delivery_board_notes/.test(sql)) throw new Error(`unexpected SQL in smoke: ${sql}`);
      if (missing) throw undefinedTable();
      if (/^SELECT/i.test(sql)) return { rows: joined() };
      if (/^INSERT INTO delivery_board_notes/i.test(sql)) {
        const [board, body, userId, baseVersion] = params;
        if (params.length !== 4 || !Number.isInteger(baseVersion)) throw new Error('smoke: upsert expects (board, body, user, int version)');
        if (!state.row) {
          state.row = { board, body, updated_by: userId, updated_at: new Date('2026-10-01T04:00:00Z'), version: 1 };
          return { rows: [{ version: 1 }] };
        }
        if (baseVersion === state.row.version) {
          state.row = { ...state.row, body, updated_by: userId, updated_at: new Date('2026-10-01T05:00:00Z'), version: state.row.version + 1 };
          return { rows: [{ version: state.row.version }] };
        }
        return { rows: [] }; // ON CONFLICT ... WHERE did not match → somebody saved first
      }
      throw new Error(`unexpected SQL in smoke: ${sql}`);
    },
  };
}

function makeReq({ method = 'GET', roles = ['admin'], id = 'GL', body = {}, noAuth = false, query = { resource: 'board-notes' } } = {}) {
  const headers = {};
  if (!noAuth) headers.authorization = `Bearer ${jwt.sign({ id, email: 'x@graysfitness.com.au', roles }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
  return { method, headers, query, body };
}
function makeRes() {
  return {
    statusCode: 0, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
  };
}
async function run(client, reqOpts) {
  const res = makeRes();
  await handleBoardNotes(makeReq(reqOpts), res, client);
  return res;
}
const isWrite = (c) => /^\s*(INSERT|UPDATE|DELETE)/i.test(c.text);

console.log('G7 board-notes smoke — fake client, no DB\n');

console.log('reading:');
{
  // Token-less on purpose: the 1h JWT expires mid-shift but the tab's other reads keep working.
  const client = makeClient({ row: { board: 'to-be-booked', body: 'Nelson — Thu 2 Oct AM', updated_by: 'GA', updated_at: new Date('2026-10-01T03:00:00Z'), version: 3 } });
  const res = await run(client, { noAuth: true });
  check('readable without a token (like the rest of the tab)', res.statusCode === 200 && res.body.body === 'Nelson — Thu 2 Oct AM');
  const expired = makeReq();
  expired.headers.authorization = 'Bearer not.a.valid-token';
  const res2 = makeRes();
  await handleBoardNotes(expired, res2, client);
  check('…and with an expired/garbage token', res2.statusCode === 200);
}
for (const role of ['technician', 'staff', 'sales', 'workshop', 'logistics', 'admin', 'superadmin']) {
  const client = makeClient({ row: { board: 'to-be-booked', body: 'Nelson — Thu 2 Oct AM', updated_by: 'GA', updated_at: new Date('2026-10-01T03:00:00Z'), version: 3 } });
  const res = await run(client, { roles: [role] });
  check(`${role} can read the note`, res.statusCode === 200 && res.body.body === 'Nelson — Thu 2 Oct AM' && res.body.available === true);
  check(`  ${role}: read issues exactly ONE statement, and it is a SELECT`, client.calls.length === 1 && !client.calls.some(isWrite));
}
{
  const client = makeClient({ row: { board: 'to-be-booked', body: 'x', updated_by: 'GA', updated_at: new Date('2026-10-01T03:00:00Z'), version: 3 } });
  const res = await run(client);
  check('shows who edited last (id + name) and when + version', res.body.updated_by === 'GA' && res.body.updated_by_name === 'Vincent Ly' && res.body.version === 3 && !!res.body.updated_at);
}
{
  const res = await run(makeClient());
  check('no note yet → empty body, version 0', res.statusCode === 200 && res.body.body === '' && res.body.version === 0 && res.body.available === true);
}
{
  const res = await run(makeClient({ missing: true }));
  check('table not migrated (42P01) → 200 with available:false, not a 500', res.statusCode === 200 && res.body.available === false && res.body.body === '');
}

console.log('\nwho may edit:');
check('edit roles = logistics, admin, superadmin', BOARD_NOTES_EDIT_ROLES.join(',') === 'logistics,admin,superadmin');
for (const role of ['technician', 'staff', 'sales', 'workshop']) {
  const client = makeClient();
  const res = await run(client, { method: 'PUT', roles: [role], body: { body: 'hi', base_version: 0 } });
  check(`403 for ${role} — and no query ran`, res.statusCode === 403 && client.calls.length === 0);
}
{
  const client = makeClient();
  const res = await run(client, { method: 'PUT', noAuth: true, body: { body: 'hi', base_version: 0 } });
  check('401 PUT without a token — and no query ran', res.statusCode === 401 && client.calls.length === 0);
}
for (const role of BOARD_NOTES_EDIT_ROLES) {
  const client = makeClient();
  const res = await run(client, { method: 'PUT', roles: [role], id: 'GL', body: { body: 'Cobbs — next Tues', base_version: 0 } });
  check(`${role} can save`, res.statusCode === 200 && client.state.row.body === 'Cobbs — next Tues', JSON.stringify(res.body));
  check(`  ${role}: stamped with the ACTING user from the token`, client.state.row.updated_by === 'GL' && res.body.updated_by === 'GL' && res.body.updated_by_name === 'Shaun Cronin');
}

console.log('\nsaving:');
{
  const client = makeClient({ row: { board: 'to-be-booked', body: 'old', updated_by: 'GA', updated_at: new Date('2026-10-01T03:00:00Z'), version: 3 } });
  const res = await run(client, { method: 'PUT', body: { body: 'new\nline two', base_version: 3 } });
  check('save on the version I opened → 200, version bumps', res.statusCode === 200 && res.body.version === 4 && res.body.body === 'new\nline two');
  check('multi-line text is kept as-is', client.state.row.body === 'new\nline two');
  const writes = client.calls.filter(isWrite);
  check('exactly one write statement, to delivery_board_notes only', writes.length === 1 && /delivery_board_notes/.test(writes[0].text) && !/\b(delivery|workorder|workorder_items|workorder_logs)\b(?!_board)/i.test(writes[0].text.replace(/delivery_board_notes/g, '')));
}
{
  const client = makeClient({ row: { board: 'to-be-booked', body: 'theirs', updated_by: 'GA', updated_at: new Date('2026-10-01T03:00:00Z'), version: 5 } });
  const res = await run(client, { method: 'PUT', body: { body: 'mine', base_version: 3 } });
  check('someone saved since I opened it → 409, nothing overwritten', res.statusCode === 409 && client.state.row.body === 'theirs');
  check('  the 409 carries their note so the page can show it', res.body.current?.body === 'theirs' && res.body.current?.updated_by_name === 'Vincent Ly' && res.body.current?.version === 5);
  const blind = await run(client, { method: 'PUT', body: { body: 'mine', base_version: 3, force: true } });
  check('  there is NO blind force — `force` is ignored, still 409', blind.statusCode === 409 && client.state.row.body === 'theirs');
  const overwrite = await run(client, { method: 'PUT', body: { body: 'mine', base_version: 5 } });
  check('  "Overwrite with mine" = saving on the version I was SHOWN', overwrite.statusCode === 200 && client.state.row.body === 'mine' && overwrite.body.version === 6);
  const third = await run(client, { method: 'PUT', body: { body: 'late', base_version: 5 } });
  check('  …so a third save in between is caught too', third.statusCode === 409 && client.state.row.body === 'mine');
}
{
  const client = makeClient({ row: { board: 'to-be-booked', body: 'theirs', updated_by: 'GA', updated_at: new Date(), version: 1 } });
  const res = await run(client, { method: 'PUT', body: { body: 'mine', base_version: 0 } });
  check('I opened an empty panel but a note exists now → 409', res.statusCode === 409 && client.state.row.body === 'theirs');
}
{
  const client = makeClient();
  const res = await run(client, { method: 'PUT', body: { body: '   ', base_version: 0 } });
  check('clearing the note is allowed (saves empty)', res.statusCode === 200 && client.state.row.body === '');
}
{
  const client = makeClient();
  const tooLong = await run(client, { method: 'PUT', body: { body: 'x'.repeat(BOARD_NOTE_MAX_LENGTH + 1), base_version: 0 } });
  check(`400 over ${BOARD_NOTE_MAX_LENGTH} characters — and no query ran`, tooLong.statusCode === 400 && client.calls.length === 0);
  const notText = await run(client, { method: 'PUT', body: { body: { evil: true }, base_version: 0 } });
  check('400 when body is not text — and no query ran', notText.statusCode === 400 && client.calls.length === 0);
  for (const bad of ['3', true, [5], 1.5, -1, 1e10, { v: 1 }]) {
    const r = await run(client, { method: 'PUT', body: { body: 'hi', base_version: bad } });
    check(`400 for base_version ${JSON.stringify(bad)} — and no query ran`, r.statusCode === 400 && client.calls.length === 0);
  }
  const nul = makeClient();
  const nulRes = await run(nul, { method: 'PUT', body: { body: 'a\u0000b', base_version: 0 } });
  check('a NUL character is dropped, not a 500', nulRes.statusCode === 200 && nul.state.row.body === 'ab');
  const atCap = await run(client, { method: 'PUT', body: { body: 'x'.repeat(BOARD_NOTE_MAX_LENGTH), base_version: 0 } });
  check('exactly at the cap is accepted', atCap.statusCode === 200);
}
{
  const client = makeClient({ missing: true });
  const res = await run(client, { method: 'PUT', body: { body: 'hi', base_version: 0 } });
  check('table not migrated → 503 with a plain message, not a 500', res.statusCode === 503 && /not (set up|available)/i.test(res.body.error));
}
for (const method of ['POST', 'PATCH', 'DELETE']) {
  const client = makeClient();
  const res = await run(client, { method });
  check(`405 for ${method} — and no query ran`, res.statusCode === 405 && client.calls.length === 0);
}
{
  const client = makeClient();
  const res = await run(client, { query: { resource: 'board-notes', board: 'something-else' } });
  check('400 for an unknown board — and no query ran', res.statusCode === 400 && client.calls.length === 0);
}
{
  const client = makeClient();
  client.query = async () => { throw Object.assign(new Error('boom'), { code: 'XX000' }); };
  let threw = false;
  try { await run(client); } catch { threw = true; }
  check('an unexpected DB error is NOT swallowed as "not migrated"', threw);
}

console.log('\nwiring + migration:');
{
  const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
  const handler = read('../lib/handlers/delivery.js');
  const at = handler.indexOf("=== 'board-notes'");
  check('delivery handler routes resource=board-notes to handleBoardNotes', at > 0 && /handleBoardNotes\(req,\s*res,\s*client\)/.test(handler));
  check('…and dispatches it BEFORE the ungated create/read paths', at < handler.indexOf("if (method === 'GET')"));
  // The panel repeats two server constants (CRA can't import from lib/) — keep them honest.
  const panel = read('../src/components/DeliveryBoardNotes.js');
  const clientRoles = /const EDIT_ROLES = \[([^\]]*)\]/.exec(panel)?.[1].replace(/['\s]/g, '');
  check('panel EDIT_ROLES matches the server list', clientRoles === BOARD_NOTES_EDIT_ROLES.join(','), clientRoles);
  check('panel MAX_LENGTH matches the server cap', new RegExp(`const MAX_LENGTH = ${BOARD_NOTE_MAX_LENGTH};`).test(panel));
  const up = read('../db/migrations/0007_delivery_board_notes.sql');
  const down = read('../db/migrations/0007_delivery_board_notes_down.sql');
  check('migration is additive + idempotent', /CREATE TABLE IF NOT EXISTS delivery_board_notes/.test(up) && !/\b(DROP|ALTER TABLE (?!delivery_board_notes))/i.test(up));
  check('paired down migration drops only this table', /DROP TABLE IF EXISTS delivery_board_notes/.test(down) && (down.match(/DROP /g) || []).length === 1);
}

console.log(`\n✅ G7 board-notes smoke: ${passed} checks passed`);
