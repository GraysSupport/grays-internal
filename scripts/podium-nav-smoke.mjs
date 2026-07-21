// scripts/podium-nav-smoke.mjs — offline smoke for F19 increment 2a (portal navigation).
//
// F19 incr 2 is the mobile-usable pass over the portal. The first thing it has to fix is the
// worst one: the dashboard sidebar is `hidden md:block`, and it is the ONLY navigation in the
// portal — so on a phone there are NO links at all. Increment 1 made the portal installable,
// which makes this sharper, not softer: an installed PWA runs standalone with no browser URL
// bar, so a rep who lands on the dashboard has no links AND no address bar to type one.
//
// The fix renders the same nav twice (desktop sidebar + mobile drawer), so the item list has
// to come from ONE place or the two will drift and a role will end up gated in one and not the
// other. That one place is src/utils/nav.js, and this smoke is its contract: WHICH ITEMS EACH
// ROLE SEES. It is JSX-free and importable in node, the same arrangement as
// src/utils/compose.js and src/utils/lotLabels.js.
//
// The server is always the real authority (lib/rbac.js). These rules only decide what to SHOW,
// so a bug here is a usability bug, not a security hole — except in the other direction: a
// link that disappears for a role that should have it makes a whole feature unreachable on a
// phone, which is exactly what this increment exists to prevent.
//
//   node scripts/podium-nav-smoke.mjs

import { buildNavItems, NAV_KEYS } from '../src/utils/nav.js';

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const keysFor = (user, roles) => buildNavItems({ user, roles }).map((i) => i.key);
const superadmin = { id: 'NK', name: 'Nick', access: 'superadmin' };
const staff = { id: 'ST', name: 'Staff', access: 'staff' };
const technician = { id: 'TE', name: 'Tech', access: 'technician' };
const workshop = { id: 'WK', name: 'Workshop', access: 'workshop' };

console.log('F19 nav smoke — pure, no DOM, no network\n');

console.log('always-present items:');
{
  for (const user of [superadmin, staff, technician, workshop]) {
    const keys = keysFor(user, [user.access]);
    check(`${user.access} sees Dashboard`, keys.includes('dashboard'));
    check(`${user.access} sees Account Settings`, keys.includes('settings'));
    check(`${user.access} sees Delivery Operations`, keys.includes('delivery'));
    check(`${user.access} sees Logout last`, keys[keys.length - 1] === 'logout');
  }
}

console.log('\nrole-gated items (mirrors the server gates on /api/podium/inbox, /api/leads, /api/logistics, /api/integrations):');
{
  const salesKeys = keysFor({ id: 'AM', name: 'Amelia', access: 'staff' }, ['staff', 'sales']);
  check('a sales user sees Inbox', salesKeys.includes('inbox'));
  check('a sales user sees Lead Funnel', salesKeys.includes('leads'));
  check('a sales user does NOT see Awaiting Workorder', !salesKeys.includes('logistics'));
  check('a sales user does NOT see Integrations', !salesKeys.includes('integrations'));

  const logisticsKeys = keysFor({ id: 'LO', name: 'Logi', access: 'staff' }, ['staff', 'logistics']);
  check('a logistics user sees Awaiting Workorder', logisticsKeys.includes('logistics'));
  check('a logistics user does NOT see Inbox', !logisticsKeys.includes('inbox'));

  const plainKeys = keysFor(staff, ['staff']);
  check('a plain staff user sees neither Inbox nor Lead Funnel', !plainKeys.includes('inbox') && !plainKeys.includes('leads'));

  const adminKeys = keysFor(superadmin, ['superadmin']);
  for (const k of ['inbox', 'leads', 'logistics', 'integrations', 'peloton', 'register']) {
    check(`superadmin sees ${k}`, adminKeys.includes(k));
  }
  check('a staff user does NOT see Register New User', !plainKeys.includes('register'));
  check('a staff user does NOT see Peloton', !plainKeys.includes('peloton'));
}

console.log('\ntechnician restrictions (unchanged from the pre-F19 sidebar):');
{
  const keys = keysFor(technician, ['technician']);
  for (const k of ['products', 'customers', 'waitlist']) {
    check(`technician does NOT see ${k}`, !keys.includes(k));
  }
  check('technician still sees Delivery Operations', keys.includes('delivery'));
  const staffKeys = keysFor(staff, ['staff']);
  for (const k of ['products', 'customers', 'waitlist']) {
    check(`staff DOES see ${k}`, staffKeys.includes(k));
  }
}

console.log('\nthe WK workshop account routes Delivery Operations to /workshop:');
{
  const wkItem = buildNavItems({ user: workshop, roles: ['workshop'] }).find((i) => i.key === 'delivery');
  check('WK goes to /workshop', wkItem.to === '/workshop');
  const staffItem = buildNavItems({ user: staff, roles: ['staff'] }).find((i) => i.key === 'delivery');
  check('everyone else goes to /delivery_operations', staffItem.to === '/delivery_operations');
}

console.log('\nshape + robustness (it renders during the pre-auth loading window and on a stale session):');
{
  // Guard against the crash-instead-of-empty failure: dashboard.js renders before `user` is
  // set, and a session written before F0b has no `roles` at all.
  const none = buildNavItems({ user: null, roles: null });
  check('a null user yields items without throwing', Array.isArray(none) && none.length > 0);
  check('a null user sees no role-gated items', !none.some((i) => ['inbox', 'leads', 'logistics', 'integrations', 'register', 'peloton'].includes(i.key)));

  const legacy = buildNavItems({ user: { id: 'OL', access: 'superadmin' }, roles: [] });
  check('an empty roles[] still resolves superadmin-only items from user.access', legacy.some((i) => i.key === 'register'));

  const all = buildNavItems({ user: superadmin, roles: ['superadmin'] });
  check('every item has key + label', all.every((i) => i.key && i.label));
  check('every item except logout has a `to`', all.every((i) => i.key === 'logout' || typeof i.to === 'string'));
  check('logout is an action, not a link', all.find((i) => i.key === 'logout').to === undefined);
  check('keys are unique', new Set(all.map((i) => i.key)).size === all.length);
  check('NAV_KEYS lists every key the builder can emit', all.every((i) => NAV_KEYS.includes(i.key)));
}

console.log(`\n✅ nav smoke: ${passed} checks passed`);
