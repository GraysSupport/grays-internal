// lib/podiumContact.js — Contact ↔ Customer bridge (feature F4).
//
// Turns a Podium conversation/contact into the portal's own `customers` row, and
// gathers the "customer panel" the inbox side-panel needs (execution-plan.md §F4 +
// the 6 Jul reviewer feedback): the matched customer's details, their OPEN
// workorders + active deliveries (so a rep can check an order's progress without
// leaving the inbox), and the open lead (funnel stage).
//
// Matching order (execution-plan §F4): customers.podium_contact_id → LOWER(email)
// → phone (last-8-digits). A match by email/phone lazily backfills
// customers.podium_contact_id (the same lazy-resolve-and-persist pattern as F1b's
// resolvePodiumUserId), so the next lookup is an indexed hit on idx_customers_podium.
// Creating a customer from a contact is a DELIBERATE action (POST action=create),
// never an implicit side effect of a read — an unmatched read returns customer:null
// so the UI can offer "Create customer from contact".
//
// Mock-first (Golden Rule 6): every Podium hop routes through lib/podium.js, which
// serves lib/podium.mock.js while PODIUM_MOCK=true, so the whole bridge is reviewable
// on the Preview without live creds.
//
// P1: this module reads/writes only CRM metadata (the contact↔customer link and
// customer/workorder/delivery/lead rows). It NEVER reads or persists message bodies —
// Podium remains the system of record for chat (execution-plan P1/P3).

import { getContact, getConversation } from './podium.js';

// ---- Podium contact resolution --------------------------------------------

/**
 * Normalise a Podium contact object into the compact shape the panel returns.
 * Live Podium field names may differ (VERIFY against docs.podium.com at live wiring);
 * the mock uses `phoneNumber` + `email` + `name` (execution-plan §15 / lib/podium.mock.js).
 */
export function normalizeContact(raw, conversation = null) {
  if (!raw && !conversation) return null;
  const c = raw || {};
  return {
    uid: c.uid || null,
    name: c.name || null,
    email: c.email || null,
    phone: c.phoneNumber || c.phone || null,
    channels: Array.isArray(c.channels) ? c.channels : [],
    // The conversation's channel is a useful label when there is no contact record.
    channel: conversation?.channel || null,
  };
}

// Channel types whose identifier is a phone number (§15 conversation object:
// ["apple","car_wars","email","facebook","fallback_email","google","google_brand",
//  "iframe","instagram","phone","secure","sms","text","whatsapp"]). Social channels
// carry opaque handles — those are neither a phone nor an email.
const PHONE_CHANNEL_TYPES = new Set(['phone', 'sms', 'text', 'whatsapp']);

/**
 * Contact stub built from the conversation itself, for when there is no contact
 * record to fetch. VERIFIED at live wiring (14 Jul 2026): LIVE conversations carry
 * NO `contact` object (docs.podium.com/reference/the-conversation-object), and the
 * live contacts list cannot be filtered by phone/email — so `contactName` + the
 * channel identifier ARE the contact details, and they're enough for the F4
 * email/phone customer match to run.
 */
export function channelStubContact(conversation, contactUid = null) {
  const chan = conversation?.channel || null;
  const ident = chan?.identifier || null;
  const isEmail = typeof ident === 'string' && ident.includes('@');
  const isPhone = !isEmail && !!ident && PHONE_CHANNEL_TYPES.has(String(chan?.type || ''));
  return {
    uid: contactUid,
    name: conversation?.contactName || null,
    email: isEmail ? ident : null,
    phone: isPhone ? ident : null,
    channels: [],
    channel: chan,
  };
}

/**
 * Resolve the Podium contact behind a conversation (or a direct contactId), AS the
 * logged-in rep (P4). Prefers a direct `contactId`; otherwise reads the conversation
 * and follows its contact reference (resolved via the Contacts API off the stable
 * conversation.uid — NOT the deprecated webhook `sender`/`contact` hint, §15.6).
 *
 * @returns {Promise<object|null>} normalised contact, or null if neither id resolves.
 */
