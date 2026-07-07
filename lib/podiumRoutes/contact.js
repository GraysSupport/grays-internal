// lib/podiumRoutes/contact.js — Contact ↔ Customer bridge endpoint (feature F4).
//
// Served via the api/podium/[...podium].js catch-all as /api/podium/contact (Hobby-cap
// discipline: a new `case`, NOT a new function file). Gated to sales/superadmin via the
// login JWT — the server is the real gate (F9 formalises nav).
//
//   GET  /api/podium/contact?conversationId=<uid>   (or ?contactId=<uid>)
//        → resolve the Podium contact behind the conversation, match it to a customer
//          (podium_contact_id → email → phone; backfills the link on an email/phone
//          match), and return the customer panel: matched customer + OPEN workorders +
//          ACTIVE deliveries + open lead (funnel stage). customer:null when unmatched,
//          so the UI can offer "Create customer from contact".
//   POST /api/podium/contact
//        { conversationId?|contactId?, action:'create'|'link', customerId?, customer? }
//        · action:'link'   → link an EXISTING customer (customerId) to this contact.
//        · action:'create' → create a customer from the contact (customer{} fills gaps
//                             like a missing email), then link it.
//        Both return the freshly rebuilt panel.
//
// Mock-first (Golden Rule 6): the Podium hops run through lib/podium.js → the mock
// while PODIUM_MOCK=true, so the bridge is reviewable on the Preview without creds.
// Runs on the acting rep's token (P4). P1: only CRM metadata is read/written here —
// no message bodies are ever touched.

import { getAuthUser, hasAnyRole } from '../rbac.js';
import { isMock } from '../podium.js';
import { getClientWithTimezone } from '../db.js';
import {
  buildCustomerPanel,
  createCustomerFromContact,
  linkContactToCustomer,
  resolveContact,
} from '../podiumContact.js';

// P11: reading a customer's context in the inbox is a `sales` action; superadmin too.
const ALLOWED_ROLES = ['sales', 'superadmin'];

export default async function handler(req, res) {
  const auth = getAuthUser(req);
  if (!auth) return res.status(401).json({ error: 'Not authenticated' });
  if (!hasAnyRole(auth.roles, ALLOWED_ROLES)) {
    return res.status(403).json({ error: 'Requires the sales role to view customer details' });
  }

  if (req.method === 'GET') return handleGet(req, res, auth);
  if (req.method === 'POST') return handlePost(req, res, auth);
  return res.status(405).json({ error: 'Method not allowed' });
}

// GET — resolve + match + panel (best-effort backfill of the contact link).
async function handleGet(req, res, auth) {
  const conversationId = req.query?.conversationId;
  const contactId = req.query?.contactId;
  if (!conversationId && !contactId) {
    return res.status(400).json({ error: 'conversationId or contactId is required' });
  }
  const client = await getClientWithTimezone();
  try {
    const panel = await buildCustomerPanel(client, auth.id, {
      conversationId: conversationId ? String(conversationId) : undefined,
      contactId: contactId ? String(contactId) : undefined,
    });
    return res.status(200).json({ ...panel, mock: isMock() });
  } catch (err) {
    return respondError(res, err, 'load the customer panel');
  } finally {
    client.release();
  }
}

// POST — explicit link/create, then return the rebuilt panel.
async function handlePost(req, res, auth) {
  const { conversationId, contactId, action, customerId, customer } = req.body || {};
  if (!conversationId && !contactId) {
    return res.status(400).json({ error: 'conversationId or contactId is required' });
  }
  const act = String(action || '').toLowerCase();
  if (act !== 'create' && act !== 'link') {
    return res.status(400).json({ error: "action must be 'create' or 'link'" });
  }

  const client = await getClientWithTimezone();
  try {
    // Resolve the contact once; both actions need its uid (and 'create' its fields).
    const contact = await resolveContact(auth.id, {
      conversationId: conversationId ? String(conversationId) : undefined,
      contactId: contactId ? String(contactId) : undefined,
      client,
    });
    if (!contact || !contact.uid) {
      return res.status(404).json({ error: 'No Podium contact found for this conversation' });
    }

    if (act === 'link') {
      if (!customerId) return res.status(400).json({ error: 'customerId is required to link' });
      const exists = await client.query('SELECT id FROM customers WHERE id = $1 LIMIT 1', [customerId]);
      if (!exists.rowCount) return res.status(404).json({ error: `Customer ${customerId} not found` });
      await linkContactToCustomer(client, Number(customerId), contact.uid);
    } else {
      // create
      await createCustomerFromContact(client, contact, customer || {});
    }

    // Rebuild the panel so the caller immediately sees the newly-linked customer + 360.
    const panel = await buildCustomerPanel(client, auth.id, {
      conversationId: conversationId ? String(conversationId) : undefined,
      contactId: contactId ? String(contactId) : undefined,
    });
    return res.status(act === 'create' ? 201 : 200).json({ ...panel, mock: isMock() });
  } catch (err) {
    if (err?.code === 'EMAIL_REQUIRED') {
      return res.status(422).json({ error: err.message, code: 'EMAIL_REQUIRED' });
    }
    if (err?.code === '23505') {
      // Unlikely (customers.email isn't uniquely constrained today) but safe to surface.
      return res.status(409).json({ error: 'A customer with these details already exists' });
    }
    return respondError(res, err, 'update the customer link');
  } finally {
    client.release();
  }
}

function respondError(res, err, action) {
  if (err?.code === 'PODIUM_NOT_CONNECTED') {
    return res.status(409).json({ error: 'You have not linked a Podium account', code: 'NOT_CONNECTED' });
  }
  if (err?.status === 404) return res.status(404).json({ error: 'Not found in Podium' });
  console.error(`podium contact: could not ${action}:`, err);
  return res.status(502).json({ error: `Could not ${action}` });
}
