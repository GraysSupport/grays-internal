import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import CameraBarcodeScanner from '../components/CameraBarcodeScanner';
import { authHeaders, getRoles, getStoredUser, hasAnyRole } from '../utils/auth';
import { endExpiredSession } from '../utils/session';
import { formatWhen } from '../utils/lotTracker';
import { AUDIO_SUBS, CHECK_ITEMS, canUseTechChecklist, emptyChecks, unansweredItems } from '../utils/techChecklist';

// G16 (Nick, 19 Oct 2026) — Technician screen & electronics checklist.
//
// The paper tag hung on cardio machines with consoles, on a phone: scan the lot sticker
// (camera, USB/Bluetooth scanner, or type it), see which order it is for, tick each line Yes or
// N/A with any fault noted, record the base + console serial numbers, and sign off
// "Screen OK to ship". Saving writes the serials back to the workorder item and the lot; the
// sign-off is recorded (who + when) but never changes the item's workshop status.
//
// Technician / workshop / superadmin, plus the shared WK workshop account — the server
// (lib/techChecklist.js) is the real gate.

const BRAND_RED = '#B50B1D';

function Field({ label, children }) {
  return (
    <div>
      <dt className="text-xs text-gray-600">{label}</dt>
      <dd className="text-sm font-medium text-gray-900 break-words">{children || '—'}</dd>
    </div>
  );
}

function OrderCard({ view, me }) {
  const { lot, order } = view;
  const otherTech = order?.technician_id && me?.isTechnician && order.technician_id !== me.id;
  return (
    <section aria-label="Order" className="rounded-xl border bg-white p-4">
      <div className="text-xs text-gray-600">Lot <span className="font-mono">{lot.lot_number}</span> · {lot.status}</div>
      <h2 className="text-lg font-semibold">{lot.product_name || lot.product_sku}</h2>
      <div className="text-sm text-gray-600">
        {lot.product_brand ? `${lot.product_brand} · ` : ''}SKU <span className="font-mono">{lot.product_sku}</span>
      </div>
      {otherTech && (
        <div role="note" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Assigned to {order.technician_name || order.technician_id}, not you. You can still fill in the checklist.
        </div>
      )}
      {order ? (
        <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label="Workorder">
            <Link className="underline" to={`/delivery_operations/workorder/${order.workorder_id}`}>{String(order.workorder_id)}</Link>
          </Field>
          <Field label="Invoice">{order.invoice_id}</Field>
          <Field label="Target completion">{order.estimated_completion ? formatWhen(order.estimated_completion, true) : null}</Field>
          <Field label="Delivering to">{[order.delivery_suburb, order.delivery_state].filter(Boolean).join(', ')}</Field>
          <Field label="Technician">{order.technician_name || order.technician_id}</Field>
          <Field label="Item status">{order.item_status}</Field>
        </dl>
      ) : (
        <p className="mt-3 text-sm text-gray-700">Not assigned to an order yet.</p>
      )}
    </section>
  );
}

function AnswerRadios({ name, value, onChange, labelPrefix = '' }) {
  return (
    <div className="flex gap-2">
      {[['yes', 'Yes'], ['na', 'N/A']].map(([v, text]) => (
        <label key={v} className={`flex min-h-[44px] cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm ${value === v ? 'border-gray-900 bg-gray-100 font-semibold' : 'bg-white'}`}>
          <input
            type="radio"
            name={name}
            value={v}
            checked={value === v}
            onChange={() => onChange(v)}
          />
          {/* Sub-ticks (Audio 3.5 / BT / SPK) read "SPK N/A" to a screen reader, not a bare "N/A". */}
          {labelPrefix && <span className="sr-only">{labelPrefix} </span>}
          {text}
        </label>
      ))}
    </div>
  );
}

function formFrom(view) {
  const c = view.checklist;
  const checks = emptyChecks();
  if (c?.checks) {
    for (const key of Object.keys(checks)) checks[key] = { ...checks[key], ...(c.checks[key] || {}) };
  }
  return {
    checks,
    test_tag_no: c?.test_tag_no || '',
    base_serial: view.prefill?.base_serial || '',
    console_serial: view.prefill?.console_serial || '',
    comments: c?.comments || '',
    ok_to_ship: !!c?.ok_to_ship,
    version: c?.version || 0,
  };
}

