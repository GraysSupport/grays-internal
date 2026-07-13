// src/pages/customers/[id].js — Customer-360 (feature F6).
//
// A single customer's unified view: a merged Journey timeline (lead funnel ∪ workorder /
// delivery lifecycle, from GET /api/customers/:id/journey) plus a Conversations tab that
// live-fetches the customer's Podium threads (never stored — reuses the F14 conversation
// search on the inbox proxy, gated to sales/superadmin server-side). Read-only.

import { useEffect, useState, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import BackButton from '../../components/backbutton';
import HomeButton from '../../components/homebutton';
import { authHeaders, getRoles, hasAnyRole } from '../../utils/auth';

// Parse a fetch Response as JSON, but fail with a readable message if the server returned
// HTML (e.g. a platform 404/500 page) instead of JSON — so the page never crashes with a
// raw "Unexpected token" JSON error.
async function parseJson(res) {
  const text = await res.text();
  try {
    return { ok: res.ok, status: res.status, data: JSON.parse(text) };
  } catch {
    return { ok: false, status: res.status, data: { error: `Server returned a non-JSON response (HTTP ${res.status}).` } };
  }
}

// Timeline colour + label per event category.
const CATEGORY_STYLE = {
  lead: { dot: 'bg-amber-500', chip: 'bg-amber-100 text-amber-800', label: 'Lead' },
  workorder: { dot: 'bg-indigo-500', chip: 'bg-indigo-100 text-indigo-800', label: 'Workorder' },
  delivery: { dot: 'bg-green-600', chip: 'bg-green-100 text-green-800', label: 'Delivery' },
};

function fmtTime(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString('en-AU', {
      timeZone: 'Australia/Melbourne',
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return String(ts);
  }
}

export default function CustomerDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [customer, setCustomer] = useState(null);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('journey');

  // Conversations tab (lazy — only fetched on first open).
  const [convState, setConvState] = useState({ loaded: false, loading: false, rows: [], notLinked: false, mock: false, denied: false, error: null });
  const canSeeConversations = hasAnyRole(getRoles(), ['sales', 'superadmin']);

  useEffect(() => {
    if (!localStorage.getItem('user')) { navigate('/'); return; }
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        // Query form (?id=) — the proven convention used across this app.
        const [cRes, jRes] = await Promise.all([
          fetch(`/api/customers?id=${encodeURIComponent(id)}`),
          fetch(`/api/customers?id=${encodeURIComponent(id)}&resource=journey`),
        ]);
        const c = await parseJson(cRes);
        if (!c.ok) throw new Error(c.data.error || 'Failed to load customer');
        const j = await parseJson(jRes);
        if (!j.ok) throw new Error(j.data.error || 'Failed to load journey');
        if (!alive) return;
        setCustomer(j.data.customer || c.data);
        setEvents(Array.isArray(j.data.events) ? j.data.events : []);
      } catch (err) {
        if (alive) toast.error(err.message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [id, navigate]);

  // Live Podium threads for this customer — search the inbox proxy by the most precise
  // identity we have (phone, else email, else name). Bodies are never stored.
  const loadConversations = useCallback(async () => {
    if (!customer) return;
    if (!canSeeConversations) { setConvState((s) => ({ ...s, loaded: true, denied: true })); return; }
    const term = (customer.phone || customer.email || customer.name || '').trim();
    if (!term) { setConvState({ loaded: true, loading: false, rows: [], notLinked: false, mock: false, denied: false, error: null }); return; }
    setConvState((s) => ({ ...s, loading: true }));
    try {
      const res = await fetch(
        `/api/podium/inbox?resource=conversations&bucket=all&status=all&search=${encodeURIComponent(term)}`,
        { headers: authHeaders() }
      );
      const { ok, status, data } = await parseJson(res);
      if (status === 403) { setConvState({ loaded: true, loading: false, rows: [], notLinked: false, mock: false, denied: true, error: null }); return; }
      if (!ok) throw new Error(data.error || 'Failed to load conversations');
      setConvState({
        loaded: true, loading: false,
        rows: Array.isArray(data.data) ? data.data : [],
        notLinked: !!data.notLinked, mock: !!data.mock, denied: false, error: null,
      });
    } catch (err) {
      setConvState({ loaded: true, loading: false, rows: [], notLinked: false, mock: false, denied: false, error: err.message });
    }
  }, [customer, canSeeConversations]);

  const openTab = (t) => {
    setTab(t);
    if (t === 'conversations' && !convState.loaded && !convState.loading) loadConversations();
  };

  return (
    <>
      <div className="fixed top-4 left-6 z-50 flex gap-2">
        <HomeButton />
        <BackButton />
      </div>
      <div className="min-h-screen bg-gray-100 p-6">
        <div className="max-w-3xl mx-auto">
          {/* Customer summary */}
          {loading && !customer ? (
            <div className="text-center text-gray-500 py-10">Loading customer…</div>
          ) : !customer ? (
            <div className="text-center text-gray-500 py-10">Customer not found.</div>
          ) : (
            <>
              <div className="bg-white rounded-lg shadow p-5 mb-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-xl font-bold">{customer.name}</h2>
                      {customer.customer_type && (
                        <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                          customer.customer_type === 'Business' ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-700'
                        }`}>
                          {customer.customer_type}
                        </span>
                      )}
                    </div>
                    <div className="mt-2 text-sm text-gray-600 space-y-0.5">
                      {customer.email && <div>✉️ {customer.email}</div>}
                      {customer.phone && <div>📞 {customer.phone}</div>}
                      {customer.address && <div>📍 {customer.address}</div>}
                    </div>
                  </div>
                  <Link
                    to={`/customers/${customer.id}/edit`}
                    className="text-sm px-3 py-1.5 border rounded text-blue-600 hover:bg-blue-50 whitespace-nowrap"
                  >
                    Edit
                  </Link>
                </div>
              </div>

              {/* Tabs */}
              <div className="flex gap-1 mb-4 border-b">
                {[['journey', 'Journey'], ['conversations', 'Conversations']].map(([key, lbl]) => (
                  <button
                    key={key}
                    onClick={() => openTab(key)}
                    className={`px-4 py-2 text-sm font-medium -mb-px border-b-2 ${
                      tab === key
                        ? 'border-indigo-600 text-indigo-700'
                        : 'border-transparent text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    {lbl}
                  </button>
                ))}
              </div>

              {tab === 'journey' && (
                <div className="bg-white rounded-lg shadow p-5">
                  {loading ? (
                    <div className="text-gray-500 text-sm">Loading journey…</div>
                  ) : events.length === 0 ? (
                    <div className="text-gray-500 text-sm">No journey activity yet for this customer.</div>
                  ) : (
                    <ol className="relative border-l border-gray-200 ml-2">
                      {events.map((e, i) => {
                        const st = CATEGORY_STYLE[e.category] || CATEGORY_STYLE.workorder;
                        return (
                          <li key={`${e.ref_type}-${e.ref_id}-${e.code}-${i}`} className="mb-5 ml-4">
                            <span className={`absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full ${st.dot} ring-2 ring-white`} />
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${st.chip}`}>
                                {st.label}
                              </span>
                              <span className="text-sm font-medium text-gray-900">{e.title}</span>
                              {e.ref_id != null && (
                                <span className="text-xs text-gray-400">
                                  {e.ref_type === 'lead' ? `Lead #${e.ref_id}` : e.ref_type === 'workorder' ? `WO #${e.ref_id}` : `Delivery #${e.ref_id}`}
                                </span>
                              )}
                            </div>
                            {e.detail && <div className="text-sm text-gray-600 mt-0.5">{e.detail}</div>}
                            <div className="text-xs text-gray-400 mt-0.5">
                              {fmtTime(e.event_time)}{e.actor_name ? ` · ${e.actor_name}` : e.actor ? ` · ${e.actor}` : ''}
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                  )}
                </div>
              )}

              {tab === 'conversations' && (
                <div className="bg-white rounded-lg shadow p-5">
                  {convState.loading ? (
                    <div className="text-gray-500 text-sm">Loading conversations…</div>
                  ) : convState.denied ? (
                    <div className="text-gray-500 text-sm">
                      Podium conversations are available to <b>sales</b> users. Ask a sales team member or an admin to view this customer's chat threads.
                    </div>
                  ) : convState.error ? (
                    <div className="text-sm text-red-600">
                      Couldn't load conversations: {convState.error}
                      <button onClick={loadConversations} className="ml-2 underline text-blue-600">Retry</button>
                    </div>
                  ) : convState.notLinked ? (
                    <div className="text-gray-500 text-sm">
                      Connect your Podium account in <Link to="/settings" className="text-blue-600 underline">Settings</Link> to see this customer's conversations.
                    </div>
                  ) : convState.rows.length === 0 ? (
                    <div className="text-gray-500 text-sm">No Podium conversations found for this customer.</div>
                  ) : (
                    <>
                      {convState.mock && (
                        <div className="mb-3 inline-block text-[11px] px-2 py-0.5 rounded bg-yellow-100 text-yellow-800">Mock data</div>
                      )}
                      <ul className="divide-y">
                        {convState.rows.map((c) => {
                          const name = c.identity?.customer?.name || c.identity?.contact?.name || c.contactName || c.channel?.identifier || 'Unknown';
                          const channel = c.channel?.type || 'chat';
                          const when = c.lastItemAt || c.updatedAt || c.createdAt;
                          const closed = c.closed === true;
                          return (
                            <li key={c.uid} className="py-3 flex items-center justify-between gap-3">
                              <div className="min-w-0">
                                <div className="text-sm font-medium text-gray-900 truncate">{name}</div>
                                <div className="text-xs text-gray-500 mt-0.5">
                                  <span className="uppercase">{channel}</span>
                                  {when ? ` · ${fmtTime(when)}` : ''}
                                  <span className={`ml-2 inline-block px-1.5 py-0.5 rounded text-[10px] ${closed ? 'bg-gray-100 text-gray-600' : 'bg-green-100 text-green-800'}`}>
                                    {closed ? 'Closed' : 'Open'}
                                  </span>
                                </div>
                              </div>
                              <Link to="/inbox" className="text-sm text-blue-600 underline whitespace-nowrap">Open in Inbox →</Link>
                            </li>
                          );
                        })}
                      </ul>
                      <div className="text-[11px] text-gray-400 mt-3">Live from Podium — not stored (chat bodies stay in Podium).</div>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
