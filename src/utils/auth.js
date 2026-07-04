// utils/auth.js — client-side auth helpers for the portal SPA.
//
// The Podium API routes (and future F3/F9 routes) are gated server-side via the login
// JWT (lib/rbac.js getAuthUser reads `Authorization: Bearer <token>`). These helpers
// attach that header and expose the signed role set for UI decisions. The server is
// always the real authority — role checks here only decide what to *show*.

export function getToken() {
  return localStorage.getItem('token');
}

export function getStoredUser() {
  try {
    return JSON.parse(localStorage.getItem('user') || 'null');
  } catch {
    return null;
  }
}

/** Headers for an authenticated fetch: Bearer token + any extras (e.g. Content-Type). */
export function authHeaders(extra = {}) {
  const token = getToken();
  return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra };
}

// Decode the (unverified) JWT payload for display-only purposes. The server re-verifies
// the signature on every request, so reading it here without verification is safe.
function decodeJwtRoles(token) {
  try {
    const part = token.split('.')[1];
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(json);
    return Array.isArray(payload.roles) ? payload.roles : null;
  } catch {
    return null;
  }
}

/**
 * The logged-in user's full role set (P10/P11). Prefers the roles signed into the JWT
 * (authoritative), then the stored user object, then the legacy single `access` value
 * so pre-F0b/pre-roles sessions still resolve to at least their primary role.
 */
export function getRoles() {
  const token = getToken();
  const fromJwt = token ? decodeJwtRoles(token) : null;
  if (fromJwt && fromJwt.length) return fromJwt;
  const user = getStoredUser();
  if (Array.isArray(user?.roles) && user.roles.length) return user.roles;
  if (user?.access) return [user.access];
  return [];
}

/** Case-insensitive: does `roles` include any of `wanted`? */
export function hasAnyRole(roles, wanted) {
  const set = new Set((roles || []).map((r) => String(r).toLowerCase()));
  return (wanted || []).some((w) => set.has(String(w).toLowerCase()));
}
