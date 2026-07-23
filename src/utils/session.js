// F34 — one definition of "end a dead session", shared by every 401 handler in the inbox.
//
// Generalises the F32(a) pollNow fix to the twelve other 401 sites (and the two loaders that
// swallowed a 401 into an empty list). A 401 in this app almost always means the 1h JWT expired
// mid-shift, and the old handlers just did `navigate('/')`, which:
//   - left `token`/`user`/`sessionExpiry` in localStorage, so Back re-mounted /inbox, the client
//     gate saw a token and let it mount, it 401'd, and redirected again — a loop; and
//   - used a push, keeping the dead route in history.
//
// This clears the SAME three keys App.js's own logout clears and navigates with REPLACE. It is
// deliberately SILENT: F32(a) split the inbox's 401s into click-driven (the rep knows what they
// did — no toast) and timer-driven (the poll fires unattended, so IT says why). Keeping the toast
// out of this shared helper preserves that split and, as a bonus, means a mass-expiry (several
// inbox fetches 401 at once) can't stack one toast per request. The poll keeps its own toast.
//
// No access-log POST on the way out: unlike App.js's authenticated logout, the token is already
// dead here, so that write would itself 401. The redirect is the honest signal.
export function endExpiredSession(navigate) {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  localStorage.removeItem('sessionExpiry');
  navigate('/', { replace: true });
}
