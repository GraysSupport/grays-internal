import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import BackButton from '../components/backbutton';
import HomeButton from '../components/homebutton';
import { authHeaders, getRoles, hasAnyRole } from '../utils/auth';
import { endExpiredSession } from '../utils/session';
import { formatWhen } from '../utils/lotTracker';
import { periodPresets, formatDollars, formatPct, changeBadge, monthsBetween, monthLabel } from '../utils/director';
import { Change, Coverage } from '../components/DirectorParts';
import DirectorProducts from '../components/DirectorProducts';
import DirectorDeliveries from '../components/DirectorDeliveries';

// G22 Director's View (owner, 29 Oct 2026) — superadmin only; read-only performance figures.
// G22a = the shell (period picker, compare, coverage lines) + the sales team section. The server
// (lib/director.js) re-checks superadmin on every request; the check here only decides what to
// show. Every money figure is AUD, GST-inclusive as stored; every section says what share of the
// data its numbers rest on, so a low-coverage figure is never mistaken for the truth.

const PRIMARY = 'rounded bg-[#B50B1D] px-4 py-2 text-white hover:bg-[#8f0917] disabled:opacity-50';
// The sections (one per G22 phase). Only the open one loads its figures.
const SECTIONS = [
  { key: 'sales', label: 'Sales team' },
  { key: 'products', label: 'Products & profit' },
  { key: 'deliveries', label: 'Deliveries & removalists' },
];

function PeriodPicker({ presets, value, onChange }) {
  const [key, setKey] = useState(value.key);
  const [from, setFrom] = useState(value.from);
  const [to, setTo] = useState(value.to);
  const pick = (k) => {
    setKey(k);
    const p = presets.find((x) => x.key === k);
    if (p) onChange({ ...p });
  };
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="text-sm">
        <span className="block font-medium">Period</span>
        <select className="rounded border p-2" value={key} onChange={(e) => pick(e.target.value)}>
          {presets.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          <option value="custom">Custom range…</option>
        </select>
      </label>
      {key === 'custom' && (
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (from && to && from <= to) onChange({ key: 'custom', label: 'Custom', from, to, compare: '1' }); }}>
          <label className="text-sm"><span className="block font-medium">From</span><input type="date" className="rounded border p-2" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="text-sm"><span className="block font-medium">To</span><input type="date" className="rounded border p-2" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <button type="submit" className={PRIMARY} disabled={!from || !to || from > to}>Show</button>
        </form>
      )}
    </div>
  );
}

function Drilldown({ person, range, onClose }) {
  const navigate = useNavigate();
  const [state, setState] = useState({ loading: true, error: null, rows: [] });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const qs = new URLSearchParams({ resource: 'sales-workorders', salesperson: person.salesperson, from: range.from, to: range.to });
        const res = await fetch(`/api/director?${qs}`, { headers: authHeaders() });
        if (cancelled) return;
        if (res.status === 401) { endExpiredSession(navigate); return; }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not load the workorders');
        if (!cancelled) setState({ loading: false, error: null, rows: data.workorders || [] });
      } catch (err) {
        if (!cancelled) setState({ loading: false, error: err.message, rows: [] });
      }
    })();
    return () => { cancelled = true; };
  }, [person.salesperson, range.from, range.to, navigate]);
  const title = `${person.salesperson_name} — workorders`;
  return (
    <section aria-label={title} className="mt-4 rounded-xl border bg-white p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold">{title}</h3>
        <button type="button" onClick={onClose} className="text-sm text-gray-700 underline">Close</button>
      </div>
      {state.loading && <p className="text-sm text-gray-600">Loading…</p>}
      {state.error && <p role="alert" className="text-sm text-red-800">{state.error}</p>}
      {!state.loading && !state.error && (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-gray-700"><th className="px-2 py-1">Workorder</th><th className="px-2 py-1">Created</th><th className="px-2 py-1">Status</th><th className="px-2 py-1 text-right">Sales</th><th className="px-2 py-1 text-right">Balance owed</th></tr></thead>
            <tbody>
              {state.rows.map((w) => (
                <tr key={w.workorder_id} className="border-t">
                  <td className="px-2 py-1"><Link className="text-blue-700 underline" to={`/delivery_operations/workorder/${w.workorder_id}`}>{w.invoice_id || `WO ${w.workorder_id}`}</Link></td>
                  <td className="px-2 py-1">{formatWhen(w.date_created)}</td>
                  <td className="px-2 py-1">{w.status}</td>
                  <td className="px-2 py-1 text-right">{formatDollars(w.sales)}</td>
                  <td className="px-2 py-1 text-right">{formatDollars(w.outstanding_balance)}</td>
                </tr>
              ))}
              {state.rows.length === 0 && <tr><td colSpan={5} className="px-2 py-2 text-gray-600">No workorders in this period.</td></tr>}
            </tbody>
          </table>
          {state.rows.length >= 500 && <Coverage>Showing the latest 500.</Coverage>}
        </div>
      )}
    </section>
  );
}

