// src/pages/peloton/sales-orders.js
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { PackageSearch, Plus, X, ChevronDown, ChevronUp, ChevronRight } from 'lucide-react';
import BackButton from '../../components/backbutton';
import HomeButton from '../../components/homebutton';
import PelotonTabs from '../../components/PelotonTabs';

// ─── constants ────────────────────────────────────────────────────────────────

const FACILITIES = [
  { code: '2000', label: 'NSW' },
  { code: '3000', label: 'VIC' },
  { code: '4000', label: 'QLD' },
  { code: '5000', label: 'SA'  },
  { code: '6000', label: 'WA'  },
  { code: '7000', label: 'TAS' },
  { code: '8000', label: 'NT'  },
];

const STATUSES = ['Draft', 'Submitted', 'Confirmed', 'Shipped', 'Cancelled'];

// SAP document order types
const ORDER_TYPE_META = {
  ZWSO: { label: 'Standard Order (ZWSO)',          color: 'bg-blue-100 text-blue-700',   needsShipToCode: false, needsReturnRef: false },
  ZISO: { label: 'Interstate Order (ZISO)',         color: 'bg-orange-100 text-orange-700', needsShipToCode: true,  needsReturnRef: false },
  ZRE:  { label: 'Return Order (ZRE)',              color: 'bg-red-100 text-red-700',     needsShipToCode: true,  needsReturnRef: true  },
};

// Actions shown in the "New Order" dropdown — maps to order type or special action
const NEW_ORDER_ACTIONS = [
  { id: 'ZWSO', label: 'Create Standard Order (ZWSO)' },
  { id: 'ZISO', label: 'Create Interstate Order (ZISO) with ShipToCode' },
  { id: 'ZRE',  label: 'Create Return Order (ZRE) with ShipToCode' },
];

const STATUS_STYLE = {
  Draft:      'bg-gray-100 text-gray-600',
  Submitted:  'bg-blue-100 text-blue-700',
  Confirmed:  'bg-green-100 text-green-700',
  Shipped:    'bg-purple-100 text-purple-700',
  Cancelled:  'bg-red-100 text-red-600',
};

// ─── helpers ──────────────────────────────────────────────────────────────────

const API = '/api/winnings?section=sales-orders';

function authHeaders(user) {
  return {
    'X-User-Access': user?.access || '',
    'X-User-Id':     user?.id     || '',
  };
}

function fmtMoney(v) {
  const n = Number(v);
  if (isNaN(n)) return '—';
  return n.toLocaleString('en-AU', { style: 'currency', currency: 'AUD' });
}

function fmtQty(v) {
  const n = Number(v);
  return isNaN(n) ? '—' : (Number.isInteger(n) ? String(n) : n.toFixed(2));
}

