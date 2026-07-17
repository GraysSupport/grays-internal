// lib/podiumCompose.js — F20: start a NEW conversation to a phone/email, with dedupe.
//
// A salesperson composes a new chat. Before creating anything we DEDUPE: if a conversation
// for that phone/email already exists, we reopen it (if closed) and continue it rather than
// spawning a duplicate thread; only when nothing matches do we create the Podium contact
// and open a fresh conversation. Reuses the F4 bridge's phone normalisation and the F11
// open/close (setConversationStatus). Mock-first: every Podium hop routes through
// lib/podium.js, which serves the typed mock under PODIUM_MOCK.
//
// The Podium service functions are injectable (deps) so the dedupe/reopen/create decision
// is unit-testable without network or DB. P1 holds — no message body is persisted here.

import { phoneKey } from './podiumContact.js';
import {
  listConversations, getContact, sendMessage, setConversationStatus, createContact,
  openConversation,
} from './podium.js';

function composeError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Classify the recipient as a phone or an email, and derive a stable match key
// (phone → normalised last-8 digits; email → trimmed + lowercased). Throws
// INVALID_COMPOSE_TARGET for anything that is neither.
export function classifyTarget(to) {
  const value = String(to ?? '').trim();
  if (!value) throw composeError('A phone number or email is required', 'INVALID_COMPOSE_TARGET');
  if (EMAIL_RE.test(value)) {
    return { kind: 'email', value, key: value.toLowerCase() };
  }
  const digits = value.replace(/\D/g, '');
  if (digits.length >= 6) {
    return { kind: 'phone', value, key: phoneKey(value) };
  }
  throw composeError('Enter a valid phone number or email address', 'INVALID_COMPOSE_TARGET');
}

// Does a resolved Podium contact match the target?
export function contactMatchesTarget(contact, target) {
  if (!contact) return false;
  if (target.kind === 'phone') {
    return !!contact.phoneNumber && phoneKey(contact.phoneNumber) === target.key;
  }
  return !!contact.email && String(contact.email).trim().toLowerCase() === target.key;
}

// Does a conversation belong to the target? Fast path on the channel identifier (phone/
// email channels carry the raw number/address); otherwise resolve the contact and compare.
async function conversationMatchesTarget(userId, conv, target, svc) {
  const ident = conv?.channel?.identifier;
  if (ident) {
    if (target.kind === 'phone' && /\d/.test(ident) && phoneKey(ident) === target.key) return true;
    if (target.kind === 'email' && String(ident).includes('@') && String(ident).trim().toLowerCase() === target.key) return true;
  }
  const contactUid = conv?.contact?.uid;
  if (contactUid) {
    const contact = await svc.getContact(userId, contactUid);
    if (contactMatchesTarget(contact, target)) return true;
  }
  return false;
}

function isOpen(conv) {
  return conv?.closed !== true && (conv?.status || 'open') !== 'closed';
}

// Find an existing conversation for the target. Scans one page (≤100) of ALL conversations
// (both statuses) and prefers an OPEN match, falling back to a closed one. (Single-page
// scan mirrors F14's dedupe/search cap; a paginating scan is a live-wiring follow-up.)
export async function findExistingConversation(userId, target, deps = {}) {
  const svc = { listConversations, getContact, ...deps };
  const resp = await svc.listConversations(userId, { limit: 100 });
  const convs = Array.isArray(resp?.data) ? resp.data : [];
  let openMatch = null;
  let anyMatch = null;
  for (const conv of convs) {
    // eslint-disable-next-line no-await-in-loop
    if (await conversationMatchesTarget(userId, conv, target, svc)) {
      if (!anyMatch) anyMatch = conv;
      if (isOpen(conv) && !openMatch) openMatch = conv;
    }
  }
  return openMatch || anyMatch || null;
}

function normalizeChannel(channel, target) {
  const c = String(channel ?? '').trim().toLowerCase();
  if (c) return c;
  return target.kind === 'email' ? 'email' : 'sms';
}

// Start (or continue) a conversation with `to` on `channel`, carrying the first message
// `body`. Returns { conversationId, reused, reopened, contactUid }.
export async function composeConversation(userId, { to, channel, body } = {}, deps = {}) {
  const svc = {
    listConversations, getContact, sendMessage, setConversationStatus, createContact, openConversation,
    ...deps,
  };

  const text = (body == null ? '' : String(body)).trim();
  if (!text) throw composeError('A message is required to start a conversation', 'COMPOSE_BODY_REQUIRED');
  const target = classifyTarget(to); // throws INVALID_COMPOSE_TARGET
  const ch = normalizeChannel(channel, target);

  const existing = await findExistingConversation(userId, target, svc);
  if (existing) {
    const wasClosed = !isOpen(existing);
    if (wasClosed) await svc.setConversationStatus(userId, existing.uid, 'open');
    await svc.sendMessage(userId, { conversationUid: existing.uid, body: text });
    return {
      conversationId: existing.uid,
      reused: true,
      reopened: wasClosed,
      contactUid: existing?.contact?.uid || null,
    };
  }

  // Nothing matched — create the contact, then open a new thread carrying the first message.
  const contactFields = target.kind === 'phone'
    ? { phoneNumber: target.value, channels: [ch] }
    : { email: target.value, channels: [ch] };
  const contact = await svc.createContact(userId, contactFields);
  const conv = await svc.openConversation(userId, {
    to: target.value,
    channel: ch,
    body: text,
    contactUid: contact?.uid || null,
  });
  return {
    conversationId: conv?.uid || null,
    reused: false,
    reopened: false,
    contactUid: contact?.uid || null,
  };
}