export async function resolveContact(userId, { conversationId, contactId, client } = {}) {
  let contactUid = contactId ? String(contactId) : null;
  let conversation = null;

  if (!contactUid && conversationId) {
    conversation = await getConversation(userId, String(conversationId), { client });
    // conversation.contact.uid is the durable reference where it exists (mock rows).
    // LIVE conversations have no contact object at all — the stub below carries the
    // details the conversation itself holds (contactName + channel identifier).
    contactUid = conversation?.contact?.uid || null;
  }

  if (!contactUid) {
    if (conversation) return channelStubContact(conversation);
    return null;
  }

  const raw = await getContact(userId, contactUid, { client });
  return normalizeContact(raw, conversation);
}

// ---- Customer matching -----------------------------------------------------

/** Keep only digits; return the last `n` (for loose phone equality across formats). */
export function phoneKey(value, n = 8) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length > n ? digits.slice(-n) : digits;
}

const CUSTOMER_COLS =
  'id, name, email, phone, address, notes, podium_contact_id, myob_uid, woo_customer_id';

/**
 * Match a Podium contact to a `customers` row: podium_contact_id → LOWER(email) →
 * phone (last-8-digits). Returns { customer, matchedBy } where matchedBy is one of
 * 'podium_contact_id' | 'email' | 'phone' | 'none'.
 */
export async function matchCustomer(client, contact) {
  if (!contact) return { customer: null, matchedBy: 'none' };

  // 1) Strong link on the id we may have stored previously (indexed: idx_customers_podium).
  if (contact.uid) {
    const r = await client.query(
      `SELECT ${CUSTOMER_COLS} FROM customers WHERE podium_contact_id = $1 LIMIT 1`,
      [contact.uid]
    );
    if (r.rowCount) return { customer: r.rows[0], matchedBy: 'podium_contact_id' };
  }

  // 2) Email (indexed: idx_customers_email_lower).
  const email = String(contact.email || '').toLowerCase().trim();
  if (email) {
    const r = await client.query(
      `SELECT ${CUSTOMER_COLS} FROM customers WHERE LOWER(email) = $1 LIMIT 1`,
      [email]
    );
    if (r.rowCount) return { customer: r.rows[0], matchedBy: 'email' };
  }

  // 3) Phone, last-8-digits (best-effort; no index — customers is small, and F4's UI
  //    fetches this once per conversation open, not per render).
  const key = phoneKey(contact.phone);
  if (key && key.length >= 6) {
    const r = await client.query(
      `SELECT ${CUSTOMER_COLS} FROM customers
        WHERE phone IS NOT NULL
          AND right(regexp_replace(phone, '\\D', '', 'g'), 8) = $1
        LIMIT 1`,
      [key]
    );
    if (r.rowCount) return { customer: r.rows[0], matchedBy: 'phone' };
  }

  return { customer: null, matchedBy: 'none' };
}

/**
 * Link a Podium contact uid onto a customer, but only when the slot is empty — never
 * clobber an existing link (idempotent; mirrors F1b's persist-only-when-empty rule).
 * @returns {Promise<boolean>} true if this call wrote the link.
 */
export async function linkContactToCustomer(client, customerId, contactUid) {
  if (!customerId || !contactUid) return false;
  const r = await client.query(
    `UPDATE customers SET podium_contact_id = $1
       WHERE id = $2 AND (podium_contact_id IS NULL OR podium_contact_id = '')`,
    [contactUid, customerId]
  );
  return (r.rowCount || 0) > 0;
}

/**
 * Create a `customers` row from a Podium contact. Creation is explicit (POST
 * action=create) — the UI's "Create customer from contact". `overrides` lets the UI
 * fill gaps the contact lacks (customers.email is NOT NULL, and some Podium contacts
 * — e.g. social-only — have no email). Throws EMAIL_REQUIRED if no email is available
 * from either the contact or the overrides, so the UI can prompt for one.
 */
export async function createCustomerFromContact(client, contact, overrides = {}) {
  const email = String(overrides.email || contact?.email || '').trim();
  if (!email) {
    const e = new Error('An email is required to create a customer from this contact');
    e.code = 'EMAIL_REQUIRED';
    throw e;
  }
  const name =
    String(overrides.name || contact?.name || '').trim() || email.split('@')[0] || 'Podium Contact';
  const phone = (overrides.phone ?? contact?.phone) || null;
  const address = overrides.address || null;
  const contactUid = contact?.uid || null;

  const r = await client.query(
    `INSERT INTO customers (name, email, phone, address, podium_contact_id)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING ${CUSTOMER_COLS}`,
    [name, email, phone, address, contactUid]
  );
  return r.rows[0];
}

