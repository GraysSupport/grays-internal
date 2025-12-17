// /pages/delivery_operations/collections/[id].js
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import BackButton from '../../../components/backbutton';
import HomeButton from '../../../components/homebutton';
import CreateProductModal from '../../../components/CreateProductModal';

const ensureArray = (x) => (Array.isArray(x) ? x : (x && typeof x === 'object' ? [x] : []));

function money(n) {
  const v = Number(n || 0);
  return v.toLocaleString(undefined, { style: 'currency', currency: 'AUD' });
}

function formatAUSDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const dtf = new Intl.DateTimeFormat('en-AU', {
    weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric'
  });
  const parts = dtf.formatToParts(d);
  const bag = {};
  for (const p of parts) bag[p.type] = p.value;
  return `${bag.weekday}, ${bag.day}-${bag.month}-${bag.year}`;
}

const isOther = (sku) => String(sku || '').toUpperCase() === 'OTHER';

export default function CollectionDetailPage() {
  const navigate = useNavigate();
  const { id } = useParams();

  // Logged in user (for superadmin UI + x-user-id header)
  const me = useMemo(() => {
    try { return JSON.parse(localStorage.getItem('user') || 'null'); }
    catch { return null; }
  }, []);
  const isSuperadmin = String(me?.access || '').toLowerCase() === 'superadmin';
  const userIdHeader = me?.id != null ? String(me.id) : '';

  // States
  const [loading, setLoading] = useState(true);
  const [collection, setCollection] = useState(null);
  const [items, setItems] = useState([]);
  const [products, setProducts] = useState([]);

  const [form, setForm] = useState({ product_sku: '', quantity: '', purchase_price: '', custom_description: '' });
  const [openProductDropdown, setOpenProductDropdown] = useState(false);
  const [productSearch, setProductSearch] = useState('');
  const [showCreateProductModal, setShowCreateProductModal] = useState(false);
  const productInputRef = useRef(null);
  const productDropdownRef = useRef(null);

  const productBySku = useMemo(() => {
    const m = new Map();
    products.forEach((p) => m.set(String(p.sku).toUpperCase(), p));
    return m;
  }, [products]);

  // Extraction state linked to DB fields
  const [est, setEst] = useState(0);
  const [act, setAct] = useState(0);

  // ----------------- Load -----------------
  useEffect(() => {
    const stored = localStorage.getItem('user');
    if (!stored) {
      navigate('/');
      return;
    }
    fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, navigate]);

  async function fetchAll() {
    try {
      setLoading(true);
      const [collRes, prodRes] = await Promise.all([
        fetch(`/api/collections?id=${id}&include=items`),
        fetch('/api/products'),
      ]);
      const [collData, prodData] = await Promise.all([
        collRes.json().catch(() => null),
        prodRes.json().catch(() => []),
      ]);
      if (!collRes.ok) throw new Error(collData?.error || 'Failed to load collection');
      if (!prodRes.ok) throw new Error(prodData?.error || 'Failed to load products');

      setCollection(collData.collection || null);
      setItems(ensureArray(collData.items || []).map((it) => ({
        ...it,
        custom_description: it.custom_description || '',
      })));
      setProducts(ensureArray(prodData));
      setEst(collData.collection?.est_extraction || 0);
      setAct(collData.collection?.act_extraction || 0);
    } catch (err) {
      toast.error(err.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  // ---- NEW: refresh only the products list (avoid wiping local items/form) ----
  async function fetchProductsOnly() {
    try {
      const res = await fetch('/api/products');
      const data = await res.json().catch(() => []);
      if (!res.ok) throw new Error(data?.error || 'Failed to load products');
      setProducts(ensureArray(data));
    } catch (err) {
      toast.error(err.message || 'Failed to load products');
    }
  }

  // ----------------- Product Dropdown -----------------
  const filteredProducts = useMemo(() => {
    const q = productSearch.trim().toLowerCase();
    const list = products; // include OTHER
    if (!q) return list.slice(0, 50);
    const parts = q.split(' ').filter(Boolean);
    return list.filter((p) => {
      const text = `${p.sku} ${p.name} ${p.brand || ''}`.toLowerCase();
      return parts.every((k) => text.includes(k));
    });
  }, [products, productSearch]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleDocMouseDown(e) {
      if (!openProductDropdown) return;
      const root = productDropdownRef.current;
      if (root && !root.contains(e.target)) {
        setOpenProductDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleDocMouseDown);
    return () => document.removeEventListener('mousedown', handleDocMouseDown);
  }, [openProductDropdown]);

  // ----------------- Local Item Functions -----------------
  function addItem() {
    const sku = String(form.product_sku || '').trim().toUpperCase();
    const qty = Number(form.quantity || 0);
    const price = Number(form.purchase_price || 0);

    if (!sku) return toast.error('Select a product first');
    if (qty <= 0) return toast.error('Quantity must be >= 1');
    if (price < 0) return toast.error('Price cannot be negative');
    if (isOther(sku) && !String(form.custom_description || '').trim()) {
      return toast.error('Please enter a description for OTHER item.');
    }

    const prod = productBySku.get(sku) || {};
    const newLocal = {
      _tempid: `${Date.now()}-${Math.random()}`,
      product_sku: sku,
      name: prod.name || (sku === 'OTHER' ? 'Other (custom)' : ''),
      brand: prod.brand || '',
      quantity: qty,
      purchase_price: price,
      custom_description: isOther(sku) ? String(form.custom_description || '').trim() : '',
    };
    setItems((prev) => [...prev, newLocal]);
    setForm({ product_sku: '', quantity: '', purchase_price: '', custom_description: '' });
    setOpenProductDropdown(false);
    setTimeout(() => productInputRef.current?.focus(), 0);
  }

  function removeItem(idOrTemp) {
    setItems((prev) =>
      prev.filter(
        (it) =>
          it.collection_items_id !== idOrTemp &&
          it._tempid !== idOrTemp
      )
    );
  }

  // ----------------- Live extraction allocation (UI only) -----------------
  const totalQtyExclOther = useMemo(
    () => items.filter((it) => !isOther(it.product_sku))
      .reduce((a, b) => a + Number(b.quantity || 0), 0),
    [items]
  );

  const diff = Number(act || 0) - Number(est || 0);
  const perUnitAdj = totalQtyExclOther > 0 ? diff / totalQtyExclOther : 0;

  const totalWithExtraction = useMemo(() => {
    return items.reduce((sum, it) => {
      const base = Number(it.purchase_price || 0);
      const qty = Number(it.quantity || 0);
      const perUnit = isOther(it.product_sku) ? 0 : perUnitAdj;
      const eff = base + perUnit;
      return sum + qty * eff;
    }, 0);
  }, [items, perUnitAdj]);

  if (loading) return <div className="p-4">Loading…</div>;
  if (!collection) return <div className="p-4">Collection not found.</div>;

  const formattedDate = formatAUSDate(collection.collection_date);

  const canApply = isSuperadmin && !collection.inventory_applied_at;

  return (
    <>
      <div className="fixed top-4 left-6 z-50 flex gap-2">
        <HomeButton />
        <BackButton />
        <CreateProductModal
          isOpen={showCreateProductModal}
          onClose={() => setShowCreateProductModal(false)}
          onCreated={async () => {
            await fetchProductsOnly();
            setShowCreateProductModal(false);
            setOpenProductDropdown(true);
            setTimeout(() => productInputRef.current?.focus(), 0);
          }}
        />
      </div>

      <div className="min-h-screen bg-gray-100 flex justify-center items-start p-6">
        <div className="bg-white p-6 rounded shadow-md w-full max-w-6xl space-y-6">
          <h2 className="text-xl font-bold text-center">Collection #{collection.id}</h2>

          {/* Collection details card */}
          <div className="grid md:grid-cols-3 gap-4 border rounded p-4 bg-gray-50">
            <div>
              <div className="text-xs uppercase text-gray-500">Name</div>
              <div className="font-medium">{collection.name}</div>
            </div>
            <div>
              <div className="text-xs uppercase text-gray-500">Suburb / State</div>
              <div className="font-medium">
                {collection.suburb || '—'}{collection.state ? `, ${collection.state}` : ''}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase text-gray-500">Carrier</div>
              <div className="font-medium">{collection.removalist_name || '—'}</div>
            </div>
            <div>
              <div className="text-xs uppercase text-gray-500">Collection Date</div>
              <div className="font-medium">{formattedDate}</div>
            </div>
            <div>
              <div className="text-xs uppercase text-gray-500">Status</div>
              <div className="font-medium">{collection.status}</div>
            </div>

            <div>
              <div className="text-xs uppercase text-gray-500">Inventory Applied</div>
              <div className="font-medium">
                {collection.inventory_applied_at
                  ? new Date(collection.inventory_applied_at).toLocaleString()
                  : 'No'}
              </div>
            </div>

            <div className="md:col-span-3">
              <div className="text-xs uppercase text-gray-500">Notes</div>
              <div className="font-medium whitespace-pre-wrap">{collection.notes || '—'}</div>
            </div>
          </div>

          {/* Extraction inputs */}
          <div className="grid sm:grid-cols-4 gap-3">
            <div>
              <label className="block text-xs uppercase text-gray-600 mb-1">Estimated Extraction</label>
              <input
                type="number"
                step="0.01"
                className="border p-2 rounded w-full"
                value={est}
                onChange={(e) => setEst(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs uppercase text-gray-600 mb-1">Actual Extraction</label>
              <input
                type="number"
                step="0.01"
                className="border p-2 rounded w-full"
                value={act}
                onChange={(e) => setAct(e.target.value)}
              />
            </div>
            <div className="flex items-end">
              <div className="p-2 border rounded w-full">
                <div className="text-xs uppercase text-gray-600">Difference</div>
                <div className="font-medium">{money(diff)}</div>
              </div>
            </div>
            <div className="flex items-end">
              <div className="p-2 border rounded w-full">
                <div className="text-xs uppercase text-gray-600">Extraction / Unit (live)</div>
                <div className="font-medium">
                  {totalQtyExclOther > 0 ? money(perUnitAdj) : '—'}
                </div>
              </div>
            </div>
          </div>

          {/* Add item form */}
          <div className="space-y-3">
            <h3 className="font-semibold">Add Item</h3>
            <div className="grid md:grid-cols-12 gap-3 items-start" ref={productDropdownRef}>
              <div className="md:col-span-6">
                <div className="text-xs text-gray-500 mb-1">
                  Can&apos;t find a product?{' '}
                  <button
                    type="button"
                    className="p-0 m-0 bg-transparent border-0 text-blue-700 hover:underline cursor-pointer align-baseline"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setOpenProductDropdown(false);
                      setTimeout(() => setShowCreateProductModal(true), 0);
                    }}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setOpenProductDropdown(false);
                      setTimeout(() => setShowCreateProductModal(true), 0);
                    }}
                  >
                    Add one here
                  </button>
                </div>

                <div className="relative">
                  <input
                    ref={productInputRef}
                    id="product-input"
                    type="text"
                    className="border p-2 rounded w-full"
                    placeholder="Search SKU, name, brand"
                    value={openProductDropdown ? productSearch : form.product_sku}
                    onFocus={() => { setOpenProductDropdown(true); setProductSearch(''); }}
                    onChange={(e) => { setOpenProductDropdown(true); setProductSearch(e.target.value); }}
                  />

                  {openProductDropdown && (
                    <div className="dropdown-portal absolute z-10 bg-white border rounded w-full max-h-56 overflow-y-auto shadow mt-1">
                      {filteredProducts.map((p) => (
                        <div
                          key={p.sku}
                          className="cursor-pointer px-2 py-1 hover:bg-gray-100"
                          onMouseDown={() => {
                            setForm((f) => ({ ...f, product_sku: p.sku.toUpperCase() }));
                            setOpenProductDropdown(false);
                          }}
                        >
                          {p.sku} — {p.name} {p.brand ? `(${p.brand})` : ''}
                        </div>
                      ))}
                      {!filteredProducts.length && (
                        <div className="px-2 py-2 text-gray-500 text-sm">No matches</div>
                      )}
                      <div className="border-t my-1" />
                      <div
                        className="cursor-pointer px-2 py-2 hover:bg-gray-100 text-emerald-700"
                        onMouseDown={() => {
                          setForm((f) => ({ ...f, product_sku: 'OTHER' }));
                          setOpenProductDropdown(false);
                        }}
                      >
                        Use OTHER — Custom item (excluded from extraction allocation)
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="md:col-span-3">
                <label className="block text-xs uppercase text-gray-600 mb-1">Quantity</label>
                <input
                  type="number"
                  step="1"
                  className="border p-2 rounded w-full"
                  value={form.quantity}
                  onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))}
                />
              </div>

              <div className="md:col-span-3">
                <label className="block text-xs uppercase text-gray-600 mb-1">
                  Purchase Price <span className="text-xs text-gray-400">(can be 0)</span>
                </label>
                <input
                  type="number"
                  step="0.01"
                  className="border p-2 rounded w-full"
                  value={form.purchase_price}
                  onChange={(e) => setForm((f) => ({ ...f, purchase_price: e.target.value }))}
                />
              </div>

              {isOther(form.product_sku) && (
                <div className="md:col-span-12">
                  <label className="block text-xs uppercase text-gray-600 mb-1">Description (for OTHER)</label>
                  <input
                    type="text"
                    className="border p-2 rounded w-full"
                    placeholder="Describe the item..."
                    value={form.custom_description}
                    onChange={(e) => setForm((f) => ({ ...f, custom_description: e.target.value }))}
                  />
                  <div className="text-xs text-gray-500 mt-1">Required for OTHER items.</div>
                </div>
              )}

              <div className="md:col-span-12">
                <button
                  onClick={addItem}
                  type="button"
                  className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
                >
                  Add Item (local)
                </button>
              </div>
            </div>
          </div>

          {/* Items Table */}
          <div>
            <h3 className="font-semibold mb-2">Items in Collection</h3>
            <table className="w-full border min-w-[900px]">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left p-2 border">SKU</th>
                  <th className="text-left p-2 border">Name / Description</th>
                  <th className="text-right p-2 border">Qty</th>
                  <th className="text-right p-2 border">Purchase / Item</th>
                  <th className="text-right p-2 border">Extraction / Unit</th>
                  <th className="text-right p-2 border">Effective / Item</th>
                  <th className="text-right p-2 border">Subtotal (Effective)</th>
                  <th className="p-2 border"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => {
                  const key = it.collection_items_id || it._tempid;
                  const qty = Number(it.quantity || 0);
                  const base = Number(it.purchase_price || 0);
                  const perUnit = isOther(it.product_sku) ? 0 : perUnitAdj;
                  const effective = base + perUnit;
                  const subtotalEff = qty * effective;
                  const nameDisplay = isOther(it.product_sku)
                    ? (it.custom_description || 'Other (custom)')
                    : (it.name || '—');

                  return (
                    <tr key={key} className="odd:bg-white even:bg-gray-50">
                      <td className="p-2 border">{it.product_sku}</td>
                      <td className="p-2 border">
                        {nameDisplay}
                        {isOther(it.product_sku) && it.custom_description && (
                          <div className="text-xs text-gray-500 mt-0.5">[OTHER]</div>
                        )}
                      </td>
                      <td className="p-2 border text-right">{qty}</td>
                      <td className="p-2 border text-right">{money(base)}</td>
                      <td className="p-2 border text-right">{perUnit ? money(perUnit) : '—'}</td>
                      <td className="p-2 border text-right">{money(effective)}</td>
                      <td className="p-2 border text-right">{money(subtotalEff)}</td>
                      <td className="p-2 border text-right">
                        <button
                          onClick={() => removeItem(it.collection_items_id || it._tempid)}
                          className="text-red-600 hover:underline"
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  );
                })}
                <tr>
                  <td colSpan={6} className="p-2 border font-medium">Total (Effective)</td>
                  <td className="p-2 border text-right font-semibold">{money(totalWithExtraction)}</td>
                  <td className="p-2 border"></td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Buttons */}
          <div className="flex justify-end gap-3">
            {/* Superadmin Apply */}
            {isSuperadmin && (
              <button
                onClick={async () => {
                  const toastId = toast.loading('Applying stock & cost updates...');
                  try {
                    const res = await fetch(`/api/collections?resource=apply-inventory&id=${id}`, {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        'x-user-id': userIdHeader,
                      },
                    });
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok) throw new Error(data?.error || 'Failed to apply inventory updates');

                    if (data?.alreadyApplied) toast.success('Already applied (no changes made)', { id: toastId });
                    else toast.success('Stock & cost updates applied', { id: toastId });

                    await fetchAll();
                  } catch (err) {
                    toast.error(err.message || 'Failed', { id: toastId });
                  }
                }}
                disabled={!canApply}
                className={`px-6 py-2 rounded text-white ${
                  canApply ? 'bg-indigo-600 hover:bg-indigo-700' : 'bg-gray-400 cursor-not-allowed'
                }`}
              >
                Apply Stock & Cost
              </button>
            )}

            {/* Save (everyone) */}
            <button
              onClick={async () => {
                const toastId = toast.loading('Saving...');
                try {
                  const payloadItems = items.map((it) => ({
                    product_sku: it.product_sku,
                    quantity: Number(it.quantity || 0),
                    purchase_price: Number(it.purchase_price || 0),
                    custom_description: isOther(it.product_sku) ? (it.custom_description || '') : null,
                  }));

                  const res = await fetch(`/api/collections?id=${id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      est_extraction: Number(est) || 0,
                      act_extraction: Number(act) || 0,
                      items: payloadItems,
                    }),
                  });

                  if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    throw new Error(data?.error || 'Failed to save');
                  }

                  toast.success('Collection saved', { id: toastId });
                  await fetchAll();
                } catch (err) {
                  toast.error(err.message, { id: toastId });
                }
              }}
              className="bg-green-600 text-white px-6 py-2 rounded hover:bg-green-700"
            >
              Save Collection
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