function fmtDate(d) {
  if (!d) return null;
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function orderTotal(items) {
  if (!Array.isArray(items)) return null;
  const t = items.reduce((s, it) => s + (Number(it.quantity) || 0) * (Number(it.unit_price) || 0), 0);
  return t > 0 ? t : null;
}

function emptyItem() {
  return { _key: crypto.randomUUID(), sku: '', description: '', quantity: '', unit_price: '' };
}

function emptyForm(orderType = 'ZWSO') {
  return {
    order_type:       orderType,
    facility:         '2000',
    customer_name:    '',
    customer_ref:     '',
    ship_to:          '',
    ship_to_code:     '',
    return_reference: '',
    requested_date:   '',
    status:           'Draft',
    notes:            '',
    items:            [emptyItem()],
  };
}

// ─── LineItemsTable ───────────────────────────────────────────────────────────

function LineItemsTable({ items, onItemChange, onAddItem, onRemoveItem }) {
  const formTotal = items.reduce((s, it) => {
    return s + (Number(it.quantity) || 0) * (it.unit_price !== '' ? Number(it.unit_price) || 0 : 0);
  }, 0);

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-gray-700">Line Items</h3>
        <button
          type="button"
          onClick={onAddItem}
          className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-gray-300 hover:bg-gray-50 transition"
        >
          <Plus size={12} /> Add Line
        </button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-left border-b">
              <th className="px-3 py-2 font-semibold text-gray-600 w-36">SKU <span className="text-red-500">*</span></th>
              <th className="px-3 py-2 font-semibold text-gray-600">Description</th>
              <th className="px-3 py-2 font-semibold text-gray-600 w-24 text-right">Qty <span className="text-red-500">*</span></th>
              <th className="px-3 py-2 font-semibold text-gray-600 w-28 text-right">Unit Price</th>
              <th className="px-3 py-2 font-semibold text-gray-600 w-28 text-right">Line Total</th>
              <th className="px-3 py-2 w-10" />
            </tr>
          </thead>
          <tbody>
            {items.map((it, idx) => {
              const lineTotal = Number(it.quantity) > 0 && it.unit_price !== ''
                ? Number(it.quantity) * Number(it.unit_price) : null;
              return (
                <tr key={it._key} className="border-t">
                  <td className="px-3 py-2">
                    <input
                      type="text"
                      value={it.sku}
                      onChange={(e) => onItemChange('sku', idx, e.target.value.toUpperCase())}
                      placeholder="e.g. PLT-001"
                      className="w-full border border-gray-300 rounded px-2 py-1 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-gray-400"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="text"
                      value={it.description}
                      onChange={(e) => onItemChange('description', idx, e.target.value)}
                      placeholder="Item description"
                      className="w-full border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-gray-400"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number" min="0.01" step="0.01"
                      value={it.quantity}
                      onChange={(e) => onItemChange('quantity', idx, e.target.value)}
                      placeholder="0"
                      className="w-full border border-gray-300 rounded px-2 py-1 text-xs text-right focus:outline-none focus:ring-1 focus:ring-gray-400"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number" min="0" step="0.01"
                      value={it.unit_price}
                      onChange={(e) => onItemChange('unit_price', idx, e.target.value)}
                      placeholder="0.00"
                      className="w-full border border-gray-300 rounded px-2 py-1 text-xs text-right focus:outline-none focus:ring-1 focus:ring-gray-400"
                    />
                  </td>
                  <td className="px-3 py-2 text-right text-xs text-gray-500">
                    {lineTotal != null ? fmtMoney(lineTotal) : <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {items.length > 1 && (
                      <button type="button" onClick={() => onRemoveItem(idx)}
                        className="text-gray-400 hover:text-red-500 transition" title="Remove line">
                        <X size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
          {formTotal > 0 && (
            <tfoot>
              <tr className="border-t bg-gray-50">
                <td colSpan={4} className="px-3 py-2 text-right text-xs font-semibold text-gray-600">Order Total</td>
                <td className="px-3 py-2 text-right text-sm font-bold text-gray-900">{fmtMoney(formTotal)}</td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

// ─── CreateForm ───────────────────────────────────────────────────────────────

function CreateForm({ user, orderType, onCreated, onClose }) {
  const [form, setForm]     = useState(emptyForm(orderType));
  const [saving, setSaving] = useState(false);
  const meta = ORDER_TYPE_META[orderType];

  const setField     = (k, v)       => setForm((f) => ({ ...f, [k]: v }));
  const setItemField = (k, idx, v)  => setForm((f) => ({ ...f, items: f.items.map((it, i) => i === idx ? { ...it, [k]: v } : it) }));
  const addItem      = ()           => setForm((f) => ({ ...f, items: [...f.items, emptyItem()] }));
  const removeItem   = (idx)        => setForm((f) => ({ ...f, items: f.items.filter((_, i) => i !== idx) }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.customer_name.trim()) { toast.error('Customer name is required'); return; }
    if (meta.needsShipToCode && !form.ship_to_code.trim()) { toast.error('Ship To Code is required for this order type'); return; }
    if (meta.needsReturnRef  && !form.return_reference.trim()) { toast.error('Return Reference (original SO) is required for Return orders'); return; }
    for (const it of form.items) {
      if (!it.sku.trim())                          { toast.error('Every line item needs a SKU'); return; }
      if (!it.quantity || Number(it.quantity) <= 0){ toast.error('Every line item needs a positive quantity'); return; }
    }

    setSaving(true);
    const tid = toast.loading('Creating sales order…');
    try {
      const r = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(user) },
        body: JSON.stringify({
          order_type:       form.order_type,
          facility:         form.facility,
          customer_name:    form.customer_name.trim(),
          customer_ref:     form.customer_ref.trim()     || null,
          ship_to:          form.ship_to.trim()          || null,
          ship_to_code:     form.ship_to_code.trim()     || null,
          return_reference: form.return_reference.trim() || null,
          requested_date:   form.requested_date          || null,
          status:           form.status,
          notes:            form.notes.trim()            || null,
          created_by:       user?.id                     || null,
          items: form.items.map((it) => ({
            sku:         it.sku.trim(),
            description: it.description.trim() || null,
            quantity:    Number(it.quantity),
            unit_price:  it.unit_price !== '' ? Number(it.unit_price) : null,
          })),
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Create failed');
      toast.success(`Created ${data.so_number}`, { id: tid });
      onCreated();
    } catch (err) {
      toast.error(err.message || 'Failed', { id: tid });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white rounded-xl shadow border">
      {/* Form header */}
      <div className="px-5 py-4 border-b flex items-center gap-3">
        <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${meta.color}`}>{orderType}</span>
        <h2 className="font-semibold text-gray-800">{meta.label}</h2>
        <button type="button" onClick={onClose} className="ml-auto text-gray-400 hover:text-gray-600">
          <X size={16} />
        </button>
      </div>

      <form onSubmit={handleSubmit} className="p-5 space-y-5">
        {/* Header fields grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Facility / Warehouse <span className="text-red-500">*</span></label>
            <select value={form.facility} onChange={(e) => setField('facility', e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400">
              {FACILITIES.map((f) => <option key={f.code} value={f.code}>{f.label} ({f.code})</option>)}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Status</label>
            <select value={form.status} onChange={(e) => setField('status', e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400">
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Requested Delivery Date</label>
            <input type="date" value={form.requested_date} onChange={(e) => setField('requested_date', e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400" />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Customer Name <span className="text-red-500">*</span></label>
            <input type="text" value={form.customer_name} onChange={(e) => setField('customer_name', e.target.value)}
              placeholder="e.g. Acme Corp"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400" />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Customer Reference / PO#</label>
            <input type="text" value={form.customer_ref} onChange={(e) => setField('customer_ref', e.target.value)}
              placeholder="Customer's own PO number"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400" />
          </div>

          {/* Ship To Code — required for ZISO / ZRE */}
          {meta.needsShipToCode && (
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Ship To Code <span className="text-red-500">*</span>
                <span className="ml-1 text-gray-400 font-normal">(SAP ShipToCode)</span>
              </label>
              <input type="text" value={form.ship_to_code} onChange={(e) => setField('ship_to_code', e.target.value.toUpperCase())}
                placeholder="e.g. C1234"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-gray-400" />
            </div>
          )}

          {/* Return Reference — required for ZRE */}
          {meta.needsReturnRef && (
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Original SO Reference <span className="text-red-500">*</span>
                <span className="ml-1 text-gray-400 font-normal">(order being returned)</span>
              </label>
              <input type="text" value={form.return_reference} onChange={(e) => setField('return_reference', e.target.value.toUpperCase())}
                placeholder="e.g. SO-20260101-0012"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-gray-400" />
            </div>
          )}

          <div className={meta.needsShipToCode ? '' : 'sm:col-span-2 lg:col-span-1'}>
            <label className="block text-xs font-medium text-gray-600 mb-1">Ship-to Address</label>
            <textarea rows={2} value={form.ship_to} onChange={(e) => setField('ship_to', e.target.value)}
              placeholder="Delivery address"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 resize-none" />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Notes / Special Instructions</label>
          <textarea rows={2} value={form.notes} onChange={(e) => setField('notes', e.target.value)}
            placeholder="Any special instructions or comments"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 resize-none" />
        </div>

        <LineItemsTable
          items={form.items}
          onItemChange={setItemField}
          onAddItem={addItem}
          onRemoveItem={removeItem}
        />

        <div className="flex justify-end gap-3 pt-1">
          <button type="button" onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg border border-gray-300 hover:bg-gray-50 transition">
            Cancel
          </button>
          <button type="submit" disabled={saving}
            className="px-5 py-2 text-sm rounded-lg bg-gray-900 text-white hover:bg-black/90 disabled:opacity-60 transition">
            {saving ? 'Creating…' : `Create ${orderType} Order`}
          </button>
        </div>
      </form>
    </div>
  );
}

// ─── UpdatePanel ──────────────────────────────────────────────────────────────

function UpdatePanel({ order, user, onUpdated, onClose }) {
  const [form, setForm]     = useState({
    status:           order.status,
    customer_ref:     order.customer_ref     || '',
    ship_to:          order.ship_to          || '',
    ship_to_code:     order.ship_to_code     || '',
    return_reference: order.return_reference || '',
    requested_date:   order.requested_date   ? order.requested_date.slice(0, 10) : '',
    notes:            order.notes            || '',
  });
  const [saving, setSaving] = useState(false);
  const meta = ORDER_TYPE_META[order.order_type] || ORDER_TYPE_META['ZWSO'];

  const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const handleSave = async () => {
    setSaving(true);
    const tid = toast.loading('Updating…');
    try {
      const r = await fetch(`${API}&id=${order.so_id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders(user) },
        body: JSON.stringify({
          status:           form.status,
          customer_ref:     form.customer_ref     || null,
          ship_to:          form.ship_to          || null,
          ship_to_code:     form.ship_to_code     || null,
          return_reference: form.return_reference || null,
          requested_date:   form.requested_date   || null,
          notes:            form.notes            || null,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Update failed');
      toast.success('Updated', { id: tid });
      onUpdated();
    } catch (err) {
      toast.error(err.message, { id: tid });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-3 border rounded-lg bg-white p-4 space-y-4">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Update Order</span>
        <span className="text-xs text-gray-400">— {order.so_number}</span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Status</label>
          <select value={form.status} onChange={(e) => setField('status', e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400">
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Customer Reference</label>
          <input type="text" value={form.customer_ref} onChange={(e) => setField('customer_ref', e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400" />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Requested Date</label>
          <input type="date" value={form.requested_date} onChange={(e) => setField('requested_date', e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400" />
        </div>

        {meta.needsShipToCode && (
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Ship To Code</label>
            <input type="text" value={form.ship_to_code} onChange={(e) => setField('ship_to_code', e.target.value.toUpperCase())}
              className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-gray-400" />
          </div>
        )}

        {meta.needsReturnRef && (
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Original SO Reference</label>
            <input type="text" value={form.return_reference} onChange={(e) => setField('return_reference', e.target.value.toUpperCase())}
              className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-gray-400" />
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Ship-to Address</label>
          <input type="text" value={form.ship_to} onChange={(e) => setField('ship_to', e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400" />
        </div>

        <div className="sm:col-span-2 lg:col-span-3">
          <label className="block text-xs font-medium text-gray-600 mb-1">Notes</label>
          <textarea rows={2} value={form.notes} onChange={(e) => setField('notes', e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 resize-none" />
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose}
          className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 hover:bg-gray-50 transition">
          Discard
        </button>
        <button type="button" onClick={handleSave} disabled={saving}
          className="px-4 py-1.5 text-sm rounded-lg bg-gray-900 text-white hover:bg-black/90 disabled:opacity-60 transition">
          {saving ? 'Saving…' : 'Save Changes'}
        </button>
      </div>
    </div>
  );
}

// ─── NewOrderDropdown ─────────────────────────────────────────────────────────

function NewOrderDropdown({ onSelect }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 text-white text-sm rounded-lg hover:bg-gray-700 transition"
      >
        <Plus size={14} />
        New Sales Order
        <ChevronDown size={13} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute right-0 mt-1 w-72 bg-white border border-gray-200 rounded-xl shadow-lg z-50 overflow-hidden">
          {NEW_ORDER_ACTIONS.map((a) => (
            <button
              key={a.id}
              className="w-full text-left px-4 py-3 text-sm hover:bg-gray-50 flex items-center gap-2 transition border-b last:border-b-0"
              onClick={() => { onSelect(a.id); setOpen(false); }}
            >
              <ChevronRight size={13} className="text-gray-400 flex-shrink-0" />
              <span>{a.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── main page ────────────────────────────────────────────────────────────────

export default function SalesOrdersPage() {
  const navigate = useNavigate();

  const [user, setUser]         = useState(null);
  const [orders, setOrders]     = useState([]);
  const [loading, setLoading]   = useState(true);

  // which create form is open ('ZWSO' | 'ZISO' | 'ZRE' | null)
  const [createType, setCreateType] = useState(null);

  // which row is expanded for detail view
  const [expandedId, setExpandedId] = useState(null);

  // which row is open for update
  const [updatingId, setUpdatingId] = useState(null);

  // filters
  const [filterStatus,    setFilterStatus]    = useState('');
  const [filterFacility,  setFilterFacility]  = useState('');
  const [filterOrderType, setFilterOrderType] = useState('');

  // ── auth guard ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const stored = localStorage.getItem('user');
    if (!stored) { navigate('/'); return; }
    const u = JSON.parse(stored);
    if (u?.access !== 'superadmin') {
      toast.error('Insufficient permissions');
      navigate('/dashboard');
      return;
    }
    setUser(u);
  }, [navigate]);

  // ── fetch orders ────────────────────────────────────────────────────────────
  const fetchOrders = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterStatus)    params.set('status',     filterStatus);
      if (filterFacility)  params.set('facility',   filterFacility);
      if (filterOrderType) params.set('order_type', filterOrderType);

      const r = await fetch(`${API}&${params}`, { headers: authHeaders(user) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Failed to load');
      setOrders(Array.isArray(data) ? data : []);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }, [user, filterStatus, filterFacility, filterOrderType]);

  useEffect(() => { fetchOrders(); }, [fetchOrders]);

  // ── cancel order ────────────────────────────────────────────────────────────
  const handleCancel = async (o) => {
    if (!window.confirm(`Cancel ${o.so_number}? This cannot be undone.`)) return;
    const tid = toast.loading('Cancelling…');
    try {
      const r = await fetch(`${API}&id=${o.so_id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders(user) },
        body: JSON.stringify({ status: 'Cancelled' }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Cancel failed');
      toast.success(`${o.so_number} cancelled`, { id: tid });
      fetchOrders();
    } catch (err) {
      toast.error(err.message, { id: tid });
    }
  };

  // ── render ───────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-screen bg-gray-100">

      {/* ── top bar ── */}
      <header className="bg-white shadow-md px-4 py-3 flex items-center gap-3 flex-shrink-0">
        <BackButton />
        <HomeButton />
        <div className="flex items-center gap-2 ml-2">
          <span className="inline-flex items-center gap-1.5 bg-black text-white text-xs font-bold px-2.5 py-1 rounded-full tracking-wide">
            <PackageSearch size={13} />
            PELOTON
          </span>
          <h1 className="text-base font-semibold text-gray-800">Sales Orders</h1>
        </div>
        <div className="ml-auto">
          <NewOrderDropdown onSelect={(type) => { setCreateType(type); setUpdatingId(null); }} />
        </div>
      </header>

      {/* ── filters bar ── */}
      <div className="bg-white border-b px-4 py-2 flex items-center gap-3 flex-shrink-0 flex-wrap">
        <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400">
          <option value="">All Statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>

        <select value={filterFacility} onChange={(e) => setFilterFacility(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400">
          <option value="">All Facilities</option>
          {FACILITIES.map((f) => <option key={f.code} value={f.code}>{f.label}</option>)}
        </select>

        <select value={filterOrderType} onChange={(e) => setFilterOrderType(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gray-400">
          <option value="">All Order Types</option>
          {Object.entries(ORDER_TYPE_META).map(([k, v]) => (
            <option key={k} value={k}>{k} — {v.label.split(' (')[0]}</option>
          ))}
        </select>

        <span className="ml-auto text-xs text-gray-400">
          {loading ? 'Loading…' : `${orders.length} order${orders.length !== 1 ? 's' : ''}`}
        </span>
      </div>

      {/* ── main ── */}
      <main className="flex-1 overflow-auto p-4 space-y-4">

        {/* Create form */}
        {createType && (
          <CreateForm
            user={user}
            orderType={createType}
            onCreated={() => { setCreateType(null); fetchOrders(); }}
            onClose={() => setCreateType(null)}
          />
        )}

        {/* Orders list */}
        {loading ? (
          <div className="bg-white rounded-xl shadow border animate-pulse">
            <div className="h-12 bg-gray-100 rounded-t-xl" />
            {[...Array(4)].map((_, i) => (
              <div key={i} className="flex gap-4 px-4 py-4 border-t">
                <div className="h-4 bg-gray-100 rounded w-32" />
                <div className="h-4 bg-gray-100 rounded w-16" />
                <div className="h-4 bg-gray-100 rounded flex-1" />
                <div className="h-4 bg-gray-100 rounded w-24" />
              </div>
            ))}
          </div>
        ) : orders.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-24 text-gray-400">
            <PackageSearch size={42} strokeWidth={1.4} />
            <p className="text-sm">No sales orders yet. Use "New Sales Order" above.</p>
          </div>
        ) : (
          <div className="bg-white rounded-xl shadow border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-left border-b">
                  <th className="px-4 py-3 font-semibold text-gray-700 whitespace-nowrap">Order #</th>
                  <th className="px-4 py-3 font-semibold text-gray-700 whitespace-nowrap">Type</th>
                  <th className="px-4 py-3 font-semibold text-gray-700 whitespace-nowrap">Status</th>
                  <th className="px-4 py-3 font-semibold text-gray-700 whitespace-nowrap">Facility</th>
                  <th className="px-4 py-3 font-semibold text-gray-700">Customer</th>
                  <th className="px-4 py-3 font-semibold text-gray-700 whitespace-nowrap">Ship To Code</th>
                  <th className="px-4 py-3 font-semibold text-gray-700 whitespace-nowrap text-right">Items</th>
                  <th className="px-4 py-3 font-semibold text-gray-700 whitespace-nowrap text-right">Total</th>
                  <th className="px-4 py-3 font-semibold text-gray-700 whitespace-nowrap">Req. Date</th>
                  <th className="px-4 py-3 font-semibold text-gray-700 whitespace-nowrap">Created</th>
                  <th className="px-4 py-3 font-semibold text-gray-700 whitespace-nowrap">Actions</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o, i) => {
                  const isExpanded  = expandedId  === o.so_id;
                  const isUpdating  = updatingId  === o.so_id;
                  const total       = orderTotal(o.items);
                  const typeMeta    = ORDER_TYPE_META[o.order_type] || ORDER_TYPE_META['ZWSO'];
                  const facilityLbl = FACILITIES.find((f) => f.code === o.facility)?.label || o.facility;
                  const isCancelled = o.status === 'Cancelled';

                  return (
                    <>
                      <tr
                        key={o.so_id}
                        className={`border-t hover:bg-gray-50 transition ${i % 2 ? 'bg-gray-50/40' : 'bg-white'}`}
                      >
                        {/* Order # — click to expand */}
                        <td
                          className="px-4 py-3 font-mono font-medium text-gray-900 whitespace-nowrap cursor-pointer"
                          onClick={() => setExpandedId(isExpanded ? null : o.so_id)}
                        >
                          <span className="flex items-center gap-1">
                            {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                            {o.so_number}
                          </span>
                        </td>

                        <td className="px-4 py-3">
                          <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-bold ${typeMeta.color}`}>
                            {o.order_type}
                          </span>
                        </td>

                        <td className="px-4 py-3">
                          <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${STATUS_STYLE[o.status] || 'bg-gray-100 text-gray-600'}`}>
                            {o.status}
                          </span>
                        </td>

                        <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{facilityLbl}</td>
                        <td className="px-4 py-3 text-gray-800 font-medium">
                          {o.customer_name}
                          {o.customer_ref && <span className="ml-1 text-xs text-gray-400">({o.customer_ref})</span>}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-gray-500">
                          {o.ship_to_code || <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-4 py-3 text-right text-gray-600">
                          {Array.isArray(o.items) ? o.items.length : '—'}
                        </td>
                        <td className="px-4 py-3 text-right font-medium text-gray-900">
                          {total != null ? fmtMoney(total) : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-4 py-3 text-gray-500 whitespace-nowrap text-xs">
                          {fmtDate(o.requested_date) || <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">{o.created_fmt}</td>

                        {/* Row actions */}
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            <button
                              title="Update this order"
                              disabled={isCancelled}
                              onClick={() => setUpdatingId(isUpdating ? null : o.so_id)}
                              className={`px-2 py-1 text-xs rounded border transition
                                ${isUpdating
                                  ? 'bg-gray-800 text-white border-gray-800'
                                  : 'border-gray-300 hover:bg-gray-50 text-gray-600'}
                                disabled:opacity-40 disabled:cursor-not-allowed`}
                            >
                              Update
                            </button>
                            <button
                              title="Cancel this order"
                              disabled={isCancelled}
                              onClick={() => handleCancel(o)}
                              className="px-2 py-1 text-xs rounded border border-red-200 text-red-600 hover:bg-red-50 transition disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              Cancel
                            </button>
                          </div>
                        </td>
                      </tr>

                      {/* Inline Update form */}
                      {isUpdating && (
                        <tr key={`${o.so_id}-update`} className="border-t bg-amber-50/30">
                          <td colSpan={11} className="px-6 py-3">
                            <UpdatePanel
                              order={o}
                              user={user}
                              onUpdated={() => { setUpdatingId(null); fetchOrders(); }}
                              onClose={() => setUpdatingId(null)}
                            />
                          </td>
                        </tr>
                      )}

                      {/* Expanded detail view */}
                      {isExpanded && !isUpdating && (
                        <tr key={`${o.so_id}-detail`} className="border-t bg-blue-50/20">
                          <td colSpan={11} className="px-6 py-4">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

                              {/* Line items */}
                              <div>
                                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Line Items</div>
                                {Array.isArray(o.items) && o.items.length > 0 ? (
                                  <table className="w-full text-sm border rounded-lg overflow-hidden bg-white">
                                    <thead>
                                      <tr className="bg-gray-50 border-b text-left">
                                        <th className="px-3 py-2 font-semibold text-gray-600 w-32">SKU</th>
                                        <th className="px-3 py-2 font-semibold text-gray-600">Description</th>
                                        <th className="px-3 py-2 font-semibold text-gray-600 text-right w-16">Qty</th>
                                        <th className="px-3 py-2 font-semibold text-gray-600 text-right w-24">Unit Price</th>
                                        <th className="px-3 py-2 font-semibold text-gray-600 text-right w-24">Total</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {o.items.map((it) => {
                                        const lt = Number(it.quantity) > 0 && it.unit_price != null
                                          ? Number(it.quantity) * Number(it.unit_price) : null;
                                        return (
                                          <tr key={it.item_id} className="border-t">
                                            <td className="px-3 py-2 font-mono text-xs text-gray-900">{it.sku}</td>
                                            <td className="px-3 py-2 text-xs text-gray-600">{it.description || <span className="text-gray-300">—</span>}</td>
                                            <td className="px-3 py-2 text-right text-xs text-gray-700">{fmtQty(it.quantity)}</td>
                                            <td className="px-3 py-2 text-right text-xs text-gray-700">{it.unit_price != null ? fmtMoney(it.unit_price) : <span className="text-gray-300">—</span>}</td>
                                            <td className="px-3 py-2 text-right text-xs font-medium text-gray-900">{lt != null ? fmtMoney(lt) : <span className="text-gray-300">—</span>}</td>
                                          </tr>
                                        );
                                      })}
                                    </tbody>
                                    {total != null && (
                                      <tfoot>
                                        <tr className="border-t bg-gray-50">
                                          <td colSpan={4} className="px-3 py-2 text-right text-xs font-semibold text-gray-600">Order Total</td>
                                          <td className="px-3 py-2 text-right text-sm font-bold text-gray-900">{fmtMoney(total)}</td>
                                        </tr>
                                      </tfoot>
                                    )}
                                  </table>
                                ) : (
                                  <p className="text-xs text-gray-400">No line items.</p>
                                )}
                              </div>

                              {/* Order metadata */}
                              <div className="space-y-2 text-xs text-gray-700">
                                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Order Details</div>
                                {[
                                  ['Order Type',      `${o.order_type} — ${typeMeta.label}`],
                                  ['Ship To Address', o.ship_to],
                                  ['Ship To Code',    o.ship_to_code],
                                  ['Return Ref.',     o.return_reference],
                                  ['Notes',           o.notes],
                                  ['Created By',      o.created_by],
                                ].map(([label, val]) => val ? (
                                  <div key={label} className="flex gap-2">
                                    <span className="font-semibold text-gray-500 w-28 flex-shrink-0">{label}:</span>
                                    <span>{val}</span>
                                  </div>
                                ) : null)}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </main>

      <PelotonTabs />
    </div>
  );
}
