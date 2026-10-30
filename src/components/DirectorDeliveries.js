import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { authHeaders } from '../utils/auth';
import { endExpiredSession } from '../utils/session';
import { formatDollars, formatPct, changeBadge, monthLabel } from '../utils/director';
import { Coverage, Tile } from './DirectorParts';

// G22c (owner, 29 Oct 2026) — Director's View: deliveries & removalists, the live version of the
// 22 Sep 2026 rate-card review. Read-only, superadmin only (the server checks). Money figures
// that compare cost with charge use only jobs where BOTH are entered, and say how many that is.

const fmtInt = (v) => Number(v || 0).toLocaleString('en-AU');
const signedPct = (r) => (r === null || r === undefined ? '—' : `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(Math.round(r * 100))}%`);

const ZONE_NOTE = {
  drift: 'drifted over 10% — card needs a refresh',
  ok: 'within 10% of the card',
  'too-few': 'too few single-item jobs to judge',
  'several-zones': 'several card zones in this state — needs suburbs mapped to zones',
  'no-card': 'no card zone',
};

export default function DirectorDeliveries({ period, compare }) {
  const navigate = useNavigate();
  const [state, setState] = useState({ loading: true, error: null, data: null });

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    (async () => {
      try {
        const qs = new URLSearchParams({ resource: 'deliveries', from: period.from, to: period.to });
        if (compare) qs.set('compare', period.compare || '1');
        const res = await fetch(`/api/director?${qs}`, { headers: authHeaders() });
        if (cancelled) return;
        if (res.status === 401) { endExpiredSession(navigate); return; }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not load the delivery figures');
        if (!cancelled) setState({ loading: false, error: null, data });
      } catch (err) {
        if (!cancelled) setState({ loading: false, error: err.message, data: null });
      }
    })();
    return () => { cancelled = true; };
  }, [period.from, period.to, period.compare, compare, navigate]);

  const d = state.data;
  const markup = d ? Math.round((d.target_markup - 1) * 100) : 20;
  return (
    <section aria-label="Deliveries & removalists" className="space-y-4 rounded-xl border bg-white p-4">
      <h2 className="text-lg font-bold">Deliveries &amp; removalists</h2>
      {state.error && <p role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">{state.error}</p>}
      {state.loading && <p role="status" className="text-sm text-gray-700">{d ? 'Updating…' : 'Loading…'}</p>}
      {d && (
        <div aria-busy={state.loading} className={`space-y-4 ${state.loading ? 'opacity-60' : ''}`}>
          <div className="space-y-1">
            <Coverage>Cost vs charge: {fmtInt(d.coverage.jobs_both)} of {fmtInt(d.coverage.jobs)} jobs have both a carrier cost and a charge entered — the price difference, recovery and target use those jobs only. A carrier cost of $0 means “not entered”.</Coverage>
            <Coverage>{fmtInt(d.coverage.excluded_collects)} Customer Collect pickups are left out (by delivery type, state or the “Customer Collect” removalist). A job is in the period by its delivery date, else the date it was created. “Free” means charged exactly $0.</Coverage>
            <Coverage>Assumes the carrier cost and the charge are on the same GST footing (both as stored) — to be confirmed. Target = carrier cost + {markup}% (the rate-card review&apos;s target, about 17% gross margin).</Coverage>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-4">
            <Tile label="Price difference (charged − carrier cost)" value={formatDollars(d.totals.price_difference)}
              badge={compare && d.previous ? changeBadge(d.totals.price_difference, d.previous.totals.price_difference) : null}
              note={`Charged ${formatDollars(d.totals.both_charged)} vs carrier ${formatDollars(d.totals.both_cost)}`} />
            <Tile label="Cost recovered" value={formatPct(d.totals.recovery)} note={`${fmtInt(d.totals.jobs_both)} comparable jobs`} />
            <Tile label="Jobs that lost money" value={fmtInt(d.totals.loss_jobs)} note={`of ${fmtInt(d.totals.jobs_both)} comparable · ${formatDollars(d.totals.loss_amount)} lost`} />
            <Tile label="Free deliveries" value={fmtInt(d.totals.free_jobs)} note={`${formatDollars(d.totals.free_cost)} carrier cost absorbed on ${fmtInt(d.totals.free_jobs_with_cost)} of ${fmtInt(d.totals.free_jobs)} free jobs (the rest have no cost entered)`} />
            <Tile label={`Charged vs target (cost + ${markup}%)`} value={formatDollars(d.totals.vs_target)} note={`${fmtInt(d.totals.under_target_jobs)} jobs under target`} />
            <Tile label="Delivery jobs" value={fmtInt(d.totals.jobs)} note={`${fmtInt(d.removalists.length)} removalists`} />
            <Tile label="Cash to removalist" value={fmtInt(d.totals.cash_jobs)} note={`Installation on ${fmtInt(d.totals.install_jobs)} jobs (${formatDollars(d.totals.install_cost)})`} />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border text-sm">
              <caption className="px-2 py-1 text-left text-sm font-semibold">By removalist</caption>
              <thead className="bg-gray-100">
                <tr>
                  {['Removalist', 'Jobs', 'Comparable jobs', 'Carrier cost (comparable)', 'Charged (comparable)', 'Price difference', 'Recovery', 'Avg cost (jobs with a cost)', 'Median cost (jobs with a cost)', 'Lost money', 'Free', 'Vs target'].map((h, i) => (
                    <th key={h} className={`border px-2 py-1 ${i === 0 ? 'text-left' : 'text-right'}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {d.removalists.map((r) => (
                  <tr key={r.removalist_id ?? 'none'} aria-label={r.removalist}>
                    <th scope="row" className="border px-2 py-1 text-left font-normal">{r.removalist}</th>
                    <td className="border px-2 py-1 text-right">{fmtInt(r.jobs)}</td>
                    <td className="border px-2 py-1 text-right">{fmtInt(r.jobs_both)}</td>
                    <td className="border px-2 py-1 text-right">{r.jobs_both ? formatDollars(r.both_cost) : '—'}</td>
                    <td className="border px-2 py-1 text-right">{r.jobs_both ? formatDollars(r.both_charged) : '—'}</td>
                    <td className="border px-2 py-1 text-right">{r.jobs_both ? formatDollars(r.price_difference) : '—'}</td>
                    <td className="border px-2 py-1 text-right">{formatPct(r.recovery)}</td>
                    <td className="border px-2 py-1 text-right">{formatDollars(r.avg_cost)}</td>
                    <td className="border px-2 py-1 text-right">{formatDollars(r.median_cost)}</td>
                    <td className="border px-2 py-1 text-right whitespace-nowrap">{r.jobs_both ? `${fmtInt(r.loss_jobs)} (${formatDollars(r.loss_amount)})` : '—'}</td>
                    <td className="border px-2 py-1 text-right whitespace-nowrap">{fmtInt(r.free_jobs)}{r.free_jobs_with_cost ? ` (${formatDollars(r.free_cost)} on ${fmtInt(r.free_jobs_with_cost)})` : ''}</td>
                    <td className="border px-2 py-1 text-right">{r.jobs_both ? formatDollars(r.vs_target) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border text-sm">
              <caption className="px-2 py-1 text-left text-sm font-semibold">By state vs the 22 Sep 2026 rate card (single-item jobs)</caption>
              <thead className="bg-gray-100">
                <tr>
                  {['State', 'Jobs', 'Single-item jobs', 'Avg single-item cost', 'Card zone base', 'Drift', 'Price difference'].map((h, i) => (
                    <th key={h} className={`border px-2 py-1 ${i === 0 ? 'text-left' : 'text-right'}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {d.states.map((s) => (
                  <tr key={s.state} aria-label={s.state}>
                    <th scope="row" className="border px-2 py-1 text-left font-normal">{s.state}</th>
                    <td className="border px-2 py-1 text-right">{fmtInt(s.jobs)}</td>
                    <td className="border px-2 py-1 text-right">{fmtInt(s.single_jobs)}</td>
                    <td className="border px-2 py-1 text-right">{formatDollars(s.single_avg_cost)}</td>
                    <td className="border px-2 py-1 text-right">{s.card_base ? `${s.card_zone} ${formatDollars(s.card_base)}` : '—'}</td>
                    <td className={`border px-2 py-1 text-right ${s.flag === 'drift' ? 'font-semibold text-red-800' : ''}`}>
                      {s.drift !== null && <span>{signedPct(s.drift)} </span>}
                      <span className="text-xs">{s.flag === 'drift' && <span aria-hidden="true">⚠ </span>}{ZONE_NOTE[s.flag]}</span>
                      {s.regional_caveat && <span className="block text-xs font-normal text-gray-700">includes regional jobs; drift may be overstated</span>}
                    </td>
                    <td className="border px-2 py-1 text-right">{s.price_difference === null ? '—' : formatDollars(s.price_difference)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Coverage>The rate card prices zones (e.g. Melbourne Metro / Outer / VIC Regional); deliveries only record a state, so a state is compared only when one card zone stands for it — ACT, Tasmania and NT, plus SA and WA against the Adelaide and Perth metro bases (regional jobs there push the average up).</Coverage>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border text-sm">
              <caption className="px-2 py-1 text-left text-sm font-semibold">Like-for-like carriers (same state, single-item jobs)</caption>
              <thead className="bg-gray-100"><tr><th className="border px-2 py-1 text-left">State</th><th className="border px-2 py-1 text-left">Removalist</th><th className="border px-2 py-1 text-right">Jobs</th><th className="border px-2 py-1 text-right">Avg cost</th><th className="border px-2 py-1 text-right">Median cost</th></tr></thead>
              <tbody>
                {d.like_for_like.flatMap((g) => g.carriers.map((c, i) => (
                  <tr key={`${g.state}-${c.removalist_id ?? 'none'}`}>
                    {i === 0 && <th scope="rowgroup" rowSpan={g.carriers.length} className="border px-2 py-1 text-left align-top font-normal">{g.state}</th>}
                    <td className="border px-2 py-1">{c.removalist}</td>
                    <td className="border px-2 py-1 text-right">{fmtInt(c.jobs)}</td>
                    <td className="border px-2 py-1 text-right">{formatDollars(c.avg_cost)}</td>
                    <td className="border px-2 py-1 text-right">{formatDollars(c.median_cost)}</td>
                  </tr>
                )))}
                {d.like_for_like.length === 0 && <tr><td colSpan={5} className="border px-2 py-2 text-gray-600">No state had two or more carriers on single-item jobs.</td></tr>}
              </tbody>
            </table>
            <Coverage>Carriers are zone specialists, so they are only compared inside one state — averages across states would mislead.</Coverage>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border text-sm">
              <caption className="px-2 py-1 text-left text-sm font-semibold">Monthly cost, charge and margin (comparable jobs)</caption>
              <thead className="bg-gray-100"><tr><th className="border px-2 py-1 text-left">Month</th><th className="border px-2 py-1 text-right">Jobs</th><th className="border px-2 py-1 text-right">Carrier cost</th><th className="border px-2 py-1 text-right">Charged</th><th className="border px-2 py-1 text-right">Margin</th></tr></thead>
              <tbody>
                {d.monthly.map((m) => (
                  <tr key={m.month}>
                    <th scope="row" className="border px-2 py-1 text-left font-normal">{monthLabel(m.month)}</th>
                    <td className="border px-2 py-1 text-right">{fmtInt(m.jobs)} ({fmtInt(m.jobs_both)} comparable)</td>
                    <td className="border px-2 py-1 text-right">{m.jobs_both ? formatDollars(m.cost) : '—'}</td>
                    <td className="border px-2 py-1 text-right">{m.jobs_both ? formatDollars(m.charged) : '—'}</td>
                    <td className={`border px-2 py-1 text-right ${m.margin < 0 ? 'text-red-800' : ''}`}>{m.margin === null ? '—' : formatDollars(m.margin)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
