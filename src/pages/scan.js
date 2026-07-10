// G5 — public stock scanner. No login required (decision D7). Scan a lot
// sticker (USB scanner types the lot number + Enter) or type it, and see the
// product, retail price, stock, and lot status. Read-only; the backend
// lot_number lookup returns no cost or customer data.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

function money(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });
}

const STATUS_CLS = {
  Sold: 'bg-green-100 text-green-800',
  Assigned: 'bg-blue-100 text-blue-800',
  Void: 'bg-gray-200 text-gray-500',
  'In Stock': 'bg-amber-100 text-amber-800',
};

export default function ScanPage() {
  const [code, setCode] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const lookup = async (raw) => {
    const lot = String(raw || '').trim();
    if (!lot) return;
    setLoading(true);
    try {
      const r = await fetch(`/api/lots?lot_number=${encodeURIComponent(lot)}`);
      if (r.status === 404) setResult({ notFound: true, code: lot });
      else if (!r.ok) setResult({ error: 'Lookup failed' });
      else setResult({ lot: await r.json() });
    } catch {
      setResult({ error: 'Network error' });
    } finally {
      setLoading(false);
      setCode('');
      inputRef.current?.focus();
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center p-6">
      <div className="w-full max-w-md">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold">Stock Scanner</h1>
          <Link to="/" className="text-sm text-blue-600 underline">Staff login</Link>
        </div>
        <p className="text-sm text-gray-600 mb-3">
          Scan a lot sticker, or type its lot number (e.g. <span className="font-mono">L00042</span>) and press Enter.
        </p>
        <form onSubmit={(e) => { e.preventDefault(); lookup(code); }}>
          <input
            ref={inputRef}
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Scan or type lot number…"
            className="w-full border rounded-lg p-4 text-lg font-mono"
          />
        </form>

        {loading && <div className="mt-6 text-gray-500">Looking up…</div>}

        {!loading && result?.notFound && (
          <div className="mt-6 rounded-lg border border-red-300 bg-red-50 p-4 text-red-800">
            No lot found for <span className="font-mono font-semibold">{result.code}</span>.
          </div>
        )}
        {!loading && result?.error && (
          <div className="mt-6 rounded-lg border border-red-300 bg-red-50 p-4 text-red-800">{result.error}</div>
        )}
        {!loading && result?.lot && (
          <div className="mt-6 rounded-lg border bg-white p-5 shadow-sm">
            <div className="text-xs text-gray-500">Lot</div>
            <div className="text-xl font-mono font-bold">{result.lot.lot_number}</div>
            <div className="mt-3 text-lg font-semibold">{result.lot.product_name || result.lot.product_sku}</div>
            <div className="text-sm text-gray-600 font-mono">{result.lot.product_sku}</div>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div>
                <div className="text-xs text-gray-500">Price</div>
                <div className="text-lg font-semibold">{money(result.lot.product_price)}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500">In stock</div>
                <div className="text-lg font-semibold">{result.lot.product_stock ?? '—'}</div>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="text-xs text-gray-500">Lot status:</span>
              <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${STATUS_CLS[result.lot.status] || 'bg-gray-100 text-gray-700'}`}>
                {result.lot.status}
              </span>
              {result.lot.invoice_id && (
                <span className="text-xs text-gray-500">· on invoice {result.lot.invoice_id}</span>
              )}
              {result.lot.serial_number && (
                <span className="text-xs text-gray-500">· serial {result.lot.serial_number}</span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
