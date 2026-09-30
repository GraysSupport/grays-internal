import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import DeliveryTabs from '../../components/DeliveryTabs';
import StopOrderList from '../../components/StopOrderList';
import { authHeaders, getRoles, hasAnyRole } from '../../utils/auth';
import { endExpiredSession } from '../../utils/session';
import {
  emptyPlan, toStop, addRun, updateRun, removeRun, addStop, removeStop, moveStop,
  plannedKeys, buildCsv, buildRunSheetHtml, loadPlan, savePlan, clearPlan, refreshStops,
  TEMP_RUN_ROLES,
} from '../../utils/tempRun';

// G8 (Nick, 28 Sep 2026) — "Create temporary delivery run".
//
// Logistics picks stops from current workorders and to-be-booked deliveries, groups them into
// runs (carrier + planned day), orders them, and prints or exports a run sheet to send drivers
// BEFORE anything is booked.
//
// ⛔ HARD RULE: this page never writes. Its only request is the gated read
// GET /api/logistics?resource=run-candidates. The plan lives in this browser (localStorage)
// until "Clear run". Nothing here books a delivery, changes a status or writes a log row —
// pinned by src/pages/__tests__/tempDeliveryRun.test.js ("ZERO WRITE REQUESTS").

export { TEMP_RUN_ROLES };
const BRAND_RED = '#B50B1D';

function isPristine(plan) {
  return plan.runs.length === 1 && plan.runs[0].stops.length === 0
    && !plan.runs[0].carrier && !plan.runs[0].day;
}

// A distinct accessible name per row: two customers can share a name, and a row can lack one.
function stopRef(stop) {
  if (stop.workorder_id != null) return `WO ${stop.workorder_id}`;
  return `delivery ${stop.delivery_id}`;
}

function CandidateRow({ stop, onAdd }) {
  return (
    <li className="flex items-start gap-3 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="font-medium text-gray-900">{stop.customer_name || '—'}</div>
        <div className="text-sm text-gray-600">
          {[stop.suburb, stop.state].filter(Boolean).join(' ') || 'No suburb'}
          {stop.workorder_id != null && <> · WO {stop.workorder_id}</>}
          {stop.invoice_id && <> · Inv {stop.invoice_id}</>}
        </div>
        <div className="truncate text-sm text-gray-700" title={stop.items_text}>{stop.items_text}</div>
      </div>
      <button
        type="button"
        aria-label={`Add ${stop.customer_name || 'stop'} (${stopRef(stop)}) to run`}
        onClick={() => onAdd(stop)}
        className="shrink-0 rounded-lg border px-3 py-1.5 text-sm font-medium hover:bg-gray-50"
      >
        + Add
      </button>
    </li>
  );
}

// One stop as it appears on a run. `live` = still in the candidates list; `nowDelivery` = a
// planned workorder that has since completed and become a To-Be-Booked delivery.
function RunStop({ stop: s, ready, live, nowDelivery }) {
  return (
    <div>
      <div className="font-medium" data-testid="stop-name">{s.customer_name || '—'}</div>
      <div className="text-sm text-gray-700">
        {s.phone || 'No phone'}
        {s.workorder_id != null && <> · WO {s.workorder_id}</>}
        {s.delivery_type && <> · <span className="font-medium">{s.delivery_type}</span></>}
      </div>
      <div className="text-sm text-gray-600">{[s.suburb, s.state].filter(Boolean).join(' ') || 'No suburb'}</div>
      <div className="text-sm text-gray-700">{s.items_text}</div>
      {s.notes && <div className="text-sm italic text-gray-600">{s.notes}</div>}
      {s.internal_notes && (
        <div className="text-sm text-gray-600">
          <span className="font-medium">Workorder notes (internal — not printed):</span> {s.internal_notes}
        </div>
      )}
      {ready && !live && (
        s.source === 'workorder' && nowDelivery ? (
          <div className="mt-1 inline-block rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700">
            Workorder completed — now a To-Be-Booked delivery. The stop stays as planned.
          </div>
        ) : (
          <div className="mt-1 inline-block rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-900">
            No longer waiting to be booked — check before sending this sheet.
          </div>
        )
      )}
    </div>
  );
}

