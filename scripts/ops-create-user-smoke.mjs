// scripts/ops-create-user-smoke.mjs — offline smoke for G6 (Nick, 28 Sep 2026):
// "creating a new user from the superadmin view fails".
//
// Root cause (reproduced on Neon dev, 1 Oct 2026): `users.access` is the Postgres enum
// `user_access_level` = superadmin | admin | staff | technician | it-technician. The role
// picker also offers logistics / sales / workshop (F0b roles that live in `user_roles`), and
// the handler wrote primaryRole(roles) straight into `users.access` — so a user whose
// highest role is one of those three died with 22P02 and the page showed "Server error".
//
// The fake client below ENFORCES that enum, so these checks fail the same way the real
// database does.
//
//   node scripts/ops-create-user-smoke.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ROLES, LEGACY_ACCESS_LEVELS, legacyAccessFor, syncUserRoles } from '../lib/rbac.js';
import { registerUser } from '../lib/usersAdmin.js';

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// The real enum on prod + dev (queried 1 Oct 2026).
const DB_ENUM = ['superadmin', 'admin', 'staff', 'technician', 'it-technician'];

// A tiny in-memory `users` + `user_roles` that behaves like Postgres where it matters here.
function makeDb(seed = []) {
  const users = new Map(seed.map((u) => [u.id, { ...u }]));
  const roles = [];
  const calls = [];
  const pgErr = (code, message) => Object.assign(new Error(message), { code });
  return {
    users, roles, calls,
    async query(text, params = []) {
      calls.push({ text, params });
      const sql = text.replace(/\s+/g, ' ').trim();
      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql)) return { rows: [] };
      if (/^SELECT 1 FROM users WHERE lower\(email\) = lower\(\$1\)/i.test(sql)) {
        const hit = [...users.values()].some((u) => u.email.toLowerCase() === String(params[0]).toLowerCase());
        return { rows: hit ? [{ '?column?': 1 }] : [] };
      }
      if (/^SELECT 1 FROM users WHERE id = \$1/i.test(sql)) {
        return { rows: users.has(params[0]) ? [{ '?column?': 1 }] : [] };
      }
      if (/^INSERT INTO users/i.test(sql)) {
        const [id, name, email, password, access] = params;
        if (String(id).length > 2) throw pgErr('22001', 'value too long for type character varying(2)');
        if (!DB_ENUM.includes(access)) throw pgErr('22P02', `invalid input value for enum user_access_level: "${access}"`);
        if (users.has(id)) throw pgErr('23505', 'duplicate key value violates unique constraint "users_pkey"');
        users.set(id, { id, name, email, password, access });
        return { rows: [] };
      }
      if (/^DELETE FROM user_roles WHERE user_id = \$1/i.test(sql)) {
        for (let i = roles.length - 1; i >= 0; i -= 1) if (roles[i].user_id === params[0]) roles.splice(i, 1);
        return { rows: [] };
      }
      if (/^INSERT INTO user_roles/i.test(sql)) {
        roles.push({ user_id: params[0], role: params[1], granted_by: params[2] });
        return { rows: [] };
      }
      if (/^DELETE FROM users WHERE id = \$1/i.test(sql)) {
        users.delete(params[0]);
        return { rows: [] };
      }
      throw new Error(`unexpected SQL in smoke: ${sql}`);
    },
  };
}

const deps = { hash: async (pw) => `hashed(${pw})` };
const body = (over = {}) => ({ id: 'ZZ', name: 'Zed Zebra', email: 'zed@graysfitness.com.au', password: 'pw-123456', roles: ['staff'], ...over });
const rolesOf = (db, id) => db.roles.filter((r) => r.user_id === id).map((r) => r.role).sort().join(',');

console.log('G6 create-user smoke — fake DB that enforces the user_access_level enum\n');

console.log('users.access is always an enum-safe value:');
{
  check('LEGACY_ACCESS_LEVELS ⊆ the DB enum', LEGACY_ACCESS_LEVELS.every((a) => DB_ENUM.includes(a)));
  for (const role of ROLES) {
    check(`legacyAccessFor(['${role}']) is in the enum`, DB_ENUM.includes(legacyAccessFor([role])), legacyAccessFor([role]));
  }
  check("['logistics'] → staff", legacyAccessFor(['logistics']) === 'staff');
  check("['sales','logistics'] → staff", legacyAccessFor(['sales', 'logistics']) === 'staff');
  check("['workshop'] → staff", legacyAccessFor(['workshop']) === 'staff');
  check("['logistics','technician'] → technician (keeps the technician dropdown working)", legacyAccessFor(['logistics', 'technician']) === 'technician');
  check("['logistics','admin'] → admin", legacyAccessFor(['logistics', 'admin']) === 'admin');
  check("['sales','superadmin'] → superadmin", legacyAccessFor(['sales', 'superadmin']) === 'superadmin');
  check('[] → staff', legacyAccessFor([]) === 'staff');
}

