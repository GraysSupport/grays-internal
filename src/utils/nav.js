// src/utils/nav.js — F19 increment 2a: the portal's navigation, as data.
//
// WHY THIS FILE EXISTS: the dashboard sidebar used to be the one and only navigation in the
// portal, and it is `hidden md:block` — so on a phone there were no links at all. Increment 2a
// adds a mobile drawer, which means the same nav is now rendered TWICE. Two hand-maintained
// copies of a role-gated list is how a feature ends up reachable on a laptop and invisible on
// a phone (or worse, the reverse), so the list lives here once and both renderers read it.
//
// Kept pure and JSX-free so scripts/podium-nav-smoke.mjs can import it in node — the same
// arrangement as src/utils/compose.js and src/utils/lotLabels.js.
//
// ⚠️ These gates decide what to SHOW only. The server is authoritative: /api/podium/inbox,
// /api/leads, /api/logistics and /api/integrations all re-check the JWT role set via
// lib/rbac.js. Hiding a link is never the security control.

// Imported with the .js extension on purpose: node (which runs the smoke) resolves ESM
// specifiers literally and cannot find './auth'. Webpack and jest both accept the extension.
import { hasAnyRole } from './auth.js';

// Every key this builder can emit, in render order. Exported so a test can assert the builder
// never invents a key nobody styled or routed.
export const NAV_KEYS = [
  'dashboard',
  'settings',
  'inbox',
  'leads',
  'logistics',
  'products',
  'customers',
  'waitlist',
  'delivery',
  'peloton',
  'integrations',
  'register',
  'logout',
];

/**
 * The nav items for a given user + role set, in display order.
 *
 * Returns `[{ key, label, to?, emphasis?, dot? }]`. `logout` has no `to` — it is an action the
 * renderer wires to its own handler, because logging out writes an access-log row and clears
 * storage, which is page behaviour, not navigation.
 *
 * Tolerates `user: null` / `roles: null`. dashboard.js gates its whole render on `loading`, so
 * a null user is COMPUTED but never rendered today — the tolerance is there so a future caller
 * (or a reordered effect) gets an empty nav rather than a crashed page. A session created
 * before F0b genuinely has no `roles` array, and that path is live.
 */
export function buildNavItems({ user, roles } = {}) {
  const roleSet = Array.isArray(roles) ? roles : [];
  // Fall back to the legacy single `access` value so a pre-roles session still resolves its
  // primary role — same precedence as utils/auth.js getRoles().
  const effectiveRoles = roleSet.length ? roleSet : (user?.access ? [user.access] : []);

  // F3/F5: the Inbox and lead funnel are sales tools. F7b: the Awaiting-Workorder queue is a
  // logistics tool. F10: the Integrations log is superadmin-only observability.
  const canUseInbox = hasAnyRole(effectiveRoles, ['sales', 'superadmin']);
  const canUseLeads = canUseInbox;
  const canUseLogistics = hasAnyRole(effectiveRoles, ['logistics', 'superadmin']);
  const canUseIntegrations = hasAnyRole(effectiveRoles, ['superadmin']);
  const isSuperadmin = user?.access === 'superadmin';
  const isTechnician = user?.access === 'technician';

  const items = [
    { key: 'dashboard', label: 'Dashboard', to: '/dashboard' },
    { key: 'settings', label: 'Account Settings', to: '/settings' },
  ];

  if (canUseInbox) items.push({ key: 'inbox', label: 'Inbox', to: '/inbox' });
  if (canUseLeads) items.push({ key: 'leads', label: 'Lead Funnel', to: '/leads' });
  if (canUseLogistics) {
    items.push({ key: 'logistics', label: 'Awaiting Workorder', to: '/logistics/awaiting-workorder' });
  }

  if (!isTechnician) {
    items.push({ key: 'products', label: 'Products', to: '/products' });
    items.push({ key: 'customers', label: 'Customers', to: '/customers' });
    items.push({ key: 'waitlist', label: 'Waitlist', to: '/waitlist' });
  }

  // Delivery Operations is visible to everyone; the shared WK workshop account gets the
  // workshop view instead of the ops view.
  items.push({
    key: 'delivery',
    label: 'Delivery Operations',
    to: user?.id === 'WK' ? '/workshop' : '/delivery_operations',
  });

  if (isSuperadmin) items.push({ key: 'peloton', label: 'Peloton', to: '/peloton', dot: true });
  if (canUseIntegrations) items.push({ key: 'integrations', label: 'Integrations', to: '/integrations' });
  if (isSuperadmin) {
    items.push({ key: 'register', label: 'Register New User', to: '/register', emphasis: true });
  }

  items.push({ key: 'logout', label: 'Logout' });

  return items;
}
