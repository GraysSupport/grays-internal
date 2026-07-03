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

const LOCATION_UID = () => process.env.PODIUM_LOCATION_UID || 'pod_loc_GRAYSHQ';
const ORG_UID = () => process.env.PODIUM_ORG_UID || 'pod_org_GRAYS';

// Conversations — one per contact, spread across channels + assignees.
const CONVERSATIONS = [
  {
    uid: 'pod_cnv_00001',
    channel: { type: 'phone', identifier: '+61400111222' },
    contact: { uid: 'pod_con_maRIA1' }, // deprecated hint (see §15.6) — resolve via Contacts API
    assignedUser: { uid: 'pod_usr_amELia' },
    location: { uid: LOCATION_UID(), organizationUid: ORG_UID() },
    lastMessageAt: '2026-07-03T09:15:00+10:00',
  },
  {
    uid: 'pod_cnv_00002',
    channel: { type: 'facebook', identifier: 'fb:graysfitness' },
    contact: { uid: 'pod_con_maRIA1' },
    assignedUser: { uid: 'pod_usr_bENjin' },
    location: { uid: LOCATION_UID(), organizationUid: ORG_UID() },
    lastMessageAt: '2026-07-02T16:40:00+10:00',
  },
  {
    uid: 'pod_cnv_00003',
    channel: { type: 'phone', identifier: '+61400333444' },
    contact: { uid: 'pod_con_toMH20' },
    assignedUser: null, // unassigned — auto-created lead would be unassigned (P12)
    location: { uid: LOCATION_UID(), organizationUid: ORG_UID() },
    lastMessageAt: '2026-07-03T08:02:00+10:00',
  },
  {
    uid: 'pod_cnv_00004',
    channel: { type: 'instagram', identifier: 'ig:graysfitness' },
    contact: { uid: 'pod_con_liNDA3' },
    assignedUser: { uid: 'pod_usr_amELia' },
    location: { uid: LOCATION_UID(), organizationUid: ORG_UID() },
    lastMessageAt: '2026-07-01T11:20:00+10:00',
  },
  {
    uid: 'pod_cnv_00005',
    channel: { type: 'google', identifier: 'gbm:graysfitness' },
    contact: { uid: 'pod_con_jaKE44' },
    assignedUser: { uid: 'pod_usr_bENjin' },
    location: { uid: LOCATION_UID(), organizationUid: ORG_UID() },
    lastMessageAt: '2026-07-03T07:45:00+10:00',
  },
];

// Messages keyed by conversation uid (oldest → newest). `body` present (see P1 note).
const MESSAGES = {
  pod_cnv_00001: [
    { uid: 'pod_msg_0001a', direction: 'inbound', channel: 'phone', body: 'Hi, is the 20kg adjustable dumbbell set back in stock?', createdAt: '2026-07-03T09:10:00+10:00' },
    { uid: 'pod_msg_0001b', direction: 'outbound', channel: 'phone', body: 'Hi Maria! Yes, we just restocked — want me to hold a set for you?', createdAt: '2026-07-03T09:12:00+10:00' },
    { uid: 'pod_msg_0001c', direction: 'inbound', channel: 'phone', body: 'Yes please, and can you do delivery to Brunswick?', createdAt: '2026-07-03T09:15:00+10:00' },
  ],
  pod_cnv_00002: [
    { uid: 'pod_msg_0002a', direction: 'inbound', channel: 'facebook', body: 'Do you price match on the rowing machine?', createdAt: '2026-07-02T16:38:00+10:00' },
    { uid: 'pod_msg_0002b', direction: 'outbound', channel: 'facebook', body: 'We can usually get close — send me the competitor link?', createdAt: '2026-07-02T16:40:00+10:00' },
  ],
  pod_cnv_00003: [
    { uid: 'pod_msg_0003a', direction: 'inbound', channel: 'phone', body: 'What are your warehouse pickup hours on Saturday?', createdAt: '2026-07-03T08:02:00+10:00' },
  ],
  pod_cnv_00004: [
    { uid: 'pod_msg_0004a', direction: 'inbound', channel: 'instagram', body: 'Love the new squat racks 😍 do they come assembled?', createdAt: '2026-07-01T11:18:00+10:00' },
    { uid: 'pod_msg_0004b', direction: 'outbound', channel: 'instagram', body: 'Thank you! They ship flat-packed but assembly is straightforward.', createdAt: '2026-07-01T11:20:00+10:00' },
  ],
  pod_cnv_00005: [
    { uid: 'pod_msg_0005a', direction: 'inbound', channel: 'google', body: 'Can I get a quote for a full home gym setup?', createdAt: '2026-07-03T07:45:00+10:00' },
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

  // GET /contacts  ·  GET /contacts/{uid}
  if (segs[0] === 'contacts') {
    if (segs[1]) {
      const c = CONTACTS.find((x) => x.uid === segs[1]);
      if (!c) return notFound('contact', segs[1]);
      return c;
    }
    return paginateList(CONTACTS, query);
  }

  // conversations ...
  if (segs[0] === 'conversations') {
    // GET /conversations
    if (!segs[1]) {
      let items = CONVERSATIONS;
      if (query.assigneeUid) items = items.filter((c) => c.assignedUser?.uid === query.assigneeUid);
      return paginateList(items, query);
    }
    const convUid = segs[1];
    const conv = CONVERSATIONS.find((c) => c.uid === convUid);
    // GET /conversations/{uid}/messages
    if (segs[2] === 'messages') {
      if (!conv) return notFound('conversation', convUid);
      return paginateList(MESSAGES[convUid] || [], query);
    }
    // GET|PUT /conversations/{uid}/assignees
    if (segs[2] === 'assignees') {
      if (!conv) return notFound('conversation', convUid);
      if (m === 'PUT') {
        const assigneeUid = body.userUid || body.assigneeUid || body.uid || null;
        return { conversationUid: convUid, assignedUser: assigneeUid ? { uid: assigneeUid } : null };
      }
      return { conversationUid: convUid, assignedUser: conv.assignedUser || null };
    }
    // GET|PATCH /conversations/{uid}
    if (!conv) return notFound('conversation', convUid);
    if (m === 'PATCH') return { ...conv, ...body };
    return conv;
  }

  // POST /messages (send)
  if (segs[0] === 'messages' && m === 'POST') {
    return {
      uid: `pod_msg_sent_${Date.now().toString(36)}`,
      conversationUid: body.conversationUid || null,
      channel: body.channel || 'phone',
      direction: 'outbound',
      status: 'sent',
      locationUid: body.locationUid || LOCATION_UID(),
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
export const fixtures = { USERS, CONTACTS, CONVERSATIONS, MESSAGES };
export const _internal = { encodeCursor, decodeCursor, paginateList };
