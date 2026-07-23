// src/pages/inbox.js — In-portal Inbox (feature F3, increment 2: the React UI;
// feature F4, increment 2: the customer side panel).
//
// Renders the Podium inbox LIVE on the logged-in rep's own token (P4) and stores
// nothing (P1 — Podium is the system of record). It talks only to the F3 live-proxy
// dispatcher shipped in increment 1:
//
//   GET  /api/podium/inbox?resource=conversations&bucket=&status=  → the conversation list
//   GET  /api/podium/inbox?resource=messages&conversationId=<uid>  → a live thread
//   POST /api/podium/inbox?resource=messages {conversationId, body}→ send a reply as the rep
//   GET  /api/podium/inbox?resource=poll&since=<ISO>&bucket=&status= → recently-touched convos (5–10s poll)
//
// F11 adds Podium-parity conversation buckets: bucket ∈ {mine (Assigned to You,
// default), unassigned, all} × status ∈ {open (default), closed}. The default
// bucket=mine preserves the F1b increment-3 "My conversations" view.
//
// F4 increment 2 adds the Podium-style split-view CUSTOMER PANEL beside the thread,
// backed by the F4 increment-1 bridge (on main):
//
//   GET  /api/podium/contact?conversationId=<uid> → { contact, customer, matchedBy,
//        linked, workorders[], deliveries[], lead }  (the matched customer + their OPEN
//        workorders + ACTIVE deliveries + open lead / funnel stage)
//   POST /api/podium/contact {conversationId, action:'create', customer?} → create a
//        customer from the contact when none matched (422 EMAIL_REQUIRED → prompt).
//
// This directly serves Nick's 6 Jul feedback: customer details in the panel, the
// attached workorder/invoice so a rep can check order progress without leaving the
// inbox, and the funnel status. The broader Podium-parity conversation-list rework
// (Open/Closed within Unassigned / All / Assigned-to-You) is F11; the AI-summary card
// is F16 — this increment leaves a labelled slot for it.
//
// F12 rich messaging adds to the composer: image/video ATTACHMENTS (metadata-only seam
// — the file bytes stay in the browser; real Podium media upload is a live-wiring swap),
// team-only INTERNAL NOTES (POST ?resource=note — rendered distinctly, never sent to the
// customer), and Podium MESSAGE TEMPLATES (GET ?resource=templates — inserted into the draft).
//
// Default view is "My conversations" (scope=mine) — this closes F1b increment 3.
// Mock-first: while PODIUM_MOCK=true the backend serves lib/podium.mock.js, so the
// whole inbox + panel are browsable on the Preview without live Podium credentials.
//
// P1 GUARD: message bodies live only in this component's React state and in the live
// request/response — nothing is written to the database. The panel reads/writes only
// CRM metadata (customer / workorder / delivery / lead), never message text.

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import useDialog from '../hooks/useDialog';
import toast from 'react-hot-toast';
import BackButton from '../components/backbutton';
import HomeButton from '../components/homebutton';
import { authHeaders, getToken, getRoles, hasAnyRole } from '../utils/auth';
import { parseMaybeJson } from '../utils/http';
import { classifyComposeTarget, isValidComposeTarget, composeResultMessage } from '../utils/compose';

const INBOX_ROLES = ['sales', 'superadmin'];
const POLL_MS = 8000;
const COMPOSE_TIMEOUT_MS = 30000; // give up on a stalled compose rather than lock the modal

// Channel presentation (label + Tailwind classes). Falls back to the raw type.
const CHANNELS = {
  phone: { label: 'SMS', cls: 'bg-green-100 text-green-800' },
  sms: { label: 'SMS', cls: 'bg-green-100 text-green-800' },
  facebook: { label: 'Facebook', cls: 'bg-blue-100 text-blue-800' },
  instagram: { label: 'Instagram', cls: 'bg-pink-100 text-pink-800' },
  google: { label: 'Google', cls: 'bg-yellow-100 text-yellow-800' },
  webchat: { label: 'Webchat', cls: 'bg-purple-100 text-purple-800' },
  whatsapp: { label: 'WhatsApp', cls: 'bg-emerald-100 text-emerald-800' },
};

// Funnel stage presentation for the lead badge (mirrors execution-plan §1c / §4.3).
const STAGE_CLS = {
  New: 'bg-gray-100 text-gray-700',
  Contacted: 'bg-blue-100 text-blue-800',
  Quoted: 'bg-amber-100 text-amber-800',
  'Payment Received': 'bg-purple-100 text-purple-800',
  Won: 'bg-green-100 text-green-800',
  Lost: 'bg-red-100 text-red-700',
};

