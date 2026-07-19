// scripts/podium-rbac-smoke.mjs — offline smoke for the F9 RBAC gate.
//
// Covers lib/rbac.js's server-authoritative gate — the piece F9 uses to lock the
// user-administration endpoints down to superadmin — plus the granted_by wiring F0b
// deferred to F9. No network, no database, no secrets:
//
//   node scripts/podium-rbac-smoke.mjs
//
// requireRoles() is the single place a handler asks "is this caller allowed?", so it is
// worth real coverage: it must FAIL CLOSED (401) on a missing/forged/expired token or an
// unconfigured JWT_SECRET, 403 a genuine user who lacks the role, and pass a multi-role
// user (P10 — one user can hold sales AND logistics AND superadmin).

process.env.JWT_SECRET = 'test-secret-for-rbac-smoke';

const jwt = (await import('jsonwebtoken')).default;
const { requireRoles, syncUserRoles, hasAnyRole, primaryRole, sanitizeRoles, BOOKING_SMS_ROLES } = await import('../lib/rbac.js');

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const reqWith = (token) => ({ headers: token ? { authorization: `Bearer ${token}` } : {} });
const tokenFor = (roles, opts = {}) =>
  jwt.sign({ id: 'GS', email: 'a@b.c', roles }, process.env.JWT_SECRET, opts);

console.log('F9 RBAC gate smoke — no DB, no network\n');

console.log('fails closed:');
{
  const r1 = requireRoles({ headers: {} }, ['superadmin']);
  check('no Authorization header → 401', r1.ok === false && r1.status === 401);

  const r2 = requireRoles(reqWith('not-a-jwt'), ['superadmin']);
  check('malformed token → 401', r2.ok === false && r2.status === 401);

  const forged = jwt.sign({ id: 'XX', roles: ['superadmin'] }, 'the-wrong-secret');
  const r3 = requireRoles(reqWith(forged), ['superadmin']);
  check('token signed with the wrong secret → 401 (not 403)', r3.ok === false && r3.status === 401);

  const expired = tokenFor(['superadmin'], { expiresIn: -10 });
  const r4 = requireRoles(reqWith(expired), ['superadmin']);
  check('expired token → 401', r4.ok === false && r4.status === 401);

  const saved = process.env.JWT_SECRET;
  delete process.env.JWT_SECRET;
  const r5 = requireRoles(reqWith(jwt.sign({ id: 'GS', roles: ['superadmin'] }, saved)), ['superadmin']);
  check('JWT_SECRET unset → 401, never open', r5.ok === false && r5.status === 401);
  process.env.JWT_SECRET = saved;
}

console.log('\nauthorises:');
{
  const r1 = requireRoles(reqWith(tokenFor(['staff'])), ['superadmin']);
  check('authenticated but wrong role → 403 (not 401)', r1.ok === false && r1.status === 403);
  check('403 carries an error message', typeof r1.error === 'string' && r1.error.length > 0);

  const r2 = requireRoles(reqWith(tokenFor(['superadmin'])), ['superadmin']);
  check('right role → ok', r2.ok === true);
  check('ok exposes the acting user id (for granted_by / audit)', r2.auth?.id === 'GS');

  // P10: a role SET, not a single value.
  const multi = reqWith(tokenFor(['sales', 'logistics']));
  check('multi-role user passes a sales gate', requireRoles(multi, ['sales', 'superadmin']).ok === true);
  check('multi-role user passes a logistics gate', requireRoles(multi, ['logistics', 'superadmin']).ok === true);
  check('multi-role user still 403s on a gate it lacks', requireRoles(multi, ['superadmin']).ok === false);

  check('role match is case-insensitive', requireRoles(reqWith(tokenFor(['SuperAdmin'])), ['superadmin']).ok === true);

  const noRoles = requireRoles(reqWith(tokenFor([])), ['superadmin']);
  check('valid token with an empty role set → 403', noRoles.ok === false && noRoles.status === 403);
}