export default function TempDeliveryRunPage() {
  const navigate = useNavigate();
  const allowed = useMemo(() => hasAnyRole(getRoles(), TEMP_RUN_ROLES), []);

  const [plan, setPlan] = useState(loadPlan);
  const [targetRunId, setTargetRunId] = useState(null);
  const [candidates, setCandidates] = useState({ deliveries: [], workorders: [], removalists: [] });
  // Left panel shows one source at a time (Nick, 29 Sep 2026): 'tbb' = To be booked,
  // 'ops' = Current operations (workorders still Work Ordered).
  const [source, setSource] = useState('tbb');
  const [status, setStatus] = useState('loading'); // loading | ready | forbidden | error
  const [search, setSearch] = useState('');

  // Keep the draft across refreshes. A pristine plan is removed rather than stored, so
  // "Clear run" really leaves nothing behind.
  useEffect(() => {
    if (isPristine(plan)) clearPlan();
    else savePlan(plan);
  }, [plan]);

  const load = useCallback(async () => {
    setStatus('loading');
    try {
      const res = await fetch('/api/logistics?resource=run-candidates', { headers: authHeaders() });
      if (res.status === 401) { endExpiredSession(navigate); return; }
      if (res.status === 403) { setStatus('forbidden'); return; }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Could not load stops');
      setCandidates({
        deliveries: Array.isArray(data.deliveries) ? data.deliveries : [],
        workorders: Array.isArray(data.workorders) ? data.workorders : [],
        removalists: Array.isArray(data.removalists) ? data.removalists : [],
      });
      setStatus('ready');
    } catch (e) {
      setStatus('error');
      toast.error(e.message || 'Could not load stops');
    }
  }, [navigate]);

  useEffect(() => {
    if (!localStorage.getItem('user')) { navigate('/'); return; }
    if (allowed) load();
  }, [allowed, load, navigate]);

  const deliveryStops = useMemo(() => candidates.deliveries.map((r) => toStop(r, 'delivery')), [candidates]);
  const workorderStops = useMemo(() => candidates.workorders.map((r) => toStop(r, 'workorder')), [candidates]);
  const liveKeys = useMemo(
    () => new Set([...deliveryStops, ...workorderStops].map((s) => s.key)),
    [deliveryStops, workorderStops]
  );
  // Workorders that now have a To-Be-Booked delivery row (the workorder completed after it
  // was planned). Same customer, same goods — not a new stop.
  const deliveryWoIds = useMemo(
    () => new Set(deliveryStops.map((s) => s.workorder_id).filter((id) => id != null)),
    [deliveryStops]
  );

  // Pick up corrections (phone, address, items) for stops already on a run, keeping order.
  useEffect(() => {
    if (status !== 'ready') return;
    setPlan((p) => refreshStops(p, [...deliveryStops, ...workorderStops]));
  }, [status, deliveryStops, workorderStops]);

  const planned = useMemo(() => plannedKeys(plan), [plan]);
  const plannedWoIds = useMemo(
    () => new Set([...planned].map((k) => plan.stops[k]?.workorder_id).filter((id) => id != null)),
    [planned, plan.stops]
  );
  const q = search.trim().toLowerCase();
  const visible = useCallback(
    (list) => list.filter((s) => !planned.has(s.key)
      && !(s.workorder_id != null && plannedWoIds.has(s.workorder_id))
      && (!q || [
      s.customer_name, s.suburb, s.state, s.items_text, s.invoice_id, s.workorder_id, s.address,
    ].join(' ').toLowerCase().includes(q))),
    [planned, plannedWoIds, q]
  );

  // Carriers a run can go with. Customer Collect is a pickup, never a run carrier.
  const carrierNames = useMemo(
    () => [...new Set(candidates.removalists
      .map((r) => (r?.name || '').trim())
      .filter((n) => n && n.toLowerCase() !== 'customer collect'))],
    [candidates.removalists]
  );

  const activeRunId = plan.runs.some((r) => r.id === targetRunId) ? targetRunId : plan.runs[0].id;

  const onAdd = (stop) => setPlan((p) => addStop(p, activeRunId, stop));

  // New stops go to the run just added — that's almost always the one being filled next.
  const onAddRun = () => {
    const next = addRun(plan);
    setPlan(next);
    setTargetRunId(next.runs[next.runs.length - 1].id);
  };

  const onClear = () => {
    if (!window.confirm('Clear the temporary run? This only clears this planning draft — nothing is booked or changed.')) return;
    clearPlan();
    setPlan(emptyPlan());
    setTargetRunId(null);
  };

  const hasStops = planned.size > 0;

  const onPrint = () => {
    const win = window.open('', '_blank');
    if (!win) { toast.error('Allow pop-ups for this site to print the run sheet'); return; }
    win.document.open();
    win.document.write(buildRunSheetHtml(plan));
    win.document.close();
  };

  const onExport = () => {
    // BOM so Excel reads the file as UTF-8 (the items text uses "×").
    const blob = new Blob(['﻿', buildCsv(plan)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `temporary-delivery-run-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  if (!allowed) {
    return (
      <div className="flex min-h-screen flex-col bg-gray-50 text-gray-900">
        <main className="flex-1 p-6">
          <div className="mx-auto max-w-lg rounded-xl border bg-white p-6">
            <h1 className="text-xl font-semibold">Temporary delivery run</h1>
            <p className="mt-2 text-gray-700">Planning delivery runs is available to logistics, admin or superadmin users.</p>
            <Link to="/delivery_operations" className="mt-4 inline-block text-sm underline">Back to Delivery Operations</Link>
          </div>
        </main>
        <DeliveryTabs />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-gray-50 text-gray-900">
      <header className="border-b bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Temporary delivery run</h1>
            <p className="text-sm text-gray-600">Plan runs and send drivers a sheet before the deliveries are booked.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onPrint}
              disabled={!hasStops}
              className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              style={{ backgroundColor: BRAND_RED }}
            >
              Print run sheet
            </button>
            <button
              type="button"
              onClick={onExport}
              disabled={!hasStops}
              className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
            >
              Export CSV
            </button>
            <button
              type="button"
              onClick={onClear}
              className="rounded-lg border px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Clear run
            </button>
          </div>
        </div>
        <div
          role="note"
          className="border-t px-4 py-2 text-sm font-medium"
          style={{ backgroundColor: '#FDECEE', color: BRAND_RED }}
        >
          Temporary run — not booked. This is a planning draft saved in this browser only. Nothing here books a delivery or changes a workorder.
        </div>
      </header>

      <div className="grid flex-1 grid-cols-12 gap-6 px-4 py-6">
        {/* Available stops */}
        <section className="col-span-12 lg:col-span-5" aria-labelledby="available-heading">
          <div className="rounded-xl border bg-white">
            <div className="border-b p-4">
              <h2 id="available-heading" className="font-semibold">Available stops</h2>
              <label className="mt-2 block text-sm text-gray-700">
                <span className="sr-only">Search stops</span>
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search name, suburb, items, WO, invoice"
                  aria-label="Search stops"
                  className="w-full rounded-lg border px-3 py-2 outline-none focus:ring-2 focus:ring-gray-300"
                />
              </label>
              {plan.runs.length > 1 && (
                <label className="mt-2 flex items-center gap-2 text-sm text-gray-700">
                  Add stops to
                  <select
                    value={activeRunId}
                    onChange={(e) => setTargetRunId(e.target.value)}
                    className="rounded border px-2 py-1"
                  >
                    {plan.runs.map((r, i) => (
                      <option key={r.id} value={r.id}>{`Run ${i + 1}${r.carrier ? ` — ${r.carrier}` : ''}`}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>

            {status === 'loading' && <p className="p-4 text-sm text-gray-600">Loading stops…</p>}
            {status === 'forbidden' && (
              <p className="p-4 text-sm text-gray-700">You don’t have access to plan delivery runs. Ask a superadmin to add the logistics role.</p>
            )}
            {status === 'error' && (
              <div className="p-4 text-sm text-gray-700">
                Couldn’t load stops.{' '}
                <button type="button" onClick={load} className="underline">Try again</button>
              </div>
            )}
            {status === 'ready' && (
              <>
                <div role="group" aria-label="Show stops from" className="flex gap-1 border-b bg-gray-50 p-2">
                  {[
                    { id: 'tbb', label: 'To be booked', list: deliveryStops },
                    { id: 'ops', label: 'Current operations', list: workorderStops },
                  ].map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      aria-pressed={source === t.id}
                      onClick={() => setSource(t.id)}
                      className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium ${
                        source === t.id ? 'bg-white text-gray-900 shadow ring-1 ring-gray-300' : 'text-gray-700 hover:bg-white'
                      }`}
                    >
                      {t.label} ({visible(t.list).length})
                    </button>
                  ))}
                </div>
                <ul className="divide-y">
                  {visible(source === 'tbb' ? deliveryStops : workorderStops).map((s) => (
                    <CandidateRow key={s.key} stop={s} onAdd={onAdd} />
                  ))}
                  {visible(source === 'tbb' ? deliveryStops : workorderStops).length === 0 && (
                    <li className="px-3 py-3 text-sm text-gray-600">Nothing to add.</li>
                  )}
                </ul>
              </>
            )}
          </div>
        </section>

        {/* Runs */}
        <section className="col-span-12 space-y-4 lg:col-span-7" aria-label="Runs">
          {plan.runs.map((run, ri) => {
            const n = ri + 1;
            const stops = run.stops.map((k) => plan.stops[k]).filter(Boolean);
            return (
              <div key={run.id} className="rounded-xl border bg-white">
                <div className="flex flex-wrap items-end gap-3 border-b p-4">
                  <h2 className="mr-auto font-semibold">Run {n}</h2>
                  <label className="text-sm text-gray-700">
                    <span className="block">Carrier / driver</span>
                    <select
                      aria-label={`Run ${n} carrier`}
                      value={run.carrier}
                      onChange={(e) => { const carrier = e.target.value; setPlan((p) => updateRun(p, run.id, { carrier })); }}
                      className="mt-1 w-48 rounded border bg-white px-2 py-1"
                    >
                      <option value="">Select carrier…</option>
                      {/* A carrier typed before the list existed stays selectable rather than vanishing. */}
                      {run.carrier && !carrierNames.includes(run.carrier) && (
                        <option value={run.carrier}>{`${run.carrier} (not in list)`}</option>
                      )}
                      {carrierNames.map((name) => <option key={name} value={name}>{name}</option>)}
                    </select>
                  </label>
                  <label className="text-sm text-gray-700">
                    <span className="block">Planned day</span>
                    <input
                      type="date"
                      aria-label={`Run ${n} day`}
                      value={run.day}
                      onChange={(e) => { const day = e.target.value; setPlan((p) => updateRun(p, run.id, { day })); }}
                      className="mt-1 rounded border px-2 py-1"
                    />
                  </label>
                  {plan.runs.length > 1 && (
                    <button
                      type="button"
                      aria-label={`Remove run ${n}`}
                      onClick={() => setPlan((p) => removeRun(p, run.id))}
                      className="rounded border px-3 py-1 text-sm text-gray-700 hover:bg-gray-50"
                    >
                      Remove run
                    </button>
                  )}
                </div>
                <div className="p-3">
                  <StopOrderList
                    ariaLabel={`Run ${n} stops`}
                    items={stops}
                    getKey={(s) => s.key}
                    getLabel={(s) => s.customer_name || s.key}
                    onMove={(from, to) => setPlan((p) => moveStop(p, run.id, from, to))}
                    onRemove={(s) => setPlan((p) => removeStop(p, run.id, s.key))}
                    emptyText="No stops yet — add them from the list."
                    renderItem={(s) => (
                      <RunStop stop={s} ready={status === 'ready'} live={liveKeys.has(s.key)} nowDelivery={deliveryWoIds.has(s.workorder_id)} />
                    )}
                  />
                </div>
              </div>
            );
          })}
          <button
            type="button"
            onClick={onAddRun}
            className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-gray-50"
          >
            Add another run
          </button>
        </section>
      </div>

      <DeliveryTabs />
    </div>
  );
}