const COLS = [
  ['Sales', (s) => formatDollars(s.sales), true],
  ['Workorders', (s) => s.workorders],
  ['Invoices', (s) => s.invoices],
  ['Avg order', (s) => formatDollars(s.aov)],
  ['Units', (s) => s.units],
  ['Gross profit', (s) => formatDollars(s.gross_profit)],
  ['Margin', (s) => formatPct(s.margin)],
  ['Delivery charged', (s) => formatDollars(s.delivery_charged)],
  ['Carrier cost', (s) => formatDollars(s.carrier_cost)],
  ['Delivery net', (s) => formatDollars(s.delivery_net)],
  ['Free deliveries', (s) => `${s.free_jobs} (${formatDollars(s.free_cost)})`],
  ['Owed on open WOs', (s) => formatDollars(s.outstanding)],
  ['Open / completed', (s) => `${s.open} / ${s.completed}`],
  ['Avg days to complete', (s) => (s.avg_days == null ? '—' : s.avg_days)],
  ['On time', (s) => formatPct(s.on_time_pct)],
  ['E-commerce', (s) => s.ecommerce],
];

function SalesTeam({ data, compare, range }) {
  const [open, setOpen] = useState(null);
  const prevBy = useMemo(() => new Map((data.previous?.salespeople || []).map((p) => [p.salesperson, p])), [data]);
  const max = Math.max(1, ...data.salespeople.map((s) => s.sales));
  const months = monthsBetween(range.from, range.to);
  const c = data.coverage;
  const prevTotal = data.previous?.totals?.sales;

  return (
    <section aria-labelledby="dv-sales" className="rounded-xl border bg-white p-4">
      <h2 id="dv-sales" className="text-lg font-bold">Sales team</h2>
      <div className="mt-2 space-y-1">
        <Coverage>Sales value: {c.priced_lines} of {c.lines} lines use the price on the order; {c.estimated_lines} are estimated from the product list price{c.unpriced_lines ? `; ${c.unpriced_lines} have no price and count as $0` : ''}. Canceled items are excluded.</Coverage>
        <Coverage>Profit: {c.costed_lines} of {c.lines} lines have a cost set — gross profit and margin cover those lines only (an unknown cost is never counted as $0).</Coverage>
        <Coverage>Completion: {c.completed_timed} of {c.completed} completed workorders have a completion record (days to complete and on-time use those). Outstanding is today&apos;s balance on open workorders created in the period.</Coverage>
        <Coverage>Deliveries: Customer Collect excluded; “free” means charged exactly $0; of {c.delivery_jobs} jobs, {c.jobs_no_cost} have no carrier cost entered (counted as $0) and {c.jobs_no_charge ?? 0} have no charge entered (not counted as free). The total invoice count is distinct across the team. Invoices are counted once per salesperson — one invoice number can appear on more than one workorder.</Coverage>
        <Coverage>E-commerce: the flag is set on {c.ecommerce} of {c.workorders} workorders, so it may not be reliable.</Coverage>
      </div>

      <ul className="mt-4 space-y-1" aria-label="Sales by salesperson">
        {data.salespeople.map((s) => (
          <li key={s.salesperson} className="flex items-center gap-2 text-sm">
            <span className="w-40 shrink-0 truncate">{s.salesperson_name}</span>
            <span className="h-3 rounded bg-[#B50B1D]" style={{ width: `${Math.max(2, (s.sales / max) * 60)}%` }} aria-hidden="true" />
            <span>{formatDollars(s.sales)}</span>
          </li>
        ))}
      </ul>

      <div className="mt-4 overflow-x-auto">
        <table aria-label="Sales team performance" className="w-full border text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="border px-2 py-1 text-left">Salesperson</th>
              {COLS.map(([h]) => <th key={h} className="border px-2 py-1 text-right">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {data.salespeople.map((s) => (
              <tr key={s.salesperson ?? 'unassigned'} aria-label={s.salesperson_name}>
                <th scope="row" className="border px-2 py-1 text-left font-medium">
                  {s.salesperson ? (
                    <button type="button" onClick={() => setOpen(s)} aria-label={`Show workorders for ${s.salesperson_name}`} className="text-left text-blue-700 underline">
                      {s.salesperson_name}
                    </button>
                  ) : s.salesperson_name}
                </th>
                {COLS.map(([h, f, withChange]) => (
                  <td key={h} className="border px-2 py-1 text-right whitespace-nowrap">
                    {f(s)}
                    {withChange && compare && data.previous && <Change badge={changeBadge(s.sales, prevBy.get(s.salesperson)?.sales ?? 0)} />}
                  </td>
                ))}
              </tr>
            ))}
            <tr aria-label="Total" className="bg-gray-50 font-semibold">
              <th scope="row" className="border px-2 py-1 text-left">Total</th>
              {COLS.map(([h, f, withChange]) => (
                <td key={h} className="border px-2 py-1 text-right whitespace-nowrap">
                  {f(data.totals)}
                  {withChange && compare && data.previous && <Change badge={changeBadge(data.totals.sales, prevTotal)} />}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      {compare && data.previous && (
        <Coverage>
          ▲/▼ compares sales with {data.previous.mode === 'year' ? 'the same dates a year earlier' : 'the period just before'}: {formatWhen(data.previous.range.from, true)} – {formatWhen(data.previous.range.to, true)}.
        </Coverage>
      )}

      {open && <Drilldown person={open} range={range} onClose={() => setOpen(null)} />}

      <h3 className="mt-6 text-base font-semibold">Monthly sales</h3>
      <div className="mt-2 overflow-x-auto">
        <table aria-label="Monthly sales by salesperson" className="w-full border text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="border px-2 py-1 text-left">Salesperson</th>
              {months.map((m) => <th key={m} className="border px-2 py-1 text-right whitespace-nowrap">{monthLabel(m)}</th>)}
            </tr>
          </thead>
          <tbody>
            {data.salespeople.map((s) => (
              <tr key={s.salesperson}>
                <th scope="row" className="border px-2 py-1 text-left font-medium">{s.salesperson_name}</th>
                {months.map((m) => <td key={m} className="border px-2 py-1 text-right">{formatDollars(data.monthly?.[s.salesperson]?.[m] ?? 0)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function DirectorPage({ now }) {
  const navigate = useNavigate();
  const isSuperadmin = hasAnyRole(getRoles(), ['superadmin']);
  const presets = useMemo(() => periodPresets(now || new Date()), [now]);
  const [period, setPeriod] = useState(presets[0]);
  const [compare, setCompare] = useState(true);
  const [section, setSection] = useState('sales');
  const [state, setState] = useState({ loading: true, error: null, data: null });

  const load = useCallback(async (signal) => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const qs = new URLSearchParams({ resource: 'sales', from: period.from, to: period.to });
      if (compare) qs.set('compare', period.compare || '1');
      const res = await fetch(`/api/director?${qs}`, { headers: authHeaders() });
      if (res.status === 401) { endExpiredSession(navigate); return; }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not load the Director's View");
      if (!signal.cancelled) setState({ loading: false, error: null, data });
    } catch (err) {
      if (!signal.cancelled) setState({ loading: false, error: err.message, data: null });
    }
  }, [period.from, period.to, period.compare, compare, navigate]);

  useEffect(() => {
    if (!isSuperadmin || section !== 'sales') return undefined;
    const signal = { cancelled: false };
    load(signal);
    return () => { signal.cancelled = true; };
  }, [isSuperadmin, section, load]);

  return (
    <>
      <div className="fixed top-4 left-6 z-50 flex gap-2">
        <HomeButton />
        <BackButton />
      </div>
      <div className="min-h-screen bg-gray-100 p-6 max-sm:pt-16">
        <h1 className="mb-4 text-center text-xl font-bold">Director&apos;s View</h1>
        {!isSuperadmin ? (
          <p className="rounded border bg-white p-4 text-center text-sm text-gray-700">Superadmin only.</p>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-3 rounded-xl border bg-white p-4">
              <PeriodPicker presets={presets} value={period} onChange={setPeriod} />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} />
                Compare with the previous period
              </label>
            </div>
            <p className="text-xs text-gray-700">
              {formatWhen(period.from, true)} – {formatWhen(period.to, true)} · All money is AUD, GST-inclusive as stored, rounded to the dollar. Read-only — nothing here changes any record.
            </p>
            <div role="tablist" aria-label="Director's View sections" className="flex gap-1 border-b border-gray-300">
              {SECTIONS.map((s) => (
                <button
                  key={s.key}
                  id={`dv-tab-${s.key}`}
                  type="button"
                  role="tab"
                  aria-selected={section === s.key}
                  aria-controls={section === s.key ? `dv-panel-${s.key}` : undefined}
                  onClick={() => setSection(s.key)}
                  className={`-mb-px border-b-2 px-4 py-2 text-sm font-semibold ${section === s.key ? 'border-[#B50B1D] text-gray-900' : 'border-transparent text-gray-700 hover:text-gray-900'}`}
                >
                  {s.label}
                </button>
              ))}
            </div>
            {section === 'deliveries' ? (
              <div role="tabpanel" id="dv-panel-deliveries" aria-labelledby="dv-tab-deliveries">
                <DirectorDeliveries period={period} compare={compare} />
              </div>
            ) : section === 'products' ? (
              <div role="tabpanel" id="dv-panel-products" aria-labelledby="dv-tab-products">
                <DirectorProducts period={period} compare={compare} />
              </div>
            ) : (
              <div role="tabpanel" id="dv-panel-sales" aria-labelledby="dv-tab-sales" className="space-y-4">
                {state.error && <p role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">{state.error}</p>}
                {state.loading && !state.data && <p className="text-sm text-gray-600">Loading…</p>}
                {state.loading && state.data && <p role="status" className="text-sm text-gray-700">Updating…</p>}
                {state.data && (
                  <div aria-busy={state.loading} className={state.loading ? 'opacity-60' : ''}>
                    <SalesTeam data={state.data} compare={compare} range={state.data.range} />
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
