// lib/podium.mock.js — typed, in-memory Podium API v4 mock (F1, mock-first).
//
// Until live Podium developer credentials are wired into Vercel (PODIUM_MOCK=true,
// Golden Rule 6), `lib/podium.js` routes every call through this module so the
// Preview stays reviewable without network or secrets. Responses are shaped to
// match the VERIFIED Podium v4 reference in execution-plan.md §15 — cursor
// pagination envelope `{ data, metadata:{ nextCursor, previousCursor } }`, stable
// opaque `uid`s, `conversation.channel.{type,identifier}`, `assignedUser.uid`, and
// the (deprecated-but-present) `contact` hint on message events.
//
// NOTE ON P1: this mock returns `data.body` on messages purely so the future inbox
// UI has something to render live. The service and its callers must NEVER persist
// message bodies (execution-plan P1) — Podium is the system of record.

// ---- Fixtures -------------------------------------------------------------

// Reps / members (Podium "users"). Their `uid` maps to users.podium_user_id.
const USERS = [
  { uid: 'pod_usr_amELia', name: 'Amelia Reid', email: 'amelia@graysfitness.com.au', role: 'member' },
  { uid: 'pod_usr_bENjin', name: 'Ben Jindra', email: 'ben@graysfitness.com.au', role: 'member' },
  { uid: 'pod_usr_owNER1', name: 'Grays Owner', email: 'owner@graysfitness.com.au', role: 'owner' },
];

// Contacts (customers on the Podium side). uid maps to customers.podium_contact_id.
const CONTACTS = [
  { uid: 'pod_con_maRIA1', name: 'Maria Papadopoulos', phoneNumber: '+61400111222', email: 'maria@example.com', channels: ['phone', 'facebook'] },
  { uid: 'pod_con_toMH20', name: 'Tom Harris', phoneNumber: '+61400333444', email: 'tom.h@example.com', channels: ['phone'] },
  { uid: 'pod_con_liNDA3', name: 'Linda Nguyen', phoneNumber: '+61400555666', email: null, channels: ['instagram'] },
  { uid: 'pod_con_jaKE44', name: 'Jake Wilson', phoneNumber: '+61400777888', email: 'jakew@example.com', channels: ['google'] },
];

// Message templates (canned responses) — Podium's saved templates a rep inserts
// into the composer (feature F12). Australian English, Grays brand voice; no hard
// prices (exact pricing lives in the product/quote flow). Under live Podium these
// come from the templates API — VERIFY the live endpoint/field names at wiring.
const MESSAGE_TEMPLATES = [
  { uid: 'pod_tpl_greet', title: 'Greeting', body: 'Hi! Thanks for reaching out to Grays Fitness. How can I help you today?' },
  { uid: 'pod_tpl_deliv', title: 'Delivery quote', body: 'We deliver Australia-wide. If you can share your suburb and postcode, I’ll organise a delivery quote for you.' },
  { uid: 'pod_tpl_stock', title: 'Stock check', body: 'Let me check our current stock on that for you — one moment.' },
  { uid: 'pod_tpl_warra', title: 'Warranty', body: 'All our equipment is commercially graded and professionally refurbished, and comes with a warranty. Happy to run through the details.' },
  { uid: 'pod_tpl_hold', title: 'Hold item', body: 'I can hold that for you for 24 hours while you decide. Would you like me to organise that?' },
];

const LOCATION_UID = () => process.env.PODIUM_LOCATION_UID || 'pod_loc_GRAYSHQ';
const ORG_UID = () => process.env.PODIUM_ORG_UID || 'pod_org_GRAYS';