// ---- Customer 360 (compact) for the inbox side panel -----------------------

/** OPEN workorders (anything not yet Completed) for a customer, newest first. */
export async function openWorkordersForCustomer(client, customerId) {
  if (!customerId) return [];
  const r = await client.query(
    `SELECT workorder_id, invoice_id, status, outstanding_balance,
            delivery_suburb, delivery_state, estimated_completion, date_created, ecommerce
       FROM workorder
      WHERE customer_id = $1 AND status <> 'Completed'
      ORDER BY date_created DESC`,
    [customerId]
  );
  return r.rows;
}

/** ACTIVE deliveries (not yet Delivery Completed) for a customer, newest first. */
export async function activeDeliveriesForCustomer(client, customerId) {
  if (!customerId) return [];
  const r = await client.query(
    `SELECT delivery_id, invoice_id, workorder_id, delivery_suburb, delivery_state,
            delivery_date, delivery_status, date_created
       FROM delivery
      WHERE customer_id = $1 AND delivery_status <> 'Delivery Completed'
      ORDER BY date_created DESC`,
    [customerId]
  );
  return r.rows;
}

/**
 * The customer's most-recent lead (funnel stage), matched by conversation → contact →
 * customer, whichever we have. Returns the latest lead at ANY stage (incl. Won/Lost) so
 * the inbox panel can show the current funnel stage + history even after a deal closes,
 * and only offers "Add to funnel" when there is no lead at all. Defensive: returns null
 * if the leads table isn't migrated yet (42P01) — Production (pre-F0-release) still
 * serves the panel; the funnel just shows empty until leads exist.
 */
export async function latestLeadFor(client, { customerId = null, contactUid = null, conversationId = null } = {}) {
  if (!customerId && !contactUid && !conversationId) return null;
  try {
    const r = await client.query(
      `SELECT lead_id, stage, assigned_to, source_channel, value_est, product_interest,
              quote_invoice_id, payment, converted_workorder_id,
              last_contact_at, created_at, updated_at
         FROM leads
        WHERE ( ($1::varchar IS NOT NULL AND podium_conversation_id = $1)
             OR ($2::varchar IS NOT NULL AND podium_contact_id = $2)
             OR ($3::int     IS NOT NULL AND customer_id = $3) )
        ORDER BY updated_at DESC
        LIMIT 1`,
      [conversationId, contactUid, customerId]
    );
    return r.rowCount ? r.rows[0] : null;
  } catch (err) {
    if (err?.code === '42P01') return null; // leads not migrated on this DB yet
    throw err;
  }
}

/**
 * Build the full customer panel for a conversation/contact: resolve the Podium
 * contact, match (and best-effort backfill the link on an email/phone match), then
 * gather the customer's open workorders, active deliveries, and open lead.
 *
 * @param {object} client  pg client (caller owns the connection)
 * @param {string} userId  acting rep's portal id (their Podium token is used, P4)
 * @param {{conversationId?:string, contactId?:string, autoLink?:boolean}} opts
 * @returns {Promise<object>} the panel (see the shape assembled below).
 */
export async function buildCustomerPanel(client, userId, { conversationId, contactId, autoLink = true } = {}) {
  const contact = await resolveContact(userId, { conversationId, contactId, client });

  const panel = {
    conversationId: conversationId ? String(conversationId) : null,
    contact: contact || null,
    customer: null,
    matchedBy: 'none',
    linked: false,
    workorders: [],
    deliveries: [],
    lead: null,
  };
  if (!contact) return panel;

  const { customer, matchedBy } = await matchCustomer(client, contact);
  panel.matchedBy = matchedBy;

  if (customer) {
    // Backfill the durable link when we matched on email/phone (never overwrite one).
    if (autoLink && matchedBy !== 'podium_contact_id' && contact.uid) {
      panel.linked = await linkContactToCustomer(client, customer.id, contact.uid);
      if (panel.linked) customer.podium_contact_id = contact.uid;
    }
    panel.customer = customer;
    panel.workorders = await openWorkordersForCustomer(client, customer.id);
    panel.deliveries = await activeDeliveriesForCustomer(client, customer.id);
  }

  panel.lead = await latestLeadFor(client, {
    customerId: customer?.id || null,
    contactUid: contact.uid || null,
    conversationId: conversationId ? String(conversationId) : null,
  });

  return panel;
}