function Checklist({ view, onSaved, request }) {
  const [form, setForm] = useState(() => formFrom(view));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null); // { kind: 'ok' | 'error' | 'conflict', text, current? }
  const missing = unansweredItems(form.checks);
  const c = view.checklist;

  const setLine = (key, patch) => setForm((f) => ({ ...f, checks: { ...f.checks, [key]: { ...f.checks[key], ...patch } } }));
  // Changing an answer back to unanswered can't happen with radios, but a sign-off must never
  // survive a checklist that is no longer complete.
  const okToShip = form.ok_to_ship && missing.length === 0;

  const save = async (baseVersion) => {
    setSaving(true);
    setMessage(null);
    try {
      const out = await request('/api/lots?resource=tech-checklist', {
        method: 'PUT',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          lot_number: view.lot.lot_number,
          checks: form.checks,
          test_tag_no: form.test_tag_no,
          base_serial: form.base_serial,
          console_serial: form.console_serial,
          comments: form.comments,
          ok_to_ship: okToShip,
          base_version: baseVersion,
        }),
      });
      if (!out) return;
      const { res, data } = out;
      if (res.status === 409 && data?.current) {
        setMessage({ kind: 'conflict', text: data.error || 'Someone else saved this checklist after you opened it', current: data.current });
        return;
      }
      if (!res.ok) { setMessage({ kind: 'error', text: data?.error || 'Save failed' }); return; }
      onSaved(data);
      setForm(formFrom(data));
      setMessage({ kind: 'ok', text: `Saved ${formatWhen(data.checklist?.updated_at)}` });
    } catch {
      setMessage({ kind: 'error', text: 'Network error — nothing was saved. Check your connection and try again.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save(form.version); }}>
      <section className="rounded-xl border bg-white p-4">
        <h2 className="text-base font-semibold">Screen &amp; electronics checklist</h2>
        {c?.updated_at && (
          <p className="mt-1 text-xs text-gray-600">Last saved {formatWhen(c.updated_at)} by {c.updated_by_name || c.updated_by}</p>
        )}
        <div className="mt-3 divide-y">
          {CHECK_ITEMS.map((item) => {
            const line = form.checks[item.key];
            return (
              <fieldset key={item.key} className="py-3">
                <legend className="text-sm font-medium text-gray-900">{item.label}</legend>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <AnswerRadios name={`chk-${item.key}`} value={line.v} onChange={(v) => setLine(item.key, { v })} />
                  <input
                    aria-label={`${item.label} comment`}
                    value={line.note}
                    maxLength={200}
                    onChange={(e) => setLine(item.key, { note: e.target.value })}
                    placeholder="Fault / comment"
                    className="min-w-0 flex-1 rounded-lg border p-2 text-sm"
                  />
                </div>
                {item.key === 'audio' && (
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
                    {AUDIO_SUBS.map((sub) => (
                      <div key={sub.key} className="flex items-center gap-2 text-sm">
                        <span className="w-10 text-gray-700">{sub.label}</span>
                        <AnswerRadios name={`chk-audio-${sub.key}`} value={line[sub.key]} labelPrefix={sub.label} onChange={(v) => setLine('audio', { [sub.key]: v })} />
                      </div>
                    ))}
                  </div>
                )}
                {item.key === 'test_tag' && (
                  <label className="mt-2 flex items-center gap-2 text-sm">
                    <span className="text-gray-700">Test &amp; Tag No.</span>
                    <input
                      value={form.test_tag_no}
                      maxLength={30}
                      onChange={(e) => setForm((f) => ({ ...f, test_tag_no: e.target.value }))}
                      className="w-32 rounded-lg border p-2 font-mono"
                    />
                  </label>
                )}
              </fieldset>
            );
          })}
        </div>
      </section>

      <section className="rounded-xl border bg-white p-4">
        <h2 className="text-base font-semibold">Serial numbers</h2>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="text-gray-700">Base S/N</span>
            <input value={form.base_serial} maxLength={60} onChange={(e) => setForm((f) => ({ ...f, base_serial: e.target.value }))} className="mt-1 w-full rounded-lg border p-3 font-mono uppercase" autoCapitalize="characters" />
          </label>
          <label className="text-sm">
            <span className="text-gray-700">Console S/N</span>
            <input value={form.console_serial} maxLength={60} onChange={(e) => setForm((f) => ({ ...f, console_serial: e.target.value }))} className="mt-1 w-full rounded-lg border p-3 font-mono uppercase" autoCapitalize="characters" />
          </label>
        </div>
        <p className="mt-2 text-xs text-gray-600">Saved to the workorder as “base &amp; CONSOLE console”. Leaving both blank keeps what is already recorded.</p>
        <label className="mt-3 block text-sm">
          <span className="text-gray-700">Comments</span>
          <textarea value={form.comments} maxLength={2000} rows={3} onChange={(e) => setForm((f) => ({ ...f, comments: e.target.value }))} className="mt-1 w-full rounded-lg border p-2" />
        </label>
      </section>

      <section className="rounded-xl border bg-white p-4">
        <label className={`flex items-center gap-3 text-base font-semibold ${missing.length ? 'text-gray-500' : 'text-gray-900'}`}>
          <input
            type="checkbox"
            className="h-6 w-6"
            checked={okToShip}
            disabled={missing.length > 0}
            onChange={(e) => setForm((f) => ({ ...f, ok_to_ship: e.target.checked }))}
          />
          Screen OK to ship
        </label>
        {missing.length > 0 && (
          <p className="mt-1 text-xs text-gray-600">Answer every line (Yes or N/A) to sign off — {missing.length} to go.</p>
        )}
        {c?.ok_to_ship && c.approved_at && (
          <p className="mt-1 text-sm text-green-800">Signed off by {c.approved_by_name || c.approved_by} · {formatWhen(c.approved_at)}</p>
        )}
      </section>

      {message?.kind === 'ok' && <div role="status" className="rounded-lg border border-green-300 bg-green-50 p-3 text-sm text-green-800">{message.text}</div>}
      {message?.kind === 'error' && <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">{message.text}</div>}
      {message?.kind === 'conflict' && (
        <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <p>{message.text}.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" disabled={saving} onClick={() => save(message.current.checklist?.version || 0)} className="rounded-lg border border-amber-700 bg-white px-3 py-2 font-medium">
              Overwrite with mine
            </button>
            <button type="button" disabled={saving} onClick={() => { onSaved(message.current); setForm(formFrom(message.current)); setMessage(null); }} className="rounded-lg border bg-white px-3 py-2">
              Discard mine and load theirs
            </button>
          </div>
        </div>
      )}

      <button type="submit" disabled={saving} className="w-full rounded-lg py-4 text-lg font-semibold text-white hover:opacity-90 disabled:opacity-60" style={{ backgroundColor: BRAND_RED }}>
        {saving ? 'Saving…' : 'Save checklist'}
      </button>
    </form>
  );
}

export default function TechChecklistPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const me = useMemo(() => {
    const user = getStoredUser();
    const roles = getRoles();
    return { id: String(user?.id || '').toUpperCase(), allowed: canUseTechChecklist(user, roles), isTechnician: hasAnyRole(roles, ['technician']) };
  }, []);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [camera, setCamera] = useState(false);
  const [view, setView] = useState(null); // lookup payload | { notFound } | { error }
  const inputRef = useRef(null);
  const latestRef = useRef(0); // only the most recent lookup may update the screen
  const lotParam = params.get('lot');

  const request = useCallback(async (url, opts = {}) => {
    const res = await fetch(url, { headers: authHeaders(), ...opts });
    if (res.status === 401) { endExpiredSession(navigate); return null; }
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }, [navigate]);

  const openLot = useCallback(async (raw) => {
    const lot = String(raw || '').trim().toUpperCase();
    if (!lot) return;
    const mine = ++latestRef.current;
    setLoading(true);
    try {
      const out = await request(`/api/lots?resource=tech-checklist&lot_number=${encodeURIComponent(lot)}`);
      if (!out || mine !== latestRef.current) return;
      const { res, data } = out;
      if (res.status === 404) setView({ notFound: lot });
      else if (!res.ok) setView({ error: res.status === 403 ? 'You don’t have access to the technician checklist.' : (data?.error || 'Lookup failed') });
      else setView(data);
    } catch {
      if (mine === latestRef.current) setView({ error: 'Network error — check your connection and try again.' });
    } finally {
      if (mine === latestRef.current) setLoading(false);
    }
  }, [request]);

  const submit = useCallback((raw) => {
    const lot = String(raw || '').trim().toUpperCase();
    if (!lot) return;
    setCode('');
    inputRef.current?.focus();
    if (lot === lotParam) openLot(lot); // same sticker scanned again → refresh it
    else setParams({ lot });
  }, [lotParam, openLot, setParams]);

  useEffect(() => {
    if (!localStorage.getItem('user')) { navigate('/', { replace: true }); return; }
    if (!me.allowed) return;
    if (lotParam) openLot(lotParam);
    else setView(null);
  }, [me.allowed, lotParam, openLot, navigate]);

  if (!me.allowed) {
    return (
      <div className="min-h-screen bg-gray-100 p-6">
        <div className="mx-auto max-w-xl rounded-xl border bg-white p-6">
          <h1 className="text-xl font-bold">Tech Checklist</h1>
          <p className="mt-2 text-gray-700">The screen &amp; electronics checklist is for technicians and the workshop.</p>
          <Link to="/dashboard" className="mt-4 inline-block underline">Back to the dashboard</Link>
        </div>
      </div>
    );
  }

  const found = view && view.lot;
  return (
    <div className="min-h-screen bg-gray-100 p-4 sm:p-6">
      <div className="mx-auto max-w-2xl">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-bold">Tech Checklist</h1>
          <Link to="/dashboard" className="text-sm underline">Dashboard</Link>
        </div>
        <p className="mt-2 text-sm text-gray-700">Scan the lot sticker with the camera or a scanner, or type the lot number (e.g. <span className="font-mono">L00042</span>).</p>

        <form onSubmit={(e) => { e.preventDefault(); submit(code); }} className="mt-4 flex gap-2">
          <label htmlFor="tech-checklist-input" className="sr-only">Lot number</label>
          <input
            id="tech-checklist-input"
            ref={inputRef}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Scan or type a lot number"
            className="min-w-0 flex-1 rounded-lg border p-4 text-lg font-mono"
          />
          <button type="button" onClick={() => setCamera(true)} className="rounded-lg border bg-white px-4 text-2xl hover:bg-gray-50" title="Scan with the camera" aria-label="Scan with the camera">
            📷
          </button>
          <button type="submit" className="rounded-lg px-5 font-medium text-white hover:opacity-90" style={{ backgroundColor: BRAND_RED }}>
            Open
          </button>
        </form>

        {camera && (
          <CameraBarcodeScanner onResult={(text) => { setCamera(false); submit(text); }} onClose={() => setCamera(false)} />
        )}

        {loading && <div className="mt-6 text-gray-700">Looking up…</div>}
        {!loading && view?.notFound && (
          <div role="alert" className="mt-6 rounded-lg border border-red-300 bg-red-50 p-4 text-red-800">
            No lot found for <span className="font-mono font-semibold">{view.notFound}</span>.
          </div>
        )}
        {!loading && view?.error && (
          <div role="alert" className="mt-6 rounded-lg border border-red-300 bg-red-50 p-4 text-red-800">{view.error}</div>
        )}

        {!loading && found && (
          <div className="mt-6 space-y-4">
            <OrderCard view={view} me={me} />
            {view.available ? (
              <Checklist key={`${view.lot.lot_number}`} view={view} onSaved={setView} request={request} />
            ) : (
              <p className="rounded-xl border bg-white p-4 text-sm text-gray-700">
                The checklist is not available yet — it is switched on when the database is updated. The order details above are correct.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
