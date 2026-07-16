// src/pages/integrations.js — Integrations observability (feature F10).
//
// The superadmin read of `integration_sync_log` over the F10 backend
// (lib/handlers/integrations.js → GET /api/integrations?resource=sync-log).
//
// Every Podium integration already writes here — the F2 webhook receiver dedupes inbound
// events on it, and the F8 automations (waitlist back-in-stock, delivery-booked, review
// request) claim and record every outbound send. Nothing surfaced it until now: a failed
// customer SMS was invisible without a SQL console. This page answers the only question
// ops actually has — "is anything failing?" — and the health tiles ARE the alert
// (execution-plan §F10; a push/email alert is the next increment).
//
// A `failed` row matters: the F8 automations are AT-MOST-ONCE by design, so a failed send
// is NOT retried. That customer did not get their message, and someone has to decide
// whether to contact them by hand. Hence failures are called out, not just listed.
//
// Gated to superadmin (display-only here; the server re-checks on the login JWT). Query
// form (?resource=) keeps us on the app's proven-safe single-segment routing convention.
// P1: the log holds envelope metadata only (ids, SKUs, event types) — no chat bodies were
// ever written to it, so nothing here can leak message content.

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import BackButton from '../components/backbutton';
import HomeButton from '../components/homebutton';
import { authHeaders, getToken, getRoles, hasAnyRole } from '../utils/auth';
import { parseMaybeJson } from '../utils/http';

const ADMIN_ROLES = ['superadmin'];

const STATUSES = ['', 'sent', 'failed', 'pending', 'skipped'];

// Plain-English labels for the event types the integrations actually write.
const EVENT_LABELS = {
  'waitlist.back_in_stock': 'Waitlist — back in stock SMS',
  'delivery_booked': 'Delivery booked SMS',
  'delivery.booked': 'Delivery booked SMS',
  'workorder.review_request': 'Review request',
};

const STATUS_STYLES = {
  sent: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  pending: 'bg-amber-100 text-amber-800',
  skipped: 'bg-gray-100 text-gray-700',
};

function when(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' });
}

