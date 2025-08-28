import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';

function formatMoney(n) {
  const v = Number(n || 0);
  return v.toLocaleString(undefined, { style: 'currency', currency: 'AUD' });
}
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString();
}

export default function WorkorderDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [wo, setWo] = useState(null);
  const [items, setItems] = useState([]);

  const [notes, setNotes] = useState('');
  const [deliveryCharged, setDeliveryCharged] = useState('');
  const [outstandingBalance, setOutstandingBalance] = useState('');

  const [activity, setActivity] = useState([]);
  const [techs, setTechs] = useState([]);

  const userId = useMemo(() => {
    try {
      const u = JSON.parse(localStorage.getItem('user') || '{}');
      return u?.id || '';
    } catch {
      return '';
    }
  }, []);

  const handleBack = () => {
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      navigate('/delivery_operations');
    }
  };

  // Load technicians once
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/users?access=technician');
        const data = await r.json();
        if (r.ok) setTechs(Array.isArray(data) ? data : []);
      } catch {}
    })();
  }, []);

  // Load WO
  useEffect(() => {
    const stored = localStorage.getItem('user');
    if (!stored) {
      navigate('/');
      return;
    }

    (async () => {
      setLoading(true);
      try {
        const r = await fetch(`/api/workorder?id=${encodeURIComponent(id)}`);
        const data = await r.json();
        if (!r.ok) throw new Error(data?.error || 'Failed to load workorder');

        setWo(data);
        setItems(data.items || []);
        setNotes(data.notes || '');
        setDeliveryCharged(data.delivery_charged ?? '');
        setOutstandingBalance(data.outstanding_balance ?? '');
        setActivity(data.activity || []);
      } catch (e) {
        toast.error(e.message || 'Failed to load');
      } finally {
        setLoading(false);
      }
    })();
  }, [id, navigate]);

  // Update local item field
  const setItemField = (idx, key, val) => {
    setItems((arr) => {
      const copy = [...arr];
      copy[idx] = { ...copy[idx], [key]: val };
      return copy;
    });
  };

  const handleSave = async () => {
    if (!wo) return;
    setSaving(true);
    const toastId = toast.loading('Saving changes...');
    try {
      const payload = {
        notes,
        delivery_charged:
          deliveryCharged === '' ? null : Number(deliveryCharged),
        outstanding_balance:
          outstandingBalance === ''
            ? wo.outstanding_balance
            : Number(outstandingBalance),
        items: items.map((it) => ({
          workorder_items_id: it.workorder_items_id,
          status: it.status,
          technician_id: it.technician_id,
        })),
      };

      const r = await fetch(
        `/api/workorder?id=${encodeURIComponent(wo.workorder_id)}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-User-Id': userId || '',
          },
          body: JSON.stringify(payload),
        }
      );
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data?.error || 'Save failed');

      // Refresh from response (API returns updated resource)
      setWo(data);
      setItems(data.items || []);
      setNotes(data.notes || '');
      setDeliveryCharged(data.delivery_charged ?? '');
      setOutstandingBalance(data.outstanding_balance ?? '');
      setActivity(data.activity || []);

      toast.success('Saved!', { id: toastId });
    } catch (e) {
      toast.error(e.message || 'Save failed', { id: toastId });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 grid place-items-center">
        <div className="text-gray-600">Loading work order…</div>
      </div>
    );
  }

  if (!wo) {
    return (
      <div className="p-6">
        <div className="mb-4">
          <button
            onClick={handleBack}
            className="text-blue-600 underline"
          >
            ← Back
          </button>
        </div>
        <div className="text-red-600">Work order not found.</div>
      </div>
    );
  }


  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <header className="border-b bg-white">
        <div className="py-4 px-4 flex items-center justify-between">
          <button
            onClick={handleBack}
            className="rounded-md border px-3 py-1 text-sm hover:bg-gray-50"
          >
            ← Back
          </button>
          <h1 className="text-2xl font-semibold tracking-tight text-center">
            Work Order Details: Invoice #{wo.invoice_id}
          </h1>
          <div />
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-4">
        {/* Top summary */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
          <div className="rounded-lg border bg-white p-3">
            <div className="text-xs text-gray-500">Customer Name:</div>
            <div className="font-semibold">{wo.customer_name}</div>
          </div>
          <div className="rounded-lg border bg-white p-3">
            <div className="text-xs text-gray-500">Workorder Date:</div>
            <div className="font-semibold">{fmtDate(wo.date_created)}</div>
          </div>
          <div className="rounded-lg border bg-white p-3">
            <div className="text-xs text-gray-500">Expected Completion Date:</div>
            <div className="font-semibold">{fmtDate(wo.estimated_completion)}</div>
          </div>
          <div className="rounded-lg border bg-white p-3">
            <div className="text-xs text-gray-500">Salesperson:</div>
            <div className="font-semibold">{wo.salesperson}</div>
          </div>
          <div className="rounded-lg border bg-white p-3">
            <div className="text-xs text-gray-500">Payment Status:</div>
            <div className="font-semibold">
              {Number(wo.outstanding_balance) > 0 ? (
                <span className="text-red-600">{formatMoney(wo.outstanding_balance)} Outstanding</span>
              ) : (
                <span className="text-green-600">Paid</span>
              )}
            </div>
          </div>
        </div>

        {/* Items */}
        <div className="rounded-xl border bg-white">
          <div className="border-b p-4 text-center font-semibold">Items</div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-100">
                <tr className="text-left text-xs font-semibold uppercase tracking-wider text-gray-600">
                  <th className="px-4 py-3 w-14">Qty</th>
                  <th className="px-4 py-3 w-32">SKU</th>
                  <th className="px-4 py-3">Equipment Name</th>
                  <th className="px-4 py-3 w-20">Condition</th>
                  <th className="px-4 py-3 w-40">Tech Assigned</th>
                  <th className="px-4 py-3 w-48">Status</th>
                  <th className="px-4 py-3 w-28">Workshop Duration</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {items.map((it, idx) => (
                  <tr key={it.workorder_items_id} className={idx % 2 ? 'bg-gray-50' : 'bg-white'}>
                    <td className="px-4 py-3 text-sm">{Number(it.quantity)}</td>
                    <td className="px-4 py-3 text-sm">{it.product_id}</td>
                    <td className="px-4 py-3 text-sm">{it.product_name}</td>
                    <td className="px-4 py-3 text-sm">{it.condition}</td>
                    <td className="px-4 py-3 text-sm">
                      <select
                        className="border rounded px-2 py-1 w-full"
                        value={it.technician_id || ''}
                        onChange={(e) => setItemField(idx, 'technician_id', e.target.value)}
                      >
                        <option value="" disabled>Select tech</option>
                        {techs.map((t) => (
                          <option key={t.id} value={t.id}>{t.id} — {t.name}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <select
                        className="border rounded px-2 py-1 w-full"
                        value={it.status}
                        onChange={(e) => setItemField(idx, 'status', e.target.value)}
                      >
                        <option>Not in Workshop</option>
                        <option>In Workshop</option>
                        <option>Completed</option>
                      </select>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {it.wokrshop_duration != null ? `${Number(it.wokrshop_duration)} hours` : (it.status === 'In Workshop' ? '—' : '0 hours')}
                    </td>
                  </tr>
                ))}
                {!items.length && (
                  <tr><td className="px-4 py-4 text-center text-sm text-gray-500" colSpan={7}>No items.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Activity Log + Notes/Charges */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-6">
          <div className="md:col-span-2 rounded-xl border bg-white p-3">
            <div className="font-semibold mb-2 text-center">Activity Log</div>
            <div className="h-72 overflow-y-auto border rounded p-2 text-sm font-mono bg-gray-50">
              {activity.length ? activity.map((l) => {
                const itemLine = l.workorder_items_id
                  ? `${l.ts}   ${l.product_name ?? '(Item)'} — ${l.event_type}${l.current_item_status ? `: ${l.current_item_status}` : ''} - ${l.user_id}`
                  : `${l.ts}   ${l.event_type} - ${l.user_id}`;
                return <div key={l.id}>{itemLine}</div>;
              }) : <div className="text-gray-500">No activity yet.</div>}
            </div>
          </div>

          <div className="rounded-xl border bg-white p-3">
            <div className="font-semibold mb-2">Notes</div>
            <textarea
              className="w-full border rounded p-2 h-28"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Notes"
            />
            <div className="mt-4">
              <div className="text-sm text-gray-600 mb-1">Delivery Charged ($)</div>
              <input
                type="number"
                step="0.01"
                className="w-full border rounded p-2"
                value={deliveryCharged ?? ''}
                onChange={(e) => setDeliveryCharged(e.target.value)}
                placeholder="Value"
              />
            </div>
            <div className="mt-3">
              <div className="text-sm text-gray-600 mb-1">Outstanding Balance ($)</div>
              <input
                type="number"
                step="0.01"
                className="w-full border rounded p-2"
                value={outstandingBalance ?? ''}
                onChange={(e) => setOutstandingBalance(e.target.value)}
                placeholder="Value"
              />
            </div>

            <div className="mt-4 flex gap-2">
              <button
                onClick={handleSave}
                disabled={saving}
                className="w-full rounded-md bg-gray-900 px-4 py-2 text-white hover:bg-black/90 disabled:opacity-60"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}