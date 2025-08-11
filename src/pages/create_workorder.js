// pages/create_workorder.js
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import BackButton from '../components/backbutton';
import CreateCustomerModal from '../components/CreateCustomerModal';

const DELIVERY_STATES = ['VIC', 'NSW', 'ACT', 'TAS', 'QLD', 'WA', 'SA'];
const LEAD_OPTIONS = ['1 Week', '2 Weeks', '3 Weeks', '4 Weeks', '5 Weeks'];

// Utility: add N weeks to today -> yyyy-mm-dd
function datePlusWeeks(weeks) {
  const d = new Date();
  d.setDate(d.getDate() + weeks * 7);
  return d.toISOString().slice(0, 10);
}
function parseWeeks(label) {
  const m = String(label || '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}
const ensureArray = (x) => (Array.isArray(x) ? x : (x && typeof x === 'object' ? [x] : []));

export default function CreateWorkorderPage() {
  const navigate = useNavigate();

  // ---------- modal visibility ----------
  const [showCustomerModal, setShowCustomerModal] = useState(false);

  // ---------- form state ----------
  const [form, setForm] = useState({
    invoice_id: '',
    customer_id: '',
    salesperson: '',                 // varchar(2) -> store user.id (2 chars)
    delivery_suburb: '',
    delivery_state: '',
    delivery_charged: '',
    lead_time: '',
    estimated_completion: '',
    notes: '',
    status: 'Work Ordered',
    outstanding_balance: '',         // numeric string in UI; API will cast
    items: [
      { product_id: '', quantity: '', condition: '', technician_id: '', status: 'Not in Workshop' }
    ]
  });

  // ---------- data sources ----------
  const [customerInput, setCustomerInput] = useState('');
  const [customers, setCustomers] = useState([]);
  const [products, setProducts] = useState([]);
  const [users, setUsers] = useState([]);            // all users -> salesperson dropdown (value=id, label=name)
  const [technicians, setTechnicians] = useState([]); // filtered for tech search
  const [loading, setLoading] = useState(true);

  // dropdown visibility controls
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false);
  const [openProductDropdownIdx, setOpenProductDropdownIdx] = useState(null);
  const [productSearch, setProductSearch] = useState({});   // { [rowIndex]: 'query' }
  const [openTechDropdownIdx, setOpenTechDropdownIdx] = useState(null);
  const [techSearch, setTechSearch] = useState({});         // { [rowIndex]: 'query' }

  const customerRef = useRef(null);

  // ---------- load data ----------
  const fetchData = async () => {
    try {
      const [cRes, pRes, uRes, tRes] = await Promise.all([
        fetch('/api/customers'),
        fetch('/api/products'),
        fetch('/api/users'),                    // all users for salesperson dropdown
        fetch('/api/users?access=technician'),  // technicians list
      ]);

      const [cData, pData, uData, tData] = await Promise.all([
        cRes.json().catch(() => []),
        pRes.json().catch(() => []),
        uRes.json().catch(() => []),
        tRes.json().catch(() => []),
      ]);

      if (!cRes.ok) throw new Error(cData?.error || 'Failed to load customers');
      if (!pRes.ok) throw new Error(pData?.error || 'Failed to load products');
      if (!uRes.ok) throw new Error(uData?.error || 'Failed to load users');
      if (!tRes.ok) throw new Error(tData?.error || 'Failed to load technicians');

      setCustomers(ensureArray(cData));
      setProducts(ensureArray(pData));
      setUsers(ensureArray(uData));
      setTechnicians(ensureArray(tData));

      // Prefill salesperson with logged-in user (by id) if present
      try {
        const stored = localStorage.getItem('user');
        if (stored) {
          const parsed = JSON.parse(stored);
          // If your stored user has .id (2-char), prefill; leave selectable
          if (parsed?.id) {
            setForm((f) => ({ ...f, salesperson: parsed.id }));
          }
        }
      } catch {}

      setLoading(false);
    } catch (err) {
      toast.error(err.message || 'Failed to load data');
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  // close dropdowns on outside click
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (customerRef.current && !customerRef.current.contains(e.target)) {
        setShowCustomerDropdown(false);
      }
      // close any product/tech dropdowns if clicking elsewhere
      if (!e.target.closest('.dropdown-portal')) {
        setOpenProductDropdownIdx(null);
        setOpenTechDropdownIdx(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // ---------- computed lists ----------
  const filteredCustomers = useMemo(() => {
    const q = customerInput.toLowerCase();
    return customers.filter((c) => `${c.id} ${c.name}`.toLowerCase().includes(q)).slice(0, 50);
  }, [customers, customerInput]);

  const productListForRow = (idx) => {
    const q = (productSearch[idx] || '').toLowerCase();
    return products
      .filter((p) => `${p.sku} ${p.name}`.toLowerCase().includes(q))
      .slice(0, 50);
  };

  const techListForRow = (idx) => {
    const q = (techSearch[idx] || '').toLowerCase();
    return technicians
      .filter((t) => `${t.id} ${t.name}`.toLowerCase().includes(q))
      .slice(0, 50);
  };

  // ---------- mutators ----------
  const addItemRow = () => {
    setForm((f) => ({
      ...f,
      items: [
        ...f.items,
        { product_id: '', quantity: '', condition: '', technician_id: '', status: 'Not in Workshop' },
      ],
    }));
  };

  const updateItem = (index, key, value) => {
    setForm((f) => {
      const updated = [...f.items];
      updated[index] = { ...updated[index], [key]: value };
      return { ...f, items: updated };
    });
  };

  // when lead_time changes, compute estimated_completion on client too
  const onLeadTimeChange = (leadLabel) => {
    const weeks = parseWeeks(leadLabel);
    const est = weeks ? datePlusWeeks(weeks) : '';
    setForm((f) => ({ ...f, lead_time: leadLabel, estimated_completion: est }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    // minimal client validation to match API requirements
    if (!form.invoice_id || !form.customer_id || !form.salesperson || !form.delivery_state || !form.lead_time || form.outstanding_balance === '') {
      toast.error('Please fill all required fields.');
      return;
    }

    const toastId = toast.loading('Creating workorder...');
    try {
      // ensure default item status
      const payload = {
        ...form,
        items: form.items.map((it) => ({
          ...it,
          status: it.status && String(it.status).trim() ? it.status : 'Not in Workshop',
          quantity: it.quantity === '' ? null : Number(it.quantity),
        })),
        delivery_charged: form.delivery_charged === '' ? null : Number(form.delivery_charged),
        outstanding_balance: Number(form.outstanding_balance),
      };

      // if user cleared estimated_completion, let server compute from lead_time
      if (!payload.estimated_completion) {
        delete payload.estimated_completion;
      }

      const res = await fetch('/api/workorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Creation failed');

      toast.success('Workorder created!', { id: toastId });
      navigate('/workorders');
    } catch (err) {
      toast.error(err.message || 'Failed to create', { id: toastId });
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-100 flex justify-center items-center">
        <div className="text-gray-600 text-lg font-medium">Loading form...</div>
      </div>
    );
  }

  return (
    <>
      <BackButton />

      {/* Create Customer Modal (controlled) */}
      {showCustomerModal && (
        <CreateCustomerModal
          onClose={() => setShowCustomerModal(false)}
          onSuccess={async () => {
            await fetchData();            // refresh the customer list
            setShowCustomerModal(false);  // close after success
          }}
        />
      )}

      <div className="min-h-screen bg-gray-100 flex justify-center items-center p-6">
        <div className="bg-white p-6 rounded shadow-md w-full max-w-4xl">
          <h2 className="text-xl font-bold mb-4 text-center">New Workorder</h2>

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Invoice ID (required) */}
            <input
              type="text"
              placeholder="Invoice ID *"
              className="border p-2 rounded w-full"
              value={form.invoice_id}
              onChange={(e) => setForm((f) => ({ ...f, invoice_id: e.target.value }))}
              required
            />

            {/* Customer Search (required) */}
            <div className="relative" ref={customerRef}>
              <input
                type="text"
                placeholder="Search customer... *"
                className="border p-2 rounded w-full"
                value={customerInput}
                onFocus={() => setShowCustomerDropdown(true)}
                onChange={(e) => { setCustomerInput(e.target.value); setShowCustomerDropdown(true); }}
                required
              />
              {showCustomerDropdown && (
                <div className="dropdown-portal absolute z-10 bg-white border rounded w-full max-h-48 overflow-y-auto shadow">
                  {filteredCustomers.map((c) => (
                    <div
                      key={c.id}
                      onMouseDown={() => {
                        setForm((f) => ({ ...f, customer_id: c.id }));
                        setCustomerInput(`${c.id} - ${c.name}`);
                        setShowCustomerDropdown(false);
                      }}
                      className="cursor-pointer px-2 py-1 hover:bg-gray-100"
                    >
                      {c.id} - {c.name}
                    </div>
                  ))}
                  {!filteredCustomers.length && (
                    <div className="px-2 py-2 text-gray-500 text-sm">No matches</div>
                  )}
                </div>
              )}
              <div
                className="text-sm mt-1 text-blue-600 hover:underline cursor-pointer"
                onClick={() => setShowCustomerModal(true)}
              >
                Can't find customer? Add one
              </div>
            </div>

            {/* Salesperson (all users; stores 2-char id) */}
            <select
              className="border p-2 rounded w-full"
              value={form.salesperson}
              onChange={(e) => setForm((f) => ({ ...f, salesperson: e.target.value }))}
              required
            >
              <option value="">Select Salesperson *</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.id} - {u.name}
                </option>
              ))}
            </select>

            {/* Delivery Suburb */}
            <input
              type="text"
              placeholder="Delivery Suburb"
              className="border p-2 rounded w-full"
              value={form.delivery_suburb}
              onChange={(e) => setForm((f) => ({ ...f, delivery_suburb: e.target.value }))}
            />

            {/* Delivery State (required) */}
            <select
              className="border p-2 rounded w-full"
              value={form.delivery_state}
              onChange={(e) => setForm((f) => ({ ...f, delivery_state: e.target.value }))}
              required
            >
              <option value="">Delivery State *</option>
              {DELIVERY_STATES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>

            {/* Delivery Charged */}
            <input
              type="number"
              step="0.01"
              placeholder="Delivery Charged ($)"
              className="border p-2 rounded w-full"
              value={form.delivery_charged}
              onChange={(e) => setForm((f) => ({ ...f, delivery_charged: e.target.value }))}
            />

            {/* Lead Time (required) + Estimated Completion (auto) */}
            <select
              className="border p-2 rounded w-full"
              value={form.lead_time}
              onChange={(e) => onLeadTimeChange(e.target.value)}
              required
            >
              <option value="">Lead Time *</option>
              {LEAD_OPTIONS.map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>

            <input
              type="date"
              className="border p-2 rounded w-full"
              value={form.estimated_completion}
              onChange={(e) => setForm((f) => ({ ...f, estimated_completion: e.target.value }))}
              placeholder="Estimated Completion"
            />

            {/* Outstanding Balance (required) */}
            <input
              type="number"
              step="0.01"
              placeholder="Outstanding Balance ($) *"
              className="border p-2 rounded w-full"
              value={form.outstanding_balance}
              onChange={(e) => setForm((f) => ({ ...f, outstanding_balance: e.target.value }))}
              required
            />

            {/* Items */}
            <div>
              <h3 className="font-semibold mb-2">Items</h3>

              {form.items.map((item, index) => (
                <div key={index} className="grid grid-cols-5 gap-2 mb-2">
                  {/* Product searchable */}
                  <div className="relative col-span-2">
                    <input
                      type="text"
                      className="border p-2 rounded w-full"
                      placeholder="Search product..."
                      value={
                        openProductDropdownIdx === index
                          ? (productSearch[index] ?? '')
                          : (item.product_id ? String(item.product_id) : '')
                      }
                      onFocus={() => { setOpenProductDropdownIdx(index); setProductSearch((s) => ({ ...s, [index]: '' })); }}
                      onChange={(e) => setProductSearch((s) => ({ ...s, [index]: e.target.value }))}
                    />
                    {openProductDropdownIdx === index && (
                      <div className="dropdown-portal absolute z-10 bg-white border rounded w-full max-h-48 overflow-y-auto shadow">
                        {productListForRow(index).map((p) => (
                          <div
                            key={p.sku}
                            className="cursor-pointer px-2 py-1 hover:bg-gray-100"
                            onMouseDown={() => {
                              updateItem(index, 'product_id', p.sku); // store SKU
                              setOpenProductDropdownIdx(null);
                            }}
                          >
                            {p.sku} — {p.name}
                          </div>
                        ))}
                        {!productListForRow(index).length && (
                          <div className="px-2 py-2 text-gray-500 text-sm">No matches</div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Qty */}
                  <input
                    type="number"
                    step="1"
                    placeholder="Qty"
                    className="border p-2 rounded"
                    value={item.quantity}
                    onChange={(e) => updateItem(index, 'quantity', e.target.value)}
                  />

                  {/* Condition (free text to match your enum values) */}
                  <input
                    type="text"
                    placeholder="Condition"
                    className="border p-2 rounded"
                    value={item.condition}
                    onChange={(e) => updateItem(index, 'condition', e.target.value)}
                  />

                  {/* Technician searchable (stores 2-char id) */}
                  <div className="relative">
                    <input
                      type="text"
                      className="border p-2 rounded w-full"
                      placeholder="Search technician..."
                      value={
                        openTechDropdownIdx === index
                          ? (techSearch[index] ?? '')
                          : (item.technician_id ? String(item.technician_id) : '')
                      }
                      onFocus={() => { setOpenTechDropdownIdx(index); setTechSearch((s) => ({ ...s, [index]: '' })); }}
                      onChange={(e) => setTechSearch((s) => ({ ...s, [index]: e.target.value }))}
                    />
                    {openTechDropdownIdx === index && (
                      <div className="dropdown-portal absolute z-10 bg-white border rounded w-full max-h-48 overflow-y-auto shadow">
                        {techListForRow(index).map((t) => (
                          <div
                            key={t.id}
                            className="cursor-pointer px-2 py-1 hover:bg-gray-100"
                            onMouseDown={() => {
                              updateItem(index, 'technician_id', t.id); // store 2-char id
                              setOpenTechDropdownIdx(null);
                            }}
                          >
                            {t.id} — {t.name}
                          </div>
                        ))}
                        {!techListForRow(index).length && (
                          <div className="px-2 py-2 text-gray-500 text-sm">No matches</div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}

              <button
                type="button"
                className="text-blue-600 mt-1"
                onClick={addItemRow}
              >
                + Add another product
              </button>
            </div>

            {/* Notes */}
            <textarea
              placeholder="Notes"
              className="border p-2 rounded w-full"
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            />

            <button
              type="submit"
              className="w-full bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600"
            >
              Save Workorder
            </button>
          </form>
        </div>
      </div>
    </>
  );
}