console.log('\ngranted_by wiring (F0b deferred this to F9):');
{
  const calls = [];
  const client = { async query(sql, params) { calls.push({ sql, params }); return { rowCount: 1, rows: [] }; } };

  await syncUserRoles(client, 'BR', ['sales', 'logistics'], 'GS');
  const inserts = calls.filter((c) => /INSERT INTO user_roles/i.test(c.sql));
  check('one INSERT per role', inserts.length === 2, `got ${inserts.length}`);
  check('granted_by carries the acting admin id', inserts.every((c) => c.params[2] === 'GS'));
  check('roles are wrapped in a transaction', calls.some((c) => /BEGIN/i.test(c.sql)) && calls.some((c) => /COMMIT/i.test(c.sql)));
  check('the old set is cleared first (idempotent replace)', /DELETE FROM user_roles/i.test(calls[1].sql));

  const calls2 = [];
  const client2 = { async query(sql, params) { calls2.push({ sql, params }); return { rowCount: 1, rows: [] }; } };
  await syncUserRoles(client2, 'BR', ['sales'], undefined);
  const ins2 = calls2.find((c) => /INSERT INTO user_roles/i.test(c.sql));
  check('no acting admin → granted_by null, never undefined', ins2.params[2] === null);

  // A DB that hasn't run the F0 migration must not break user admin.
  const err = new Error('relation "user_roles" does not exist'); err.code = '42P01';
  const bare = { async query(sql) { if (/user_roles/i.test(sql)) throw err; return { rowCount: 0, rows: [] }; } };
  check('missing user_roles table → false, no throw', (await syncUserRoles(bare, 'BR', ['sales'], 'GS')) === false);
}

console.log('\ngate is actually WIRED IN (not just sound in isolation):');
{
  // Everything above proves requireRoles works; none of it would fail if the gate were
  // deleted from the router — and the gate IS the feature. The handler builds its own pg
  // client (see backlog F21), so until that's injectable these static assertions are the
  // cheapest honest guard against the wiring being dropped.
  const fs = await import('node:fs/promises');
  const url = await import('node:url');
  const routerPath = url.fileURLToPath(new URL('../api/[...path].js', import.meta.url));
  const src = await fs.readFile(routerPath, 'utf8');

  check('router imports requireRoles', /import\s*\{[^}]*requireRoles[^}]*\}\s*from\s*'\.\.\/lib\/rbac\.js'/.test(src));

  const registerBlock = src.slice(src.indexOf("action === 'register'"), src.indexOf("action === 'change-password'"));
  check('register action gates on superadmin', /requireRoles\(req,\s*\['superadmin'\]\)/.test(registerBlock));
  check('register passes the acting admin as granted_by', /syncUserRoles\(client,\s*id,\s*roles,\s*gate\.auth\.id\)/.test(registerBlock));

  const usersBlock = src.slice(src.indexOf('async function handleUsers'));
  const gateCount = (usersBlock.match(/requireRoles\(req,\s*\['superadmin'\]\)/g) || []).length;
  check('users PUT and DELETE both gate on superadmin', gateCount === 2, `found ${gateCount}`);
  check('users PUT passes the acting admin as granted_by', /syncUserRoles\(client,\s*id,\s*roles,\s*gate\.auth\.id\)/.test(usersBlock));
  check('the last superadmin cannot be orphaned', /wouldOrphanSuperadmin/.test(usersBlock) && /409/.test(usersBlock));

  // Documents a DELIBERATE decision: GET /api/users stays ungated because
  // create_workorder.js + the workorder detail page fetch it token-less for dropdowns.
  // If someone gates reads, these pages must start sending authHeaders() first.
  check('GET /api/users is deliberately left ungated (see the F9 report)',
    !/method === 'GET'[\s\S]{0,400}requireRoles/.test(usersBlock));
}

