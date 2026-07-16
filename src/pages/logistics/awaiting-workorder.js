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

import { useCallback, useEffect, useMemo, useState } from 'react';
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

// Workorder enums (verified on the Neon dev branch) the F7c create form maps onto.
const DELIVERY_STATES = ['VIC', 'NSW', 'QLD', 'ACT', 'WA', 'SA', 'TAS', 'Customer Collect', 'NT'];
const LEAD_TIMES = ['1 Week', '2 Weeks', '3 Weeks', '4 Weeks', '5 Weeks'];

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

// F7c — the confirm-payment / create-workorder modal. Logistics confirms how the
// customer paid (50% deposit is the normal trigger; "Other" is allowed with a note —
// P8), supplies the delivery state + lead time the workorder needs, and creates the
// workorder shell. The workshop adds items later. On success the row leaves the queue.
function ConfirmPaymentModal({ row, onClose, onConverted }) {
  const orderTotal = row.order_total != null && row.order_total !== '' ? Number(row.order_total) : null;

  const [payment, setPayment] = useState('deposit_50');
  const [paymentNote, setPaymentNote] = useState('');
  const [deliveryState, setDeliveryState] = useState('VIC');
  const [leadTime, setLeadTime] = useState('2 Weeks');
  const [deliverySuburb, setDeliverySuburb] = useState('');
  const [deliveryCharged, setDeliveryCharged] = useState('');
  const [outstanding, setOutstanding] = useState(''); // explicit override; required for "Other"
  const [submitting, setSubmitting] = useState(false);

  // The outstanding balance the workorder will carry — an explicit entry wins, else derive.
  const computedOutstanding = useMemo(() => {
    if (outstanding !== '') { const n = Number(outstanding); return Number.isFinite(n) ? n : null; }
    if (payment === 'paid_full') return 0;
    if (payment === 'deposit_50') return orderTotal != null ? Math.round(orderTotal * 0.5 * 100) / 100 : null;
    return null; // "exception" needs an explicit figure
  }, [outstanding, payment, orderTotal]);

  const money = (v) =>
    v === null || v === undefined ? '—'
      : Number(v).toLocaleString('en-AU', { style: 'currency', currency: 'AUD' });

  async function submit() {
    if (payment === 'exception' && !paymentNote.trim()) { toast.error('Add a note for an "Other" payment'); return; }
    if (payment === 'exception' && outstanding === '') { toast.error('Enter the outstanding balance for an "Other" payment'); return; }
    if (payment === 'deposit_50' && orderTotal == null && outstanding === '') {
      toast.error('No order total on file — enter the outstanding balance'); return;
    }
    setSubmitting(true);
    try {
      const body = { lead_id: row.lead_id, payment, delivery_state: deliveryState, lead_time: leadTime };
      if (paymentNote.trim()) body.payment_note = paymentNote.trim();
      if (deliverySuburb.trim()) body.delivery_suburb = deliverySuburb.trim();
      if (deliveryCharged !== '') body.delivery_charged = Number(deliveryCharged);
      if (outstanding !== '') body.outstanding_balance = Number(outstanding);

      const res = await fetch('/api/logistics?resource=confirm-payment', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await parseMaybeJson(res);
      if (!res.ok) { toast.error(data?.error || 'Could not create the workorder'); setSubmitting(false); return; }
      onConverted(data);
    } catch {
      toast.error('Server error creating the workorder');
      setSubmitting(false);
    }
  }

  const custName = row.customer_name || (row.customer_id ? `Customer #${row.customer_id}` : 'Customer');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <h2 className="text-lg font-semibold">Confirm payment &amp; create workorder</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
        </div>

        <div className="px-5 py-4 space-y-4 text-sm">
          <div className="bg-gray-50 rounded p-3 text-gray-700">
            <div className="font-medium">{custName}</div>
            <div className="text-xs text-gray-500 mt-0.5">
              Invoice <span className="font-mono">{row.quote_invoice_id || '—'}</span>
              {orderTotal != null ? <> · Order total {money(orderTotal)}</> : null}
            </div>
          </div>

          <div>
            <div className="font-medium mb-1">Payment received</div>
            <div className="space-y-1.5">
              {[
                ['deposit_50', '50% deposit (usual trigger)'],
                ['paid_full', 'Paid in full'],
                ['exception', 'Other (partial / waived — needs a note)'],
              ].map(([val, label]) => (
                <label key={val} className="flex items-center gap-2">
                  <input type="radio" name="payment" value={val} checked={payment === val} onChange={() => setPayment(val)} />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </div>

          {payment === 'exception' ? (
            <div>
              <label className="block font-medium mb-1">Note <span className="text-red-600">*</span></label>
              <input
                type="text" value={paymentNote} onChange={(e) => setPaymentNote(e.target.value)}
                placeholder="e.g. partial deposit agreed, payment waived"
                className="w-full border border-gray-300 rounded px-2 py-1.5"
              />
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-medium mb-1">Delivery state</label>
              <select value={deliveryState} onChange={(e) => setDeliveryState(e.target.value)}
                className="w-full border border-gray-300 rounded px-2 py-1.5">
                {DELIVERY_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="block font-medium mb-1">Lead time</label>
              <select value={leadTime} onChange={(e) => setLeadTime(e.target.value)}
                className="w-full border border-gray-300 rounded px-2 py-1.5">
                {LEAD_TIMES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-medium mb-1">Delivery suburb</label>
              <input type="text" value={deliverySuburb} onChange={(e) => setDeliverySuburb(e.target.value)}
                placeholder="optional" className="w-full border border-gray-300 rounded px-2 py-1.5" />
            </div>
            <div>
              <label className="block font-medium mb-1">Delivery charged</label>
              <input type="number" step="0.01" min="0" value={deliveryCharged}
                onChange={(e) => setDeliveryCharged(e.target.value)}
                placeholder="optional" className="w-full border border-gray-300 rounded px-2 py-1.5" />
            </div>
          </div>

          <div>
            <label className="block font-medium mb-1">
              Outstanding balance {payment === 'exception' ? <span className="text-red-600">*</span> : <span className="text-gray-400 font-normal">(override)</span>}
            </label>
            <input type="number" step="0.01" min="0" value={outstanding}
              onChange={(e) => setOutstanding(e.target.value)}
              placeholder={computedOutstanding != null ? String(computedOutstanding) : 'enter amount'}
              className="w-full border border-gray-300 rounded px-2 py-1.5" />
            <p className="text-xs text-gray-500 mt-1">
              Workorder will carry <span className="font-medium">{money(computedOutstanding)}</span> outstanding.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t bg-gray-50">
          <button onClick={onClose} className="px-3 py-1.5 rounded border border-gray-300 bg-white hover:bg-gray-100">
            Cancel
          </button>
          <button
            onClick={submit} disabled={submitting}
            className="px-4 py-1.5 rounded bg-emerald-600 text-white font-medium hover:bg-emerald-700 disabled:opacity-60"
          >
            {submitting ? 'Creating…' : 'Create workorder'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AwaitingWorkorder() {
  const navigate = useNavigate();

  const [authorized, setAuthorized] = useState(false);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [convertRow, setConvertRow] = useState(null); // F7c: the row being converted

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

  // F7c — once a lead is converted, drop it from the queue and confirm the new workorder.
  const onConverted = useCallback((data) => {
    const leadId = convertRow?.lead_id;
    setConvertRow(null);
    setRows((rs) => rs.filter((r) => r.lead_id !== leadId));
    toast.success(
      (t) => (
        <span className="flex items-center gap-3">
          Workorder #{data.workorder_id} created.
          <button
            onClick={() => { toast.dismiss(t.id); navigate(`/delivery_operations/workorder/${data.workorder_id}`); }}
            className="underline font-medium"
          >
            Open
          </button>
        </span>
      ),
      { duration: 6000 }
    );
  }, [convertRow, navigate]);

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
                  <th className="px-4 py-3 font-medium text-right">Action</th>
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
                      <td className="px-4 py-3 text-right">
                        {r.customer_id ? (
                          <button
                            onClick={() => setConvertRow(r)}
                            className="px-2.5 py-1 rounded bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700 whitespace-nowrap"
                          >
                            Confirm payment
                          </button>
                        ) : (
                          <span className="text-xs text-gray-400" title="Link a customer to this lead first">Link customer first</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {convertRow && (
          <ConfirmPaymentModal
            row={convertRow}
            onClose={() => setConvertRow(null)}
            onConverted={onConverted}
          />
        )}
      </div>
    </div>
  );
}
