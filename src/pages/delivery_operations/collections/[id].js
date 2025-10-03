// pages/delivery_operations/collections/[id].js
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import BackButton from '../../../components/backbutton';
import HomeButton from '../../../components/homebutton';

const DELIVERY_STATES = ['VIC', 'NSW', 'ACT', 'TAS', 'QLD', 'WA', 'SA', 'NT'];
const ensureArray = (x) => (Array.isArray(x) ? x : (x && typeof x === 'object' ? [x] : []));

function ErrorNotice({ message }) {
  return (
    <div className="min-h-screen bg-gray-100 flex justify-center items-center">
      <div className="bg-white px-4 py-3 rounded border text-red-700 border-red-300">
        {message}
      </div>
    </div>
  );
}

export default function EditCollectionPage() {
  const navigate = useNavigate();
  const { id } = useParams(); // expects route: /delivery_operations/collections/:id

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [removalists, setRemovalists] = useState([]);
  const [products, setProducts] = useState([]);
  const [header, setHeader] = useState({
    id: '',
    name: '',
    suburb: '',
    state: '',
    description: '',
    removalist_id: '',
    collection_date: '',
    notes: '',
    status: 'To Be Booked',
  });

  // Front-end only extraction cost
  const [extractionCost, setExtractionCost] = useState('');

  const [items, setItems] = useState([
    { collection_items_id: null, product_sku: '', quantity: '', purchase_price: '' }
  ]);
  const [openSkuIdx, setOpenSkuIdx] = useState(null);
  const [skuSearch, setSkuSearch] = useState({});

  const fetchAll = async (collectionId) => {
    setLoadError('');
    try {
      const [rRes, pRes, cRes] = await Promise.all([
        fetch('/api/collections?resource=carriers'),
        fetch('/api/products'),
        fetch(`/api/collections?id=${collectionId}&include=items`),
      ]);

      const [rData, pData, cData] = await Promise.all([
        rRes.json().catch(() => []),
        pRes.json().catch(() => []),
        cRes.json().catch(() => ({})),
      ]);

      if (!rRes.ok) throw new Error(rData?.error || 'Failed to load removalists');
      if (!pRes.ok) throw new Error(pData?.error || 'Failed to load products');
      if (!cRes.ok) throw new Error(cData?.error || 'Failed to load collection');

      setRemovalists(ensureArray(rData));
      setProducts(ensureArray(pData));

      const col = cData.collection || cData || {};
      if (!col?.id) throw new Error('Collection not found');

      setHeader({
        id: col.id,
        name: col.name || '',
        suburb: col.suburb || '',
        state: col.state || '',
        description: col.description || '',
        removalist_id: col.removalist_id || '',
        collection_date: col.collection_date || '',
        notes: col.notes || '',
        status: col.status || 'To Be Booked',
      });

      const initialItems = ensureArray(cData.items || []);
      setItems(
        initialItems.length
          ? initialItems.map(it => ({
              collection_items_id: it.collection_items_id,
              product_sku: it.product_sku || '',
              quantity: it.quantity ?? '',
              purchase_price: it.purchase_price ?? ''
            }))
          : [{ collection_items_id: null, product_sku: '', quantity: '', purchase_price: '' }]
      );
    } catch (err) {
      setLoadError(err.message || 'Failed to load');
      toast.error(err.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const stored = localStorage.getItem('user');
    if (!stored) {
      navigate('/');
      return;
    }
    if (!id) {
      setLoadError('Missing collection id in route.');
      setLoading(false);
      return;
    }
    fetchAll(id);
  }, [navigate, id]);

  // Product search utils
  const productText = (p) => `${p.sku} ${p.name || ''} ${p.brand || ''}`.toLowerCase();
  const productListForRow = (idx) => {
    const q = (skuSearch[idx] || '').trim().toLowerCase();
    const kws = q.split(' ').filter(Boolean);
    return products
      .filter((p) => kws.every(kw => productText(p).includes(kw)))
      .slice(0, 50);
  };

  const updateHeader = (k, v) => setHeader(h => ({ ...h, [k]: v }));
  const updateItem = (i, k, v) =>
    setItems(arr => {
      const copy = [...arr];
      copy[i] = { ...copy[i], [k]: v };
      return copy;
    });

  const addRow = () =>
    setItems(arr => [...arr, { collection_items_id: null, product_sku: '', quantity: '', purchase_price: '' }]);

  const removeRow = (i) =>
    setItems(arr => arr.length > 1 ? arr.filter((_, idx) => idx !== i) : arr);

  const onSave = async (e) => {
    e.preventDefault();

    if (!header.name) {
      toast.error('Name is required');
      return;
    }
    if (header.status === 'Completed' && (!header.collection_date || !header.removalist_id)) {
      toast.error('To set Completed, please select a date and a carrier.');
      return;
    }

    const cleaned = items
      .map(it => ({
        collection_items_id: it.collection_items_id ?? null,
        product_sku: String(it.product_sku || '').trim(),
        quantity: it.quantity === '' ? null : Number(it.quantity),
        purchase_price: it.purchase_price === '' ? null : Number(it.purchase_price),
      }))
      .filter(it => it.product_sku || it.quantity !== null || it.purchase_price !== null);

    const toastId = toast.loading('Saving collection...');
    try {
      // 1) Save header
      const hdrRes = await fetch(`/api/collections?id=${header.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(header),
      });
      const hdrData = await hdrRes.json().catch(() => ({}));
      if (!hdrRes.ok) throw new Error(hdrData?.error || 'Header save failed');

      // 2) Save items (bulk upsert) — pass extraction_cost (front-end only)
      const itmRes = await fetch(`/api/collections?resource=items&collection_id=${header.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: cleaned,
          extraction_cost: extractionCost === '' ? 0 : Number(extractionCost),
        }),
      });
      const itmData = await itmRes.json().catch(() => ({}));
      if (!itmRes.ok) throw new Error(itmData?.error || 'Items save failed');

      toast.success('Collection saved', { id: toastId });
      navigate('/delivery_operations'); // tweak destination if needed
    } catch (err) {
      toast.error(err.message || 'Save failed', { id: toastId });
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-100 flex justify-center items-center">
        <div className="text-gray-600 text-lg font-medium">Loading...</div>
      </div>
    );
  }

  if (loadError) {
    return <ErrorNotice message={loadError} />;
  }

  return (
    <>
      <div className="fixed top-4 left-6 z-50 flex gap-2">
        <HomeButton />
        <BackButton />
      </div>

      <div className="min-h-screen bg-gray-100 flex justify-center items-center p-6">
        <div className="bg-white p-6 rounded shadow-md w-full max-w-6xl">
          <h2 className="text-xl font-bold text-center mb-4">Edit Collection</h2>

          <form onSubmit={onSave} className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* LEFT */}
              <div className="space-y-4">
                <input
                  type="text"
                  placeholder="Name *"
                  className="border p-2 rounded w-full"
                  value={header.name}
                  onChange={(e) => updateHeader('name', e.target.value)}
                  required
                />
                <input
                  type="text"
                  placeholder="Suburb"
                  className="border p-2 rounded w-full"
                  value={header.suburb}
                  onChange={(e) => updateHeader('suburb', e.target.value)}
                />
                <select
                  className="border p-2 rounded w-full"
                  value={header.state || ''}
                  onChange={(e) => updateHeader('state', e.target.value)}
                >
                  <option value="">State</option>
                  {DELIVERY_STATES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
                <textarea
                  placeholder="Description"
                  className="border p-2 rounded w-full"
                  value={header.description || ''}
                  onChange={(e) => updateHeader('description', e.target.value)}
                />
              </div>

              {/* RIGHT */}
              <div className="space-y-4">
                <select
                  className="border p-2 rounded w-full"
                  value={header.removalist_id || ''}
                  onChange={(e) => updateHeader('removalist_id', e.target.value)}
                >
                  <option value="">Carrier</option>
                  {removalists.map(r => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>

                <input
                  type="date"
                  className="border p-2 rounded w-full"
                  value={header.collection_date || ''}
                  onChange={(e) => updateHeader('collection_date', e.target.value)}
                />

                {/* Extraction cost — front-end only */}
                <input
                  type="number"
                  step="0.01"
                  placeholder="Extraction Cost ($)"
                  className="border p-2 rounded w-full"
                  value={extractionCost}
                  onChange={(e) => setExtractionCost(e.target.value)}
                />

                <select
                  className="border p-2 rounded w-full"
                  value={header.status}
                  onChange={(e) => updateHeader('status', e.target.value)}
                >
                  {['To Be Booked', 'Booked', 'Completed', 'Cancelled'].map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>

                <textarea
                  placeholder="Notes"
                  className="border p-2 rounded w-full"
                  value={header.notes || ''}
                  onChange={(e) => updateHeader('notes', e.target.value)}
                />
              </div>
            </div>

            {/* ITEMS */}
            <div>
              <div className="flex items-center justify-between">
                <h3 className="font-semibold mb-2">Collection Items</h3>
              </div>

              {items.map((it, idx) => (
                <div key={idx} className="grid grid-cols-6 gap-2 mb-2">
                  {/* SKU search / selection */}
                  <div className="relative col-span-3">
                    <input
                      type="text"
                      className="border p-2 rounded w-full"
                      placeholder="Search product (SKU, name, brand)"
                      value={openSkuIdx === idx ? (skuSearch[idx] ?? '') : (it.product_sku || '')}
                      onFocus={() => { setOpenSkuIdx(idx); setSkuSearch(s => ({ ...s, [idx]: '' })); }}
                      onChange={(e) => setSkuSearch(s => ({ ...s, [idx]: e.target.value }))}
                    />
                    {openSkuIdx === idx && (
                      <div className="dropdown-portal absolute z-10 bg-white border rounded w-full max-h-48 overflow-y-auto shadow">
                        {productListForRow(idx).map(p => (
                          <div
                            key={p.sku}
                            className="cursor-pointer px-2 py-1 hover:bg-gray-100"
                            onMouseDown={() => {
                              updateItem(idx, 'product_sku', p.sku);
                              setOpenSkuIdx(null);
                              setSkuSearch(s => ({ ...s, [idx]: '' }));
                            }}
                          >
                            {p.sku} — {p.name} {p.brand ? `(${p.brand})` : ''}
                          </div>
                        ))}

                        <div className="border-t my-1" />
                        {/* OTHER — special sentinel */}
                        <div
                          className="cursor-pointer px-2 py-1 hover:bg-gray-100"
                          onMouseDown={() => {
                            updateItem(idx, 'product_sku', 'OTHER');
                            setOpenSkuIdx(null);
                            setSkuSearch(s => ({ ...s, [idx]: '' }));
                          }}
                        >
                          OTHER — Custom item (excluded from pricing)
                        </div>

                        {!productListForRow(idx).length && (
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
                    value={it.quantity}
                    onChange={(e) => updateItem(idx, 'quantity', e.target.value)}
                  />

                  {/* Purchase price (per-unit by default) */}
                  <input
                    type="number"
                    step="0.01"
                    placeholder="Purchase Price ($)"
                    className="border p-2 rounded"
                    value={it.purchase_price}
                    onChange={(e) => updateItem(idx, 'purchase_price', e.target.value)}
                  />

                  {/* Row actions */}
                  <div className="flex gap-2 items-center">
                    <button
                      type="button"
                      className="px-2 py-1 border rounded text-sm"
                      onClick={() => removeRow(idx)}
                      title="Remove row"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}

              <button type="button" className="text-blue-600 mt-1" onClick={addRow}>
                + Add another item
              </button>
            </div>

            {/* SAVE */}
            <button
              type="submit"
              className="w-full bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600"
            >
              Save Collection
            </button>
          </form>
        </div>
      </div>
    </>
  );
}
