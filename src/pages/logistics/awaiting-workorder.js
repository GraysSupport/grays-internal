// src/pages/logistics/awaiting-workorder.js — Awaiting-Workorder queue (feature F7b).
//
// The logistics daily worklist over the F7b backend (lib/handlers/logistics.js →
// GET /api/logistics?resource=awaiting-workorder). It lists leads a salesperson has
// QUOTED (stage 'Quoted' with a MYOB `quote_invoice_id`, raised in F7a) that are waiting
// on payment + workorder creation. Logistics works this list top-down (oldest first),
// cross-checking MYOB for payment; converting a row into a workorder is F7c (a future
// action button here). This page is read-only.
//
// Gated to logistics/superadmin (display-only here; the server re-checks on the login
// JWT). The query form (?resource=) keeps us on the app's proven-safe single-segment
// routing convention. No message bodies are touched — leads carry CRM metadata only.

import { useCallback, useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import BackButton from '../../components/backbutton';
import HomeButton from '../../components/homebutton';
import { authHeaders, getToken, getRoles, hasAnyRole } from '../../utils/auth';
import { parseMaybeJson } from '../../utils/http';

const LOGISTICS_ROLES = ['logistics', 'superadmin'];

// Channel label map (mirrors the leads Kanban CHANNELS map).
const CHANNELS = {
  phone: 'SMS', sms: 'SMS', email: 'Email', facebook: 'Facebook',
  instagram: 'Instagram', google: 'Google', webchat: 'Webchat', whatsapp: 'WhatsApp',
};

function money(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (Number.isNaN(n)) return null;
  return n.toLocaleString('en-AU', { style: 'currency', currency: 'AUD' });
}

// Human "time since" for the age column (from updated_at ≈ when it was quoted).
function ageSince(iso) {
  if (!iso) return '—';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '—';
  const mins = Math.max(0, Math.round((Date.now() - then.getTime()) / 60000));
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h`;
  const days = Math.round(hrs / 24);
  return `${days}d`;
}

export default function AwaitingWorkorder() {
  const navigate = useNavigate();

  const [authorized, setAuthorized] = useState(false);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!getToken()) { navigate('/'); return; }
    if (!hasAnyRole(getRoles(), LOGISTICS_ROLES)) {
      toast.error('The awaiting-workorder queue is for logistics users');
      navigate('/dashboard');
      return;
    }
    setAuthorized(true);
  }, [navigate]);

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch('/api/logistics?resource=awaiting-workorder', { headers: authHeaders() });
      if (res.status === 401) { navigate('/'); return; }
      if (res.status === 403) { toast.error('The awaiting-workorder queue is for logistics users'); navigate('/dashboard'); return; }
      const data = await parseMaybeJson(res);
      if (!res.ok) { toast.error(data?.error || 'Could not load the queue'); return; }
      setRows(Array.isArray(data) ? data : []);
    } catch {
      toast.error('Server error loading the queue');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [navigate]);

  useEffect(() => {
    if (authorized) load();
  }, [authorized, load]);

  if (!authorized) return null;

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

        <header className="mb-4">
          <h1 className="text-2xl font-bold flex items-center gap-3">
            Awaiting Workorder
            <span className="text-sm font-medium bg-amber-100 text-amber-800 rounded-full px-2.5 py-0.5">
              {rows.length}
            </span>
          </h1>
          <p className="text-sm text-gray-600 mt-1">
            Quoted leads with a raised invoice, waiting on payment. Confirm payment in MYOB, then
            create the workorder. Worked oldest-first.
          </p>
        </header>

        {loading ? (
          <div className="bg-white rounded shadow p-8 text-center text-gray-500">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="bg-white rounded shadow p-8 text-center text-gray-500">
            No leads are awaiting a workorder. When a salesperson raises a quote, it appears here.
          </div>
        ) : (
          <div className="bg-white rounded shadow overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b">
                  <th className="px-4 py-3 font-medium">Customer</th>
                  <th className="px-4 py-3 font-medium">Channel</th>
                  <th className="px-4 py-3 font-medium">Invoice #</th>
                  <th className="px-4 py-3 font-medium">Value</th>
                  <th className="px-4 py-3 font-medium">Sales rep</th>
                  <th className="px-4 py-3 font-medium">Quoted</th>
                  <th className="px-4 py-3 font-medium">Conversation</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const value = money(r.order_total) ?? money(r.value_est);
                  const rep = r.assigned_name || r.assigned_to || 'Unassigned';
                  const channel = r.source_channel ? (CHANNELS[String(r.source_channel).toLowerCase()] || r.source_channel) : '—';
                  const custName = r.customer_name || (r.customer_id ? `Customer #${r.customer_id}` : 'Unmatched');
                  return (
                    <tr key={r.lead_id} className="border-b last:border-0 hover:bg-gray-50 align-top">
                      <td className="px-4 py-3">
                        {r.customer_id ? (
                          <Link to={`/customers/${r.customer_id}`} className="font-medium text-blue-700 hover:underline">
                            {custName}
                          </Link>
                        ) : (
                          <span className="font-medium">{custName}</span>
                        )}
                        {r.product_interest ? (
                          <div className="text-xs text-gray-500 mt-0.5">{r.product_interest}</div>
                        ) : null}
                        {r.customer_email ? (
                          <div className="text-xs text-gray-400 mt-0.5">{r.customer_email}</div>
                        ) : null}
                      </td>
                      <td className="px-4 py-3">{channel}</td>
                      <td className="px-4 py-3 font-mono">{r.quote_invoice_id || '—'}</td>
                      <td className="px-4 py-3">{value || '—'}</td>
                      <td className="px-4 py-3">{rep}</td>
                      <td className="px-4 py-3 text-gray-600" title={r.updated_at || ''}>{ageSince(r.updated_at)} ago</td>
                      <td className="px-4 py-3">
                        {r.customer_id ? (
                          <Link to={`/customers/${r.customer_id}`} className="text-blue-600 hover:underline">
                            Open
                          </Link>
                        ) : r.podium_conversation_id ? (
                          <Link to="/inbox" className="text-blue-600 hover:underline">Inbox</Link>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