// ---- F14 conversation search ----------------------------------------------

/**
 * Build a compact, searchable identity for a conversation, reusing the F4 bridge: the
 * Podium contact behind it (name/phone/email) AND the matched portal customer
 * (name/email/phone). Drives the inbox conversation search (feature F14) — filter the
 * list by WHO a conversation is with, and give each row a real display name instead of a
 * bare phone number. Reads only CRM metadata, never message bodies (P1).
 *
 * We already hold the conversation object (from GET /conversations), so the contact is
 * resolved directly off conversation.contact.uid — no extra GET /conversations/{uid}.
 * A missing/404 contact degrades to a channel-only stub (phone from the channel), so a
 * phone-number search still works for conversations with no contact record.
 *
 * @param {object} client  pg client (caller owns the connection)
 * @param {string} userId  acting rep's portal id (their Podium token is used, P4)
 * @param {object} conv    a §15 conversation object
 * @returns {Promise<{contactName:?string, customerName:?string, customerId:?number,
 *   email:?string, phone:?string, matchedBy:string, displayName:?string}>}
 */
export async function buildConversationIdentity(client, userId, conv) {
  const contactUid = conv?.contact?.uid || null;
  let contact = null;
  if (contactUid) {
    try {
      contact = normalizeContact(await getContact(userId, contactUid, { client }), conv);
    } catch (err) {
      if (err?.status !== 404) throw err; // contact gone upstream → fall through to a channel stub
    }
  }
  if (!contact) contact = channelStubContact(conv, contactUid);

  const { customer, matchedBy } = await matchCustomer(client, contact);
  const displayName =
    customer?.name || contact.name || contact.phone || conv?.channel?.identifier || null;

  return {
    contactName: contact.name || null,
    customerName: customer?.name || null,
    customerId: customer?.id || null,
    email: customer?.email || contact.email || null,
    phone: customer?.phone || contact.phone || null,
    matchedBy,
    displayName,
  };
}

/**
 * Does a conversation's resolved identity match a free-text search term? Case-insensitive
 * substring on name/email/handle; loose phone matching (digits only): substring of the
 * full stored number (so a prefix typed in the stored format matches) PLUS last-8
 * equality (so a full number typed in local 04xx form still matches a +61-stored one).
 * The raw channel identifier is searched too (covers social handles + phone numbers).
 * An empty/whitespace term matches everything.
 */
export function identityMatchesSearch(identity, conv, term) {
  const q = String(term || '').trim().toLowerCase();
  if (!q) return true;

  const text = [
    identity?.contactName,
    identity?.customerName,
    identity?.email,
    identity?.displayName,
    conv?.channel?.identifier,
  ].filter(Boolean).map((s) => String(s).toLowerCase());
  if (text.some((s) => s.includes(q))) return true;

  const qDigits = q.replace(/\D/g, '');
  if (qDigits.length >= 3) {
    const phones = [identity?.phone, conv?.channel?.identifier]
      .filter(Boolean)
      .map((p) => String(p).replace(/\D/g, ''))
      .filter(Boolean);
    for (const p of phones) {
      if (p.includes(qDigits)) return true;                                    // prefix/substring, stored form
      if (qDigits.length >= 8 && p.slice(-8) === qDigits.slice(-8)) return true; // full number, cross-format
    }
  }
  return false;
}

export default {
  normalizeContact,
  resolveContact,
  phoneKey,
  matchCustomer,
  linkContactToCustomer,
  createCustomerFromContact,
  openWorkordersForCustomer,
  activeDeliveriesForCustomer,
  latestLeadFor,
  buildCustomerPanel,
  buildConversationIdentity,
  identityMatchesSearch,
};