function ChannelBadge({ type }) {
  const key = String(type || '').toLowerCase();
  const c = CHANNELS[key] || { label: type || 'Chat', cls: 'bg-gray-100 text-gray-700' };
  return (
    <span className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded-full ${c.cls}`}>
      {c.label}
    </span>
  );
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-AU', {
    timeZone: 'Australia/Melbourne',
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-AU', {
    timeZone: 'Australia/Melbourne', day: '2-digit', month: 'short', year: 'numeric',
  });
}

// Money (AUD) — returns null for empty/NaN so callers can hide the field.
function money(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (Number.isNaN(n)) return null;
  return n.toLocaleString('en-AU', { style: 'currency', currency: 'AUD' });
}

// A human-ish label for a conversation until F4 resolves real contact names.
function convTitle(c) {
  return c?.channel?.identifier || c?.contact?.uid || c?.uid || 'Conversation';
}

// F12 — classify a picked file into an attachment kind for rendering/send metadata.
function kindForType(mime) {
  const t = String(mime || '').toLowerCase();
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('video/')) return 'video';
  return 'file';
}

export default function Inbox() {
  const navigate = useNavigate();

  const [authorized, setAuthorized] = useState(false);
  const [myPodiumUid, setMyPodiumUid] = useState(null);

  // F11 Podium-parity buckets: bucket (mine|unassigned|all) × status (open|closed).
  const [bucket, setBucket] = useState('mine');
  const [status, setStatus] = useState('open');
  const [conversations, setConversations] = useState([]);
  const [notLinked, setNotLinked] = useState(false);
  const [mock, setMock] = useState(false);
  const [loadingConvos, setLoadingConvos] = useState(true);

  // F14 — conversation search (by customer name / phone / email, via the F4 bridge).
  // `searchInput` is the live box; `search` is the debounced value used for the fetch.
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [searchTruncated, setSearchTruncated] = useState(false);

  const [selectedId, setSelectedId] = useState(null);
  // F27 — mirrors `selectedId` for synchronous reads. The composer-reset guard in
  // openConversation must compare against the CURRENT selection, not the one captured when
  // this render ran; see the comment there. Kept in sync by the effect below rather than at
  // each call site, so a future setSelectedId cannot forget to update it.
  const selectedIdRef = useRef(null);
  const [selectedConv, setSelectedConv] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loadingThread, setLoadingThread] = useState(false);

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  // F12 rich messaging: internal-note mode, message templates, attachments.
  const [composerMode, setComposerMode] = useState('reply'); // 'reply' | 'note'
  const [templates, setTemplates] = useState([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const [attachments, setAttachments] = useState([]); // {id,file,url,kind,filename,mimeType,size}
  const fileInputRef = useRef(null);
  const attachmentsRef = useRef([]); // latest attachments, for object-URL cleanup on unmount

  // F15 — product price/stock widget. The list is fetched ONCE when the Inbox opens
  // and cached client-side (Nick's feedback), then filtered in the browser. Retail
  // price + stock only — no x-user-access header is sent, so avg_cost is never returned.
  const [products, setProducts] = useState([]);
  const [productsLoaded, setProductsLoaded] = useState(false);
  const [showProducts, setShowProducts] = useState(false);
  const [productSearch, setProductSearch] = useState('');

  // F4 incr 2 — customer side panel state.
  const [panel, setPanel] = useState(null);
  const [panelLoading, setPanelLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createEmail, setCreateEmail] = useState('');
  const [needEmail, setNeedEmail] = useState(false);

  // F20 incr 2 — compose a new conversation (to a phone/email). The server dedupes:
  // an existing thread for that number/address is reopened and continued, never duplicated.
  const [showCompose, setShowCompose] = useState(false);
  const [composeSending, setComposeSending] = useState(false);
  const composeSendingRef = useRef(false); // synchronous double-submit guard (see submitCompose)

  // F17 — workorder detail modal (opened from a workorder card in the panel).
  const [woDetail, setWoDetail] = useState(null);
  const [woLoading, setWoLoading] = useState(false);
  const [woOpenId, setWoOpenId] = useState(null);

  // F13 — multi-assignee: assignable reps, the selected conversation's resolved
  // assignee set, and the assignment picker.
  const [reps, setReps] = useState([]);
  const [assignees, setAssignees] = useState([]); // [{podiumUserId, portalId, name, linked}]
  const [showAssign, setShowAssign] = useState(false);
  const [assignSaving, setAssignSaving] = useState(false);

  // Feedback (8 Jul): open/close a conversation + add a conversation to the funnel.
  const [statusSaving, setStatusSaving] = useState(false);
  const [addingLead, setAddingLead] = useState(false);
  // Funnel stage history (timeline) for the conversation's lead.
  const [leadHistory, setLeadHistory] = useState([]);
  const deepLinkedRef = useRef(false); // one-shot: open ?conversation= from a funnel deep-link

  const sinceRef = useRef(null); // last poll cursor timestamp (server echoes serverTime)
  const conversationsRef = useRef([]); // latest list, for the poll (see F31 note in pollNow)

  // ---- Gate (client-side display only; the server re-checks every request) -------
  useEffect(() => {
    if (!getToken()) {
      navigate('/');
      return;
    }
    if (!hasAnyRole(getRoles(), INBOX_ROLES)) {
      toast.error('The Inbox is for sales users');
      navigate('/dashboard');
      return;
    }
    setAuthorized(true);
    // Best-effort: learn my own Podium member uid so "assigned to me" can be highlighted.
    fetch('/api/podium/status', { headers: authHeaders() })
      .then(async (r) => {
        const d = await parseMaybeJson(r);
        if (r.ok && d?.podiumUserId) setMyPodiumUid(d.podiumUserId);
      })
      .catch(() => {});
  }, [navigate]);

  // ---- Data loaders --------------------------------------------------------------
  const loadConversations = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoadingConvos(true);
    try {
      const q = search ? `&search=${encodeURIComponent(search)}` : '';
      const res = await fetch(
        `/api/podium/inbox?resource=conversations&bucket=${bucket}&status=${status}${q}&limit=30`,
        { headers: authHeaders() },
      );
      if (res.status === 401) { navigate('/'); return; }
      if (res.status === 403) { toast.error('The Inbox is for sales users'); navigate('/dashboard'); return; }
      const data = await parseMaybeJson(res);
      if (!res.ok) {
        if (!silent) toast.error(data?.error || 'Could not load conversations');
        return;
      }
      setConversations(Array.isArray(data?.data) ? data.data : []);
      setNotLinked(!!data?.notLinked);
      setSearchTruncated(!!data?.searchTruncated);
      setMock(!!data?.mock);
      sinceRef.current = new Date().toISOString();
    } catch {
      if (!silent) toast.error('Server error loading conversations');
    } finally {
      if (!silent) setLoadingConvos(false);
    }
  }, [bucket, status, search, navigate]);

  const loadThread = useCallback(async (convId, { silent = false } = {}) => {
    if (!convId) return;
    if (!silent) setLoadingThread(true);
    try {
      const res = await fetch(
        `/api/podium/inbox?resource=messages&conversationId=${encodeURIComponent(convId)}&limit=50`,
        { headers: authHeaders() },
      );
      if (res.status === 401) { navigate('/'); return; }
      const data = await parseMaybeJson(res);
      if (!res.ok) {
        if (!silent) toast.error(data?.error || 'Could not load this conversation');
        return;
      }
      setMessages(Array.isArray(data?.data) ? data.data : []);
    } catch {
      if (!silent) toast.error('Server error loading messages');
    } finally {
      if (!silent) setLoadingThread(false);
    }
  }, [navigate]);

  // F4 incr 2 — load the customer panel for the open conversation.
  const loadPanel = useCallback(async (convId) => {
    if (!convId) return;
    setPanelLoading(true);
    setPanel(null);
    setNeedEmail(false);
    setCreateEmail('');
    try {
      const res = await fetch(
        `/api/podium/contact?conversationId=${encodeURIComponent(convId)}`,
        { headers: authHeaders() },
      );
      if (res.status === 401) { navigate('/'); return; }
      const data = await parseMaybeJson(res);
      if (!res.ok) {
        // A missing customer is not an error (customer:null comes back 200); only surface
        // real failures, and keep them quiet — the panel just shows "unavailable".
        if (res.status !== 403) toast.error(data?.error || 'Could not load customer details');
        return;
      }
      setPanel(data);
    } catch {
      toast.error('Server error loading customer details');
    } finally {
      setPanelLoading(false);
    }
  }, [navigate]);

  // F13 — load the selected conversation's assignee set (resolved to portal reps, with
  // a Podium-member name fallback) for the header chips + the assignment picker.
  const loadAssignees = useCallback(async (convId) => {
    if (!convId) { setAssignees([]); return; }
    try {
      const res = await fetch(
        `/api/podium/assign?conversationId=${encodeURIComponent(convId)}`,
        { headers: authHeaders() },
      );
      if (!res.ok) { setAssignees([]); return; }
      const data = await parseMaybeJson(res);
      setAssignees(Array.isArray(data?.assignees) ? data.assignees : []);
    } catch {
      setAssignees([]);
    }
  }, []);

  // Funnel stage history (timeline) for the panel's lead — when/if there is one.
  const loadLeadHistory = useCallback(async (leadId) => {
    if (!leadId) { setLeadHistory([]); return; }
    try {
      const res = await fetch(`/api/leads/${leadId}/history`, { headers: authHeaders() });
      if (!res.ok) { setLeadHistory([]); return; }
      const data = await parseMaybeJson(res);
      setLeadHistory(Array.isArray(data?.history) ? data.history : []);
    } catch {
      setLeadHistory([]);
    }
  }, []);

  // Open a conversation by uid even when it isn't in the current bucket/status list —
  // fetches it directly, then opens its thread + panel. Used by the funnel deep-link and
  // (F20 incr 2) after composing, where the resulting thread may sit outside the active
  // filters (e.g. bucket=mine but Podium hasn't assigned the new thread to this rep yet).
  const clearAttachments = useCallback(() => {
    setAttachments((prev) => {
      prev.forEach((a) => URL.revokeObjectURL(a.url));
      return [];
    });
  }, []);

  // Everything the rep may have typed for the PREVIOUS thread. Reset whenever the open
  // conversation changes, so a draft (or an active internal-note mode) can't follow them
  // into a different customer's thread.
  const resetComposerState = useCallback(() => {
    setComposerMode('reply');
    setShowTemplates(false);
    setDraft('');
    clearAttachments();
  }, [clearAttachments]);

  const openConversationById = useCallback(async (convId) => {
    if (!convId) return false;
    // Reset the composer before switching threads. Without this, a half-typed reply to
    // customer A (and, worse, an active internal-note mode) survives into customer B's
    // thread — one Send away from a genuine mis-send. Reaching a thread WITHOUT clicking a
    // list item is new here, so this path clears; the pre-existing openConversation click
    // path has the same gap and is recorded in the backlog rather than fixed in passing.
    resetComposerState();
    try {
      const res = await fetch(
        `/api/podium/inbox?resource=conversation&conversationId=${encodeURIComponent(convId)}`,
        { headers: authHeaders() },
      );
      if (res.status === 401) { navigate('/'); return false; }
      const data = await parseMaybeJson(res);
      if (!res.ok || !data?.conversation) return false;
      setSelectedId(convId);
      setSelectedConv(data.conversation);
      loadThread(convId);
      loadPanel(convId);
      loadAssignees(convId);
      return true;
    } catch {
      return false;
    }
  }, [navigate, loadThread, loadPanel, loadAssignees, resetComposerState]);

  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);

  // F31 — read by the poll, which must not take `conversations` as a dependency: pollNow is the
  // interval's callback, so a new identity on every list update would tear down and restart the
  // 8s timer each time and the poll could drift indefinitely.
  useEffect(() => { conversationsRef.current = conversations; }, [conversations]);

  // Fetch the timeline whenever the panel resolves a lead.
  useEffect(() => {
    loadLeadHistory(panel?.lead?.lead_id || null);
  }, [panel, loadLeadHistory]);

  // F14 — debounce the search box (300 ms) before it drives the list fetch.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Load (and reload on scope/search change) once authorized. loadConversations depends
  // on bucket/status/search, so this re-runs whenever any of them changes.
  useEffect(() => {
    if (authorized) loadConversations();
  }, [authorized, loadConversations]);

  // F12 — fetch Podium message templates once (canned responses for the composer).
  useEffect(() => {
    if (!authorized) return;
    fetch('/api/podium/inbox?resource=templates', { headers: authHeaders() })
      .then((r) => (r.ok ? parseMaybeJson(r) : null))
      .then((d) => { if (Array.isArray(d?.data)) setTemplates(d.data); })
      .catch(() => { /* templates are best-effort */ });
  }, [authorized]);

  // F13 — fetch the assignable reps once (sales/superadmin portal users) for the picker.
  useEffect(() => {
    if (!authorized) return;
    fetch('/api/podium/inbox?resource=reps', { headers: authHeaders() })
      .then((r) => (r.ok ? parseMaybeJson(r) : null))
      .then((d) => { if (Array.isArray(d?.reps)) setReps(d.reps); })
      .catch(() => { /* reps list is best-effort */ });
  }, [authorized]);

  // F15 — fetch the product price/stock list ONCE and cache it (Nick's feedback:
  // "fetch once when the Inbox opens"). Reuses the existing GET /api/products case
  // (a bare array of {sku, brand, name, stock, price}); no x-user-access header is
  // sent, so a sales rep never receives avg_cost. Filtering is done in the browser.
  useEffect(() => {
    if (!authorized) return;
    fetch('/api/products', { headers: authHeaders() })
      .then((r) => (r.ok ? parseMaybeJson(r) : null))
      .then((d) => { if (Array.isArray(d)) setProducts(d); })
      .catch(() => { /* product list is best-effort */ })
      .finally(() => setProductsLoaded(true));
  }, [authorized]);

  // F12 — keep the latest attachments in a ref and revoke their object URLs on unmount
  // (avoids leaking blob: URLs). Per-item revokes happen in removeAttachment/clearAttachments.
  useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);
  useEffect(() => () => { attachmentsRef.current.forEach((a) => URL.revokeObjectURL(a.url)); }, []);

  // Funnel → chat deep-link: open ?conversation=<uid> once, even if it's not in the
  // current bucket/status. Fetches the conversation directly and opens its thread+panel.
  useEffect(() => {
    if (!authorized || deepLinkedRef.current) return;
    const convId = new URLSearchParams(window.location.search).get('conversation');
    if (!convId) return;
    deepLinkedRef.current = true;
    setBucket('all'); // widen the list so the deep-linked thread isn't behind a notLinked prompt
    openConversationById(convId); // best-effort; swallows its own errors
  }, [authorized, openConversationById]);

  // ---- Poll: refresh the list (and the open thread) for new activity -------------
  const pollNow = useCallback(async () => {
    try {
      const since = sinceRef.current ? `&since=${encodeURIComponent(sinceRef.current)}` : '';
      const res = await fetch(
        `/api/podium/inbox?resource=poll&bucket=${bucket}&status=${status}${since}`,
        { headers: authHeaders() },
      );
      if (!res.ok) return;
      const data = await parseMaybeJson(res);
      if (data?.serverTime) sinceRef.current = data.serverTime;
      const updated = Array.isArray(data?.data) ? data.data : [];
      if (updated.length) {
        loadConversations({ silent: true });
        if (selectedId && updated.some((c) => c?.uid === selectedId)) {
          loadThread(selectedId, { silent: true });
        }
      }
      // F31 — a thread kept open across a filter switch is, by definition, outside the polled
      // scope, so it can NEVER appear in `updated`. Without this the rep sits in a live
      // conversation composing a reply while inbound messages silently stop arriving — no
      // error, no spinner, nothing. Refresh it directly whenever it is not in the current list.
      // (The deep-link and post-compose paths could already land in this state; they just
      // couldn't be reached with one click on the most-used control on the page.)
      if (selectedIdRef.current && !conversationsRef.current.some((c) => c?.uid === selectedIdRef.current)) {
        loadThread(selectedIdRef.current, { silent: true });
      }
    } catch {
      /* polls are best-effort; ignore transient errors */
    }
  }, [bucket, status, selectedId, loadConversations, loadThread]);

  useEffect(() => {
    if (!authorized || notLinked) return undefined;
    const id = setInterval(pollNow, POLL_MS);
    return () => clearInterval(id);
  }, [authorized, notLinked, pollNow]);

  // F17 — open a workorder's full detail in a modal. Reuses the existing
  // GET /api/workorder?id= endpoint, which returns { ...workorder, items, activity }.
  // It only exposes selling_price to a superadmin actor (via x-user-id, which the inbox
  // never sends) — so a plain sales rep sees item name/qty/condition/status + workorder
  // payment only, honouring the selling_price visibility rule.
  const openWorkorder = useCallback(async (workorderId) => {
    if (!workorderId) return;
    setWoOpenId(workorderId);
    setWoDetail(null);
    setWoLoading(true);
    try {
      const res = await fetch(`/api/workorder?id=${encodeURIComponent(workorderId)}`, {
        headers: authHeaders(),
      });
      if (res.status === 401) { navigate('/'); return; }
      const data = await parseMaybeJson(res);
      if (!res.ok) {
        toast.error(data?.error || 'Could not load the workorder');
        setWoOpenId(null);
        return;
      }
      setWoDetail(data);
    } catch {
      toast.error('Server error loading the workorder');
      setWoOpenId(null);
    } finally {
      setWoLoading(false);
    }
  }, [navigate]);

  const closeWorkorder = () => {
    setWoOpenId(null);
    setWoDetail(null);
    setWoLoading(false);
  };

  // ---- Actions -------------------------------------------------------------------

  // F12 — attachments. Files are held only in browser memory (object URLs) and only
  // metadata is sent (P1: no bytes persisted; real media upload is a live-wiring swap).
  const onPickFiles = (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length) {
      setAttachments((prev) => {
        const added = files.map((f) => ({
          id: `${f.name}_${f.size}_${Math.random().toString(36).slice(2)}`,
          file: f,
          url: URL.createObjectURL(f),
          kind: kindForType(f.type),
          filename: f.name,
          mimeType: f.type || 'application/octet-stream',
          size: f.size,
        }));
        return [...prev, ...added].slice(0, 10);
      });
    }
    e.target.value = ''; // allow re-selecting the same file
  };

  const removeAttachment = (id) => {
    setAttachments((prev) => {
      const gone = prev.find((a) => a.id === id);
      if (gone) URL.revokeObjectURL(gone.url);
      return prev.filter((a) => a.id !== id);
    });
  };

  // F12 — insert a Podium message template into the reply draft.
  const insertTemplate = (tpl) => {
    setComposerMode('reply');
    setDraft((d) => (d ? `${d}\n${tpl.body}` : tpl.body));
    setShowTemplates(false);
  };

  const clearSelection = () => {
    setSelectedId(null);
    setSelectedConv(null);
    setMessages([]);
    setPanel(null);
    setNeedEmail(false);
    setCreateEmail('');
    setWoOpenId(null);
    setWoDetail(null);
    setLeadHistory([]);
    setAssignees([]);
    setShowAssign(false);
    resetComposerState();
  };

  // F31 — is there work in the composer that a filter switch would destroy?
  //
  // Text and attachments only. Internal-note MODE is a toggle, not work: re-flicking it costs a
  // click, and treating it as content would leave threads open after every filter change for a
  // rep who happens to work in note mode.
  //
  // Whitespace is not work either — `draft.trim()` matches what the Send button already treats
  // as empty, so a composer the rep cannot send from is not one worth protecting.
  const composerHasUnsavedContent = () => draft.trim().length > 0 || attachments.length > 0;

  // F31 — is the open thread absent from the filtered list? Gated on `!loadingConvos` so the
  // notice below doesn't flash during every list reload, when `conversations` is briefly stale.
  const selectedOutsideFilter =
    !!selectedId && !loadingConvos && !conversations.some((c) => c?.uid === selectedId);

  // F31 — a bucket/status filter is about the LIST, not about the open thread. Clearing the
  // reading pane alongside it was only ever justified because it was cheap; it is not cheap
  // when it silently destroys a half-typed reply, with no undo and no warning (same family as
  // F27, pointed the other way: there a draft reached the WRONG customer, here it is simply
  // thrown away). So when there is work in the composer, the switch re-filters the list and
  // leaves the thread and the draft alone. When there isn't, behaviour is exactly as before —
  // deliberately, so this does not quietly become "the thread never closes".
  const switchScope = (applyFilter) => {
    const keepThread = composerHasUnsavedContent();
    applyFilter();
    if (!keepThread) clearSelection();
    sinceRef.current = null;
  };

  const switchBucket = (next) => {
    if (next === bucket) return;
    switchScope(() => setBucket(next));
  };

  const switchStatus = (next) => {
    if (next === status) return;
    switchScope(() => setStatus(next));
  };

  const openConversation = (c) => {
    // F27 — clear the composer when the rep moves to a DIFFERENT thread. Without this a
    // half-typed reply to customer A followed them into customer B's thread, one Send away
    // from the wrong customer receiving it; and an active internal-note mode followed too, so
    // the next Send posted a team-only note instead of a reply (or the reverse). Both are
    // silent. openConversationById (compose / deep-link) already did this since F20 incr 2 —
    // this is the same fix on the older list-click path.
    //
    // Guarded on the id CHANGING on purpose: re-clicking the thread you are already in, or a
    // list re-render, must not discard work in progress. Wiping a draft with no undo is the
    // same class of harm, just pointed the other way.
    // Read through a REF, not the render-closure state. `openConversationById` sets
    // `selectedId` inside an async continuation, so a click landing before that commit would
    // read a stale value, judge it a switch, and reset a composer the rep is still using —
    // costing them a draft, which is precisely what the guard exists to prevent. Same hazard
    // and same remedy as `composeSendingRef` above.
    if (c.uid !== selectedIdRef.current) resetComposerState();
    setSelectedId(c.uid);
    setSelectedConv(c);
    loadThread(c.uid);
    loadPanel(c.uid);
    loadAssignees(c.uid);
  };

  // F20 incr 2 — start a new conversation. The SERVER dedupes (reopen-and-continue over
  // duplicate), so the response tells us which happened and the toast reports it back:
  // silently reusing a thread while saying "started" would read as an accidental duplicate.
  const submitCompose = async ({ to, channel, body }) => {
    // Guard on a ref, not on composeSending: the state value is captured at render, so two
    // submits dispatched before React re-renders (key-repeat on Enter in the To field) would
    // both read `false`. Dedupe would keep them to ONE thread but the customer would still
    // receive the message twice.
    if (composeSendingRef.current) return;
    composeSendingRef.current = true;
    setComposeSending(true);
    // A stalled connection (warehouse wifi, hotspot handover) would otherwise leave the
    // modal locked with no way out but a reload, which loses the draft anyway.
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), COMPOSE_TIMEOUT_MS);
    try {
      const res = await fetch('/api/podium/inbox?resource=compose', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ to, channel, body }),
        signal: abort.signal,
      });
      if (res.status === 401) { navigate('/'); return; }
      const data = await parseMaybeJson(res);
      if (!res.ok) {
        toast.error(data?.error || 'Could not start the conversation');
        return; // leave the modal open with the draft intact so the rep can correct it
      }
      setShowCompose(false);
      toast.success(composeResultMessage(data));
      loadConversations({ silent: true });
      // Landing the rep in the thread is an acceptance criterion, so a failure here must be
      // said out loud — the modal and the draft are already gone, and on bucket=mine the new
      // thread may not be in the list either, leaving them with no way back to it.
      const opened = data?.conversationId
        ? await openConversationById(data.conversationId)
        : false;
      if (!opened) {
        toast('Started — find it under All conversations', { icon: 'ℹ️' });
      } else if (bucket !== 'all') {
        // Widen the list so the thread the rep is now reading is actually in it (Podium may
        // not have assigned a brand-new conversation to them yet). Same reasoning as the
        // funnel deep-link; setBucket directly, since switchBucket would clear the selection.
        setBucket('all');
      }
    } catch (err) {
      // The server sends to Podium BEFORE it responds, so a lost response does not mean a
      // lost message. Saying "server error" here invites a retry that texts the customer a
      // second time — dedupe protects the thread, not the message.
      toast.error(
        err?.name === 'AbortError'
          ? 'Timed out — the message may already have been sent. Check the inbox before retrying.'
          : "Couldn't confirm — the message may already have been sent. Check the inbox before retrying.",
      );
      loadConversations({ silent: true }); // so the thread shows up if it did land
    } finally {
      clearTimeout(timeout);
      composeSendingRef.current = false;
      setComposeSending(false);
    }
  };

  // Feedback (8 Jul): a salesperson opens/closes the selected conversation. It then
  // moves between the Open/Closed buckets — refresh the list (it may leave the current
  // status filter). The thread stays open so it can be reopened.
  const toggleConversationStatus = async () => {
    if (!selectedId || statusSaving) return;
    const current = selectedConv?.status || 'open';
    const next = current === 'open' ? 'closed' : 'open';
    setStatusSaving(true);
    try {
      const res = await fetch('/api/podium/inbox?resource=status', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ conversationId: selectedId, status: next }),
      });
      if (res.status === 401) { navigate('/'); return; }
      const data = await parseMaybeJson(res);
      if (!res.ok) { toast.error(data?.error || 'Could not update the conversation'); return; }
      setSelectedConv((c) => (c ? { ...c, status: next } : c));
      toast.success(next === 'closed' ? 'Conversation closed' : 'Conversation reopened');
      loadConversations({ silent: true });
    } catch {
      toast.error('Server error updating the conversation');
    } finally {
      setStatusSaving(false);
    }
  };

  // Feedback (8 Jul): add the open conversation to the lead funnel. Links the matched
  // customer + this conversation; if the customer has an open workorder, links it and
  // opens the lead at "Payment Received" (money in / workorder raised). Idempotent —
  // the backend returns the existing open lead if there already is one.
  const addToFunnel = async () => {
    if (!selectedId || addingLead || !panel?.customer) return;
    setAddingLead(true);
    try {
      const wo = (panel.workorders || [])[0];
      const payload = {
        podium_conversation_id: selectedId,
        customer_id: panel.customer.id,
        source_channel: selectedConv?.channel?.type || undefined,
        product_interest: wo ? `Workorder #${wo.workorder_id}` : 'Enquiry from chat',
      };
      if (wo) {
        payload.converted_workorder_id = wo.workorder_id;
        if (wo.invoice_id) payload.quote_invoice_id = wo.invoice_id;
        payload.stage = 'Won'; // a raised workorder = a closed-won deal
      }
      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
      });
      if (res.status === 401) { navigate('/'); return; }
      const data = await parseMaybeJson(res);
      if (!res.ok) { toast.error(data?.error || 'Could not add this conversation to the funnel'); return; }
      toast.success('Added to the funnel');
      loadPanel(selectedId); // refresh so the funnel-stage badge shows the new lead
    } catch {
      toast.error('Server error adding to the funnel');
    } finally {
      setAddingLead(false);
    }
  };

  // F13 — add or remove a rep from the conversation's assignee set. The picker works in
  // portal-user space: it sends the whole new set of portal ids to POST /api/podium/assign,
  // which resolves each to a Podium member and replaces the assignees (Podium is the
  // system of record). Reps who haven't linked their Podium account come back as a 409.
  const toggleAssignee = async (rep) => {
    if (!selectedId || assignSaving || !rep?.id) return;
    const has = assignees.some((a) => a.portalId === rep.id);
    // Rebuild the set from the currently-resolved portal ids (Podium-only members that
    // don't map to a portal user can't be re-sent through the portal picker).
    const currentPortalIds = assignees.map((a) => a.portalId).filter(Boolean);
    const nextIds = has
      ? currentPortalIds.filter((id) => id !== rep.id)
      : [...new Set([...currentPortalIds, rep.id])];
    setAssignSaving(true);
    try {
      const res = await fetch('/api/podium/assign', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ conversationId: selectedId, userIds: nextIds }),
      });
      if (res.status === 401) { navigate('/'); return; }
      const data = await parseMaybeJson(res);
      if (!res.ok) {
        toast.error(data?.error || 'Could not update the assignees');
        return;
      }
      toast.success(has ? `Removed ${rep.name}` : `Assigned ${rep.name}`);
      loadAssignees(selectedId);
      loadConversations({ silent: true }); // the row may move in/out of "Assigned to You"
    } catch {
      toast.error('Server error updating the assignees');
    } finally {
      setAssignSaving(false);
    }
  };

  // Composer submit dispatcher — a reply (with optional attachments) or an internal note.
  const submitComposer = (e) => {
    if (e && e.preventDefault) e.preventDefault();
    if (!selectedId || sending) return;
    if (composerMode === 'note') { sendNote(); return; }
    sendReply();
  };

  const sendReply = async () => {
    const body = draft.trim();
    const atts = attachments;
    if ((!body && atts.length === 0) || !selectedId || sending) return;
    setSending(true);
    try {
      const payload = { conversationId: selectedId, body };
      if (atts.length) {
        // Metadata only — never the file bytes (P1). Real media upload is a live-wiring swap.
        payload.attachments = atts.map((a) => ({
          kind: a.kind, filename: a.filename, mimeType: a.mimeType, size: a.size,
        }));
      }
      const res = await fetch('/api/podium/inbox?resource=messages', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
      });
      if (res.status === 401) { navigate('/'); return; }
      const data = await parseMaybeJson(res);
      if (!res.ok) {
        toast.error(data?.error || 'Could not send the message');
        return;
      }
      // Optimistically show the sent reply. Held only in React state (P1: never persisted).
      // Keep the local object URLs so image/video thumbnails render in the sent bubble.
      setMessages((prev) => [
        ...prev,
        {
          uid: data?.sent?.uid || `local_${Date.now()}`,
          direction: 'outbound',
          channel: data?.sent?.channel || selectedConv?.channel?.type,
          body,
          attachments: atts.map((a) => ({ kind: a.kind, url: a.url, filename: a.filename })),
          createdAt: new Date().toISOString(),
          optimistic: true,
        },
      ]);
      setDraft('');
      setAttachments([]); // handed to the optimistic bubble; URLs stay alive for it
    } catch {
      toast.error('Server error sending the message');
    } finally {
      setSending(false);
    }
  };

  // F12 — post a team-only INTERNAL note (not sent to the customer). The mock appends it
  // to the thread, so reload it to show the note; no chat/note body is persisted (P1).
  const sendNote = async () => {
    const body = draft.trim();
    if (!body || !selectedId || sending) return;
    setSending(true);
    try {
      const res = await fetch('/api/podium/inbox?resource=note', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ conversationId: selectedId, body }),
      });
      if (res.status === 401) { navigate('/'); return; }
      const data = await parseMaybeJson(res);
      if (!res.ok) {
        toast.error(data?.error || 'Could not add the internal note');
        return;
      }
      setDraft('');
      toast.success('Internal note added (team only)');
      loadThread(selectedId, { silent: true });
    } catch {
      toast.error('Server error adding the internal note');
    } finally {
      setSending(false);
    }
  };

  // F4 incr 2 — create a portal customer from the Podium contact (explicit action).
  const createCustomer = async () => {
    if (!selectedId || creating) return;
    const contactHasEmail = !!panel?.contact?.email;
    const typedEmail = createEmail.trim();
    if (!contactHasEmail && !typedEmail) {
      setNeedEmail(true);
      return;
    }
    setCreating(true);
    try {
      const payload = { conversationId: selectedId, action: 'create' };
      if (!contactHasEmail) payload.customer = { email: typedEmail };
      const res = await fetch('/api/podium/contact', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
      });
      const data = await parseMaybeJson(res);
      if (res.status === 401) { navigate('/'); return; }
      if (res.status === 422 && data?.code === 'EMAIL_REQUIRED') {
        setNeedEmail(true);
        toast.error('An email is required to create this customer');
        return;
      }
      if (!res.ok) {
        toast.error(data?.error || 'Could not create the customer');
        return;
      }
      setPanel(data); // POST returns the freshly rebuilt panel (now with a matched customer)
      setNeedEmail(false);
      setCreateEmail('');
      toast.success('Customer created and linked to this contact');
    } catch {
      toast.error('Server error creating the customer');
    } finally {
      setCreating(false);
    }
  };

  // ---- Render --------------------------------------------------------------------
  if (!authorized) return null;

  // F13: a conversation may have one OR MORE assignees. Prefer the `assignees` set, fall
  // back to the single `assignedUser`. Show "You" when the logged-in rep is one of them.
  const conversationAssigneeUids = (c) => (
    Array.isArray(c?.assignees) && c.assignees.length
      ? c.assignees.map((a) => a?.uid)
      : (c?.assignedUser?.uid ? [c.assignedUser.uid] : [])
  ).filter(Boolean);

  const assigneeLabel = (c) => {
    const uids = conversationAssigneeUids(c);
    // These labels sit side by side DOWN the list, so they need to stay distinguishable — but
    // the FIRST attempt got the polarity backwards (caught in review): it left "Unassigned" as
    // the faintest text on the row when an unclaimed thread is the one state a rep is hunting
    // for, and it collided with the equally-grey timestamp beside it. Unassigned is now amber —
    // a needs-attention colour rather than a weight — and the assigned states are the muted
    // ones. All three clear AA on both surfaces a row can have (white, and blue-50 when
    // selected); the colours, not the greys, carry the meaning.
    if (uids.length === 0) return { text: 'Unassigned', cls: 'text-amber-700' };
    const mine = myPodiumUid && uids.includes(myPodiumUid);
    if (uids.length === 1) {
      return mine ? { text: 'You', cls: 'text-green-700' } : { text: 'Assigned', cls: 'text-gray-600' };
    }
    return mine
      ? { text: `You +${uids.length - 1}`, cls: 'text-green-700' }
      : { text: `${uids.length} assignees`, cls: 'text-gray-600' };
  };

  // Prefer the resolved customer/contact name in the thread header once the panel loads.
  const headerTitle =
    panel?.customer?.name || panel?.contact?.name || convTitle(selectedConv);

  // F13 sender attribution — in a MULTI-REP thread (≥2 distinct outbound senders), label
  // who sent each outbound message. Names come from the message's senderUser (mock) or,
  // as a fallback, the reps/assignees maps keyed by Podium member uid.
  const nameByPodiumUid = new Map();
  reps.forEach((r) => { if (r.podiumUserId) nameByPodiumUid.set(r.podiumUserId, r.name); });
  assignees.forEach((a) => { if (a.podiumUserId && a.name) nameByPodiumUid.set(a.podiumUserId, a.name); });
  const outboundSenderUids = new Set(
    messages.filter((m) => m.direction === 'outbound' && m.senderUser?.uid).map((m) => m.senderUser.uid),
  );
  const showSenders = outboundSenderUids.size >= 2;
  const senderDisplay = (m) => {
    const s = m.senderUser;
    if (!s?.uid) return null;
    if (myPodiumUid && s.uid === myPodiumUid) return 'You';
    return s.name || nameByPodiumUid.get(s.uid) || 'Team';
  };

  return (
    <>
      <div className="fixed top-4 left-6 z-50 flex gap-2">
        <HomeButton />
        <BackButton />
      </div>

      <div className="min-h-screen bg-gray-100 pt-16 pb-4 px-3 md:px-6">
        <div className="max-w-7xl mx-auto">
          <div className="flex flex-col gap-3 mb-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold">Inbox</h1>
              {mock && (
                <span className="text-xs font-semibold text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">
                  Mock mode
                </span>
              )}
            </div>
            {/* F11 Podium-parity: bucket tabs (Assigned to You / Unassigned / All) +
                an Open/Closed split. */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden text-sm">
                {[
                  { key: 'mine', label: 'Assigned to You' },
                  { key: 'unassigned', label: 'Unassigned' },
                  { key: 'all', label: 'All' },
                ].map((b) => (
                  <button
                    key={b.key}
                    type="button"
                    onClick={() => switchBucket(b.key)}
                    className={bucket === b.key ? 'px-3 py-1.5 bg-blue-600 text-white' : 'px-3 py-1.5 bg-white text-gray-700 hover:bg-gray-50'}
                  >
                    {b.label}
                  </button>
                ))}
              </div>
              <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden text-sm">
                {[
                  { key: 'open', label: 'Open' },
                  { key: 'closed', label: 'Closed' },
                ].map((s) => (
                  <button
                    key={s.key}
                    type="button"
                    onClick={() => switchStatus(s.key)}
                    className={status === s.key ? 'px-3 py-1.5 bg-gray-800 text-white' : 'px-3 py-1.5 bg-white text-gray-700 hover:bg-gray-50'}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              {/* F20 incr 2 — start a new conversation to a phone/email (server dedupes). */}
              <button
                type="button"
                onClick={() => setShowCompose(true)}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-blue-600 bg-blue-600 text-sm text-white hover:bg-blue-700"
                title="Start a new conversation with a phone number or email"
              >
                <span aria-hidden="true">✉️</span> New conversation
              </button>
              {/* F15 — in-inbox product price/stock lookup (list cached client-side). */}
              <button
                type="button"
                onClick={() => setShowProducts(true)}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-gray-300 bg-white text-sm text-gray-700 hover:bg-gray-50"
                title="Look up product price and stock"
              >
                <span aria-hidden="true">🔍</span> Price &amp; stock
              </button>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow-md flex flex-col md:flex-row overflow-hidden" style={{ height: 'calc(100vh - 8rem)' }}>
            {/* Conversation list */}
            <aside className={`md:w-72 border-b md:border-b-0 md:border-r border-gray-200 flex flex-col ${selectedId ? 'hidden md:flex' : 'flex'}`}>
              {/* F14 — search the list by customer name / phone / email (F4 bridge). */}
              <div className="p-2 border-b border-gray-200">
                <div className="relative">
                  <input
                    type="text"
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    placeholder="Search name, phone or email…"
                    aria-label="Search conversations"
                    className="w-full text-sm border border-gray-300 rounded-md pl-3 pr-8 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-400"
                  />
                  {searchInput && (
                    <button
                      type="button"
                      onClick={() => setSearchInput('')}
                      aria-label="Clear search"
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-600"
                    >
                      ×
                    </button>
                  )}
                </div>
                {search && searchTruncated && (
                  <p className="mt-1 text-[11px] text-amber-700">
                    Showing matches from the first 100 conversations — narrow your search if needed.
                  </p>
                )}
              </div>
              <div className="flex-1 overflow-y-auto">
                {loadingConvos && (
                  <div className="p-4 text-sm text-gray-500">Loading conversations…</div>
                )}

                {!loadingConvos && notLinked && (
                  <div className="p-4 text-sm text-gray-600 space-y-3">
                    <p>You haven’t linked your Podium account yet, so there are no conversations to show here.</p>
                    <button
                      type="button"
                      onClick={() => navigate('/settings')}
                      className="w-full bg-blue-600 text-white py-2 rounded hover:bg-blue-700"
                    >
                      Connect my Podium account
                    </button>
                    <button
                      type="button"
                      onClick={() => switchBucket('all')}
                      className="w-full border border-gray-300 text-gray-700 py-2 rounded hover:bg-gray-50"
                    >
                      View all conversations instead
                    </button>
                  </div>
                )}

                {!loadingConvos && !notLinked && conversations.length === 0 && (
                  <div className="p-4 text-sm text-gray-500">
                    {search
                      ? <>No conversations match “{search}”.</>
                      : <>No {status} conversations{bucket === 'mine' ? ' assigned to you' : bucket === 'unassigned' ? ' unassigned' : ''}.</>}
                  </div>
                )}

                {!loadingConvos && conversations.map((c) => {
                  const a = assigneeLabel(c);
                  const active = c.uid === selectedId;
                  return (
                    <button
                      key={c.uid}
                      type="button"
                      onClick={() => openConversation(c)}
                      className={`w-full text-left px-4 py-3 border-b border-gray-100 hover:bg-gray-50 ${active ? 'bg-blue-50' : ''}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-sm text-gray-900 truncate">{c.identity?.displayName || convTitle(c)}</span>
                        <ChannelBadge type={c?.channel?.type} />
                      </div>
                      <div className="flex items-center justify-between gap-2 mt-1">
                        <span className={`text-xs ${a.cls}`}>{a.text}</span>
                        {/* gray-600: a selected row is bg-blue-50, where gray-500 is 4.44:1. */}
                        <span className="text-xs text-gray-600">{formatTime(c?.lastMessageAt)}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </aside>

            {/* Thread + composer */}
            <section className={`flex-1 min-w-0 flex flex-col ${selectedId ? 'flex' : 'hidden md:flex'}`}>
              {!selectedId && (
                <div className="flex-1 flex items-center justify-center text-sm text-gray-500">
                  Select a conversation to view the chat.
                </div>
              )}

              {selectedId && (
                <>
                  {/* F31 — say so when the open thread is not in the filtered list. Two problems
                      it solves: on a phone the list is hidden while a thread is open, so a
                      filter tap would otherwise produce NO visible change at all and read as a
                      broken control; and on any screen the reading pane and the list beside it
                      now disagree, with nothing to explain why. */}
                  {selectedOutsideFilter && (
                    <div className="px-4 py-2 text-xs bg-amber-50 border-b border-amber-200 text-amber-900 flex items-center justify-between gap-3">
                      <span>Kept open — this conversation isn’t in the current view. Your draft is safe.</span>
                      <button
                        type="button"
                        onClick={clearSelection}
                        className="shrink-0 font-semibold underline hover:no-underline"
                      >
                        Show the list
                      </button>
                    </div>
                  )}
                  <header className="px-4 py-3 border-b border-gray-200 flex items-center gap-3">
                    <button
                      type="button"
                      onClick={clearSelection}
                      className="md:hidden text-blue-600 text-sm"
                    >
                      ← Back
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-gray-900 truncate">{headerTitle}</span>
                        <ChannelBadge type={selectedConv?.channel?.type} />
                        {(selectedConv?.status || 'open') === 'closed' && (
                          <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-gray-200 text-gray-700">Closed</span>
                        )}
                      </div>
                      {/* F13 — assignee chips + assignment picker (one or more reps). */}
                      <AssigneeBar
                        assignees={assignees}
                        reps={reps}
                        myPodiumUid={myPodiumUid}
                        show={showAssign}
                        setShow={setShowAssign}
                        onToggle={toggleAssignee}
                        saving={assignSaving}
                      />
                    </div>
                    {/* Open/close the conversation (feedback 8 Jul) */}
                    <button
                      type="button"
                      onClick={toggleConversationStatus}
                      disabled={statusSaving}
                      className="shrink-0 text-sm px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                    >
                      {statusSaving
                        ? 'Saving…'
                        : (selectedConv?.status || 'open') === 'open' ? 'Close' : 'Reopen'}
                    </button>
                  </header>

                  <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-gray-50">
                    {loadingThread && <div className="text-sm text-gray-500">Loading messages…</div>}
                    {!loadingThread && messages.length === 0 && (
                      <div className="text-sm text-gray-500">No messages in this conversation.</div>
                    )}
                    {!loadingThread && messages.map((m) => {
                      // F12 — internal notes render distinctly (team-only, not sent to the customer).
                      if (m.internal || m.direction === 'internal') {
                        return (
                          <div key={m.uid} className="flex justify-center">
                            <div className="max-w-[85%] w-full rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                              <div className="text-[11px] font-semibold text-amber-700 mb-0.5">
                                🔒 Internal note
                                <span className="font-normal text-amber-600"> · team only, not sent to the customer</span>
                              </div>
                              <div className="whitespace-pre-wrap break-words text-sm text-amber-900">{m.body}</div>
                              <div className="text-[10px] mt-1 text-amber-500">
                                {formatTime(m.createdAt)}{m.author ? ` · ${m.author}` : ''}
                              </div>
                            </div>
                          </div>
                        );
                      }
                      const outbound = m.direction === 'outbound';
                      return (
                        <div key={m.uid} className={`flex ${outbound ? 'justify-end' : 'justify-start'}`}>
                          <div
                            className={`max-w-[75%] rounded-2xl px-4 py-2 text-sm shadow-sm ${
                              // bg-blue-600, not -500: on blue-500 the bubble's OWN white message
                              // text measures 3.68:1 — the actual conversation, failing AA worse
                              // than any grey this change started with. blue-600 puts it at 5.17
                              // and the timestamp below at 4.75.
                              outbound ? 'bg-blue-600 text-white rounded-br-sm' : 'bg-white text-gray-800 border border-gray-200 rounded-bl-sm'
                            } ${m.optimistic ? 'opacity-80' : ''}`}
                          >
                            {showSenders && outbound && senderDisplay(m) && (
                              <div className="text-[11px] font-semibold text-blue-50 mb-0.5">{senderDisplay(m)}</div>
                            )}
                            {m.body && <div className="whitespace-pre-wrap break-words">{m.body}</div>}
                            <MessageAttachments attachments={m.attachments} outbound={outbound} />
                            <div className={`text-[10px] mt-1 ${outbound ? 'text-blue-50' : 'text-gray-500'}`}>
                              {formatTime(m.createdAt)}{m.optimistic ? ' · sending…' : ''}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div className="border-t border-gray-200">
                    {/* F12 — attachment previews (reply mode) */}
                    {composerMode === 'reply' && attachments.length > 0 && (
                      <div className="px-3 pt-2 flex flex-wrap gap-2">
                        {attachments.map((a) => (
                          <div key={a.id} className="relative">
                            {a.kind === 'image' ? (
                              <img src={a.url} alt={a.filename} className="h-16 w-16 object-cover rounded-lg border border-gray-200" />
                            ) : (
                              <div className="h-16 w-24 rounded-lg border border-gray-200 bg-gray-50 flex flex-col items-center justify-center px-1 text-center">
                                <span className="text-lg">{a.kind === 'video' ? '🎬' : '📎'}</span>
                                <span className="text-[10px] text-gray-500 truncate w-full">{a.filename}</span>
                              </div>
                            )}
                            <button
                              type="button"
                              onClick={() => removeAttachment(a.id)}
                              className="absolute -top-1.5 -right-1.5 bg-gray-700 text-white rounded-full w-5 h-5 text-xs leading-none"
                              aria-label="Remove attachment"
                            >
                              ×
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* F12 — composer toolbar: Reply/Note mode, templates, attach */}
                    <div className="px-3 pt-2 flex flex-wrap items-center gap-2">
                      <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden text-xs">
                        <button
                          type="button"
                          onClick={() => setComposerMode('reply')}
                          className={composerMode === 'reply' ? 'px-2.5 py-1 bg-blue-600 text-white' : 'px-2.5 py-1 bg-white text-gray-600 hover:bg-gray-50'}
                        >
                          Reply
                        </button>
                        <button
                          type="button"
                          onClick={() => { setComposerMode('note'); setShowTemplates(false); }}
                          className={composerMode === 'note' ? 'px-2.5 py-1 bg-amber-700 text-white' : 'px-2.5 py-1 bg-white text-gray-600 hover:bg-gray-50'}
                        >
                          Internal note
                        </button>
                      </div>

                      {composerMode === 'reply' && (
                        <div className="relative">
                          <button
                            type="button"
                            onClick={() => setShowTemplates((v) => !v)}
                            disabled={templates.length === 0}
                            className="text-xs px-2.5 py-1 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-40"
                            title="Insert a message template"
                          >
                            Templates ▾
                          </button>
                          {showTemplates && templates.length > 0 && (
                            <div className="absolute bottom-full mb-1 left-0 z-10 w-64 max-h-56 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-lg">
                              {templates.map((t) => (
                                <button
                                  key={t.uid}
                                  type="button"
                                  onClick={() => insertTemplate(t)}
                                  className="w-full text-left px-3 py-2 hover:bg-gray-50 border-b border-gray-100 last:border-b-0"
                                >
                                  <div className="text-xs font-semibold text-gray-800">{t.title}</div>
                                  <div className="text-[11px] text-gray-500 truncate">{t.body}</div>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {composerMode === 'reply' && (
                        <>
                          <button
                            type="button"
                            onClick={() => fileInputRef.current && fileInputRef.current.click()}
                            className="text-xs px-2.5 py-1 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50"
                            title="Attach an image or video"
                          >
                            📎 Attach
                          </button>
                          <input
                            ref={fileInputRef}
                            type="file"
                            accept="image/*,video/*"
                            multiple
                            className="hidden"
                            onChange={onPickFiles}
                          />
                        </>
                      )}

                      {composerMode === 'note' && (
                        <span className="text-[11px] text-amber-700">Team-only — not sent to the customer.</span>
                      )}
                    </div>

                    <form onSubmit={submitComposer} className="p-3 flex items-end gap-2">
                      <textarea
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            submitComposer(e);
                          }
                        }}
                        rows={1}
                        placeholder={composerMode === 'note' ? 'Write an internal note…' : 'Type a reply…'}
                        className={`flex-1 resize-none border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 ${
                          composerMode === 'note' ? 'border-amber-300 bg-amber-50 focus:ring-amber-400' : 'border-gray-300 focus:ring-blue-400'
                        }`}
                      />
                      <button
                        type="submit"
                        disabled={sending || (composerMode === 'note' ? !draft.trim() : (!draft.trim() && attachments.length === 0))}
                        className={`px-4 py-2 rounded-lg text-sm text-white disabled:opacity-50 ${
                          composerMode === 'note' ? 'bg-amber-700 hover:bg-amber-800' : 'bg-blue-600 hover:bg-blue-700'
                        }`}
                      >
                        {sending
                          ? (composerMode === 'note' ? 'Adding…' : 'Sending…')
                          : (composerMode === 'note' ? 'Add note' : 'Send')}
                      </button>
                    </form>
                  </div>
                </>
              )}
            </section>

            {/* Customer side panel (F4 incr 2) — Podium-style split view. Desktop-only for
                now; the mobile presentation + the full Podium-parity list layout are F11. */}
            {selectedId && (
              <aside className="hidden lg:flex lg:w-80 xl:w-96 border-l border-gray-200 flex-col bg-white">
                <CustomerPanel
                  loading={panelLoading}
                  panel={panel}
                  creating={creating}
                  needEmail={needEmail}
                  createEmail={createEmail}
                  setCreateEmail={setCreateEmail}
                  onCreate={createCustomer}
                  onOpenWorkorder={openWorkorder}
                  onAddToFunnel={addToFunnel}
                  addingLead={addingLead}
                  leadHistory={leadHistory}
                />
              </aside>
            )}
          </div>

          {/* gray-600, not -500: this paragraph sits on the page shell (bg-gray-100), where
              gray-500 is 4.39:1 — under AA. Everything else de-emphasised sits on a white card. */}
          <p className="text-xs text-gray-600 mt-3">
            Chats are read live from Podium and are never stored in the portal. The customer
            panel shows the matched customer, their open orders/deliveries and funnel stage.
          </p>
        </div>
      </div>

      {/* F17 — workorder detail modal (opened from a workorder card in the panel). */}
      {woOpenId && (
        <WorkorderModal
          workorderId={woOpenId}
          detail={woDetail}
          loading={woLoading}
          onClose={closeWorkorder}
        />
      )}

      {/* F20 incr 2 — compose a new conversation (phone/email; the server dedupes). */}
      {showCompose && (
        <ComposeModal
          sending={composeSending}
          onSubmit={submitCompose}
          onClose={() => setShowCompose(false)}
        />
      )}

      {/* F15 — product price/stock lookup modal (uses the client-cached product list). */}
      {showProducts && (
        <ProductLookupModal
          products={products}
          loaded={productsLoaded}
          search={productSearch}
          setSearch={setProductSearch}
          onClose={() => setShowProducts(false)}
        />
      )}
    </>
  );
}

// ---- Customer side panel -------------------------------------------------------
// Renders the F4 bridge result: the matched customer (or a "create from contact"
// action when unmatched), their OPEN workorders + ACTIVE deliveries, and the open
// lead's funnel stage. Leaves a labelled slot at the top for the F16 AI summary.
function CustomerPanel({
  loading, panel, creating, needEmail, createEmail, setCreateEmail, onCreate, onOpenWorkorder,
  onAddToFunnel, addingLead, leadHistory,
}) {
  const customer = panel?.customer || null;
  const contact = panel?.contact || null;
  const lead = panel?.lead || null;
  const workorders = Array.isArray(panel?.workorders) ? panel.workorders : [];
  const deliveries = Array.isArray(panel?.deliveries) ? panel.deliveries : [];

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4 text-sm">
      {/* F16 slot — Podium's auto AI summary + "Jerry" land here (not built this run). */}
      <div className="rounded-lg border border-dashed border-gray-200 bg-gray-50 p-3">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">AI summary</div>
        <div className="text-xs text-gray-500 mt-1">Auto conversation summary arrives with Jerry (F16).</div>
      </div>

      {loading && <div className="text-gray-500">Loading customer details…</div>}

      {!loading && !panel && (
        <div className="text-gray-500">Customer details unavailable.</div>
      )}

      {!loading && panel && (
        <>
          {/* Customer identity (or contact + create action when unmatched) */}
          <section>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1">Customer</div>
            {customer ? (
              <div className="space-y-1">
                <div className="font-semibold text-gray-900">{customer.name || 'Unnamed customer'}</div>
                {customer.email && <Field label="Email" value={customer.email} />}
                {customer.phone && <Field label="Phone" value={customer.phone} />}
                {customer.address && <Field label="Address" value={customer.address} />}
                {panel.matchedBy && panel.matchedBy !== 'none' && (
                  <div className="text-[11px] text-gray-500 pt-1">
                    Matched by {panel.matchedBy === 'podium_contact_id' ? 'linked Podium contact' : panel.matchedBy}
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <div className="text-gray-600">
                  No portal customer is linked to this conversation yet.
                </div>
                {contact && (
                  <div className="rounded-lg border border-gray-200 p-2 space-y-1 bg-gray-50">
                    {contact.name && <Field label="Name" value={contact.name} />}
                    {contact.email && <Field label="Email" value={contact.email} />}
                    {contact.phone && <Field label="Phone" value={contact.phone} />}
                    {!contact.name && !contact.email && !contact.phone && (
                      <div className="text-xs text-gray-500">No contact details available from Podium.</div>
                    )}
                  </div>
                )}
                {needEmail && (
                  <input
                    type="email"
                    value={createEmail}
                    onChange={(e) => setCreateEmail(e.target.value)}
                    placeholder="Email for the new customer"
                    className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                  />
                )}
                <button
                  type="button"
                  onClick={onCreate}
                  disabled={creating}
                  className="w-full bg-blue-600 text-white py-2 rounded text-sm hover:bg-blue-700 disabled:opacity-50"
                >
                  {creating ? 'Creating…' : 'Create customer from contact'}
                </button>
                {needEmail && (
                  <div className="text-[11px] text-gray-500">
                    This contact has no email in Podium — enter one to create the customer.
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Funnel stage + history timeline */}
          <section>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1">Funnel stage</div>
            {lead ? (
              <div className="space-y-1">
                <span className={`inline-block text-xs font-semibold px-2 py-0.5 rounded-full ${STAGE_CLS[lead.stage] || 'bg-gray-100 text-gray-700'}`}>
                  {lead.stage}
                </span>
                {lead.product_interest && <Field label="Interest" value={lead.product_interest} />}
                {money(lead.value_est) && <Field label="Est. value" value={money(lead.value_est)} />}
                {lead.quote_invoice_id && <Field label="Quote/Invoice" value={lead.quote_invoice_id} />}
                <FunnelTimeline history={leadHistory} />
              </div>
            ) : (
              <div className="space-y-2">
                <div className="text-gray-500">Not in the funnel yet.</div>
                {customer && onAddToFunnel && (
                  <button
                    type="button"
                    onClick={onAddToFunnel}
                    disabled={addingLead}
                    className="w-full bg-blue-600 text-white py-2 rounded text-sm hover:bg-blue-700 disabled:opacity-50"
                  >
                    {addingLead
                      ? 'Adding…'
                      : workorders.length
                        ? `Add to funnel (link WO #${workorders[0].workorder_id})`
                        : 'Add to funnel'}
                  </button>
                )}
              </div>
            )}
          </section>

          {/* Open workorders — check order progress without leaving the inbox */}
          <section>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1">
              Open workorders{workorders.length ? ` (${workorders.length})` : ''}
            </div>
            {workorders.length === 0 ? (
              <div className="text-gray-500">None open.</div>
            ) : (
              <ul className="space-y-2">
                {workorders.map((w) => {
                  const owing = money(w.outstanding_balance);
                  const paid = Number(w.outstanding_balance) === 0;
                  return (
                    <li key={w.workorder_id}>
                      <button
                        type="button"
                        onClick={() => onOpenWorkorder && onOpenWorkorder(w.workorder_id)}
                        className="w-full text-left rounded-lg border border-gray-200 p-2 hover:border-blue-300 hover:bg-blue-50 transition"
                        title="View workorder detail"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-gray-900">#{w.workorder_id}</span>
                          <span className="text-xs text-gray-500">{w.status}</span>
                        </div>
                        {w.invoice_id && <Field label="Invoice" value={w.invoice_id} />}
                        {(w.delivery_suburb || w.delivery_state) && (
                          <Field label="Deliver to" value={[w.delivery_suburb, w.delivery_state].filter(Boolean).join(', ')} />
                        )}
                        {owing && (
                          <div className={`text-xs mt-0.5 ${paid ? 'text-green-700' : 'text-amber-700'}`}>
                            {paid ? 'Paid in full' : `Outstanding ${owing}`}
                          </div>
                        )}
                        <div className="text-[11px] text-blue-600 mt-1">View detail →</div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* Active deliveries */}
          <section>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1">
              Active deliveries{deliveries.length ? ` (${deliveries.length})` : ''}
            </div>
            {deliveries.length === 0 ? (
              <div className="text-gray-500">None active.</div>
            ) : (
              <ul className="space-y-2">
                {deliveries.map((d) => (
                  <li key={d.delivery_id} className="rounded-lg border border-gray-200 p-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-gray-900">#{d.delivery_id}</span>
                      <span className="text-xs text-gray-500">{d.delivery_status}</span>
                    </div>
                    {(d.delivery_suburb || d.delivery_state) && (
                      <Field label="To" value={[d.delivery_suburb, d.delivery_state].filter(Boolean).join(', ')} />
                    )}
                    {d.delivery_date && <Field label="Date" value={formatDate(d.delivery_date)} />}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

// F13 — assignee chips + the assignment picker for the thread header. Shows every
// assignee (resolved to a portal rep, or a Podium-member name), highlights the logged-in
// rep as "You", and lets a salesperson add/remove reps (the picker manages portal reps;
// reps who haven't linked their Podium account are shown disabled). A conversation can be
// assigned to one OR MORE reps — Podium's assignees endpoint is plural.
export function AssigneeBar({ assignees, reps, myPodiumUid, show, setShow, onToggle, saving }) {
  const assignedPortalIds = new Set(assignees.map((a) => a.portalId).filter(Boolean));
  const triggerRef = useRef(null);
  const menuId = useId();

  // F26 — popover semantics, NOT modal ones. This dropdown has no backdrop and the page
  // behind it stays live by design, so aria-modal would lie to a screen reader and a focus
  // trap would strand a keyboard user in a dropdown. What it DOES need is a way out that
  // isn't the mouse: Escape closes it and hands focus back to the trigger.
  useEffect(() => {
    if (!show) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      setShow(false);
      triggerRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [show, setShow]);
  return (
    <div className="mt-1 flex items-center gap-1.5 flex-wrap">
      <span className="text-[11px] text-gray-500">Assigned:</span>
      {assignees.length === 0 && <span className="text-xs text-gray-500">Unassigned</span>}
      {assignees.map((a) => {
        const you = myPodiumUid && a.podiumUserId === myPodiumUid;
        return (
          <span
            key={a.podiumUserId}
            className={`inline-flex items-center text-[11px] font-medium px-2 py-0.5 rounded-full ${you ? 'bg-green-100 text-green-800' : 'bg-blue-100 text-blue-800'}`}
          >
            {a.name || a.podiumUserId}{you ? ' (You)' : ''}
          </span>
        );
      })}
      <div className="relative">
        {/* Deliberately NO aria-haspopup. Per ARIA 1.2 `aria-haspopup="true"` is EXACTLY
            equivalent to "menu": screen readers announce "menu button" and the user presses
            Down Arrow expecting menu navigation. This popup is a plain list of toggle buttons
            — no role="menu", no menuitem children, no roving tabindex — so nothing would
            happen. "listbox"/"dialog" would be equally untrue. What this IS, is the APG
            Disclosure pattern: a button with aria-expanded + aria-controls revealing content.
            Claiming a menu we have not built is worse than claiming nothing. */}
        <button
          type="button"
          ref={triggerRef}
          aria-expanded={show}
          aria-controls={show ? menuId : undefined}
          onClick={() => setShow(!show)}
          disabled={saving || reps.length === 0}
          className="text-[11px] px-2 py-0.5 rounded-full border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-40"
          title="Assign salespeople to this conversation"
        >
          {saving ? 'Saving…' : 'Assign ▾'}
        </button>
        {show && reps.length > 0 && (
          <div id={menuId} className="absolute top-full mt-1 left-0 z-20 w-60 max-h-64 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-lg py-1">
            {reps.map((r) => {
              const checked = assignedPortalIds.has(r.id);
              return (
                <button
                  key={r.id}
                  type="button"
                  aria-pressed={checked}
                  onClick={() => onToggle(r)}
                  disabled={saving || !r.linked}
                  className="w-full flex items-center gap-2 text-left px-3 py-1.5 hover:bg-gray-50 disabled:opacity-50"
                  title={r.linked ? '' : 'This rep has not linked their Podium account'}
                >
                  {/* aria-hidden: the tick is decorative and CSS-only. Unchecked it renders
                      `text-transparent`, and transparent text is STILL in the accessibility
                      tree (only display:none / visibility:hidden / aria-hidden remove it), so
                      a screen reader announced a "✓" beside EVERY rep — assigned or not. The
                      real state is carried by aria-pressed on the button. */}
                  <span aria-hidden="true" className={`w-4 h-4 shrink-0 rounded border flex items-center justify-center text-[10px] ${checked ? 'bg-blue-600 border-blue-600 text-white' : 'border-gray-300 text-transparent'}`}>✓</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs text-gray-800 truncate">{r.name}</span>
                    {!r.linked && <span className="block text-[10px] text-gray-500">Not linked to Podium</span>}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// A compact label/value row for the panel.
function Field({ label, value }) {
  return (
    <div className="flex gap-2 text-xs">
      <span className="text-gray-500 w-20 shrink-0">{label}</span>
      <span className="text-gray-700 break-words min-w-0">{value}</span>
    </div>
  );
}

// F12 — render a message's attachments (image thumbnails inline; video/file as chips).
// In mock, image/video previews come from the sender's local object URLs; under live
// Podium the message carries hosted media URLs (a live-wiring swap).
function MessageAttachments({ attachments, outbound }) {
  const list = Array.isArray(attachments) ? attachments : [];
  if (list.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-2">
      {list.map((a, i) => {
        const key = `${i}-${a.filename || a.kind}`;
        if (a.kind === 'image' && a.url) {
          return <img key={key} src={a.url} alt={a.filename || 'attachment'} className="max-h-40 rounded-lg border border-black/10" />;
        }
        return (
          <span
            key={key}
            // bg-blue-700 rather than the old translucent bg-blue-400/60, which composited to
            // roughly #5197f8 and put this white label at 2.94:1 — the worst pairing on the page.
            className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg ${outbound ? 'bg-blue-700 text-white' : 'bg-gray-100 text-gray-700'}`}
          >
            {a.kind === 'video' ? '🎬' : '📎'} {a.filename || a.kind}
          </span>
        );
      })}
    </div>
  );
}

// Funnel stage history (timeline) — when the lead arrived, was quoted, won/lost, etc.
// Fed by GET /api/leads/:id/history (oldest → newest).
function FunnelTimeline({ history }) {
  const rows = Array.isArray(history) ? history : [];
  if (rows.length === 0) return null;
  return (
    <div className="pt-2">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1">Funnel history</div>
      <ol className="space-y-1.5 border-l border-gray-200 pl-3">
        {rows.map((h) => (
          <li key={h.id} className="relative">
            <span className="absolute -left-[0.95rem] top-1.5 w-1.5 h-1.5 rounded-full bg-blue-400" />
            <div className="text-xs font-medium text-gray-800">{h.to_stage}</div>
            <div className="text-[11px] text-gray-500">
              {formatTime(h.created_at)}{h.user_name ? ` · ${h.user_name}` : ''}
            </div>
            {/* The note is content and the timestamp is metadata; they render together on the
                same row, so the note steps DOWN to gray-700 rather than both landing on the
                same grey once the failing token was raised. */}
            {h.notes_log && <div className="text-[11px] text-gray-700 break-words">{h.notes_log}</div>}
          </li>
        ))}
      </ol>
    </div>
  );
}

// ---- Workorder detail modal (F17) ---------------------------------------------
// Shows a workorder's items + per-item status, the key payment/delivery details, and
// a read-only, scrollable log of every workorder_logs entry (oldest → newest). Fed by
// GET /api/workorder?id= (which omits selling_price for a non-superadmin actor), so a
// sales rep sees item name/qty/condition/status + workorder-level payment only.
export function WorkorderModal({ workorderId, detail, loading, onClose }) {
  const dialog = useDialog();
  const titleId = useId();

  // F26 — this read-only panel had no Escape at all. Unlike ComposeModal there is no draft to
  // lose here, so Escape always closes.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const items = Array.isArray(detail?.items) ? detail.items : [];
  // The endpoint returns activity newest-first; the log field reads oldest-first.
  const activity = Array.isArray(detail?.activity) ? detail.activity.slice().reverse() : [];
  const logText = activity
    .map((l) => {
      const bits = [l.ts, l.event_type];
      if (l.user_id) bits.push(`· ${l.user_id}`);
      if (l.current_item_status) bits.push(`· [${l.current_item_status}]`);
      if (l.product_name) bits.push(`· ${l.product_name}`);
      let line = bits.filter(Boolean).join('  ');
      if (l.notes_log) line += `  — ${l.notes_log}`;
      return line;
    })
    .join('\n');
  const owing = money(detail?.outstanding_balance);
  const paid = Number(detail?.outstanding_balance) === 0;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={dialog.ref}
        className="bg-white rounded-lg shadow-lg w-full max-w-2xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <h2 id={titleId} className="text-lg font-bold">Workorder #{workorderId}</h2>
            {detail?.status && (
              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-gray-100 text-gray-700">{detail.status}</span>
            )}
          </div>
          <button type="button" onClick={onClose} className="text-gray-500 hover:text-gray-700 text-xl leading-none" aria-label="Close">×</button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 space-y-4 text-sm">
          {loading && <div className="text-gray-500">Loading workorder…</div>}

          {!loading && !detail && <div className="text-gray-500">Workorder details unavailable.</div>}

          {!loading && detail && (
            <>
              {/* Payment / delivery details */}
              <section className="grid grid-cols-2 gap-x-4 gap-y-1">
                {detail.customer_name && <Field label="Customer" value={detail.customer_name} />}
                {detail.invoice_id && <Field label="Invoice" value={detail.invoice_id} />}
                {owing && <Field label="Outstanding" value={paid ? 'Paid in full' : owing} />}
                {money(detail.delivery_charged) && <Field label="Delivery" value={money(detail.delivery_charged)} />}
                {(detail.delivery_suburb || detail.delivery_state) && (
                  <Field label="Deliver to" value={[detail.delivery_suburb, detail.delivery_state].filter(Boolean).join(', ')} />
                )}
                {detail.estimated_completion && <Field label="ETA" value={formatDate(detail.estimated_completion)} />}
                {detail.date_created && <Field label="Created" value={formatDate(detail.date_created)} />}
              </section>

              {/* Items + per-item status */}
              <section>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1">
                  Items{items.length ? ` (${items.length})` : ''}
                </div>
                {items.length === 0 ? (
                  <div className="text-gray-500">No items.</div>
                ) : (
                  <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg">
                    {items.map((it) => (
                      <li key={it.workorder_items_id} className="flex items-center justify-between gap-3 px-3 py-2">
                        <div className="min-w-0">
                          <div className="font-medium text-gray-900 truncate">
                            {it.quantity} × {it.product_name || it.product_id}
                          </div>
                          <div className="text-xs text-gray-500">
                            {[it.condition, it.item_sn ? `SN ${it.item_sn}` : null].filter(Boolean).join(' · ')}
                          </div>
                        </div>
                        <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 shrink-0">
                          {it.status}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* Full activity log (read-only, scrollable, oldest → newest) */}
              <section>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1">Activity log</div>
                <textarea
                  readOnly
                  value={logText || 'No activity recorded.'}
                  rows={8}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs font-mono bg-gray-50 text-gray-700 resize-none"
                />
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- Compose a new conversation (F20 incr 2) ------------------------------------
// A rep starts a chat to a phone number or email. The DEDUPE lives on the server
// (POST ?resource=compose reopens and continues an existing thread rather than creating a
// duplicate), so this component deliberately makes no create/reuse decision of its own —
// it collects the recipient + first message, and reports back what the server did.
//
// The recipient is validated in the browser only to catch a typo before the round-trip;
// src/utils/compose.js mirrors the server's rule and the smoke asserts they agree.
// Exported for src/pages/__tests__/composeModal.test.js (F25). The Inbox renders it below;
// the export exists so the modal can be driven directly in a test without standing up the
// whole authenticated page, and is deliberately NOT imported anywhere else in the app.
export function ComposeModal({ sending, onSubmit, onClose }) {
  const [to, setTo] = useState('');
  const [body, setBody] = useState('');
  const dialog = useDialog();
  const titleId = useId();

  const target = classifyComposeTarget(to);
  const touched = to.trim().length > 0;
  const targetInvalid = touched && !isValidComposeTarget(to);
  const canSend = !sending && isValidComposeTarget(to) && body.trim().length > 0;

  const submit = (e) => {
    e.preventDefault();
    if (!canSend) return;
    // Channel follows the recipient type — the server defaults the same way, but sending
    // it explicitly keeps the composed thread's ChannelBadge predictable.
    onSubmit({ to: to.trim(), channel: target.kind, body: body.trim() });
  };

  // Escape closes — but never mid-send, or the rep loses the draft with a request in flight.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !sending) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sending, onClose]);

  // Backdrop-to-close only while nothing has been typed. Selecting text in the textarea and
  // releasing outside the form fires a click on the BACKDROP (the form's stopPropagation
  // can't help — the backdrop is the target), which would discard the message with no undo.
  // Escape, Cancel and × remain, so nothing is trapped.
  const closeOnBackdrop = () => {
    if (sending) return;
    if (to.trim() || body.trim()) return;
    onClose();
  };

  return (
    <div
      data-testid="compose-backdrop"
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={closeOnBackdrop}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={dialog.ref}
        className="bg-white rounded-lg shadow-lg w-full max-w-md flex flex-col"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <header className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
          <h2 id={titleId} className="text-lg font-bold">New conversation</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={sending}
            className="text-gray-500 hover:text-gray-700 text-xl leading-none disabled:opacity-40"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="px-5 py-4 space-y-4">
          <div>
            <label htmlFor="compose-to" className="block text-sm font-medium text-gray-700 mb-1">
              To
            </label>
            <input
              id="compose-to"
              type="text"
              autoFocus
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="Phone number or email address"
              className={`w-full text-sm border rounded-md px-3 py-2 focus:outline-none focus:ring-2 ${
                targetInvalid
                  ? 'border-red-400 focus:ring-red-300'
                  : 'border-gray-300 focus:ring-blue-400'
              }`}
            />
            {targetInvalid && (
              <p className="mt-1 text-xs text-red-600">
                Enter a valid phone number or email address.
              </p>
            )}
            {target && (
              <p className="mt-1 text-xs text-gray-500">
                Sending by {target.kind === 'email' ? 'email' : 'text message'}.
              </p>
            )}
          </div>

          <div>
            <label htmlFor="compose-body" className="block text-sm font-medium text-gray-700 mb-1">
              Message
            </label>
            <textarea
              id="compose-body"
              rows={4}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Type the first message…"
              className="w-full text-sm border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
          </div>

          <p className="text-[11px] text-gray-500">
            If this customer already has a conversation, it will be reopened and continued
            rather than duplicated.
          </p>
        </div>

        <footer className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-200">
          <button
            type="button"
            onClick={onClose}
            disabled={sending}
            className="px-3 py-1.5 rounded-lg border border-gray-300 bg-white text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSend}
            className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-40 disabled:hover:bg-blue-600"
          >
            {sending ? 'Starting…' : 'Start conversation'}
          </button>
        </footer>
      </form>
    </div>
  );
}

// ---- Product price/stock lookup (F15) ------------------------------------------
// A read-only in-inbox widget so a rep can quote price + stock without leaving the
// chat. The product list is fetched once (client-cached) by the Inbox and passed in;
// this modal only filters it in the browser. Retail price + stock only — no cost.
const PRODUCT_RESULT_CAP = 60; // render at most this many matches (the table has ~1,000 rows)

export function ProductLookupModal({ products, loaded, search, setSearch, onClose }) {
  const dialog = useDialog();
  const titleId = useId();

  // F26 — as with WorkorderModal: a read-only lookup with nothing to lose, so Escape closes.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Token-based, order-independent match — mirrors the product page's search
  // (src/pages/products/index.js): split on spaces, every keyword must appear
  // somewhere in "sku name brand" so "Life Treadmill SE3 HD" matches
  // "Life Fitness 95T Treadmill with Discover SE3 HD console".
  const keywords = String(search || '').toLowerCase().split(' ').filter(Boolean);
  const all = Array.isArray(products) ? products : [];
  const matches = keywords.length
    ? all.filter((p) => {
        const hay = `${p.sku || ''} ${p.name || ''} ${p.brand || ''}`.toLowerCase();
        return keywords.every((kw) => hay.includes(kw));
      })
    : all;
  const shown = matches.slice(0, PRODUCT_RESULT_CAP);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={dialog.ref}
        className="bg-white rounded-lg shadow-lg w-full max-w-xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
          <h2 id={titleId} className="text-lg font-bold">Product price &amp; stock</h2>
          <button type="button" onClick={onClose} className="text-gray-500 hover:text-gray-700 text-xl leading-none" aria-label="Close">×</button>
        </header>

        <div className="px-5 pt-4">
          <input
            type="text"
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by product, brand or SKU…"
            aria-label="Search products"
            className="w-full text-sm border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400"
          />
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-3">
          {!loaded && <div className="text-sm text-gray-500">Loading products…</div>}

          {loaded && all.length === 0 && (
            <div className="text-sm text-gray-500">Product list unavailable.</div>
          )}

          {loaded && all.length > 0 && matches.length === 0 && (
            <div className="text-sm text-gray-500">No products match “{search.trim()}”.</div>
          )}

          {loaded && shown.length > 0 && (
            <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg">
              {shown.map((p) => {
                const inStock = Number(p.stock) > 0;
                return (
                  <li key={p.sku} className="flex items-center justify-between gap-3 px-3 py-2">
                    <div className="min-w-0">
                      <div className="font-medium text-gray-900 truncate">{p.name || p.sku}</div>
                      <div className="text-xs text-gray-500 truncate">
                        {[p.brand, p.sku].filter(Boolean).join(' · ')}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-semibold text-gray-900">{money(p.price) ?? '—'}</div>
                      <span
                        className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                          inStock ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-700'
                        }`}
                      >
                        {inStock ? `In stock: ${p.stock}` : 'Out of stock'}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {loaded && matches.length > shown.length && (
            <p className="mt-2 text-[11px] text-gray-500">
              Showing the first {shown.length} of {matches.length} matches — refine your search to narrow it.
            </p>
          )}
        </div>

        <footer className="px-5 py-2 border-t border-gray-200 text-[11px] text-gray-500">
          Retail price and current stock. Loaded once when the Inbox opened.
        </footer>
      </div>
    </div>
  );
}