// Conversations — one per contact, spread across channels + assignees.
// `status` (open|closed) drives the F11 Podium-parity buckets (Open vs Closed within
// Unassigned / All / Assigned-to-You). Spread so every bucket×status cell has ≥1 row:
//   Assigned-to-amELia: 00001 open, 00004 closed
//   Unassigned:         00003 open, 00006 closed
//   (00002/00005 belong to bENjin, and round out "All").
//
// F13 multi-assignee: a conversation may be assigned to ONE OR MORE reps via the
// `assignees` array (Podium's `PUT /conversations/{uid}/assignees` is plural). When
// present it is authoritative; `assignedUser` is kept as the PRIMARY (first) assignee
// for backward-compat with the single-owner mirror (leads.assigned_to). Conversation
// 00001 is assigned to two reps (Amelia + Ben) so the multi-assignee UI + the
// who-sent-what attribution in its thread are reviewable out of the box.
const CONVERSATIONS = [
  {
    uid: 'pod_cnv_00001',
    channel: { type: 'phone', identifier: '+61400111222' },
    contact: { uid: 'pod_con_maRIA1' }, // deprecated hint (see §15.6) — resolve via Contacts API
    assignedUser: { uid: 'pod_usr_amELia' }, // primary (first) assignee
    assignees: [{ uid: 'pod_usr_amELia' }, { uid: 'pod_usr_bENjin' }], // F13: two reps
    status: 'open',
    location: { uid: LOCATION_UID(), organizationUid: ORG_UID() },
    lastMessageAt: '2026-07-03T09:18:00+10:00',
  },
  {
    uid: 'pod_cnv_00002',
    channel: { type: 'facebook', identifier: 'fb:graysfitness' },
    contact: { uid: 'pod_con_maRIA1' },
    assignedUser: { uid: 'pod_usr_bENjin' },
    status: 'closed',
    location: { uid: LOCATION_UID(), organizationUid: ORG_UID() },
    lastMessageAt: '2026-07-02T16:40:00+10:00',
  },
  {
    uid: 'pod_cnv_00003',
    channel: { type: 'phone', identifier: '+61400333444' },
    contact: { uid: 'pod_con_toMH20' },
    assignedUser: null, // unassigned — auto-created lead would be unassigned (P12)
    status: 'open',
    location: { uid: LOCATION_UID(), organizationUid: ORG_UID() },
    lastMessageAt: '2026-07-03T08:02:00+10:00',
  },
  {
    uid: 'pod_cnv_00004',
    channel: { type: 'instagram', identifier: 'ig:graysfitness' },
    contact: { uid: 'pod_con_liNDA3' },
    assignedUser: { uid: 'pod_usr_amELia' },
    status: 'closed',
    location: { uid: LOCATION_UID(), organizationUid: ORG_UID() },
    lastMessageAt: '2026-07-01T11:20:00+10:00',
  },
  {
    uid: 'pod_cnv_00005',
    channel: { type: 'google', identifier: 'gbm:graysfitness' },
    contact: { uid: 'pod_con_jaKE44' },
    assignedUser: { uid: 'pod_usr_bENjin' },
    status: 'open',
    location: { uid: LOCATION_UID(), organizationUid: ORG_UID() },
    lastMessageAt: '2026-07-03T07:45:00+10:00',
  },
  {
    uid: 'pod_cnv_00006',
    channel: { type: 'webchat', identifier: 'web:graysfitness' },
    contact: { uid: 'pod_con_toMH20' },
    assignedUser: null, // unassigned + closed — the Unassigned/Closed bucket cell
    status: 'closed',
    location: { uid: LOCATION_UID(), organizationUid: ORG_UID() },
    lastMessageAt: '2026-06-30T14:05:00+10:00',
  },
];

