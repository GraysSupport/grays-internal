// lib/usersAdmin.js — the security-critical bits of the /api/users admin endpoints,
// extracted so they can be unit-tested without a database (see
// scripts/podium-users-security-smoke.mjs).

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

// Build the UPDATE for a user edit. The list no longer returns the password hash, so an
// edit that isn't changing the password omits it — and we must NOT blank the column. When a
// real new password IS supplied we hash it: the column stores bcrypt, and writing a raw
// value here would lock the user out on their next login.
//
// `deps.hash` is bcrypt's hash (injected so the logic is testable offline).
export async function buildUserUpdate(fields, deps = {}) {
  const { id, name, email, primary, password } = fields;
  const hasNewPassword = typeof password === 'string' && password.trim().length > 0;

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
