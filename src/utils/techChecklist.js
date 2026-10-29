// G16 (Nick, 19 Oct 2026) — shared bits of the technician Screen & Electronics Checklist.
// Pure and JSX-free (nav.js imports it, and the smokes load it in node). Mirrors
// lib/techChecklist.js — scripts/ops-tech-checklist-smoke.mjs pins the two equal. The server
// is the real authority on who may use it.

import { hasAnyRole } from './auth.js';
import { formatWhen } from './lotTracker.js';

export const CHECK_ITEMS = [
  { key: 'boots_ok', label: 'Boots OK' },
  { key: 'touch_cal', label: 'Touch & Cal' },
  { key: 'screen_cont', label: 'Screen Cont.' },
  { key: 'heart_rate', label: 'Heart Rate' },
  { key: 'ergo_tog_cont', label: 'Ergo/Tog Cont.' },
  { key: 'wifi_connect', label: 'Wifi Connect' },
  { key: 'bt_connect', label: 'BT Connect' },
  { key: 'audio', label: 'Audio' },
  { key: 'rem_ads_dereg', label: 'Rem Ads / De-Reg' },
  { key: 'rem_old_chg_cables', label: 'Rem Old Chg Cables' },
  { key: 'chk_usb_corrosion', label: 'Chk USB Corrosion' },
  { key: 'fw_update', label: 'F/W Update' },
  { key: 'reset_metric', label: 'Reset to Metric' },
  { key: 'test_tag', label: 'Test & Tag' },
];
export const AUDIO_SUBS = [
  { key: 'jack', label: '3.5' },
  { key: 'bt', label: 'BT' },
  { key: 'spk', label: 'SPK' },
];
const ANSWERS = ['yes', 'na'];
export const TECH_CHECKLIST_ROLES = ['technician', 'workshop', 'superadmin'];
// The shared workshop login is an `admin` account, so it is let in by id (as nav.js does).
export const WORKSHOP_ACCOUNT_ID = 'WK';

/** Who sees the page + nav item: the roles above, or the WK workshop account. */
export function canUseTechChecklist(user, roles) {
  if (String(user?.id || '').toUpperCase() === WORKSHOP_ACCOUNT_ID) return true;
  return hasAnyRole(roles, TECH_CHECKLIST_ROLES);
}

/** Labels of the lines not yet answered Yes or N/A (sign-off needs this to be empty). */
export function unansweredItems(checks) {
  return CHECK_ITEMS.filter((i) => !ANSWERS.includes(checks?.[i.key]?.v)).map((i) => i.label);
}

/** A blank checklist: every line unanswered. */
export function emptyChecks() {
  const out = {};
  for (const i of CHECK_ITEMS) {
    out[i.key] = { v: null, note: '' };
    if (i.key === 'audio') for (const s of AUDIO_SUBS) out[i.key][s.key] = null;
  }
  return out;
}

// G20 (owner, 29 Oct 2026) — one sign-off line for /tech-checklist and the Lot Tracker so the
// two screens never drift. The save that signs off writes approved_at and updated_at together,
// so a later save only counts as an update when it is more than a minute after the sign-off.
const SAME_SAVE_MS = 60 * 1000;
const who = (name, id) => name || id;

/** "Last saved 28 Oct 2026, 3:00 pm by Nick", or null when nothing has been saved. */
export function lastSavedLine(c) {
  if (!c?.updated_at) return null;
  return `Last saved ${formatWhen(c.updated_at)} by ${who(c.updated_by_name, c.updated_by)}`;
}

/**
 * "OK to ship · signed off by Graeme · 27 Oct 2026, 2:21 pm", plus
 * " · Updated 28 Oct 2026, 3:00 pm by Nick" once it has been re-saved since the sign-off.
 * Not signed off → the "Last saved …" line.
 */
export function signOffLine(c) {
  if (!c) return null;
  if (!c.ok_to_ship || !c.approved_at) return lastSavedLine(c);
  let line = `OK to ship · signed off by ${who(c.approved_by_name, c.approved_by)} · ${formatWhen(c.approved_at)}`;
  const signed = new Date(c.approved_at).getTime();
  const updated = new Date(c.updated_at).getTime();
  if (updated - signed > SAME_SAVE_MS) {
    line += ` · Updated ${formatWhen(c.updated_at)} by ${who(c.updated_by_name, c.updated_by)}`;
  }
  return line;
}
