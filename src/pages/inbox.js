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
// Default view is "My conversations" (scope=mine) — this closes F1b increment 3.
// Mock-first: while PODIUM_MOCK=true the backend serves lib/podium.mock.js, so the
// whole inbox + panel are browsable on the Preview without live Podium credentials.
//
// P1 GUARD: message bodies live only in this component's React state and in the live
// request/response — nothing is written to the database. The panel reads/writes only
// CRM metadata (customer / workorder / delivery / lead), never message text.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import BackButton from '../components/backbutton';
import HomeButton from '../components/homebutton';
import { authHeaders, getToken, getRoles, hasAnyRole } from '../utils/auth';
import { parseMaybeJson } from '../utils/http';

const INBOX_ROLES = ['sales', 'superadmin'];
const POLL_MS = 8000;

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

  const [selectedId, setSelectedId] = useState(null);
  const [selectedConv, setSelectedConv] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loadingThread, setLoadingThread] = useState(false);

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  // F4 incr 2 — customer side panel state.
  const [panel, setPanel] = useState(null);
  const [panelLoading, setPanelLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createEmail, setCreateEmail] = useState('');
  const [needEmail, setNeedEmail] = useState(false);

  // F17 — workorder detail modal (opened from a workorder card in the panel).
  const [woDetail, setWoDetail] = useState(null);
  const [woLoading, setWoLoading] = useState(false);
  const [woOpenId, setWoOpenId] = useState(null);

  // Feedback (8 Jul): open/close a conversation + add a conversation to the funnel.
  const [statusSaving, setStatusSaving] = useState(false);
  const [addingLead, setAddingLead] = useState(false);
  // Funnel stage history (timeline) for the conversation's lead.
  const [leadHistory, setLeadHistory] = useState([]);
  const deepLinkedRef = useRef(false); // one-shot: open ?conversation= from a funnel deep-link

  const sinceRef = useRef(null); // last poll cursor timestamp (server echoes serverTime)

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
      const res = await fetch(
        `/api/podium/inbox?resource=conversations&bucket=${bucket}&status=${status}&limit=30`,
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
      setMock(!!data?.mock);
      sinceRef.current = new Date().toISOString();
    } catch {
      if (!silent) toast.error('Server error loading conversations');
    } finally {
      if (!silent) setLoadingConvos(false);
    }
  }, [bucket, status, navigate]);

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

  // Fetch the timeline whenever the panel resolves a lead.
  useEffect(() => {
    loadLeadHistory(panel?.lead?.lead_id || null);
  }, [panel, loadLeadHistory]);

  // Load (and reload on scope change) once authorized.
  useEffect(() => {
    if (authorized) loadConversations();
  }, [authorized, loadConversations]);

  // Funnel → chat deep-link: open ?conversation=<uid> once, even if it's not in the
  // current bucket/status. Fetches the conversation directly and opens its thread+panel.
  useEffect(() => {
    if (!authorized || deepLinkedRef.current) return;
    const convId = new URLSearchParams(window.location.search).get('conversation');
    if (!convId) return;
    deepLinkedRef.current = true;
    setBucket('all'); // widen the list so the deep-linked thread isn't behind a notLinked prompt
    (async () => {
      try {
        const res = await fetch(
          `/api/podium/inbox?resource=conversation&conversationId=${encodeURIComponent(convId)}`,
          { headers: authHeaders() },
        );
        if (res.status === 401) { navigate('/'); return; }
        const data = await parseMaybeJson(res);
        if (res.ok && data?.conversation) {
          setSelectedId(convId);
          setSelectedConv(data.conversation);
          loadThread(convId);
          loadPanel(convId);
        }
      } catch { /* deep-link is best-effort */ }
    })();
  }, [authorized, navigate, loadThread, loadPanel]);

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
  };

  const switchBucket = (next) => {
    if (next === bucket) return;
    setBucket(next);
    clearSelection();
    sinceRef.current = null;
  };

  const switchStatus = (next) => {
    if (next === status) return;
    setStatus(next);
    clearSelection();
    sinceRef.current = null;
  };

  const openConversation = (c) => {
    setSelectedId(c.uid);
    setSelectedConv(c);
    loadThread(c.uid);
    loadPanel(c.uid);
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

  const sendReply = async (e) => {
    e.preventDefault();
    const body = draft.trim();
    if (!body || !selectedId || sending) return;
    setSending(true);
    try {
      const res = await fetch('/api/podium/inbox?resource=messages', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ conversationId: selectedId, body }),
      });
      if (res.status === 401) { navigate('/'); return; }
      const data = await parseMaybeJson(res);
      if (!res.ok) {
        toast.error(data?.error || 'Could not send the message');
        return;
      }
      // Optimistically show the sent reply. Held only in React state (P1: never persisted).
      setMessages((prev) => [
        ...prev,
        {
          uid: data?.sent?.uid || `local_${Date.now()}`,
          direction: 'outbound',
          channel: data?.sent?.channel || selectedConv?.channel?.type,
          body,
          createdAt: new Date().toISOString(),
          optimistic: true,
        },
      ]);
      setDraft('');
    } catch {
      toast.error('Server error sending the message');
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

  const assigneeLabel = (c) => {
    const uid = c?.assignedUser?.uid;
    if (!uid) return { text: 'Unassigned', cls: 'text-gray-400' };
    if (myPodiumUid && uid === myPodiumUid) return { text: 'You', cls: 'text-green-700' };
    return { text: 'Assigned', cls: 'text-gray-500' };
  };

  // Prefer the resolved customer/contact name in the thread header once the panel loads.
  const headerTitle =
    panel?.customer?.name || panel?.contact?.name || convTitle(selectedConv);

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
                    className={bucket === b.key ? 'px-3 py-1.5 bg-blue-500 text-white' : 'px-3 py-1.5 bg-white text-gray-700 hover:bg-gray-50'}
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
            </div>
          </div>

          <div className="bg-white rounded-lg shadow-md flex flex-col md:flex-row overflow-hidden" style={{ height: 'calc(100vh - 8rem)' }}>
            {/* Conversation list */}
            <aside className={`md:w-72 border-b md:border-b-0 md:border-r border-gray-200 flex flex-col ${selectedId ? 'hidden md:flex' : 'flex'}`}>
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
                      className="w-full bg-blue-500 text-white py-2 rounded hover:bg-blue-600"
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
                    No {status} conversations{bucket === 'mine' ? ' assigned to you' : bucket === 'unassigned' ? ' unassigned' : ''}.
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
                        <span className="font-medium text-sm text-gray-900 truncate">{convTitle(c)}</span>
                        <ChannelBadge type={c?.channel?.type} />
                      </div>
                      <div className="flex items-center justify-between gap-2 mt-1">
                        <span className={`text-xs ${a.cls}`}>{a.text}</span>
                        <span className="text-xs text-gray-400">{formatTime(c?.lastMessageAt)}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </aside>

            {/* Thread + composer */}
            <section className={`flex-1 min-w-0 flex flex-col ${selectedId ? 'flex' : 'hidden md:flex'}`}>
              {!selectedId && (
                <div className="flex-1 flex items-center justify-center text-sm text-gray-400">
                  Select a conversation to view the chat.
                </div>
              )}

              {selectedId && (
                <>
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
                      <div className="text-xs text-gray-400">{assigneeLabel(selectedConv).text}</div>
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
                      <div className="text-sm text-gray-400">No messages in this conversation.</div>
                    )}
                    {!loadingThread && messages.map((m) => {
                      const outbound = m.direction === 'outbound';
                      return (
                        <div key={m.uid} className={`flex ${outbound ? 'justify-end' : 'justify-start'}`}>
                          <div
                            className={`max-w-[75%] rounded-2xl px-4 py-2 text-sm shadow-sm ${
                              outbound ? 'bg-blue-500 text-white rounded-br-sm' : 'bg-white text-gray-800 border border-gray-200 rounded-bl-sm'
                            } ${m.optimistic ? 'opacity-80' : ''}`}
                          >
                            <div className="whitespace-pre-wrap break-words">{m.body}</div>
                            <div className={`text-[10px] mt-1 ${outbound ? 'text-blue-100' : 'text-gray-400'}`}>
                              {formatTime(m.createdAt)}{m.optimistic ? ' · sending…' : ''}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <form onSubmit={sendReply} className="border-t border-gray-200 p-3 flex items-end gap-2">
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          sendReply(e);
                        }
                      }}
                      rows={1}
                      placeholder="Type a reply…"
                      className="flex-1 resize-none border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                    />
                    <button
                      type="submit"
                      disabled={sending || !draft.trim()}
                      className="bg-blue-500 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-600 disabled:opacity-50"
                    >
                      {sending ? 'Sending…' : 'Send'}
                    </button>
                  </form>
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

          <p className="text-xs text-gray-400 mt-3">
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
        <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">AI summary</div>
        <div className="text-xs text-gray-400 mt-1">Auto conversation summary arrives with Jerry (F16).</div>
      </div>

      {loading && <div className="text-gray-500">Loading customer details…</div>}

      {!loading && !panel && (
        <div className="text-gray-400">Customer details unavailable.</div>
      )}

      {!loading && panel && (
        <>
          {/* Customer identity (or contact + create action when unmatched) */}
          <section>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-1">Customer</div>
            {customer ? (
              <div className="space-y-1">
                <div className="font-semibold text-gray-900">{customer.name || 'Unnamed customer'}</div>
                {customer.email && <Field label="Email" value={customer.email} />}
                {customer.phone && <Field label="Phone" value={customer.phone} />}
                {customer.address && <Field label="Address" value={customer.address} />}
                {panel.matchedBy && panel.matchedBy !== 'none' && (
                  <div className="text-[11px] text-gray-400 pt-1">
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
                      <div className="text-xs text-gray-400">No contact details available from Podium.</div>
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
                  className="w-full bg-blue-500 text-white py-2 rounded text-sm hover:bg-blue-600 disabled:opacity-50"
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
            <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-1">Funnel stage</div>
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
                <div className="text-gray-400">Not in the funnel yet.</div>
                {customer && onAddToFunnel && (
                  <button
                    type="button"
                    onClick={onAddToFunnel}
                    disabled={addingLead}
                    className="w-full bg-blue-500 text-white py-2 rounded text-sm hover:bg-blue-600 disabled:opacity-50"
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
            <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-1">
              Open workorders{workorders.length ? ` (${workorders.length})` : ''}
            </div>
            {workorders.length === 0 ? (
              <div className="text-gray-400">None open.</div>
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
            <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-1">
              Active deliveries{deliveries.length ? ` (${deliveries.length})` : ''}
            </div>
            {deliveries.length === 0 ? (
              <div className="text-gray-400">None active.</div>
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

// A compact label/value row for the panel.
function Field({ label, value }) {
  return (
    <div className="flex gap-2 text-xs">
      <span className="text-gray-400 w-20 shrink-0">{label}</span>
      <span className="text-gray-700 break-words min-w-0">{value}</span>
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
      <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-1">Funnel history</div>
      <ol className="space-y-1.5 border-l border-gray-200 pl-3">
        {rows.map((h) => (
          <li key={h.id} className="relative">
            <span className="absolute -left-[0.95rem] top-1.5 w-1.5 h-1.5 rounded-full bg-blue-400" />
            <div className="text-xs font-medium text-gray-800">{h.to_stage}</div>
            <div className="text-[11px] text-gray-400">
              {formatTime(h.created_at)}{h.user_name ? ` · ${h.user_name}` : ''}
            </div>
            {h.notes_log && <div className="text-[11px] text-gray-500 break-words">{h.notes_log}</div>}
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
function WorkorderModal({ workorderId, detail, loading, onClose }) {
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
        className="bg-white rounded-lg shadow-lg w-full max-w-2xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-bold">Workorder #{workorderId}</h2>
            {detail?.status && (
              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-gray-100 text-gray-700">{detail.status}</span>
            )}
          </div>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none" aria-label="Close">×</button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 space-y-4 text-sm">
          {loading && <div className="text-gray-500">Loading workorder…</div>}

          {!loading && !detail && <div className="text-gray-400">Workorder details unavailable.</div>}

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
                <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-1">
                  Items{items.length ? ` (${items.length})` : ''}
                </div>
                {items.length === 0 ? (
                  <div className="text-gray-400">No items.</div>
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
                <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mb-1">Activity log</div>
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
