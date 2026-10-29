import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { authHeaders } from '../utils/auth';
import { endExpiredSession } from '../utils/session';
import { formatDollars, formatPct, changeBadge } from '../utils/director';
import { Coverage, Tile } from './DirectorParts';

// G22b (owner, 29 Oct 2026) — Director's View: products sold, earnings and profit. Read-only,
// superadmin only (the server checks). Profit only ever covers lines with a known cost; stock
// value at cost only the units with a cost — both say how much that is.

const fmtInt = (v) => Number(v || 0).toLocaleString('en-AU');

function ProductTable({ label, rows }) {
  return (
    <div className="overflow-x-auto">
      <table aria-label={label} className="w-full border text-sm">
        <caption className="px-2 py-1 text-left text-sm font-semibold">{label}</caption>
        <thead className="bg-gray-100">
          <tr>
            <th className="border px-2 py-1 text-left">Product</th>
            <th className="border px-2 py-1 text-right">Units</th>
            <th className="border px-2 py-1 text-right">Revenue</th>
            <th className="border px-2 py-1 text-right">Gross profit</th>
            <th className="border px-2 py-1 text-right">Margin</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.sku} aria-label={p.name}>
              <th scope="row" className="border px-2 py-1 text-left font-normal">
                {p.name} <span className="text-xs text-gray-700">{p.sku}</span>
                {p.costed_lines > 0 && p.costed_lines < p.lines && (
                  <span className="block text-xs text-gray-700">profit on {p.costed_lines} of {p.lines} lines</span>
                )}
              </th>
              <td className="border px-2 py-1 text-right">{fmtInt(p.units)}</td>
              <td className="border px-2 py-1 text-right">{formatDollars(p.revenue)}</td>
              <td className="border px-2 py-1 text-right">{formatDollars(p.gross_profit)}</td>
              <td className="border px-2 py-1 text-right">{formatPct(p.margin)}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={5} className="border px-2 py-2 text-gray-600">Nothing to show.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export default function DirectorProducts({ period, compare }) {
  const navigate = useNavigate();
  const [state, setState] = useState({ loading: true, error: null, data: null });

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    (async () => {
      try {
        const qs = new URLSearchParams({ resource: 'products', from: period.from, to: period.to });
        if (compare) qs.set('compare', period.compare || '1');
        const res = await fetch(`/api/director?${qs}`, { headers: authHeaders() });
        if (cancelled) return;
        if (res.status === 401) { endExpiredSession(navigate); return; }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not load the product figures');
        if (!cancelled) setState({ loading: false, error: null, data });
      } catch (err) {
        if (!cancelled) setState({ loading: false, error: err.message, data: null });
      }
    })();
    return () => { cancelled = true; };
  }, [period.from, period.to, period.compare, compare, navigate]);

  const d = state.data;
  return (
    <section aria-label="Products & profit" className="space-y-4 rounded-xl border bg-white p-4">
      <h2 className="text-lg font-bold">Products &amp; profit</h2>
      {state.error && <p role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">{state.error}</p>}
      {state.loading && <p role="status" className="text-sm text-gray-700">{d ? 'Updating…' : 'Loading…'}</p>}
      {d && (
        <div aria-busy={state.loading} className={`space-y-4 ${state.loading ? 'opacity-60' : ''}`}>
          <div className="space-y-1">
            <Coverage>Revenue: {d.totals.priced_lines} of {d.totals.lines} lines use the price on the order; {d.totals.estimated_lines} are estimated from the product list price. Canceled items are excluded.</Coverage>
            <Coverage>Profit: {d.totals.costed_lines} of {d.totals.lines} lines have a cost set — gross profit and margin cover those lines only (a cost of $0 means “not set” and is never counted as $0).</Coverage>
            <Coverage>Stock: {fmtInt(d.stock.units_costed)} of {fmtInt(d.stock.units)} units in stock have a cost — “at cost” covers those only.{d.stock.negative > 0 && ` ${d.stock.negative} products with negative stock are left out.`}</Coverage>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-4">
            <Tile label="Revenue" value={formatDollars(d.totals.revenue)} badge={compare && d.previous ? changeBadge(d.totals.revenue, d.previous.totals.revenue) : null} />
            <Tile label="Units sold" value={fmtInt(d.totals.units)} />
            <Tile label="Gross profit (costed lines)" value={formatDollars(d.totals.gross_profit)} note={`Margin ${formatPct(d.totals.margin)}`} />
            <Tile label="Products sold" value={fmtInt(d.product_count)} />
            <Tile label="Stock on hand at cost" value={formatDollars(d.stock.value_cost)} note={`${fmtInt(d.stock.units_costed)} of ${fmtInt(d.stock.units)} units costed`} />
            <Tile label="Stock on hand at sell price" value={formatDollars(d.stock.value_sell)} note={`${fmtInt(d.stock.products)} products in stock`} />
            <Tile label="Lots in stock > 90 days" value={fmtInt(d.aged.over90)} note={`${fmtInt(d.aged.over180)} over 180 days · ${fmtInt(d.aged.in_stock)} lots in stock`} />
          </div>
          <Coverage>Aged stock uses lot numbers, which only exist for stock received since lots began, so it does not cover every unit on hand.</Coverage>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <ProductTable label="Top 10 products by revenue" rows={d.top_revenue} />
            <ProductTable label="Top 10 products by gross profit" rows={d.top_profit} />
            <ProductTable label="Lowest 10 products by revenue" rows={d.bottom_revenue} />
            <ProductTable label="Lowest 10 products by gross profit" rows={d.bottom_profit} />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="overflow-x-auto">
              <table aria-label="Top brands by revenue" className="w-full border text-sm">
                <caption className="px-2 py-1 text-left text-sm font-semibold">Top brands by revenue</caption>
                <thead className="bg-gray-100"><tr><th className="border px-2 py-1 text-left">Brand</th><th className="border px-2 py-1 text-right">Revenue</th><th className="border px-2 py-1 text-right">Gross profit</th></tr></thead>
                <tbody>
                  {d.brands.map((b) => (
                    <tr key={b.brand}><th scope="row" className="border px-2 py-1 text-left font-normal">{b.brand}</th><td className="border px-2 py-1 text-right">{formatDollars(b.revenue)}</td><td className="border px-2 py-1 text-right">{formatDollars(b.gross_profit)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="overflow-x-auto">
              <table aria-label="Sales by item condition" className="w-full border text-sm">
                <caption className="px-2 py-1 text-left text-sm font-semibold">Sales by item condition</caption>
                <thead className="bg-gray-100"><tr><th className="border px-2 py-1 text-left">Condition</th><th className="border px-2 py-1 text-right">Units</th><th className="border px-2 py-1 text-right">Revenue</th></tr></thead>
                <tbody>
                  {d.conditions.map((c) => (
                    <tr key={c.condition}><th scope="row" className="border px-2 py-1 text-left font-normal">{c.condition}</th><td className="border px-2 py-1 text-right">{fmtInt(c.units)}</td><td className="border px-2 py-1 text-right">{formatDollars(c.revenue)}</td></tr>
                  ))}
                </tbody>
              </table>
              <Coverage>Condition codes are shown as stored on the workorder item.</Coverage>
            </div>
            <div className="overflow-x-auto">
              <table aria-label="Units and revenue sold per financial year" className="w-full border text-sm">
                <caption className="px-2 py-1 text-left text-sm font-semibold">Sold per financial year (all time)</caption>
                <thead className="bg-gray-100"><tr><th className="border px-2 py-1 text-left">Year</th><th className="border px-2 py-1 text-right">Units</th><th className="border px-2 py-1 text-right">Revenue</th></tr></thead>
                <tbody>
                  {d.by_fy.map((f) => (
                    <tr key={f.fy}><th scope="row" className="border px-2 py-1 text-left font-normal">FY{f.fy}</th><td className="border px-2 py-1 text-right">{fmtInt(f.units)}</td><td className="border px-2 py-1 text-right">{formatDollars(f.revenue)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table aria-label="Lots in stock over 90 days" className="w-full border text-sm">
              <caption className="px-2 py-1 text-left text-sm font-semibold">Oldest lots in stock (over 90 days)</caption>
              <thead className="bg-gray-100"><tr><th className="border px-2 py-1 text-left">Lot</th><th className="border px-2 py-1 text-left">Product</th><th className="border px-2 py-1 text-right">Days in stock</th></tr></thead>
              <tbody>
                {d.aged.oldest.map((l) => (
                  <tr key={l.lot_number}><th scope="row" className="border px-2 py-1 text-left font-mono font-normal">{l.lot_number}</th><td className="border px-2 py-1">{l.name}</td><td className="border px-2 py-1 text-right">{l.age_days}</td></tr>
                ))}
                {d.aged.oldest.length === 0 && <tr><td colSpan={3} className="border px-2 py-2 text-gray-600">No lot has been in stock over 90 days.</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="overflow-x-auto">
            <table aria-label="Price set but cost missing" className="w-full border text-sm">
              <caption className="px-2 py-1 text-left text-sm font-semibold">Price set but cost missing — clean-up list</caption>
              <thead className="bg-gray-100"><tr><th className="border px-2 py-1 text-left">Product</th><th className="border px-2 py-1 text-right">Price</th><th className="border px-2 py-1 text-right">In stock</th></tr></thead>
              <tbody>
                {d.cost_missing.items.map((p) => (
                  <tr key={p.sku}><th scope="row" className="border px-2 py-1 text-left font-normal">{p.name} <span className="text-xs text-gray-700">{p.sku}</span></th><td className="border px-2 py-1 text-right">{formatDollars(p.price)}</td><td className="border px-2 py-1 text-right">{p.stock}</td></tr>
                ))}
              </tbody>
            </table>
            <Coverage>Showing {d.cost_missing.items.length} of {fmtInt(d.cost_missing.total)} products that have a price but no cost and are in stock or sold in this period (highest stock value first). Recording their cost makes the profit figures more complete.</Coverage>
          </div>
        </div>
      )}
    </section>
  );
}
