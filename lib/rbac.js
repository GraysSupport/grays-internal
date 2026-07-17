// lib/rbac.js — Single-user-multi-role RBAC foundation (P10/P11, feature F0b)
//
// Roles live in the additive `user_roles` table (migration 0001_podium.sql, §4.0).
// `users.access` stays the PRIMARY role for backward-compat; `user_roles` holds the
// full set (including that primary). Two rules:
//   1. Authorize on the SERVER. The role set is carried in the login JWT and read
//      back via getAuthUser() — never trust a client-supplied role list alone.
//   2. Fall back to the legacy single `access` value if `user_roles` is missing,
//      so a DB that hasn't run the F0 migration yet (e.g. Production before release)
//      keeps working.

import jwt from 'jsonwebtoken';

// Known roles. Existing (from users.access): superadmin, admin, staff, technician,
// workshop. New (P11): sales, logistics. Order here is the primary-role precedence
// (highest privilege first) used to mirror a multi-role set back into users.access.
export const ROLES = ['superadmin', 'admin', 'logistics', 'sales', 'staff', 'technician', 'workshop'];

/** Derive the primary (highest-precedence) role from a set. Falls back to 'staff'. */
export function primaryRole(roles) {
  const set = new Set((roles || []).map((r) => String(r).toLowerCase()));
  for (const r of ROLES) if (set.has(r)) return r;
  // A role we don't know about — keep it rather than lose the caller's intent.
  return (roles && roles[0]) || 'staff';
}

/** Normalise a requested role list to known roles, lower-cased and de-duped. */
export function sanitizeRoles(roles) {
  const known = new Set(ROLES);
  const out = [];
  for (const r of roles || []) {
    const v = String(r).toLowerCase().trim();
    if (known.has(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * Load a user's full role set from user_roles, with a defensive fallback to the
 * legacy single `access` value when the table is absent (42P01) or empty. Always
 * returns a non-empty array when an access value exists.
 */
export async function getRolesForUser(client, userId, fallbackAccess) {
  try {
    const r = await client.query('SELECT role FROM user_roles WHERE user_id = $1', [userId]);
    const roles = r.rows.map((x) => x.role);
    if (roles.length) return roles;
  } catch (err) {
    if (err?.code !== '42P01') console.error('getRolesForUser error:', err); // 42P01 = undefined_table
  }
  return fallbackAccess ? [fallbackAccess] : [];
}

/**
 * Replace a user's role set with `roles` (idempotent, transactional). Swallows a
 * missing-table error (42P01) so it's safe on a DB that hasn't run the F0 migration
 * yet. Returns true if applied, false if user_roles is absent.
 */
export async function syncUserRoles(client, userId, roles, grantedBy) {
  const set = sanitizeRoles(roles);
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
    for (const role of set) {
      await client.query(
        `INSERT INTO user_roles (user_id, role, granted_by)
         VALUES ($1,$2,$3) ON CONFLICT (user_id, role) DO NOTHING`,
        [userId, role, grantedBy || null]
      );
    }
    await client.query('COMMIT');
    return true;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (err?.code === '42P01') return false; // user_roles not migrated on this DB yet
    throw err;
  }
}

/** Pure check: does this role set include `role`? Case-insensitive. */
export function hasRole(roles, role) {
  if (!roles) return false;
  const want = String(role).toLowerCase();
  return roles.some((r) => String(r).toLowerCase() === want);
}

/** Pure check: does this role set include ANY of `wanted`? */
export function hasAnyRole(roles, wanted) {
  return (wanted || []).some((w) => hasRole(roles, w));
}

/**
 * Server-authoritative auth context from the request's login JWT. Returns
 * { id, email, roles } or null. Use this — not a client header — to gate protected
 * routes in later features (F9). The role set is signed at login, so it can't be
 * forged by the client.
 */
export function getAuthUser(req) {
  try {
    const h = req.headers?.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token || !process.env.JWT_SECRET) return null;
    const p = jwt.verify(token, process.env.JWT_SECRET);
    return { id: p.id, email: p.email, roles: Array.isArray(p.roles) ? p.roles : [] };
  } catch {
    return null;
  }
}

/**
 * The standard server-side gate (F9). One place to ask "is this caller allowed?", so the
 * 401-vs-403 distinction and the fail-closed behaviour can't drift between handlers.
 *
 * Fails CLOSED: a missing, malformed, forged or expired token — or an unconfigured
 * JWT_SECRET — is 401, never a pass. A genuine user without one of `wanted` is 403.
 *
 *   const gate = requireRoles(req, ['superadmin']);
 *   if (!gate.ok) return res.status(gate.status).json({ error: gate.error });
 *   // gate.auth.id — the acting user, e.g. for granted_by / audit trails
 *
 * @returns {{ok:true, auth:{id:string,email:string,roles:string[]}}
 *          | {ok:false, status:401|403, error:string}}
 */
export function requireRoles(req, wanted) {
  const auth = getAuthUser(req);
  if (!auth) return { ok: false, status: 401, error: 'Authentication required' };
  if (!hasAnyRole(auth.roles, wanted)) {
    return { ok: false, status: 403, error: `Requires one of: ${(wanted || []).join(', ')}` };
  }
  return { ok: true, auth };
}