// Messages keyed by conversation uid (oldest → newest). `body` present (see P1 note).
// F13 sender attribution: OUTBOUND messages carry a `senderUser` ({uid,name}) = the rep
// who sent them, so a multi-rep thread can label who-sent-what. `name` is denormalised
// here for the mock; under live Podium the message carries the sender's user uid and the
// UI resolves the name via GET /v4/users (a live-wiring detail — VERIFY the exact field).
// Conversation 00001 is a genuine two-rep thread (Amelia + Ben both reply).
const MESSAGES = {
  pod_cnv_00001: [
    { uid: 'pod_msg_0001a', direction: 'inbound', channel: 'phone', body: 'Hi, is the 20kg adjustable dumbbell set back in stock?', createdAt: '2026-07-03T09:10:00+10:00' },
    { uid: 'pod_msg_0001b', direction: 'outbound', channel: 'phone', senderUser: { uid: 'pod_usr_amELia', name: 'Amelia Reid' }, body: 'Hi Maria! Yes, we just restocked — want me to hold a set for you?', createdAt: '2026-07-03T09:12:00+10:00' },
    { uid: 'pod_msg_0001c', direction: 'inbound', channel: 'phone', body: 'Yes please, and can you do delivery to Brunswick?', createdAt: '2026-07-03T09:15:00+10:00' },
    { uid: 'pod_msg_0001d', direction: 'outbound', channel: 'phone', senderUser: { uid: 'pod_usr_bENjin', name: 'Ben Jindra' }, body: 'Hi Maria, Ben here — I can confirm a Brunswick delivery slot for Thursday. Amelia has your dumbbells on hold.', createdAt: '2026-07-03T09:18:00+10:00' },
  ],
  pod_cnv_00002: [
    { uid: 'pod_msg_0002a', direction: 'inbound', channel: 'facebook', body: 'Do you price match on the rowing machine?', createdAt: '2026-07-02T16:38:00+10:00' },
    { uid: 'pod_msg_0002b', direction: 'outbound', channel: 'facebook', senderUser: { uid: 'pod_usr_bENjin', name: 'Ben Jindra' }, body: 'We can usually get close — send me the competitor link?', createdAt: '2026-07-02T16:40:00+10:00' },
  ],
  pod_cnv_00003: [
    { uid: 'pod_msg_0003a', direction: 'inbound', channel: 'phone', body: 'What are your warehouse pickup hours on Saturday?', createdAt: '2026-07-03T08:02:00+10:00' },
  ],
  pod_cnv_00004: [
    { uid: 'pod_msg_0004a', direction: 'inbound', channel: 'instagram', body: 'Love the new squat racks 😍 do they come assembled?', createdAt: '2026-07-01T11:18:00+10:00' },
    { uid: 'pod_msg_0004b', direction: 'outbound', channel: 'instagram', senderUser: { uid: 'pod_usr_amELia', name: 'Amelia Reid' }, body: 'Thank you! They ship flat-packed but assembly is straightforward.', createdAt: '2026-07-01T11:20:00+10:00' },
  ],
  pod_cnv_00005: [
    { uid: 'pod_msg_0005a', direction: 'inbound', channel: 'google', body: 'Can I get a quote for a full home gym setup?', createdAt: '2026-07-03T07:45:00+10:00' },
  ],
  pod_cnv_00006: [
    { uid: 'pod_msg_0006a', direction: 'inbound', channel: 'webchat', body: 'Do you deliver to regional Victoria?', createdAt: '2026-06-30T14:00:00+10:00' },
    { uid: 'pod_msg_0006b', direction: 'outbound', channel: 'webchat', body: 'We do — happy to sort a quote when you are ready. Closing this off for now.', createdAt: '2026-06-30T14:05:00+10:00' },
  ],
};

// ---- Cursor pagination -----------------------------------------------------
// Opaque cursor = base64("offset:<n>"). Mirrors §15.5 (limit 1–100, default 10).

function encodeCursor(offset) {
  return Buffer.from(`offset:${offset}`, 'utf8').toString('base64');
}
function decodeCursor(cursor) {
  if (!cursor) return 0;
  try {
    const s = Buffer.from(String(cursor), 'base64').toString('utf8');
    const m = s.match(/^offset:(\d+)$/);
    return m ? parseInt(m[1], 10) : 0;
  } catch {
    return 0;
  }
}