function Tile({ label, value, tone = 'default', active, onClick }) {
  const tones = {
    default: 'border-gray-200',
    good: 'border-green-200',
    bad: value > 0 ? 'border-red-300 bg-red-50' : 'border-gray-200',
    warn: value > 0 ? 'border-amber-300 bg-amber-50' : 'border-gray-200',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left rounded-lg border bg-white px-4 py-3 transition hover:shadow-sm ${tones[tone]} ${active ? 'ring-2 ring-offset-1 ring-gray-400' : ''}`}
    >
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`text-2xl font-semibold ${tone === 'bad' && value > 0 ? 'text-red-700' : 'text-gray-900'}`}>{value}</div>
    </button>
  );
}

export default function Integrations() {
  const navigate = useNavigate();

  const [authorized, setAuthorized] = useState(false);
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState({ total: 0, sent: 0, failed: 0, pending: 0, skipped: 0 });
  const [unavailable, setUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState(null);

  useEffect(() => {
    if (!getToken()) { navigate('/'); return; }
    if (!hasAnyRole(getRoles(), ADMIN_ROLES)) {
      toast.error('Integrations is for superadmins');
      navigate('/dashboard');
      return;
    }
    setAuthorized(true);
  }, [navigate]);

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const params = new URLSearchParams({ resource: 'sync-log' });
      if (status) params.set('status', status);
      if (q.trim()) params.set('q', q.trim());
      const res = await fetch(`/api/integrations?${params.toString()}`, { headers: authHeaders() });
      if (res.status === 401) { navigate('/'); return; }
      if (res.status === 403) { toast.error('Integrations is for superadmins'); navigate('/dashboard'); return; }
      const data = await parseMaybeJson(res);
      if (!res.ok) { toast.error(data?.error || 'Could not load the integration log'); return; }
      setRows(Array.isArray(data?.rows) ? data.rows : []);
      setSummary(data?.summary || { total: 0, sent: 0, failed: 0, pending: 0, skipped: 0 });
      setUnavailable(!!data?.unavailable);
    } catch {
      toast.error('Server error loading the integration log');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [navigate, status, q]);

  useEffect(() => {
    if (authorized) load();
  }, [authorized, load]);

  if (!authorized) return null;

  const toggleStatus = (s) => setStatus((cur) => (cur === s ? '' : s));

  return (
    <div className="min-h-screen bg-gray-100 p-4 md:p-6">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center gap-2 mb-4">
          <BackButton />
          <HomeButton />
          <div className="ml-auto">
            <button
              onClick={() => load()}
              className="text-sm px-3 py-1.5 rounded border border-gray-300 bg-white hover:bg-gray-50"
            >
              Refresh
            </button>
          </div>
        </div>

        <h1 className="text-2xl font-semibold text-gray-900">Integrations</h1>
        <p className="text-sm text-gray-600 mt-1 mb-4">
          Every message the portal sends through Podium, and every event it receives, is recorded here.
          Automated messages are sent <strong>once</strong> — a failure is not retried, so anything red
          means that customer was never contacted.
        </p>

        {unavailable && (
          <div className="mb-4 rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            The integration log table doesn’t exist on this database yet — it ships with the Podium
            migration. Nothing is broken; there’s simply nothing to show.
          </div>
        )}

        {summary.failed > 0 && (
          <div className="mb-4 rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900">
            <strong>{summary.failed} failed {summary.failed === 1 ? 'message' : 'messages'}.</strong>{' '}
            These were not retried automatically — check whether the customer needs contacting by hand.
          </div>
        )}

        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
          <Tile label="Total" value={summary.total} onClick={() => setStatus('')} active={status === ''} />
          <Tile label="Sent" value={summary.sent} tone="good" onClick={() => toggleStatus('sent')} active={status === 'sent'} />
          <Tile label="Failed" value={summary.failed} tone="bad" onClick={() => toggleStatus('failed')} active={status === 'failed'} />
          <Tile label="Pending" value={summary.pending} tone="warn" onClick={() => toggleStatus('pending')} active={status === 'pending'} />
          <Tile label="Skipped" value={summary.skipped} onClick={() => toggleStatus('skipped')} active={status === 'skipped'} />
        </div>

        <div className="flex flex-wrap items-center gap-2 mb-3">
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="text-sm rounded border border-gray-300 px-2 py-1.5 bg-white"
          >
            {STATUSES.map((s) => (
              <option key={s || 'all'} value={s}>{s ? s[0].toUpperCase() + s.slice(1) : 'All statuses'}</option>
            ))}
          </select>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search reference or error…"
            className="text-sm rounded border border-gray-300 px-2 py-1.5 bg-white flex-1 min-w-[12rem]"
          />
          <span className="text-sm text-gray-500">
            {loading ? 'Loading…' : `${rows.length} shown`}
          </span>
        </div>

        <div className="bg-white rounded-lg border border-gray-200 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="text-left px-3 py-2 font-medium">When</th>
                <th className="text-left px-3 py-2 font-medium">Event</th>
                <th className="text-left px-3 py-2 font-medium">Direction</th>
                <th className="text-left px-3 py-2 font-medium">Reference</th>
                <th className="text-left px-3 py-2 font-medium">Status</th>
                <th className="text-left px-3 py-2 font-medium">Detail</th>
              </tr>
            </thead>
            <tbody>
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-gray-500">
                    Nothing logged yet. Automated messages appear here once Podium is live
                    (they run in mock mode today, so nothing is actually sent).
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.id} className={`border-t border-gray-100 ${r.status === 'failed' ? 'bg-red-50' : ''}`}>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-700">{when(r.created_at)}</td>
                  <td className="px-3 py-2">
                    <div className="text-gray-900">{EVENT_LABELS[r.event_type] || r.event_type}</div>
                    <div className="text-xs text-gray-500">{r.source}</div>
                  </td>
                  <td className="px-3 py-2 text-gray-700">{r.direction}</td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-700">{r.reference_id || '—'}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[r.status] || 'bg-gray-100 text-gray-700'}`}>
                      {r.status}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    {r.error && <div className="text-xs text-red-700 mb-1">{r.error}</div>}
                    {r.payload && (
                      <button
                        type="button"
                        onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                        className="text-xs text-gray-600 underline"
                      >
                        {expanded === r.id ? 'Hide' : 'Show'} details
                      </button>
                    )}
                    {expanded === r.id && (
                      <pre className="mt-1 text-xs bg-gray-50 border border-gray-200 rounded p-2 overflow-x-auto">
                        {JSON.stringify(r.payload, null, 2)}
                      </pre>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-gray-500 mt-3">
          Newest first, most recent {rows.length} shown. Only what was sent is recorded — never the
          text of a customer conversation (Podium holds that).
        </p>
      </div>
    </div>
  );
}
