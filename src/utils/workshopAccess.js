// G17 (Nick, 19 Oct 2026) — technicians, the workshop role and the WK kiosk see the job, not the
// money. Pure and JSX-free (nav.js imports it; the smokes load it in node). Mirrors
// lib/workshopAccess.js — the server is the real authority; this only decides what to SHOW.

import { authHeaders, getRoles, getStoredUser, hasAnyRole } from './auth.js';

export const WORKSHOP_ROLES = ['technician', 'workshop'];
export const FULL_ACCESS_ROLES = ['superadmin', 'admin', 'logistics', 'sales', 'staff'];
export const WORKSHOP_ACCOUNT_ID = 'WK';
export const WORKSHOP_ITEM_STATUSES = ['Not in Workshop', 'In Workshop', 'Completed'];

/** Is this user a workshop login? WK by id; else technician/workshop with no full-access role. */
export function isWorkshopRestricted(user, roles) {
  if (String(user?.id || '').toUpperCase() === WORKSHOP_ACCOUNT_ID) return true;
  const set = Array.isArray(roles) && roles.length ? roles : (user?.access ? [user.access] : []);
  return hasAnyRole(set, WORKSHOP_ROLES) && !hasAnyRole(set, FULL_ACCESS_ROLES);
}

/** The logged-in user, from storage. */
export function currentUserIsWorkshop() {
  return isWorkshopRestricted(getStoredUser(), getRoles());
}

/**
 * Headers that tell the server who is asking: the login token AND the user id. The workorder /
 * delivery endpoints redact money + customer contact for workshop logins, and they can only do
 * that for a caller who identifies itself — the id keeps working after the 1h token expires.
 */
export function identityHeaders(extra = {}) {
  const id = getStoredUser()?.id;
  return authHeaders({ ...(id ? { 'X-User-Id': id } : {}), ...extra });
}