function paginateList(items, query = {}) {
  const rawLimit = parseInt(query.limit, 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 10;
  const offset = decodeCursor(query.cursor);
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + limit;
  const nextCursor = nextOffset < items.length ? encodeCursor(nextOffset) : null;
  const previousCursor = offset > 0 ? encodeCursor(Math.max(offset - limit, 0)) : null;
  return { data: page, metadata: { nextCursor, previousCursor } };
}

// ---- OAuth mock ------------------------------------------------------------

const TEN_HOURS_SECONDS = 10 * 60 * 60;

/** Synthetic token set matching the real `{ access_token, refresh_token }` shape. */
export function oauthExchange(code) {
  return {
    access_token: `mock_at_${code || 'code'}_${'x'.repeat(6)}`,
    refresh_token: `mock_rt_${code || 'code'}`,
    expires_in: TEN_HOURS_SECONDS, // access token lives 10h (§15.2)
    token_type: 'bearer',
    // resolved rep identity the callback uses to set users.podium_user_id
    podium_user_id: USERS[0].uid,
  };
}

/** Refresh returns a fresh access token; refresh token may rotate. */
export function oauthRefresh(refreshToken) {
  return {
    access_token: `mock_at_refreshed_${'x'.repeat(6)}`,
    refresh_token: refreshToken || 'mock_rt_rotated',
    expires_in: TEN_HOURS_SECONDS,
    token_type: 'bearer',
  };
}

// ---- Request router --------------------------------------------------------
// `lib/podium.js` calls handle() in mock mode. Path is the part after /v4/.

function stripV4(path) {
  return String(path || '').replace(/^\/?v4\//, '').replace(/^\//, '');
}

// F13: the effective assignee uid set for a conversation. Prefers the `assignees`
// array (multi-assignee); falls back to the single `assignedUser` for fixtures that
// carry only the legacy field. Deduped, empty when unassigned.
function assigneeUidList(conv) {
  const uids = Array.isArray(conv?.assignees) && conv.assignees.length
    ? conv.assignees.map((a) => a?.uid)
    : (conv?.assignedUser?.uid ? [conv.assignedUser.uid] : []);
  return [...new Set(uids.filter(Boolean).map(String))];
}

// Normalise a PUT /assignees body into a deduped uid array. Accepts the F13 array form
// (`userUids` / `assigneeUids`) and the legacy single form (`userUid` / `assigneeUid` /
// `uid`), so both single- and multi-assignee callers work.
function normalizeAssigneeUids(body = {}) {
  const raw = Array.isArray(body.userUids) ? body.userUids
    : Array.isArray(body.assigneeUids) ? body.assigneeUids
      : [body.userUid || body.assigneeUid || body.uid].filter(Boolean);
  return [...new Set(raw.filter(Boolean).map(String))];
}

// F20: match a contact against a create body by phone (last-8 digits) or email (case-
// insensitive) — the same identity keys lib/podiumCompose.js dedupes on.
function digitsTail(v, n = 8) {
  return String(v || '').replace(/\D/g, '').slice(-n);
}
function contactMatchesIdentity(contact, body = {}) {
  if (body.phoneNumber && contact.phoneNumber && digitsTail(body.phoneNumber) === digitsTail(contact.phoneNumber)) return true;
  if (body.email && contact.email && String(body.email).trim().toLowerCase() === String(contact.email).trim().toLowerCase()) return true;
  return false;
}

/**
 * Route a mock request. Returns a plain object shaped like the live API.
 * @param {string} method  GET|POST|PUT|PATCH|DELETE
 * @param {string} path    e.g. 'conversations' or 'conversations/pod_cnv_00001/messages'
 * @param {{query?:object, body?:object}} opts
 */
export function handle(method, path, opts = {}) {
  const m = String(method || 'GET').toUpperCase();
  const p = stripV4(path);
  const query = opts.query || {};
  const body = opts.body || {};
  const segs = p.split('/').filter(Boolean);

  // GET /users  ·  GET /users/{uid}
  if (segs[0] === 'users') {
    if (segs[1]) {
      const u = USERS.find((x) => x.uid === segs[1]);
      if (!u) return notFound('user', segs[1]);
      return u;
    }
    return paginateList(USERS, query);
  }

  // GET /contacts  ·  GET /contacts/{uid}  ·  POST /contacts (F20 create, dedupe)
  if (segs[0] === 'contacts') {
    if (segs[1]) {
      const c = CONTACTS.find((x) => x.uid === segs[1]);
      if (!c) return notFound('contact', segs[1]);
      return c;
    }
    if (m === 'POST') {
      // F20: idempotent create — Podium returns the existing contact when phone/email
      // matches, so a dedupe race never spawns a duplicate. Otherwise append a new one.
      const existing = CONTACTS.find((c) => contactMatchesIdentity(c, body));
      if (existing) return existing;
      const contact = {
        uid: `pod_con_new_${Date.now().toString(36)}`,
        name: body.name || null,
        phoneNumber: body.phoneNumber || null,
        email: body.email || null,
        channels: Array.isArray(body.channels) ? body.channels : [],
      };
      CONTACTS.push(contact);
      return contact;
    }
    return paginateList(CONTACTS, query);
  }

  // conversations ...
  if (segs[0] === 'conversations') {
    // POST /conversations — F20 compose: open a NEW conversation carrying the first
    // outbound message. Appended to the in-memory fixtures so it's readable back on the
    // Preview (writes nothing to the portal DB — Podium is the system of record, P1).
    // Dedupe is the caller's job (lib/podiumCompose.js); this always creates.
    if (!segs[1] && m === 'POST') {
      const uid = `pod_cnv_new_${Date.now().toString(36)}`;
      const conv = {
        uid,
        channel: { type: body.channel || 'sms', identifier: body.to || null },
        contact: body.contactUid ? { uid: body.contactUid } : null,
        assignedUser: null,
        status: 'open',
        location: { uid: LOCATION_UID(), organizationUid: ORG_UID() },
        lastMessageAt: nowIso(),
      };
      CONVERSATIONS.push(conv);
      MESSAGES[uid] = [];
      if (body.body) {
        MESSAGES[uid].push({
          uid: `pod_msg_${Date.now().toString(36)}`,
          direction: 'outbound',
          channel: conv.channel.type,
          body: body.body,
          createdAt: nowIso(),
        });
      }
      return conv;
    }
    // GET /conversations
    if (!segs[1]) {
      let items = CONVERSATIONS;
      // F11 buckets: `unassigned=true` (no assignee) wins; else `assigneeUid` (mine);
      // else all. `status=open|closed` narrows either. VERIFY the live Podium param
      // names for the unassigned + status filters at live wiring (§15.5 note).
      // F13: "mine" and "unassigned" test the full assignee SET (a conversation shared
      // by two reps appears in BOTH reps' "Assigned to You" buckets).
      if (query.unassigned === 'true' || query.unassigned === true) {
        items = items.filter((c) => assigneeUidList(c).length === 0);
      } else if (query.assigneeUid) {
        items = items.filter((c) => assigneeUidList(c).includes(query.assigneeUid));
      }
      if (query.status === 'open' || query.status === 'closed') {
        items = items.filter((c) => (c.status || 'open') === query.status);
      }
      return paginateList(items, query);
    }
    const convUid = segs[1];
    const conv = CONVERSATIONS.find((c) => c.uid === convUid);
    // GET /conversations/{uid}/messages
    if (segs[2] === 'messages') {
      if (!conv) return notFound('conversation', convUid);
      return paginateList(MESSAGES[convUid] || [], query);
    }
    // POST /conversations/{uid}/notes — add a team-only INTERNAL NOTE (F12). Not sent
    // to the customer; `internal:true` so the inbox renders it distinctly. Appended to
    // the in-memory thread so it persists for the Preview demo (writes nothing to the
    // portal DB — Podium is the system of record, P1). VERIFY the live endpoint at wiring.
    if (segs[2] === 'notes' && m === 'POST') {
      if (!conv) return notFound('conversation', convUid);
      const note = {
        uid: `pod_note_${Date.now().toString(36)}`,
        direction: 'internal',
        internal: true,
        channel: conv.channel?.type || 'note',
        author: body.author || null,
        body: body.body || '',
        createdAt: nowIso(),
      };
      (MESSAGES[convUid] || (MESSAGES[convUid] = [])).push(note);
      return note;
    }
    // GET|PUT /conversations/{uid}/assignees — F13 multi-assignee (Podium's endpoint is
    // plural). PUT replaces the whole assignee SET; `assignedUser` tracks the primary
    // (first). The fixture is mutated so the change persists for the Preview demo (a
    // reassignment shows up on reload/poll within this serverless instance).
    if (segs[2] === 'assignees') {
      if (!conv) return notFound('conversation', convUid);
      if (m === 'PUT') {
        const uids = normalizeAssigneeUids(body);
        const assignees = uids.map((uid) => ({ uid }));
        const primary = assignees[0] || null;
        const idx = CONVERSATIONS.findIndex((c) => c.uid === convUid);
        if (idx !== -1) {
          CONVERSATIONS[idx].assignees = assignees;
          CONVERSATIONS[idx].assignedUser = primary;
        }
        return { conversationUid: convUid, assignees, assignedUser: primary };
      }
      const assignees = assigneeUidList(conv).map((uid) => ({ uid }));
      return { conversationUid: convUid, assignees, assignedUser: conv.assignedUser || assignees[0] || null };
    }
    // GET|PATCH /conversations/{uid}
    if (!conv) return notFound('conversation', convUid);
    if (m === 'PATCH') {
      // Mutate the in-memory fixture so open/close (and other field patches) persist
      // for this serverless instance — the conversation then moves between the F11
      // Open/Closed buckets. (Cold starts reset the mock; fine for a Preview demo.)
      const idx = CONVERSATIONS.findIndex((c) => c.uid === convUid);
      if (idx === -1) return { ...conv, ...body };
      Object.assign(CONVERSATIONS[idx], body);
      return CONVERSATIONS[idx];
    }
    return conv;
  }

  // GET /message_templates — canned responses for the composer (F12).
  if (segs[0] === 'message_templates' && (!segs[1] || m === 'GET')) {
    return paginateList(MESSAGE_TEMPLATES, query);
  }

  // POST /messages (send). Echoes back any F12 rich-messaging metadata the caller
  // attached — `attachments` (image/video/file references) and `templateId` (the
  // template the body came from) — so the seam is exercised end-to-end in mock. Real
  // media upload is a live-wiring swap (Podium media API) — VERIFY at wiring.
  if (segs[0] === 'messages' && m === 'POST') {
    const attachments = Array.isArray(body.attachments) ? body.attachments : undefined;
    return {
      uid: `pod_msg_sent_${Date.now().toString(36)}`,
      conversationUid: body.conversationUid || null,
      channel: body.channel || 'phone',
      direction: 'outbound',
      status: 'sent',
      locationUid: body.locationUid || LOCATION_UID(),
      ...(attachments ? { attachments } : {}),
      ...(body.templateId ? { templateId: body.templateId } : {}),
      createdAt: nowIso(),
    };
  }

  // POST /reviews/invites
  if (segs[0] === 'reviews' && segs[1] === 'invites' && m === 'POST') {
    return {
      uid: `pod_rev_inv_${Date.now().toString(36)}`,
      status: 'sent',
      locationUid: body.locationUid || LOCATION_UID(),
      contactUid: body.contactUid || null,
      createdAt: nowIso(),
    };
  }

  // GET /reviews
  if (segs[0] === 'reviews' && !segs[1]) {
    return paginateList([], query);
  }

  // GET /locations · GET /organizations/{uid}
  if (segs[0] === 'locations') return paginateList([{ uid: LOCATION_UID(), name: 'Grays Fitness HQ', organizationUid: ORG_UID() }], query);
  if (segs[0] === 'organizations') return { uid: ORG_UID(), name: 'Grays Fitness' };

  // Webhooks CRUD (F2 will use these) — minimal echo so setup code is testable.
  if (segs[0] === 'webhooks') {
    if (m === 'POST') return { uid: `pod_wh_${Date.now().toString(36)}`, url: body.url, eventTypes: body.eventTypes || body.eventType, status: 'active' };
    if (m === 'GET') return paginateList([], query);
    if (m === 'DELETE') return { uid: segs[1] || null, deleted: true };
    if (m === 'PATCH') return { uid: segs[1] || null, ...body };
  }

  return notFound('route', `${m} /${p}`);
}

function notFound(kind, id) {
  const err = new Error(`Podium mock: ${kind} not found: ${id}`);
  err.status = 404;
  err.podiumMock = true;
  throw err;
}

function nowIso() {
  // Podium timestamps are ISO 8601; exact value is irrelevant for the mock.
  return new Date(0).toISOString();
}

// Exported for tests / later increments.
export const fixtures = { USERS, CONTACTS, CONVERSATIONS, MESSAGES, MESSAGE_TEMPLATES };
export const _internal = { encodeCursor, decodeCursor, paginateList };
