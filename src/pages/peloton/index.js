// src/pages/peloton/index.js
// Standalone Peloton tab — live stock from Winnings SAP (no DB storage).
// Fetches fresh data every time the tab is opened or Refresh is clicked.

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { RefreshCw, PackageSearch, AlertTriangle, Wifi } from 'lucide-react';
import BackButton from '../../components/backbutton';
import HomeButton from '../../components/homebutton';

// ─── constants ──────────────────────────────────────────────────────────────

const FACILITIES = [
  { code: '2000', label: 'NSW' },
  { code: '3000', label: 'VIC' },
  { code: '4000', label: 'QLD' },
  { code: '5000', label: 'SA'  },
  { code: '6000', label: 'WA'  },
  { code: '7000', label: 'TAS' },
  { code: '8000', label: 'NT'  },
];

// ─── helpers ─────────────────────────────────────────────────────────────────

function fmt(val) {
  const n = parseFloat(val);
  if (isNaN(n)) return '—';
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function fmtTime(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleTimeString('en-AU', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

// Stock level badge colour for unrestricted-use quantity
function stockBadge(qty) {
  const n = parseFloat(qty) || 0;
  if (n <= 0)  return 'bg-red-100 text-red-700';
  if (n <= 3)  return 'bg-amber-100 text-amber-700';
  return 'bg-green-100 text-green-700';
}

// ─── component ───────────────────────────────────────────────────────────────

export default function PelotonPage() {
  const navigate = useNavigate();

  const [user, setUser]                 = useState(null);
  const [facility, setFacility]         = useState('2000');   // default NSW
  const [includeZero, setIncludeZero]   = useState(false);
  const [skuFilter, setSkuFilter]       = useState('');

  const [data, setData]                 = useState([]);
  const [meta, setMeta]                 = useState(null);     // { facilityName, env, fetchedAt }
  const [loading, setLoading]           = useState(false);
  const [error, setError]               = useState(null);

  // Auth guard
  useEffect(() => {
    const stored = localStorage.getItem('user');
    if (!stored) { navigate('/'); return; }
    setUser(JSON.parse(stored));
  }, [navigate]);

  // ── fetch stock ─────────────────────────────────────────────────────────
  const fetchStock = useCallback(async () => {
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ facility });
    if (includeZero) params.set('includeZeroStock', 'true');

    try {
      const res  = await fetch(`/api/winnings?${params}`);
      const json = await res.json();

      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);

      setData(json.results || []);
      setMeta({
        facilityName: json.facilityName,
        env:          json.env,
        fetchedAt:    json.fetchedAt,
      });
    } catch (err) {
      setError(err.message);
      toast.error(`Stock fetch failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [facility, includeZero]);

  // Auto-fetch on facility / filter change
  useEffect(() => {
    if (user) fetchStock();
  }, [user, fetchStock]);

  // ── derived / filtered rows ──────────────────────────────────────────────
  const rows = data.filter((r) => {
    if (!skuFilter) return true;
    const q = skuFilter.toLowerCase();
    return (
      (r.CustomerSKU   || '').toLowerCase().includes(q) ||
      (r.SKUDescription|| '').toLowerCase().includes(q)
    );
  });

  // ── render ───────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-screen bg-gray-100">

      {/* ── top bar ── */}
      <header className="bg-white shadow-md px-4 py-3 flex items-center gap-3 flex-shrink-0">
        <BackButton />
        <HomeButton />

        <div className="flex items-center gap-2 ml-2">
          {/* Peloton logo-ish pill */}
          <span className="inline-flex items-center gap-1.5 bg-black text-white text-xs font-bold px-2.5 py-1 rounded-full tracking-wide">
            <PackageSearch size={13} />
            PELOTON
          </span>
          <h1 className="text-base font-semibold text-gray-800">
            Winnings Warehouse Stock
          </h1>
        </div>

        {/* env badge */}
        {meta && (
          <span
            className={`ml-2 text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wide ${
              meta.env === 'PROD'
                ? 'bg-green-100 text-green-700'
                : 'bg-amber-100 text-amber-700'
            }`}
          >
            {meta.env}
          </span>
        )}

        <div className="ml-auto flex items-center gap-3">
          {meta?.fetchedAt && (
            <span className="text-xs text-gray-400 hidden sm:block">
              Last updated: {fmtTime(meta.fetchedAt)}
            </span>
          )}
          <button
            onClick={fetchStock}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 text-white text-sm rounded-lg hover:bg-gray-700 disabled:opacity-50 transition"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </header>

      {/* ── state tabs ── */}
      <div className="bg-white border-b px-4 flex items-center gap-1 overflow-x-auto flex-shrink-0">
        {FACILITIES.map((f) => (
          <button
            key={f.code}
            onClick={() => setFacility(f.code)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition whitespace-nowrap ${
              facility === f.code
                ? 'border-gray-900 text-gray-900'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* ── controls bar ── */}
      <div className="bg-white border-b px-4 py-2 flex items-center gap-4 flex-shrink-0">
        {/* SKU search */}
        <input
          type="text"
          placeholder="Filter by SKU or description…"
          value={skuFilter}
          onChange={(e) => setSkuFilter(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm w-64 focus:outline-none focus:ring-2 focus:ring-gray-400"
        />

        {/* Include zero stock toggle */}
        <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={includeZero}
            onChange={(e) => setIncludeZero(e.target.checked)}
            className="w-4 h-4 accent-gray-800"
          />
          Include zero-stock items
        </label>

        <span className="ml-auto text-xs text-gray-400">
          {loading ? 'Fetching…' : `${rows.length} SKU${rows.length !== 1 ? 's' : ''}`}
        </span>
      </div>

      {/* ── main content ── */}
      <main className="flex-1 overflow-auto p-4">

        {/* Error state */}
        {error && !loading && (
          <div className="mb-4 flex items-start gap-3 bg-red-50 border border-red-200 rounded-lg p-4">
            <AlertTriangle size={18} className="text-red-500 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-red-700">Failed to load stock data</p>
              <p className="text-xs text-red-600 mt-0.5">{error}</p>
              <button
                onClick={fetchStock}
                className="mt-2 text-xs text-red-700 underline hover:no-underline"
              >
                Try again
              </button>
            </div>
          </div>
        )}

        {/* Loading skeleton */}
        {loading && (
          <div className="bg-white rounded-lg shadow overflow-hidden animate-pulse">
            <div className="h-10 bg-gray-100" />
            {[...Array(6)].map((_, i) => (
              <div key={i} className="flex gap-4 px-4 py-3 border-t">
                <div className="h-4 bg-gray-100 rounded w-24" />
                <div className="h-4 bg-gray-100 rounded flex-1" />
                <div className="h-4 bg-gray-100 rounded w-16" />
                <div className="h-4 bg-gray-100 rounded w-16" />
                <div className="h-4 bg-gray-100 rounded w-16" />
              </div>
            ))}
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && rows.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-3 py-20 text-gray-400">
            <Wifi size={40} strokeWidth={1.5} />
            <p className="text-sm">
              {data.length === 0
                ? `No stock data returned for ${FACILITIES.find(f => f.code === facility)?.label || facility}.`
                : 'No SKUs match your filter.'}
            </p>
          </div>
        )}

        {/* Stock table */}
        {!loading && rows.length > 0 && (
          <div className="bg-white rounded-lg shadow overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-left border-b">
                  <th className="px-4 py-3 font-semibold text-gray-700 whitespace-nowrap">SKU</th>
                  <th className="px-4 py-3 font-semibold text-gray-700">Description</th>
                  <th className="px-4 py-3 font-semibold text-gray-700 text-center whitespace-nowrap">Storage Loc.</th>
                  <th className="px-4 py-3 font-semibold text-gray-700 text-right whitespace-nowrap">
                    <span className="inline-flex items-center gap-1">
                      Unrestricted
                      <span className="text-[10px] font-normal text-gray-400">(avail)</span>
                    </span>
                  </th>
                  <th className="px-4 py-3 font-semibold text-gray-700 text-right whitespace-nowrap">In Transit</th>
                  <th className="px-4 py-3 font-semibold text-gray-700 text-right whitespace-nowrap">Reserved</th>
                  <th className="px-4 py-3 font-semibold text-gray-700 text-right whitespace-nowrap">On PO</th>
                  <th className="px-4 py-3 font-semibold text-gray-700 text-right whitespace-nowrap">Total Stock</th>
                  <th className="px-4 py-3 font-semibold text-gray-700 text-center whitespace-nowrap">Lead (days)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const inTransit = (parseFloat(r.SOInTransit) || 0) + (parseFloat(r.STOInTransit) || 0);
                  return (
                    <tr
                      key={`${r.CustomerSKU}-${r.StorageLocation}-${i}`}
                      className="border-t hover:bg-gray-50 transition"
                    >
                      {/* SKU */}
                      <td className="px-4 py-3 font-mono font-medium text-gray-900 whitespace-nowrap">
                        {r.CustomerSKU || '—'}
                      </td>

                      {/* Description */}
                      <td className="px-4 py-3 text-gray-700">
                        {r.SKUDescription || '—'}
                      </td>

                      {/* Storage location */}
                      <td className="px-4 py-3 text-center text-gray-500 font-mono text-xs">
                        {r.StorageLocation || '—'}
                      </td>

                      {/* Unrestricted (availability badge) */}
                      <td className="px-4 py-3 text-right">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-bold ${stockBadge(r.UnrestrictedUse)}`}>
                          {fmt(r.UnrestrictedUse)}
                        </span>
                      </td>

                      {/* In transit (SO + STO combined) */}
                      <td className="px-4 py-3 text-right text-gray-600">
                        {inTransit > 0 ? fmt(inTransit) : <span className="text-gray-300">—</span>}
                      </td>

                      {/* Reserved for delivery */}
                      <td className="px-4 py-3 text-right text-gray-600">
                        {parseFloat(r.ReservedDelivery) > 0
                          ? fmt(r.ReservedDelivery)
                          : <span className="text-gray-300">—</span>}
                      </td>

                      {/* On purchase order (not in total) */}
                      <td className="px-4 py-3 text-right text-blue-600 font-medium">
                        {parseFloat(r.OnPurchaseOrder) > 0
                          ? fmt(r.OnPurchaseOrder)
                          : <span className="text-gray-300">—</span>}
                      </td>

                      {/* Total stock */}
                      <td className="px-4 py-3 text-right font-semibold text-gray-900">
                        {fmt(r.TotalStock)}
                      </td>

                      {/* Lead time */}
                      <td className="px-4 py-3 text-center text-gray-500">
                        {r.InstallLeadTime != null && r.InstallLeadTime !== ''
                          ? r.InstallLeadTime
                          : <span className="text-gray-300">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* Table footer */}
            <div className="border-t px-4 py-2 bg-gray-50 flex items-center justify-between text-xs text-gray-400">
              <span>
                {FACILITIES.find(f => f.code === facility)?.label} warehouse
                {meta?.env ? ` · ${meta.env} environment` : ''}
              </span>
              <span>
                {rows.length} result{rows.length !== 1 ? 's' : ''}
                {meta?.fetchedAt ? ` · fetched ${fmtTime(meta.fetchedAt)}` : ''}
              </span>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
