import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { authHeaders } from '../utils/auth';
import { formatWhen } from '../utils/lotTracker';

// "View Lots" on the Products page (Nick, 13 Oct 2026): the lot numbers of one product that
// are In Stock right now. Read-only — one GET to /api/lots?resource=product-lots (admin +
// superadmin, see lib/lotJourney.js). Each lot number opens its journey in the Lot Tracker.
//
//   product: { sku, name, stock }

export default function ProductLotsModal({ product, onClose }) {
  const [state, setState] = useState({ loading: true, error: null, lots: [], limit: null });
  const closeRef = useRef(null);
  const panelRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/lots?resource=product-lots&sku=${encodeURIComponent(product.sku)}`, { headers: authHeaders() });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not load the lots');
        if (!cancelled) setState({ loading: false, error: null, lots: data.lots || [], limit: data.limit ?? null });
      } catch (err) {
        if (!cancelled) setState({ loading: false, error: err.message || 'Could not load the lots', lots: [], limit: null });
      }
    })();
    return () => { cancelled = true; };
  }, [product.sku]);

  // Escape closes it; focus goes to Close on open and back to the button that opened it after.
  useEffect(() => {
    const opener = document.activeElement;
    closeRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') { onCloseRef.current?.(); return; }
      if (e.key !== 'Tab' || !panelRef.current) return;
      // aria-modal promises the page behind is inert, so Tab stays inside the dialog.
      const items = panelRef.current.querySelectorAll('a[href], button:not([disabled])');
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const inside = panelRef.current.contains(document.activeElement);
      if (e.shiftKey && (!inside || document.activeElement === first)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (!inside || document.activeElement === last)) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (opener && typeof opener.focus === 'function') opener.focus();
    };
  }, []);

  const { loading, error, lots, limit } = state;
  const showCost = lots.some((l) => 'unit_cost' in l);
  const stock = Number(product.stock);
  const stockDiffers = !loading && !error && Number.isFinite(stock) && stock !== lots.length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="product-lots-title"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="product-lots-title" className="text-lg font-bold text-gray-900">In-stock lots</h2>
        <p className="mt-1 text-sm text-gray-700 break-words">{product.sku} · {product.name}</p>

        <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
          {loading && <p className="text-sm text-gray-600">Loading lots…</p>}
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          {!loading && !error && lots.length === 0 && (
            <p className="text-sm text-gray-700">No lots in stock for this product.</p>
          )}
          {!loading && !error && lots.length > 0 && (
            <>
              <p className="mb-2 text-sm font-semibold text-gray-900">
                {lots.length} {lots.length === 1 ? 'lot' : 'lots'} in stock
              </p>
              <div className="overflow-x-auto">
                <table className="w-full border text-sm">
                  <thead className="bg-gray-100">
                    <tr>
                      <th className="border px-3 py-2 text-left">Lot number</th>
                      <th className="border px-3 py-2 text-left">Serial number</th>
                      <th className="border px-3 py-2 text-left">Came from</th>
                      <th className="border px-3 py-2 text-left">Lot issued</th>
                      {showCost && <th className="border px-3 py-2 text-left">Unit cost</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {lots.map((l) => (
                      <tr key={l.lot_number}>
                        <td className="border px-3 py-2">
                          <Link className="text-blue-700 underline" to={`/lot-tracker?lot=${encodeURIComponent(l.lot_number)}`}>
                            {l.lot_number}
                          </Link>
                        </td>
                        <td className="border px-3 py-2">{l.serial_number || 'Not recorded'}</td>
                        <td className="border px-3 py-2">{l.collection_name || '—'}</td>
                        <td className="border px-3 py-2">{formatWhen(l.created_at)}</td>
                        {showCost && (
                          <td className="border px-3 py-2">{l.unit_cost == null ? '—' : `$${Number(l.unit_cost).toFixed(2)}`}</td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {limit != null && lots.length >= limit && (
                <p className="mt-2 text-sm text-gray-700">Showing the first {limit} lots.</p>
              )}
            </>
          )}
          {stockDiffers && (
            <p className="mt-3 text-sm text-gray-700">
              Stock on hand is {stock}, which does not match the number of lots listed here. Stock
              that came in before lot numbers were introduced, or outside a collection, has no lot.
            </p>
          )}
        </div>

        <div className="mt-4 text-right">
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="rounded bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-400"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
