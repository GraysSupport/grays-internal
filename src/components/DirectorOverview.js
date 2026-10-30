import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { authHeaders } from '../utils/auth';
import { endExpiredSession } from '../utils/session';
import { formatWhen } from '../utils/lotTracker';
import { formatDollars, formatPct, changeBadge } from '../utils/director';
import { Coverage, Tile } from './DirectorParts';

// G22d (owner, 29 Oct 2026) — Director's View business overview: headline tiles at the top of
// the page for the chosen period. Read-only, superadmin only (the server checks). Each tile says
// what share of the data it rests on; a tile with a section opens it. "Today" tiles are a
// snapshot (open orders, money owed, stock), not the period.

const fmtInt = (v) => Number(v || 0).toLocaleString('en-AU');

export default function DirectorOverview({ period, compare, onOpen }) {
  const navigate = useNavigate();
  const [state, setState] = useState({ loading: true, error: null, data: null });

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    (async () => {
      try {
        const qs = new URLSearchParams({ resource: 'overview', from: period.from, to: period.to });
        if (compare) qs.set('compare', period.compare || '1');
        const res = await fetch(`/api/director?${qs}`, { headers: authHeaders() });
        if (cancelled) return;
        if (res.status === 401) { endExpiredSession(navigate); return; }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not load the overview');
        if (!cancelled) setState({ loading: false, error: null, data });
      } catch (err) {
        if (!cancelled) setState({ loading: false, error: `Could not load the overview: ${err.message}`, data: null });
      }
    })();
    return () => { cancelled = true; };
  }, [period.from, period.to, period.compare, compare, navigate]);

  // Only a well-formed overview is drawn.
  const d = state.data?.sales ? state.data : null;
  const badge = (cur, prev) => (compare && d?.previous ? changeBadge(cur, prev) : null);
  const open = (section) => (onOpen ? () => onOpen(section) : undefined);
  const maxState = Math.max(1, ...(d?.states || []).map((s) => s.sales));

  return (
    <section aria-label="Business overview" className="space-y-3 rounded-xl border bg-white p-4">
      <h2 className="text-lg font-bold">Business overview</h2>
      {state.error && <p role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">{state.error}</p>}
      {state.loading && <p role="status" className="text-sm text-gray-700">{d ? 'Updating…' : 'Loading…'}</p>}
      {d && (
        <div aria-busy={state.loading} className={`space-y-3 ${state.loading ? 'opacity-60' : ''}`}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Tile
              label="Sales this period" value={formatDollars(d.sales.value)} badge={badge(d.sales.value, d.sales.previous)} onOpen={open('sales')}
              note={`${fmtInt(d.sales.workorders)} workorders · ${d.sales.priced_lines} of ${d.sales.lines} lines priced on the order, the rest estimated from the list price`}
            />
            <Tile
              label="Gross profit" value={formatDollars(d.profit.gross_profit)} badge={badge(d.profit.gross_profit, d.profit.previous)} onOpen={open('products')}
              note={`${formatPct(d.profit.margin)} gross margin on ${d.profit.costed_lines} of ${d.profit.lines} lines with a cost (refurbishment labour not included)`}
            />
            <Tile
              label="Open orders (today)" value={formatDollars(d.pipeline.value)} onOpen={open('sales')}
              note={`${fmtInt(d.pipeline.workorders)} open workorders · ${d.pipeline.estimated_lines} of ${d.pipeline.lines} lines estimated from the list price${d.pipeline.unpriced_lines ? `, ${d.pipeline.unpriced_lines} with no price` : ''}`}
            />
            <Tile
              label="Money still owed (today)" value={formatDollars(d.owed.total)} onOpen={open('sales')}
              note={`${fmtInt(d.owed.workorders)} workorders · ${formatDollars(d.owed.open_total)} on ${fmtInt(d.owed.open_workorders)} open ones${d.owed.credit_workorders ? ` · ${d.owed.credit_workorders} in credit, not netted off` : ''}`}
            />
            <Tile
              label="Delivery net margin" value={formatDollars(d.deliveries.net)} badge={badge(d.deliveries.net, d.deliveries.previous)} onOpen={open('deliveries')}
              note={`Charged minus carrier cost · ${d.deliveries.jobs_both} of ${d.deliveries.jobs} jobs have both a cost and a charge`}
            />
            <Tile
              label="Workshop items completed" value={fmtInt(d.workshop.items_completed)} badge={badge(d.workshop.items_completed, d.workshop.previous)}
              note={`${fmtInt(d.workshop.in_workshop_now)} in the workshop now · average ${d.workshop.avg_days ?? '—'} days in the workshop (${d.workshop.items_timed} of ${d.workshop.items_completed} items have a workshop start)`}
            />
            <Tile
              label="On-time completion" value={formatPct(d.on_time.pct)} onOpen={open('sales')}
              note={`${d.on_time.on_time} of ${d.on_time.eligible} completed workorders with a target date and a completion record${compare && d.previous && d.on_time.previous != null ? ` · ${formatPct(d.on_time.previous)} last time` : ''}`}
            />
            <Tile
              label="Stock value at cost (today)" value={formatDollars(d.stock.value_cost)} onOpen={open('products')}
              note={(
                <>
                  {fmtInt(d.stock.units_costed)} of {fmtInt(d.stock.units)} units have a cost
                  {d.stock.free_weights?.available && (
                    <span className="block">Brand New Free Weights: {formatDollars(d.stock.free_weights.value_cost)} at cost ({fmtInt(d.stock.free_weights.units_costed)} of {fmtInt(d.stock.free_weights.units)} units costed)</span>
                  )}
                </>
              )}
            />
          </div>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <div className="rounded-lg border bg-gray-50 p-3">
              <h3 className="text-sm font-semibold">Customers this period: {fmtInt(d.customers.total)}</h3>
              <p className="text-sm">{d.customers.individual} individual · {d.customers.business} business{d.customers.not_set ? ` · ${d.customers.not_set} not set` : ''}</p>
              <p className="text-sm">{d.customers.new} new · {d.customers.returning} returning</p>
              <Coverage>New = their first workorder is in this period; history starts {formatWhen(d.customers.history_from, true)}, so early periods show most customers as new.</Coverage>
            </div>
            <div className="rounded-lg border bg-gray-50 p-3">
              <h3 className="text-sm font-semibold">Sales by delivery state</h3>
              <ul aria-label="Sales by delivery state" className="mt-1 space-y-1">
                {d.states.map((s) => (
                  <li key={s.state} className="flex items-center gap-2 text-sm">
                    <span className="w-24 shrink-0 truncate">{s.state}</span>
                    <span className="h-3 rounded bg-[#B50B1D]" style={{ width: `${Math.max(2, (s.sales / maxState) * 50)}%` }} aria-hidden="true" />
                    <span>{formatDollars(s.sales)} · {fmtInt(s.workorders)} WOs</span>
                  </li>
                ))}
                {d.states.length === 0 && <li className="text-sm text-gray-600">No workorders in this period.</li>}
              </ul>
              <Coverage>By the workorder&apos;s delivery state — customers have no state of their own.</Coverage>
            </div>
          </div>
          <Coverage>
            Period figures follow the period picker; tiles marked “today” are as of now. Sales, profit and customers count workorders by the date created; workshop items by the day they were first marked Completed.
            {compare && d.previous && ` ▲/▼ compares with ${formatWhen(d.previous.range.from, true)} – ${formatWhen(d.previous.range.to, true)}.`}
          </Coverage>
        </div>
      )}
    </section>
  );
}
