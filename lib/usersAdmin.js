// lib/usersAdmin.js — the security-critical bits of the /api/users admin endpoints,
// extracted so they can be unit-tested without a database (see
// scripts/podium-users-security-smoke.mjs).

import { sanitizeRoles, legacyAccessFor, syncUserRoles } from './rbac.js';

// Every column of `users` EXCEPT `password`. The users list is fetched token-less by the
// workorder/technician dropdowns, so we cannot gate the read — but it must never carry the
// bcrypt hash. Allow-list (default-deny): a future sensitive column is not exposed until it
// is deliberately added here.
export const USERS_PUBLIC_COLUMNS = ['id', 'name', 'email', 'access', 'podium_user_id'];

// Column list for a SELECT. Pass the table alias used in the query ('u'), or nothing for
// the un-aliased fallback query.
export function usersSelectList(alias) {
  const prefix = alias ? `${alias}.` : '';
  return USERS_PUBLIC_COLUMNS.map((c) => `${prefix}${c}`).join(', ');
}

// A value already in bcrypt form ($2a/$2b/$2y$<cost>$<53 chars>) is NOT a new password —
// it's a hash that a stale admin-page tab (loaded before this fix, when GET still returned
// the hash) round-tripped back on Save. Re-hashing it would lock that user out, so we treat
// it as "no change". Guards the deploy cutover window; harmless afterwards.
const BCRYPT_RE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
export function isBcryptHash(s) {
  return typeof s === 'string' && BCRYPT_RE.test(s);
}

// Build the UPDATE for a user edit. The list no longer returns the password hash, so an
// edit that isn't changing the password omits it — and we must NOT blank the column. When a
// real new password IS supplied we hash it: the column stores bcrypt, and writing a raw
// value here would lock the user out on their next login.
//
// `deps.hash` is bcrypt's hash (injected so the logic is testable offline).
export async function buildUserUpdate(fields, deps = {}) {
  const { id, name, email, primary, password } = fields;
  const hasNewPassword =
    typeof password === 'string' && password.trim().length > 0 && !isBcryptHash(password);

  if (hasNewPassword) {
    const hashed = await deps.hash(password, 10);
    return {
      text: 'UPDATE users SET name=$1, email=$2, access=$3, password=$4 WHERE id=$5',
      params: [name, email, primary, hashed, id],
    };
  }
  return {
    text: 'UPDATE users SET name=$1, email=$2, access=$3 WHERE id=$4',
    params: [name, email, primary, id],
  };
}

// G6 — create a user (POST /api/register; the caller has already passed the superadmin gate).
// Returns { status, body } so it can be tested offline with a fake client.
//
// The bug this replaces: the handler wrote primaryRole(roles) into `users.access`, an enum
// that has no logistics / sales / workshop, so those users failed with a bare "Server error".
// users.access now gets legacyAccessFor(roles); the full set goes to user_roles as before.
//
// `deps.hash` is bcrypt's hash; `deps.syncUserRoles` is only overridden by the smoke.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function registerUser(client, body, actingUserId, deps = {}) {
  // IDs are upper-case everywhere (twoCharId() upper-cases actor IDs before lookups/logs).
  const id = String(body?.id ?? '').trim().toUpperCase();
  const name = String(body?.name ?? '').trim();
  const email = String(body?.email ?? '').trim();
  const password = typeof body?.password === 'string' ? body.password : '';

  if (!id) return { status: 400, body: { error: 'User ID is required' } };
  if (id.length > 2) return { status: 400, body: { error: 'User ID must be 1–2 characters' } };
  if (!name) return { status: 400, body: { error: 'Name is required' } };
  if (name.length > 255) return { status: 400, body: { error: 'Name must be 255 characters or fewer' } };
  if (email.length > 255) return { status: 400, body: { error: 'Email must be 255 characters or fewer' } };
  if (!EMAIL_RE.test(email)) return { status: 400, body: { error: 'A valid email is required' } };
  if (!password) return { status: 400, body: { error: 'Password is required' } };

  const dupEmail = await client.query('SELECT 1 FROM users WHERE lower(email) = lower($1)', [email]);
  if (dupEmail.rows.length) return { status: 409, body: { error: 'Email is already registered' } };
  const dupId = await client.query('SELECT 1 FROM users WHERE id = $1', [id]);
  if (dupId.rows.length) return { status: 409, body: { error: `User ID "${id}" is already in use — choose another` } };

  // F0b: role set from the multi-select (falls back to a single `access` value or 'staff').
  let roles = sanitizeRoles(body.roles);
  if (!roles.length && body.access) roles = sanitizeRoles([body.access]);
  if (!roles.length) roles = ['staff'];

  const hashed = await deps.hash(password, 10);
  try {
    await client.query(
      'INSERT INTO users (id, name, email, password, access) VALUES ($1,$2,$3,$4,$5)',
      [id, name, email, hashed, legacyAccessFor(roles)]
    );
  } catch (err) {
    // Lost a race with another create between the pre-checks and the INSERT.
    if (err?.code === '23505') {
      const what = /email/i.test(err.constraint || '') ? 'Email is already registered' : `User ID "${id}" is already in use — choose another`;
      return { status: 409, body: { error: what } };
    }
    throw err;
  }

  try {
    await (deps.syncUserRoles || syncUserRoles)(client, id, roles, actingUserId); // F9: granted_by = the acting admin
  } catch (err) {
    // Don't leave a half-created user behind: it would hold only its fallback access and block
    // a retry with "Email is already registered".
    try { await client.query('DELETE FROM users WHERE id = $1', [id]); } catch (_) {}
    throw err;
  }
  return { status: 200, body: { message: 'User registered successfully', roles } };
}