console.log('\na superadmin can create a user with EACH role:');
for (const role of ROLES) {
  const db = makeDb();
  const out = await registerUser(db, body({ roles: [role] }), 'GS', deps);
  check(`200 for ${role}`, out.status === 200, JSON.stringify(out.body));
  check(`  ${role}: user row written, password hashed`, db.users.get('ZZ')?.password === 'hashed(pw-123456)');
  check(`  ${role}: user_roles = [${role}], granted_by = acting admin`, rolesOf(db, 'ZZ') === role && db.roles.every((r) => r.granted_by === 'GS'));
}

console.log('\nmulti-role:');
{
  const db = makeDb();
  const out = await registerUser(db, body({ roles: ['sales', 'logistics'] }), 'GS', deps);
  check('200 for sales + logistics', out.status === 200, JSON.stringify(out.body));
  check('both roles stored', rolesOf(db, 'ZZ') === 'logistics,sales');
  check('response echoes the role set', out.body.roles.slice().sort().join(',') === 'logistics,sales');
}
{
  const db = makeDb();
  const out = await registerUser(db, body({ roles: undefined, access: 'technician' }), 'GS', deps);
  check('legacy single `access` body still works', out.status === 200 && db.users.get('ZZ').access === 'technician' && rolesOf(db, 'ZZ') === 'technician');
}

console.log('\nreal validation problems get a clear message, not "Server error":');
{
  const db = makeDb([{ id: 'AA', name: 'A', email: 'Taken@graysfitness.com.au', password: 'x', access: 'staff' }]);
  const dupEmail = await registerUser(db, body({ email: 'taken@graysfitness.com.au' }), 'GS', deps);
  check('409 duplicate email (case-insensitive)', dupEmail.status === 409 && /email/i.test(dupEmail.body.error));
  const dupId = await registerUser(db, body({ id: 'AA' }), 'GS', deps);
  check('409 duplicate user ID', dupId.status === 409 && /ID/.test(dupId.body.error), JSON.stringify(dupId.body));
  check('no INSERT attempted for either duplicate', !db.calls.some((c) => /INSERT INTO users/i.test(c.text)));
}
for (const [label, over, re] of [
  ['missing ID', { id: '' }, /ID/],
  ['3-character ID', { id: 'ABC' }, /2 characters/],
  ['missing name', { name: '  ' }, /name/i],
  ['missing email', { email: '' }, /email/i],
  ['malformed email', { email: 'not-an-email' }, /email/i],
  ['missing password', { password: '' }, /password/i],
]) {
  const db = makeDb();
  const out = await registerUser(db, body(over), 'GS', deps);
  check(`400 for ${label} — and no query ran`, out.status === 400 && re.test(out.body.error) && db.calls.length === 0, JSON.stringify(out.body));
}
{
  // Lost race: the ID is taken between the pre-check and the INSERT.
  const db = makeDb();
  const realQuery = db.query.bind(db);
  db.query = async (text, params) => {
    if (/^\s*INSERT INTO users/i.test(text)) throw Object.assign(new Error('dup'), { code: '23505' });
    return realQuery(text, params);
  };
  const out = await registerUser(db, body(), 'GS', deps);
  check('409 (not 500) when the INSERT hits a unique violation', out.status === 409);
}
{
  const db = makeDb();
  const out = await registerUser(db, body({ id: ' zz ' }), 'GS', deps);
  check('ID is trimmed', out.status === 200 && db.users.has('zz'));
}

console.log('\nno half-created user if the role write fails:');
{
  const db = makeDb();
  const boom = async () => { throw Object.assign(new Error('boom'), { code: 'XX000' }); };
  let threw = false;
  try { await registerUser(db, body({ roles: ['logistics'] }), 'GS', { ...deps, syncUserRoles: boom }); } catch { threw = true; }
  check('the error still surfaces', threw);
  check('the user row was removed again (retry is not blocked by "email already registered")', !db.users.has('ZZ'));
}

console.log('\nwiring — api/[...path].js uses the tested code on create AND edit:');
{
  const src = readFileSync(fileURLToPath(new URL('../api/[...path].js', import.meta.url)), 'utf8');
  check('register calls registerUser', /registerUser\(\s*client\s*,\s*req\.body\s*,\s*gate\.auth\.id/.test(src));
  check('no raw INSERT INTO users left in the catch-all', !/INSERT\s+INTO\s+users\b/i.test(src));
  check('edit (PUT) writes legacyAccessFor(roles) into users.access', /primary:\s*legacyAccessFor\(roles\)/.test(src));
  check('primaryRole(roles) is no longer passed to buildUserUpdate', !/buildUserUpdate\(\{[^}]*\bprimary\b\s*,/.test(src));
}

console.log(`\n✅ G6 create-user smoke: ${passed} checks passed`);
