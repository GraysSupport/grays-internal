// src/pages/inbox.js — In-portal Inbox (feature F3, increment 2: the React UI).
//
// Renders the Podium inbox LIVE on the logged-in rep's own token (P4) and stores
// nothing (P1 — Podium is the system of record). It talks only to the F3 live-proxy
// dispatcher shipped in increment 1:
//
//   GET  /api/podium/inbox?resource=conversations&scope=mine|all   → the conversation list
//   GET  /api/podium/inbox?resource=messages&conversationId=<uid>  → a live thread
//   POST /api/podium/inbox?resource=messages {conversationId, body}→ send a reply as the rep
//   GET  /api/podium/inbox?resource=poll&since=<ISO>&scope=        → recently-touched convos (5–10s poll)
//
// Default view is "My conversations" (scope=mine) — this closes F1b increment 3.
// Mock-first: while PODIUM_MOCK=true the backend serves lib/podium.mock.js, so the
// whole inbox is browsable on the Preview without live Podium credentials.
//
// P1 GUARD: message bodies live only in this component's React state and in the live
// request/response — nothing is written to the database. Contact NAMES (rather than the
// raw channel identifier) arrive with the F4 contact↔customer bridge; until then the
// list is labelled by the conversation's channel identifier.

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

// A human-ish label for a conversation until F4 resolves real contact names.
function convTitle(c) {
  return c?.channel?.identifier || c?.contact?.uid || c?.uid || 'Conversation';
}

export default function Inbox() {
  const navigate = useNavigate();

  const [authorized, setAuthorized] = useState(false);
  const [myPodiumUid, setMyPodiumUid] = useState(null);

  const [scope, setScope] = useState('mine');
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
        `/api/podium/inbox?resource=conversations&scope=${scope}&limit=30`,
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
  }, [scope, navigate]);

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

  // Load (and reload on scope change) once authorized.
  useEffect(() => {
    if (authorized) loadConversations();
  }, [authorized, loadConversations]);

  // ---- Poll: refresh the list (and the open thread) for new activity -------------
  const pollNow = useCallback(async () => {
    try {
      const since = sinceRef.current ? `&since=${encodeURIComponent(sinceRef.current)}` : '';
      const res = await fetch(
        `/api/podium/inbox?resource=poll&scope=${scope}${since}`,
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
  }, [scope, selectedId, loadConversations, loadThread]);

  useEffect(() => {
    if (!authorized || notLinked) return undefined;
    const id = setInterval(pollNow, POLL_MS);
    return () => clearInterval(id);
  }, [authorized, notLinked, pollNow]);

  // ---- Actions -------------------------------------------------------------------
  const switchScope = (next) => {
    if (next === scope) return;
    setScope(next);
    setSelectedId(null);
    setSelectedConv(null);
    setMessages([]);
    sinceRef.current = null;
  };

  const openConversation = (c) => {
    setSelectedId(c.uid);
    setSelectedConv(c);
    loadThread(c.uid);
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

  // ---- Render --------------------------------------------------------------------
  if (!authorized) return null;

  const assigneeLabel = (c) => {
    const uid = c?.assignedUser?.uid;
    if (!uid) return { text: 'Unassigned', cls: 'text-gray-400' };
    if (myPodiumUid && uid === myPodiumUid) return { text: 'You', cls: 'text-green-700' };
    return { text: 'Assigned', cls: 'text-gray-500' };
  };

  return (
    <>
      <div className="fixed top-4 left-6 z-50 flex gap-2">
        <HomeButton />
        <BackButton />
      </div>

      <div className="min-h-screen bg-gray-100 pt-16 pb-4 px-3 md:px-6">
        <div className="max-w-6xl mx-auto">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold">Inbox</h1>
              {mock && (
                <span className="text-xs font-semibold text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">
                  Mock mode
                </span>
              )}
            </div>
            {/* Scope toggle: My conversations (default) vs All */}
            <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden text-sm">
              <button
                type="button"
                onClick={() => switchScope('mine')}
                className={scope === 'mine' ? 'px-3 py-1.5 bg-blue-500 text-white' : 'px-3 py-1.5 bg-white text-gray-700 hover:bg-gray-50'}
              >
                My conversations
              </button>
              <button
                type="button"
                onClick={() => switchScope('all')}
                className={scope === 'all' ? 'px-3 py-1.5 bg-blue-500 text-white' : 'px-3 py-1.5 bg-white text-gray-700 hover:bg-gray-50'}
              >
                All
              </button>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow-md flex flex-col md:flex-row overflow-hidden" style={{ height: 'calc(100vh - 8rem)' }}>
            {/* Conversation list */}
            <aside className={`md:w-80 border-b md:border-b-0 md:border-r border-gray-200 flex flex-col ${selectedId ? 'hidden md:flex' : 'flex'}`}>
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
                      onClick={() => switchScope('all')}
                      className="w-full border border-gray-300 text-gray-700 py-2 rounded hover:bg-gray-50"
                    >
                      View all conversations instead
                    </button>
                  </div>
                )}

                {!loadingConvos && !notLinked && conversations.length === 0 && (
                  <div className="p-4 text-sm text-gray-500">No conversations{scope === 'mine' ? ' assigned to you' : ''} yet.</div>
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
            <section className={`flex-1 flex flex-col ${selectedId ? 'flex' : 'hidden md:flex'}`}>
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
                      onClick={() => { setSelectedId(null); setSelectedConv(null); setMessages([]); }}
                      className="md:hidden text-blue-600 text-sm"
                    >
                      ← Back
                    </button>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-gray-900 truncate">{convTitle(selectedConv)}</span>
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
          </div>

          <p className="text-xs text-gray-400 mt-3">
            Chats are read live from Podium and are never stored in the portal. Contact names arrive with the customer bridge (F4).
          </p>
        </div>
      </div>
    </>
  );
}
