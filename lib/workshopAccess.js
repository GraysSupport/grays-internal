// lib/workshopAccess.js — G17 (Nick, 19 Oct 2026): technicians, the workshop role and the WK
// workshop kiosk see the job, not the money.
//
// "Make sure they aren't able to see balances and don't enable them to view specific customer
//  details and change salesperson, target completion date as well as cancelling products,
//  adding products and modifying anything in the workorders."
//
// Decisions (Nick, 19 Oct 2026): they may still change ITEM STATUS (never to Canceled) and
// SERIALS / LOT STICKERS; they see the customer's name + suburb only; WK is restricted too.
//
// WHY THE CLAIMED USER ID COUNTS: the workorder, delivery and customer endpoints have never read
// a login token — pages identify themselves with X-User-Id / body.user_id. A restriction that
// only looked at the token would lift the moment the kiosk's 1-hour token expired (WK is never
// logged out). Claiming to be a technician can only REDUCE what a caller may do, so trusting the
// claimed id for restriction is safe. (Someone sending no identity at all is still unrestricted,
// exactly as before — that is proposal P7, a separate decision.)
//
// Mirrored for display decisions in src/utils/workshopAccess.js (pinned equal by the smoke).

import { getAuthUser, hasAnyRole } from './rbac.js';

export const WORKSHOP_ROLES = ['technician', 'workshop'];
// Holding any of these as well means a manager who also repairs machines — full access.
export const FULL_ACCESS_ROLES = ['superadmin', 'admin', 'logistics', 'sales', 'staff'];
// The shared workshop kiosk is an `admin` login on prod, so it is restricted by id.
export const WORKSHOP_ACCOUNT_ID = 'WK';
// The item statuses a workshop login may set. Canceled restocks the item — not theirs to do.
export const WORKSHOP_ITEM_STATUSES = ['Not in Workshop', 'In Workshop', 'Completed'];

// Never sent to a workshop login: money, and how to reach the customer.
const HIDDEN_WORKORDER_FIELDS = [
  'outstanding_balance', 'delivery_charged', 'installation_cost', 'cash_to_removalist', 'free_delivery',
  'customer_id', 'customer_email', 'customer_phone',
];
// Delivery notes are written by logistics and can hold phone numbers, access codes, addresses.
const HIDDEN_DELIVERY_FIELDS = [...HIDDEN_WORKORDER_FIELDS, 'delivery_quoted', 'notes'];
const HIDDEN_ITEM_FIELDS = ['selling_price', 'custom_unit_price'];

const ALLOWED_PUT_KEYS = new Set(['items', 'user_id']);
const ALLOWED_ITEM_KEYS = new Set(['workorder_items_id', 'status', 'item_sn']);

/** Pure: is this user a workshop login (restricted)? */
export function isWorkshopRestricted({ id, roles } = {}) {
  if (String(id || '').toUpperCase() === WORKSHOP_ACCOUNT_ID) return true;
  const set = Array.isArray(roles) ? roles : [];
  return hasAnyRole(set, WORKSHOP_ROLES) && !hasAnyRole(set, FULL_ACCESS_ROLES);
}

/** The user id the page says it is acting as (untrusted — used to RESTRICT only). */
function claimedUserId(req) {
  const raw = req?.headers?.['x-user-id'] || req?.body?.user_id || req?.query?.user_id || '';
  return String(raw).trim().toUpperCase().slice(0, 2);
}

const ROLE_LOOKUP = `
  SELECT u.access, COALESCE(array_agg(r.role) FILTER (WHERE r.role IS NOT NULL), '{}') AS roles
    FROM users u LEFT JOIN user_roles r ON r.user_id = u.id
   WHERE u.id = $1
   GROUP BY u.access
`;

/**
 * Is the caller a workshop login? Restricted if the signed token says so OR the claimed user id
 * belongs to one. Returns { restricted, id }.
 */
export async function resolveWorkshopActor(req, client) {
  const auth = getAuthUser(req);
  if (auth && isWorkshopRestricted(auth)) return { restricted: true, id: auth.id };
  const claimed = claimedUserId(req);
  if (!claimed) return { restricted: false, id: auth?.id || null };
  if (claimed === WORKSHOP_ACCOUNT_ID) return { restricted: true, id: claimed };
  if (auth && String(auth.id).toUpperCase() === claimed) return { restricted: false, id: auth.id };
  let r;
  try {
    r = await client.query(ROLE_LOOKUP, [claimed]);
  } catch (err) {
    if (err?.code !== '42P01') throw err; // a database without user_roles: the single access value decides
    r = await client.query('SELECT access FROM users WHERE id = $1', [claimed]);
  }
  if (!r.rows.length) return { restricted: false, id: claimed };
  const { access, roles } = r.rows[0];
  const set = Array.isArray(roles) && roles.length ? roles : (access ? [access] : []);
  return { restricted: isWorkshopRestricted({ id: claimed, roles: set }), id: claimed };
}

const omit = (obj, keys) => {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
};

/** A workorder (single or list row) as a workshop login may see it. */
export function redactWorkorder(wo) {
  const out = omit(wo, HIDDEN_WORKORDER_FIELDS);
  if (Array.isArray(out.items)) out.items = out.items.map((i) => omit(i, HIDDEN_ITEM_FIELDS));
  // Payment events stay in the timeline, but any amount in their note does not.
  if (Array.isArray(out.activity)) {
    out.activity = out.activity.map((l) => (l.event_type === 'PAYMENT_UPDATED' ? { ...l, notes_log: null } : l));
  }
  return out;
}

/** A delivery (single or list row) as a workshop login may see it. */
export function redactDelivery(d) {
  return omit(d, HIDDEN_DELIVERY_FIELDS);
}

/**
 * What a workshop login's workorder save tries to change that it may not. Empty = allowed.
 * Allowed: items[].{workorder_items_id, status ∈ WORKSHOP_ITEM_STATUSES, item_sn} (+ user_id).
 */
export function workshopPutViolations(body) {
  const b = body && typeof body === 'object' ? body : {};
  const refused = Object.keys(b).filter((k) => !ALLOWED_PUT_KEYS.has(k));
  if (b.items != null) {
    if (!Array.isArray(b.items)) refused.push('items');
    else {
      for (const item of b.items) {
        for (const k of Object.keys(item || {})) {
          if (!ALLOWED_ITEM_KEYS.has(k)) refused.push(`items.${k}`);
        }
        if (item?.status != null && !WORKSHOP_ITEM_STATUSES.includes(item.status)) refused.push(`items.status=${item.status}`);
      }
    }
  }
  return [...new Set(refused)];
}

/** Answer 403 when the caller is a workshop login. Returns true when it answered. */
export async function refuseWorkshop(req, res, client, message) {
  const actor = await resolveWorkshopActor(req, client);
  if (!actor.restricted) return false;
  res.status(403).json({ error: message });
  return true;
}