console.log('\ndelivery-booked SMS is superadmin-only (temporary lockdown, 20 Jul 2026):');
{
  // WHY: PODIUM_MOCK=false on Production (found 20 Jul), so this endpoint sends REAL
  // texts to REAL customers with copy that has not been signed off. Until it is, only
  // superadmin may send or decline one. F8b originally gated on authentication ALONE —
  // deliberately, because the `logistics` role wasn't assigned to anyone yet — which
  // means every logged-in staff member could text a customer.
  const fs = await import('node:fs/promises');
  const url = await import('node:url');

  const handlerSrc = await fs.readFile(
    url.fileURLToPath(new URL('../lib/handlers/delivery.js', import.meta.url)), 'utf8');

  check('delivery handler imports requireRoles + the shared role list',
    /import\s*\{[^}]*requireRoles[^}]*BOOKING_SMS_ROLES[^}]*\}\s*from\s*'\.\.\/rbac\.js'/.test(handlerSrc));

  // STRUCTURAL, not presence-based. An earlier version of this block sliced out the
  // booking-sms branch and asked "does a gate appear inside it?" — which a reviewer
  // defeated twice: once by adding a SECOND, ungated dispatch above the real one using
  // double quotes to dodge the string anchor, and once by leaving the guard's tokens in
  // place while moving them out of the `if`. Both let a non-superadmin send, and both
  // passed 46/46. So the assertions below count call sites across the WHOLE file.
  const dispatches = handlerSrc.match(/resource[^=]*===\s*['"]booking-sms['"]/g) || [];
  check('exactly ONE booking-sms dispatch exists in the file', dispatches.length === 1,
    `found ${dispatches.length} — a second dispatch could bypass the gate entirely`);

  const sendCalls = handlerSrc.match(/notifyDeliveryBooked\s*\(/g) || [];
  const skipCalls = handlerSrc.match(/declineDeliveryBookedSms\s*\(/g) || [];
  check('notifyDeliveryBooked is called exactly once in the file', sendCalls.length === 1, `found ${sendCalls.length}`);
  check('declineDeliveryBookedSms is called exactly once in the file', skipCalls.length === 1, `found ${skipCalls.length}`);

  const start = handlerSrc.indexOf("=== 'booking-sms'");
  check('booking-sms branch exists', start > -1);
  // indexOf returning -1 would make slice(start,-1) silently mean "rest of the file",
  // quietly widening every assertion below — so require the end marker explicitly.
  const end = handlerSrc.indexOf("if (method === 'GET')", start);
  check('the booking-sms block has a locatable end marker', end > start,
    'without this the block silently widens to the rest of the file');
  const smsBlock = handlerSrc.slice(start, end);

  check('booking-sms gates on the shared role list',
    /requireRoles\(req,\s*BOOKING_SMS_ROLES\)/.test(smsBlock),
    'without this, any logged-in user can text a customer');
  check('booking-sms returns the gate status (401 vs 403), not a blanket 401',
    /gate\.status/.test(smsBlock));
  check('booking-sms no longer relies on bare getAuthUser for authorisation',
    !/getAuthUser\(req\)/.test(smsBlock));
  check('the acting superadmin is recorded on the envelope',
    (smsBlock.match(/actorId:\s*gate\.auth\.id/g) || []).length === 2,
    'both send and skip must attribute the decision to the gated user');

  // Both actions must be behind the gate — 'skip' writes an audit row attributing the
  // decision to a person, so it is not a harmless read.
  const gateIdx = smsBlock.search(/requireRoles\(req,\s*BOOKING_SMS_ROLES\)/);
  check('the gate precedes BOTH send and skip',
    gateIdx > -1 && gateIdx < smsBlock.indexOf('declineDeliveryBookedSms')
      && gateIdx < smsBlock.indexOf('notifyDeliveryBooked'));

  // The preview carries the customer's phone number and the un-signed-off copy, so it
  // must not be handed to a caller who could not send it. Both emit sites are gated.
  const previewGates = handlerSrc.match(/requireRoles\(req,\s*BOOKING_SMS_ROLES\)\.ok/g) || [];
  check('both booking_sms preview emit sites are gated', previewGates.length === 2,
    `found ${previewGates.length} — POST-create and PUT-update must both withhold it`);

  // Client side: don't offer a button the server will 403.
  const pageSrc = await fs.readFile(
    url.fileURLToPath(new URL('../src/pages/delivery_operations/to-be-booked.js', import.meta.url)), 'utf8');
  check('to-be-booked imports the role helpers', /from\s*'\.\.\/\.\.\/utils\/auth'/.test(pageSrc));

  // Pin the guarded STATEMENT, and require it to be the only way the panel opens —
  // otherwise the guard can be left present-but-bypassed.
  check('the confirmation panel only opens for the allowed roles',
    /if \(data\?\.booking_sms && hasAnyRole\(getRoles\(\), BOOKING_SMS_ROLES\)\) \{/.test(pageSrc),
    'a non-superadmin must never be shown the send/skip panel');
  const opens = pageSrc.match(/setBookingSms\(\{\s*\.\.\.data\.booking_sms/g) || [];
  check('there is exactly one place the panel is opened from a response', opens.length === 1,
    `found ${opens.length}`);
  check('the client role list is declared once, as a constant',
    /^const BOOKING_SMS_ROLES = \['superadmin'\];$/m.test(pageSrc));
  check('the booking save sends the token (else superadmins lose the preview too)',
    /headers: authHeaders\(\{ 'Content-Type': 'application\/json' \}\)/.test(pageSrc));
  check('a 403 closes the panel instead of looping on a raw role string',
    /res\.status === 403\b/.test(pageSrc) && /restricted to an administrator/.test(pageSrc));
}

console.log('\nbehaviour: the delivery-SMS gate, asserted against the shared constant:');
{
  // Asserted against BOOKING_SMS_ROLES rather than a hardcoded ['superadmin'], so
  // LIFTING the lockdown (adding 'logistics') does not read as a test regression.
  check('BOOKING_SMS_ROLES is a non-empty array', Array.isArray(BOOKING_SMS_ROLES) && BOOKING_SMS_ROLES.length > 0);
  check('superadmin is always allowed', requireRoles(reqWith(tokenFor(['superadmin'])), BOOKING_SMS_ROLES).ok === true);

  // Every role NOT on the list must be refused. Written as a sweep so a future widening
  // is a one-line constant change, not a rewrite of the expectations.
  for (const role of ['staff', 'sales', 'logistics', 'technician', 'workshop']) {
    const expectAllowed = BOOKING_SMS_ROLES.includes(role);
    const r = requireRoles(reqWith(tokenFor([role])), BOOKING_SMS_ROLES);
    check(`${role} alone → ${expectAllowed ? 'allowed' : '403'}`,
      expectAllowed ? r.ok === true : (r.ok === false && r.status === 403));
  }

  check('a listed role held alongside others still passes (P10 multi-role)',
    requireRoles(reqWith(tokenFor(['logistics', ...BOOKING_SMS_ROLES])), BOOKING_SMS_ROLES).ok === true);
  check('no token → 401, not 403 (fails closed)',
    requireRoles({ headers: {} }, BOOKING_SMS_ROLES).status === 401);
  check('a forged token claiming the role → 401, never a pass',
    requireRoles(reqWith(jwt.sign({ id: 'XX', roles: BOOKING_SMS_ROLES }, 'wrong-secret')), BOOKING_SMS_ROLES).status === 401);
}

console.log('\nrole helpers (used by the nav + gates):');
{
  check('hasAnyRole is true when one of many matches', hasAnyRole(['staff', 'sales'], ['sales', 'superadmin']) === true);
  check('hasAnyRole is false when none match', hasAnyRole(['staff'], ['sales', 'superadmin']) === false);
  check('primaryRole picks the highest privilege', primaryRole(['sales', 'superadmin']) === 'superadmin');
  check('sanitizeRoles drops unknown roles', sanitizeRoles(['sales', 'hacker']).join(',') === 'sales');
}

console.log(`\n✅ rbac smoke: ${passed} checks passed`);
