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

  // Load (and reload on scope change) once authorized.
  useEffect(() => {
    if (authorized) loadConversations();
  }, [authorized, loadConversations]);

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

  // ---- Actions -------------------------------------------------------------------
  const clearSelection = () => {
    setSelectedId(null);
    setSelectedConv(null);
    setMessages([]);
    setPanel(null);
    setNeedEmail(false);
    setCreateEmail('');
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
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-gray-900 truncate">{headerTitle}</span>
                        <ChannelBadge type={selectedConv?.channel?.type} />
                      </div>
                      <div className="text-xs text-gray-400">{assigneeLabel(selectedConv).text}</div>
                    </div>
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
    </>
  );
}

// ---- Customer side panel -------------------------------------------------------
// Renders the F4 bridge result: the matched customer (or a "create from contact"
// action when unmatched), their OPEN workorders + ACTIVE deliveries, and the open
// lead's funnel stage. Leaves a labelled slot at the top for the F16 AI summary.
function CustomerPanel({
  loading, panel, creating, needEmail, createEmail, setCreateEmail, onCreate,
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

          {/* Funnel stage (open lead) */}
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
              </div>
            ) : (
              <div className="text-gray-400">No open lead for this conversation.</div>
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
                    <li key={w.workorder_id} className="rounded-lg border border-gray-200 p-2">
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
