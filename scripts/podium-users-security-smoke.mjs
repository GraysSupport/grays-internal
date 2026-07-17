// scripts/podium-users-security-smoke.mjs — offline smoke for the F23 user-admin fixes.
//
// Two pre-existing security faults on /api/users:
//   1. GET returned `SELECT u.*` — including every user's bcrypt password hash — with no
//      auth. The list is fetched token-less by three dropdown pages, so the fix is to stop
//      SELECTing the hash (an allow-list of non-sensitive columns), not to gate the read.
//   2. PUT wrote `password` RAW from the request body. It only "worked" because the admin
//      page round-tripped the hash it read back from that open GET. Once GET stops
//      returning the hash, PUT must (a) NOT blank the password when none is supplied, and
//      (b) HASH a genuinely new one — writing a raw value would lock the user out.
//
// The security-critical logic lives in lib/usersAdmin.js so it can be tested directly,
// with a wiring check that api/[...path].js actually uses it.
//
//   node scripts/podium-users-security-smoke.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { USERS_PUBLIC_COLUMNS, usersSelectList, buildUserUpdate } from '../lib/usersAdmin.js';

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('F23 user-admin security smoke — no DB, no network\n');

console.log('the users list never exposes the password hash:');
{
  check('USERS_PUBLIC_COLUMNS excludes password', !USERS_PUBLIC_COLUMNS.includes('password'));
  check('USERS_PUBLIC_COLUMNS is exactly the non-sensitive columns',
    USERS_PUBLIC_COLUMNS.join(',') === 'id,name,email,access,podium_user_id');
  const aliased = usersSelectList('u');
  check('usersSelectList(alias) prefixes every column', aliased === 'u.id, u.name, u.email, u.access, u.podium_user_id');
  check('usersSelectList(alias) never selects password', !/password/.test(aliased));
  const bare = usersSelectList();
  check('usersSelectList() (fallback, no alias) is safe too', bare === 'id, name, email, access, podium_user_id' && !/password/.test(bare));
}

console.log('\nPUT preserves the password when none is supplied (no lockout after an edit):');
{
  const noPw = await buildUserUpdate({ id: 'GS', name: 'Gray', email: 'g@x.co', primary: 'staff' }, { hash: async () => 'SHOULD_NOT_RUN' });
  check('UPDATE omits password entirely when none is supplied', !/password/.test(noPw.text));
  check('the existing hash is left untouched (id is the WHERE param)', noPw.params[noPw.params.length - 1] === 'GS');
  check('empty-string password is treated as "no change", not a blank-out',
    !/password/.test((await buildUserUpdate({ id: 'GS', name: 'n', email: 'e', primary: 'staff', password: '   ' }, { hash: async () => 'X' })).text));
}

console.log('\nPUT hashes a genuinely new password (never stores it raw):');
{
  let hashedArgs = null;
  const fakeHash = async (pw, rounds) => { hashedArgs = [pw, rounds]; return `HASHED::${pw}`; };
  const withPw = await buildUserUpdate({ id: 'GS', name: 'n', email: 'e', primary: 'staff', password: 'plaintext-secret' }, { hash: fakeHash });
  check('UPDATE sets the password column when a new one is supplied', /password/.test(withPw.text));
  check('the stored value is the HASH, never the raw password', withPw.params.includes('HASHED::plaintext-secret') && !withPw.params.includes('plaintext-secret'));
  check('the password is hashed with cost 10', hashedArgs && hashedArgs[0] === 'plaintext-secret' && hashedArgs[1] === 10);
  check('id is still the WHERE param', withPw.params[withPw.params.length - 1] === 'GS');
}

console.log('\nwiring — api/[...path].js handleUsers actually uses the safe helpers:');
{
  const src = readFileSync(fileURLToPath(new URL('../api/[...path].js', import.meta.url)), 'utf8');
  const start = src.indexOf('async function handleUsers');
  const usersBlock = src.slice(start, src.indexOf('async function', start + 10));
  const getBranch = usersBlock.slice(usersBlock.indexOf("method === 'GET'"), usersBlock.indexOf("method === 'PUT'"));
  check('GET no longer does SELECT u.* on users', !/u\.\*/.test(getBranch));
  check('GET fallback no longer does SELECT * FROM users', !/SELECT \* FROM users/.test(getBranch));
  check('GET builds its column list from usersSelectList', /usersSelectList/.test(getBranch));
  const putBranch = usersBlock.slice(usersBlock.indexOf("method === 'PUT'"), usersBlock.indexOf("method === 'DELETE'"));
  check('PUT delegates the password decision to buildUserUpdate', /buildUserUpdate/.test(putBranch));
  check('PUT no longer writes a raw password=$3 column', !/SET name=\$1, email=\$2, password=/.test(putBranch));
}

console.log(`\n✅ users-security smoke: ${passed} checks passed`);
