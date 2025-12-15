import { useEffect, useMemo, useState, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { createPortal } from 'react-dom';
import toast from 'react-hot-toast';
import CreateCustomerModal from '../../../components/CreateCustomerModal';

/** Utils **/
function formatMoney(n) {
  const v = Number(n || 0);
  return v.toLocaleString(undefined, { style: 'currency', currency: 'AUD' });
}
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}
function toISODate(v) {
  if (!v) return '';
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s; // already YYYY-MM-DD
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

/** Stop row toggle helper for inner controls */
function stop(e){ e.stopPropagation(); }

/** Searchable product dropdown (local filter like Products page) **/
function ProductSelect({ products, value, onChange, placeholder = 'Search SKU, name, brand' }) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const anchorRef = useRef(null);
  const menuRef = useRef(null);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0, width: 0 });

  // Close on outside click / ESC; reposition on scroll/resize
  useEffect(() => {
    const onDoc = (e) => {
      if (menuRef.current && menuRef.current.contains(e.target)) return;
      if (anchorRef.current && !anchorRef.current.contains(e.target)) setOpen(false);
    };
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false); };
    const onReflow = () => {
      if (!anchorRef.current) return;
      const r = anchorRef.current.getBoundingClientRect();
      setMenuPos({ top: r.bottom + window.scrollY, left: r.left + window.scrollX, width: r.width });
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onEsc);
    window.addEventListener('resize', onReflow);
    window.addEventListener('scroll', onReflow, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onEsc);
      window.removeEventListener('resize', onReflow);
      window.removeEventListener('scroll', onReflow, true);
    };
  }, []);

  useEffect(() => {
    if (open && anchorRef.current) {
      const r = anchorRef.current.getBoundingClientRect();
      setMenuPos({ top: r.bottom + window.scrollY, left: r.left + window.scrollX, width: r.width });
    }
  }, [open]);

  const filtered = useMemo(() => {
    if (!Array.isArray(products)) return [];
    const t = term.trim().toLowerCase();
    const base = products.filter((p) => String(p.sku).toUpperCase() !== 'OTHER'); // hide sentinel
    if (!t) return base.slice(0, 50);
    const keywords = t.split(' ').filter(Boolean);
    return base.filter((p) => {
      const txt = `${p.sku} ${p.name} ${p.brand}`.toLowerCase();
      return keywords.every((k) => txt.includes(k));
    }).slice(0, 50);
  }, [products, term]);

  const current = useMemo(() => {
    return products?.find((p) => p.sku === value) || null;
  }, [products, value]);

  return (
    <>
      <div
        ref={anchorRef}
        className="flex items-center gap-2 border rounded px-2 py-1 bg-white cursor-text"
        onClick={(e)=>{ stop(e); setOpen(true); }}
      >
        <input
          className="flex-1 outline-none"
          placeholder={placeholder}
          value={open ? term : (current ? `${current.sku} — ${current.name}` : (value === 'OTHER' ? 'OTHER — Custom item' : ''))}
          onChange={(e) => setTerm(e.target.value)}
          onFocus={() => setOpen(true)}
          onClick={stop}
        />
        {value ? (
          <button
            type="button"
            onClick={(e) => { stop(e); onChange(''); setTerm(''); }}
            className="text-xs text-gray-500 hover:text-gray-700"
            title="Clear"
          >
            ✕
          </button>
        ) : null}
      </div>

      {open && createPortal(
        <div
          ref={menuRef}
          style={{
            position: 'fixed',
            top: `${menuPos.top}px`,
            left: `${menuPos.left}px`,
            width: `${menuPos.width}px`,
            zIndex: 1000
          }}
          className="max-h-64 overflow-auto rounded border bg-white shadow"
          onMouseDown={stop}
        >
          {filtered.length ? filtered.map((p) => (
            <div
              key={p.sku}
              className="px-2 py-1 text-sm hover:bg-gray-100 cursor-pointer"
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onChange(p.sku);
                setOpen(false);
                setTerm('');
              }}
              title={`${p.name} (${p.brand || '—'})`}
            >
              <div className="font-mono">{p.sku}</div>
              <div className="text-xs text-gray-600 truncate">
                {p.name}{p.brand ? ` — ${p.brand}` : ''}
              </div>
            </div>
          )) : (
            <div className="px-2 py-2 text-sm text-gray-500">No matches.</div>
          )}

          <div className="border-t my-1" />

          <div
            className="px-2 py-1 text-sm hover:bg-gray-100 cursor-pointer"
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onChange('OTHER');
              setOpen(false);
              setTerm('');
            }}
          >
            OTHER — Custom item
          </div>
        </div>,
        document.body
      )}
    </>
  );
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
  const [users, setUsers] = useState([]);           // for salesperson dropdown
  const [editEstimated, setEditEstimated] = useState(false);
  const [editSalesperson, setEditSalesperson] = useState(false);
  const [estimatedCompletion, setEstimatedCompletion] = useState('');
  const [salesperson, setSalesperson] = useState('');

  // important flag
  const [important, setImportant] = useState(false);

  // products for dropdown
  const [products, setProducts] = useState([]);

  // pending new rows for add (supports custom + selling price for superadmin)
  const [pendingNewItems, setPendingNewItems] = useState([]);

  // deleting existing rows
  const [toDelete, setToDelete] = useState([]);

  // workorder status (for top-level WO)
  const [woStatus, setWoStatus] = useState('');

  // which existing row is expanded for Serial Number editing
  const [expandedId, setExpandedId] = useState(null);

  // user object
  const [user, setUser] = useState(null);
  const isSuperadmin = user?.access === 'superadmin';
  const isGS = user?.id === 'GS';

  const userId = useMemo(() => {
    try {
      const u = JSON.parse(localStorage.getItem('user') || '{}');
      return u?.id || '';
    } catch {
      return '';
    }
  }, []);

  useEffect(() => {
    try {
      const u = JSON.parse(localStorage.getItem('user') || 'null');
      setUser(u);
    } catch {
      setUser(null);
    }
  }, []);

  const handleBack = () => {
    if (window.history.length > 1) navigate(-1);
    else navigate('/delivery_operations');
  };

  const [showCustomerModal, setShowCustomerModal] = useState(false);
  const [customerInitial, setCustomerInitial] = useState(null);

  const openCustomerModal = async () => {
    const cid = wo.customer_id;
    if (cid) {
      try {
        const r = await fetch(`/api/customers?id=${encodeURIComponent(cid)}`);
        const data = await r.json();
        if (!r.ok) throw new Error(data?.error || 'Failed to load customer');
        setCustomerInitial(data);
      } catch (e) {
        setCustomerInitial({ name: wo.customer_name || '' });
      }
    } else {
      setCustomerInitial({ name: wo.customer_name || '' });
    }
    setShowCustomerModal(true);
  };

  // Load technicians & products once
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/users?access=technician');
        const data = await r.json();
        if (r.ok) setTechs(Array.isArray(data) ? data : []);
      } catch {}

      try {
        const res = await fetch('/api/products');
        const data = await res.json();
        if (res.ok) setProducts(Array.isArray(data) ? data : []);
      } catch {}

      try {
        const u = await fetch('/api/users');
        const uData = await u.json();
        if (u.ok) setUsers(Array.isArray(uData) ? uData : []);
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
        const r = await fetch(`/api/workorder?id=${encodeURIComponent(id)}`, {
          headers: { 'X-User-Id': userId || '' }
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data?.error || 'Failed to load workorder');

        setWo(data);
        setItems((data.items || []).filter(it => it.status !== 'Canceled'));
        setNotes(data.notes || '');
        setDeliveryCharged(data.delivery_charged ?? '');
        setOutstandingBalance(data.outstanding_balance ?? '');
        setActivity(data.activity || []);
        setImportant(!!data.important_flag);
        setWoStatus(data.status || '');
        setEstimatedCompletion(toISODate(data.estimated_completion));
        setSalesperson(data.salesperson || '');
      } catch (e) {
        toast.error(e.message || 'Failed to load');
      } finally {
        setLoading(false);
      }
    })();
  }, [id, navigate, userId]);

  // Update local existing item field
  const setItemField = (idx, key, val) => {
    setItems((arr) => {
      const copy = [...arr];
      copy[idx] = { ...copy[idx], [key]: val };
      return copy;
    });
  };

  // Update pending new item field
  const setPendingField = (tempId, key, val) => {
    setPendingNewItems((arr) => arr.map((row) => row.tempId === tempId ? { ...row, [key]: val } : row));
  };

  const handleAddPendingRow = () => {
    setPendingNewItems((arr) => [
      ...arr,
      {
        tempId: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()),
        product_id: '',
        quantity: 1,
        condition: 'New',
        technician_id: '',
        is_custom: false,
        custom_description: '',
        custom_unit_price: '',
        item_sn: '',
        selling_price: '',
      }
    ]);
  };

  const handleRemovePendingRow = (tempId) => {
    setPendingNewItems((arr) => arr.filter((r) => r.tempId !== tempId));
  };

  const toggleDelete = (workorder_items_id) => {
    setToDelete((arr) => arr.includes(workorder_items_id)
      ? arr.filter((x) => x !== workorder_items_id)
      : [...arr, workorder_items_id]
    );
  };

  const markEcommerceChecked = async () => {
    if (!wo || !isGS) return;

    const toastId = toast.loading('Marking ecommerce checked...');
    try {
      const r = await fetch(`/api/workorder?id=${encodeURIComponent(wo.workorder_id)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': userId || '',
        },
        body: JSON.stringify({ ecommerce: true }),
      });

      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data?.error || 'Failed to update ecommerce flag');

      setWo(data);
      toast.success('Ecommerce checked off', { id: toastId });
    } catch (e) {
      toast.error(e.message || 'Failed', { id: toastId });
    }
  };

  const handleSave = async () => {
    if (!wo) return;

    // Validate pending rows (catalog + custom)
    for (const row of pendingNewItems) {
      if (row.is_custom) {
        if (!String(row.custom_description || '').trim()) {
          toast.error('Custom items require a description.');
          return;
        }
        if (!row.condition) row.condition = 'NA';
        if (!row.product_id) row.product_id = 'OTHER';
      } else {
        if (!row.product_id) {
          toast.error('Please select a product for all new rows.');
          return;
        }
      }

      if (!row.quantity || Number(row.quantity) <= 0) {
        toast.error('Quantity must be at least 1.');
        return;
      }

      if (!row.technician_id || String(row.technician_id).trim() === '') {
        toast.error('Please select a technician for all new rows.');
        return;
      }

      if (row.custom_unit_price !== '' && Number.isNaN(Number(row.custom_unit_price))) {
        toast.error('Unit price must be a number.');
        return;
      }

      if (isSuperadmin && row.selling_price !== '' && Number.isNaN(Number(row.selling_price))) {
        toast.error('Selling price must be a number.');
        return;
      }
    }

    setSaving(true);
    const toastId = toast.loading('Saving changes...');
    try {
      const payload = {
        status: woStatus || wo.status,
        notes,
        delivery_charged: deliveryCharged === '' ? null : Number(deliveryCharged),
        outstanding_balance:
          outstandingBalance === ''
            ? wo.outstanding_balance
            : Number(outstandingBalance),
        important_flag: important,
        estimated_completion: estimatedCompletion || wo.estimated_completion,
        salesperson: salesperson || wo.salesperson,

        items: items.map((it) => ({
          workorder_items_id: it.workorder_items_id,
          status: it.status,
          technician_id: it.technician_id,
          item_sn: it.item_sn ?? null,
          ...(isSuperadmin ? { selling_price: it.selling_price ?? null } : {}),
        })),

        add_items: pendingNewItems.map((it) => ({
          product_id: it.is_custom ? 'OTHER' : it.product_id,
          quantity: Number(it.quantity) || 1,
          condition: it.is_custom ? (it.condition || 'NA') : it.condition,
          technician_id: it.technician_id || null,
          status: 'Not in Workshop',
          item_sn: (it.item_sn == null || String(it.item_sn).trim() === '') ? null : String(it.item_sn).trim(),

          is_custom: !!it.is_custom,
          custom_description: it.is_custom ? (it.custom_description || null) : null,
          custom_unit_price: it.is_custom && it.custom_unit_price !== '' && it.custom_unit_price != null
            ? Number(it.custom_unit_price)
            : null,

          ...(isSuperadmin ? {
            selling_price: it.selling_price !== '' && it.selling_price != null ? Number(it.selling_price) : null
          } : {}),
        })),

        delete_item_ids: toDelete
      };

      const r = await fetch(`/api/workorder?id=${encodeURIComponent(wo.workorder_id)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': userId || '',
        },
        body: JSON.stringify(payload),
      });

      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = String(data?.error || '').trim();
        if(/insufficient\s+stock/i.test(msg)){
          toast.error(msg.replace(/^Error:\s*/, ''), {id: toastId});
          return;
        }
        throw new Error(msg || 'Save failed');
      }

      // Refresh from response (API returns updated resource)
      setWo(data);
      setItems((data.items || []).filter(it => it.status !== 'Canceled'));
      setNotes(data.notes || '');
      setDeliveryCharged(data.delivery_charged ?? '');
      setOutstandingBalance(data.outstanding_balance ?? '');
      setActivity(data.activity || []);
      setImportant(!!data.important_flag);
      setWoStatus(data.status || woStatus);

      // Clear queued adds/deletes
      setPendingNewItems([]);
      setToDelete([]);

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
          <button onClick={handleBack} className="text-blue-600 underline">← Back</button>
        </div>
        <div className="text-red-600">Work order not found.</div>
      </div>
    );
  }

  const pendingAdds = pendingNewItems.length;
  const pendingDeletes = toDelete.length;
  const colCount = 7 + (isSuperadmin ? 1 : 0); // Qty, SKU, Name, Condition, Tech, Status, Actions (+ Selling Price)

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

          <div className="flex items-center gap-2">
            <button
              onClick={() => setImportant((v) => !v)}
              className={`rounded-md border px-3 py-1 text-sm hover:bg-gray-50 ${important ? 'text-amber-600 border-amber-300' : ''}`}
              title={important ? 'Unmark as important' : 'Mark as important'}
            >
              {important ? '★ Important' : '☆ Mark important'}
            </button>

            {isGS && (
              <button
                onClick={markEcommerceChecked}
                disabled={wo?.ecommerce === true}
                className={`rounded-md border px-3 py-1 text-sm hover:bg-gray-50 disabled:opacity-60 ${
                  wo?.ecommerce === true ? 'text-green-700 border-green-200 bg-green-50' : ''
                }`}
                title={wo?.ecommerce === true ? 'Already checked off' : 'Mark this workorder as checked'}
              >
                {wo?.ecommerce === true ? 'Ecommerce ✓' : 'Check Ecommerce'}
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-4">
        {/* Top summary */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
          <button
            type="button"
            onClick={openCustomerModal}
            className="rounded-lg border bg-white p-3 text-left hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-400"
            title="View / Edit customer contact"
          >
            <div className="text-xs text-gray-500 flex items-center justify-between">
              <span>Customer</span>
              <span className="text-[11px] text-blue-600 underline">View / Edit</span>
            </div>
            <div className="font-semibold">{wo.customer_name}</div>
          </button>

          <div className="rounded-lg border bg-white p-3">
            <div className="text-xs text-gray-500">Workorder Date:</div>
            <div className="font-semibold">{fmtDate(wo.date_created)}</div>
          </div>

          <div
            className="rounded-lg border bg-white p-3 cursor-pointer"
            onClick={() => setEditEstimated(true)}
            title="Click to edit"
          >
            <div className="text-xs text-gray-500">Expected Completion Date:</div>
            {!editEstimated ? (
              <div className="font-semibold">{fmtDate(estimatedCompletion || wo.estimated_completion)}</div>
            ) : (
              <input
                type="date"
                className="mt-1 border rounded px-2 py-1"
                value={estimatedCompletion}
                onChange={(e) => setEstimatedCompletion(e.target.value)}
                onClick={(e)=>e.stopPropagation()}
              />
            )}
          </div>

          <div
            className="rounded-lg border bg-white p-3 cursor-pointer"
            onClick={() => setEditSalesperson(true)}
            title="Click to change salesperson"
          >
            <div className="text-xs text-gray-500">Salesperson:</div>
            {!editSalesperson ? (
              <div className="font-semibold">{salesperson || wo.salesperson}</div>
            ) : (
              <select
                className="mt-1 border rounded px-2 py-1"
                value={salesperson || ''}
                onChange={(e) => setSalesperson(e.target.value)}
                onClick={(e)=>e.stopPropagation()}
              >
                <option value="" disabled>Select Salesperson</option>
                {users.map((u)=>(
                  <option key={u.id} value={u.id}>{u.id} — {u.name}</option>
                ))}
              </select>
            )}
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
          <div className="border-b p-4 flex items-center justify-between">
            <div className="text-center font-semibold flex-1">Items</div>
            <div className="flex-shrink-0">
              <button
                onClick={handleAddPendingRow}
                className="rounded-md border px-3 py-1 text-sm hover:bg-gray-50"
              >
                + Add Product
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-100">
                <tr className="text-left text-xs font-semibold uppercase tracking-wider text-gray-600">
                  <th className="px-4 py-3 w-10">Qty</th>
                  <th className="px-4 py-3 w-28">SKU</th>
                  <th className="px-4 py-3">Equipment Name</th>
                  <th className="px-4 py-3 w-20">Condition</th>
                  <th className="px-4 py-3 w-40">Tech Assigned</th>
                  <th className="px-4 py-3 w-48">Status</th>
                  {isSuperadmin && (
                    <th className="px-4 py-3 w-40">Selling Price</th>
                  )}
                  <th className="px-4 py-3 w-28">Actions</th>
                </tr>
              </thead>

              <tbody className="divide-y divide-gray-100">
                {/* Existing items */}
                {items
                  .filter(it => it.status !== 'Canceled')
                  .map((it, idx) => {
                    const isExpanded = expandedId === it.workorder_items_id;
                    const isRemoved = toDelete.includes(it.workorder_items_id);

                    return (
                      <>
                        <tr
                          className={`${idx % 2 ? 'bg-gray-50' : 'bg-white'} ${isRemoved ? 'opacity-60 line-through' : ''} cursor-pointer`}
                          onClick={() => setExpandedId(isExpanded ? null : it.workorder_items_id)}
                          title="Click row to edit Serial Number"
                        >
                          <td className="px-4 py-3 text-sm">{Number(it.quantity)}</td>
                          <td className="px-4 py-3 text-sm font-mono">{it.product_id}</td>
                          <td className="px-4 py-3 text-sm">{it.product_name}</td>
                          <td className="px-4 py-3 text-sm">{it.condition}</td>

                          <td className="px-4 py-3 text-sm" onClick={stop}>
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

                          <td className="px-4 py-3 text-sm" onClick={stop}>
                            <select
                              className="border rounded px-2 py-1 w-full"
                              value={it.status}
                              onChange={(e) => setItemField(idx, 'status', e.target.value)}
                            >
                              <option>Not in Workshop</option>
                              <option>In Workshop</option>
                              <option>Completed</option>
                              <option>Canceled</option>
                            </select>
                          </td>

                          {isSuperadmin && (
                            <td className="px-4 py-3 text-sm" onClick={stop}>
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                className="border rounded px-2 py-1 w-full"
                                value={it.selling_price ?? ''}
                                placeholder="e.g. 199.00"
                                onChange={(e) => setItemField(idx, 'selling_price', e.target.value)}
                              />
                            </td>
                          )}

                          <td className="px-4 py-3 text-sm" onClick={stop}>
                            <button
                              type="button"
                              className={`rounded border px-2 py-1 text-xs hover:bg-gray-50 ${isRemoved ? 'bg-red-50 border-red-200 text-red-700' : ''}`}
                              onClick={() => toggleDelete(it.workorder_items_id)}
                              title="Marks item as Canceled on Save"
                            >
                              {isRemoved ? 'Undo' : 'Remove'}
                            </button>
                          </td>
                        </tr>

                        {/* Inline expandable panel for Serial Number */}
                        {isExpanded && (
                          <tr className={`${idx % 2 ? 'bg-gray-50' : 'bg-white'}`}>
                            <td colSpan={colCount} className="px-6 pb-4">
                              <div className="mt-1 border rounded-md p-3 bg-gray-50">
                                <div className="text-sm font-medium mb-2">Serial Number</div>
                                <input
                                  type="text"
                                  className="border rounded px-2 py-1 w-full"
                                  value={it.item_sn ?? ''}
                                  placeholder="Enter serial number"
                                  onChange={(e) => setItemField(idx, 'item_sn', e.target.value)}
                                  onClick={stop}
                                />
                                <div className="text-xs text-gray-600 mt-2">
                                  Tip: Click the row to collapse/expand. Changes are saved with the main “Save” button.
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}

                {/* Pending new rows */}
                {pendingNewItems.map((row) => {
                  const selected = products.find((p) => p.sku === row.product_id);
                  const isCustom = !!row.is_custom || row.product_id === 'OTHER';

                  return (
                    <tr key={row.tempId} className="bg-white align-top">
                      <td className="px-4 py-3 text-sm">
                        <input
                          type="number"
                          min="1"
                          step="1"
                          className="border rounded px-2 py-1 w-14"
                          value={row.quantity}
                          onChange={(e) => setPendingField(row.tempId, 'quantity', e.target.value)}
                          onClick={stop}
                        />
                      </td>

                      <td className="px-4 py-3 text-sm w-48" onClick={stop}>
                        <ProductSelect
                          products={products}
                          value={row.product_id}
                          onChange={(sku) => {
                            if (sku === 'OTHER') {
                              setPendingField(row.tempId, 'product_id', 'OTHER');
                              setPendingField(row.tempId, 'is_custom', true);
                              if (!row.condition) setPendingField(row.tempId, 'condition', 'NA');
                            } else {
                              setPendingField(row.tempId, 'product_id', sku);
                              setPendingField(row.tempId, 'is_custom', false);
                            }
                          }}
                        />
                      </td>

                      <td className="px-4 py-3 text-sm text-gray-700">
                        {!isCustom ? (
                          selected ? selected.name : <span className="text-gray-400">—</span>
                        ) : (
                          <div className="space-y-2">
                            <input
                              type="text"
                              className="border rounded px-2 py-1 w-full"
                              placeholder="Custom description *"
                              value={row.custom_description || ''}
                              onChange={(e) => setPendingField(row.tempId, 'custom_description', e.target.value)}
                            />
                            <input
                              type="number"
                              step="0.01"
                              className="border rounded px-2 py-1 w-full"
                              placeholder="Unit price (optional)"
                              value={row.custom_unit_price || ''}
                              onChange={(e) => setPendingField(row.tempId, 'custom_unit_price', e.target.value)}
                            />
                            <div className="text-xs text-gray-500">SKU: OTHER (custom item)</div>
                            <button
                              type="button"
                              className="mt-1 rounded border px-2 py-1 text-xs hover:bg-gray-50"
                              onClick={() => {
                                setPendingField(row.tempId, 'is_custom', false);
                                setPendingField(row.tempId, 'product_id', '');
                                setPendingField(row.tempId, 'custom_description', '');
                                setPendingField(row.tempId, 'custom_unit_price', '');
                              }}
                            >
                              Use Catalog
                            </button>
                          </div>
                        )}
                      </td>

                      <td className="px-4 py-3 text-sm" onClick={stop}>
                        <select
                          className="border rounded px-2 py-1 w-full"
                          value={row.condition}
                          onChange={(e) => setPendingField(row.tempId, 'condition', e.target.value)}
                        >
                          <option>New</option>
                          <option>Reco</option>
                          <option>AT</option>
                          <option>CS</option>
                          <option>CCG</option>
                          <option>NA</option>
                        </select>
                      </td>

                      <td className="px-4 py-3 text-sm" onClick={stop}>
                        <select
                          className="border rounded px-2 py-1 w-full"
                          value={row.technician_id || ''}
                          onChange={(e) => setPendingField(row.tempId, 'technician_id', e.target.value)}
                        >
                          <option value="" disabled>Select tech</option>
                          {techs.map((t) => (
                            <option key={t.id} value={t.id}>{t.id} — {t.name}</option>
                          ))}
                        </select>
                      </td>

                      <td className="px-4 py-3 text-sm text-gray-500">Not in Workshop</td>

                      {isSuperadmin && (
                        <td className="px-4 py-3 text-sm" onClick={stop}>
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            className="border rounded px-2 py-1 w-full"
                            value={row.selling_price ?? ''}
                            placeholder="e.g. 199.00"
                            onChange={(e) => setPendingField(row.tempId, 'selling_price', e.target.value)}
                          />
                        </td>
                      )}

                      <td className="px-4 py-3 text-sm">
                        <button
                          onClick={() => handleRemovePendingRow(row.tempId)}
                          className="rounded border px-2 py-1 text-xs hover:bg-gray-50"
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  );
                })}

                {!items.length && !pendingNewItems.length && (
                  <tr><td className="px-4 py-4 text-center text-sm text-gray-500" colSpan={colCount}>No items.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Pending changes hint */}
        {(pendingAdds || pendingDeletes) ? (
          <div className="mt-3 text-sm text-gray-700">
            {pendingAdds ? <span className="mr-4">• {pendingAdds} item(s) queued to add</span> : null}
            {pendingDeletes ? <span>• {pendingDeletes} item(s) marked for remove</span> : null}
          </div>
        ) : null}

        {/* Activity Log + Notes/Charges */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-6">
          <div className="md:col-span-2 rounded-xl border bg-white p-3">
            <div className="font-semibold mb-2 text-center">Activity Log</div>
            <div className="h-72 overflow-y-auto border rounded p-2 text-sm font-mono bg-gray-50">
              {activity.length ? activity.map((l) => {
                const isNote = l.event_type === 'NOTE_ADDED' && (l.notes_log || '').trim();
                if (isNote) {
                  return (
                    <div key={l.id}>
                      {`${l.ts}   NOTE_ADDED - ${l.user_id}`}{" "}
                      <span className="italic text-gray-700">"{l.notes_log}"</span>
                    </div>
                  );
                }

                const base = l.workorder_items_id
                  ? `${l.ts}   ${l.product_name ?? '(Item)'} — ${l.event_type}${l.current_item_status ? `: ${l.current_item_status}` : ''} - ${l.user_id}`
                  : `${l.ts}   ${l.event_type} - ${l.user_id}`;
                return <div key={l.id}>{base}</div>;
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

            {String(woStatus) === 'Completed' && (
              <div className="mt-4 border rounded p-3 bg-amber-50">
                <div className="text-sm font-medium mb-2">Workorder Status</div>
                <div className="flex items-center gap-2">
                  <select
                    className="border rounded px-2 py-1"
                    value={woStatus}
                    onChange={(e) => setWoStatus(e.target.value)}
                  >
                    <option value="Completed">Completed</option>
                    <option value="Work Ordered">Work Ordered</option>
                  </select>
                  <span className="text-xs text-gray-600">
                    Change back to <span className="font-semibold">Work Ordered</span> if further work is needed.
                  </span>
                </div>
              </div>
            )}

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

        {showCustomerModal && (
          <CreateCustomerModal
            mode={wo.customer_id ? 'edit' : 'create'}
            customerId={wo.customer_id || null}
            initialForm={customerInitial}
            onClose={() => setShowCustomerModal(false)}
            onSuccess={(updated) => {
              if (updated?.name) {
                setWo((prev) => ({ ...prev, customer_name: updated.name, customer_id: updated.id ?? prev.customer_id }));
              }
              setShowCustomerModal(false);
            }}
          />
        )}
      </main>
    </div>
  );
}
