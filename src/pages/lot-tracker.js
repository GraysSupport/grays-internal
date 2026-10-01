import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import CameraBarcodeScanner from '../components/CameraBarcodeScanner';
import { authHeaders, getRoles, hasAnyRole } from '../utils/auth';
import { endExpiredSession } from '../utils/session';
import { LOT_TRACKER_ROLES, looksLikeLotNumber, formatWhen } from '../utils/lotTracker';

// G11 (Nick, 1 Oct 2026) — Lot Tracker.
//
// Scan a lot sticker (USB/Bluetooth scanner types the number + Enter, or the phone camera) or
// search, and see the item's whole journey: where it came from (extraction), what it is
// assigned to, when it went into the workshop and who did it, its serial number, and when it
// was delivered and by whom.
//
// Same scanner as the public /scan page on the login screen — but this is the LOGGED-IN view:
// it shows customer and workshop detail, so it is admin + superadmin only and reads
// GET /api/lots?resource=journey (lib/lotJourney.js), not the public lookup. Read-only.

const STATUS_CLS = {
  Sold: 'bg-green-100 text-green-800',
  Assigned: 'bg-blue-100 text-blue-800',
  Void: 'bg-gray-200 text-gray-700',
  'In Stock': 'bg-amber-100 text-amber-800',
};
const KIND_DOT = { origin: 'bg-amber-600', lot: 'bg-gray-500', workorder: 'bg-blue-600', workshop: 'bg-purple-700', delivery: 'bg-green-600' };
const money = (n) => Number(n).toLocaleString('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });

function Field({ label, children }) {
  return (
    <div>
      <dt className="text-xs text-gray-600">{label}</dt>
      <dd className="text-sm font-medium text-gray-900 break-words">{children || '—'}</dd>
    </div>
  );
}

function Section({ title, empty, children }) {
  return (
    <section className="rounded-xl border bg-white p-4">
      <h2 className="text-base font-semibold">{title}</h2>
      {children
        ? <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">{children}</dl>
        : <p className="mt-2 text-sm text-gray-600">{empty}</p>}
    </section>
  );
}

function Journey({ journey }) {
  const { lot, product, origin, assignment, workshop, deliveries, delivered, timeline } = journey;
  return (
    <div className="mt-6 space-y-4">
      <section className="rounded-xl border bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-xs text-gray-600">Lot</div>
            <h2 className="text-2xl font-mono font-bold">{lot.lot_number}</h2>
            <div className="mt-1 text-lg font-semibold">{product.name || product.sku}</div>
            <div className="text-sm text-gray-600">
              {product.brand ? `${product.brand} · ` : ''}SKU <span className="font-mono">{product.sku}</span>
            </div>
          </div>
          <span className={`rounded px-2 py-1 text-sm font-medium ${STATUS_CLS[lot.status] || 'bg-gray-100 text-gray-700'}`}>{lot.status}</span>
        </div>
        <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Serial number">{lot.serial_number ? <span className="font-mono">{lot.serial_number}</span> : 'Not recorded'}</Field>
          <Field label="Lot number issued">{formatWhen(lot.created_at)}{lot.created_by_name ? ` · ${lot.created_by_name}` : ''}</Field>
          {'unit_cost' in lot && <Field label="Unit cost (superadmin only)">{lot.unit_cost == null ? 'Not set' : money(lot.unit_cost)}</Field>}
        </dl>
      </section>

      <Section title="Where it came from (extraction)" empty="This lot is not linked to a collection.">
        {origin && (
          <>
            <Field label="Collection">{origin.name}</Field>
            <Field label="Location">{[origin.suburb, origin.state].filter(Boolean).join(', ')}</Field>
            <Field label="Collection date">{formatWhen(origin.collection_date, true)}</Field>
            <Field label="Collected by (carrier)">{origin.carrier}</Field>
            <Field label="Collection status">{origin.status}</Field>
            <Field label="Description">{origin.description}</Field>
            {origin.notes && <Field label="Notes">{origin.notes}</Field>}
          </>
        )}
      </Section>

      <Section title="Where it is assigned" empty="Not assigned to a workorder yet.">
        {assignment && (
          <>
            <Field label="Workorder">
              <Link className="underline" to={`/delivery_operations/workorder/${assignment.workorder_id}`}>#{assignment.workorder_id}</Link>
              {assignment.workorder_status ? ` · ${assignment.workorder_status}` : ''}
            </Field>
            <Field label="Invoice">{assignment.invoice_id}</Field>
            <Field label="Customer">{assignment.customer_name}</Field>
            <Field label="Delivering to">{[assignment.delivery_suburb, assignment.delivery_state].filter(Boolean).join(', ')}</Field>
            <Field label="Workorder created">{formatWhen(assignment.workorder_created)}</Field>
          </>
        )}
      </Section>

      <Section title="Workshop" empty="No workshop record yet — the lot is not on a workorder.">
        {workshop && (
          <>
            <Field label="Went into the workshop">{workshop.in_workshop ? formatWhen(workshop.in_workshop) : 'Not yet'}</Field>
            <Field label="Technician">{workshop.technician_name || workshop.technician_id}</Field>
            <Field label="Workshop status">{workshop.item_status}</Field>
            <Field label="Condition">{workshop.condition}</Field>
            <Field label="Serial number">{workshop.serial_number ? <span className="font-mono">{workshop.serial_number}</span> : 'Not recorded'}</Field>
          </>
        )}
      </Section>

      <section className="rounded-xl border bg-white p-4">
        <h2 className="text-base font-semibold">Delivery</h2>
        {deliveries.length === 0 && <p className="mt-2 text-sm text-gray-600">No delivery has been raised for this workorder yet.</p>}
        {deliveries.length > 1 && (
          <p className="mt-2 text-sm text-gray-700">
            This workorder has {deliveries.length} deliveries. The portal records deliveries per workorder, not per item, so it can’t say which one this item went on.
          </p>
        )}
        {deliveries.map((d) => (
          <dl key={d.delivery_id} className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Status">{d.delivery_status}</Field>
            <Field label="Delivery date">{d.delivery_date ? formatWhen(d.delivery_date, true) : 'No date set'}</Field>
            <Field label={d.delivery_status === 'Delivery Completed' ? 'Delivered by (carrier)' : 'Carrier'}>{d.carrier}</Field>
            <Field label="To">{[d.suburb, d.state].filter(Boolean).join(', ')}</Field>
          </dl>
        ))}
        {delivered && (
          <dl className="mt-3 grid grid-cols-1 gap-3 border-t pt-3 sm:grid-cols-2">
            <Field label="Marked completed">{formatWhen(delivered.completed_at)}</Field>
            <Field label="Marked completed by">{delivered.completed_by_name || delivered.completed_by}</Field>
          </dl>
        )}
      </section>

      <section className="rounded-xl border bg-white p-4">
        <h2 className="text-base font-semibold">Journey</h2>
        <ol aria-label="Item journey" className="mt-3 space-y-3">
          {timeline.map((e, i) => (
            <li key={`${e.title}-${e.at}-${i}`} className="flex gap-3">
              <span aria-hidden="true" className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${KIND_DOT[e.kind] || 'bg-gray-500'}`} />
              <div className="min-w-0">
                <div className="text-sm font-medium text-gray-900">{e.title}</div>
                <div className="text-xs text-gray-600">
                  {formatWhen(e.at, e.date_only)}
                  {(e.by_name || e.by) ? ` · ${e.by_name || e.by}` : ''}
                </div>
                {e.detail && <div className="text-xs text-gray-600 break-words">{e.detail}</div>}
              </div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

export default function LotTrackerPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const allowed = useMemo(() => hasAnyRole(getRoles(), LOT_TRACKER_ROLES), []);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [camera, setCamera] = useState(false);
  const [view, setView] = useState(null); // { journey } | { results, q } | { notFound } | { error }
  const inputRef = useRef(null);
  const latestRef = useRef(0); // only the most recent lookup may update the screen
  // The lot lives in the URL (?lot=L00042) so a journey can be bookmarked, shared and reloaded.
  const lotParam = params.get('lot');

  const request = useCallback(async (url) => {
    const res = await fetch(url, { headers: authHeaders() });
    if (res.status === 401) { endExpiredSession(navigate); return null; }
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }, [navigate]);

  // Run one lookup. If another starts before it finishes (two stickers scanned quickly), the
  // slower, older answer is dropped instead of overwriting the newer one.
  const lookup = useCallback(async (url, onResult) => {
    const mine = ++latestRef.current;
    setLoading(true);
    try {
      const out = await request(url);
      if (out && mine === latestRef.current) setView(onResult(out));
    } catch {
      if (mine === latestRef.current) setView({ error: 'Network error — check your connection and try again.' });
    } finally {
      if (mine === latestRef.current) setLoading(false);
    }
  }, [request]);

  const openLot = useCallback((raw) => {
    const lot = String(raw || '').trim().toUpperCase();
    if (!lot) return;
    lookup(`/api/lots?resource=journey&lot_number=${encodeURIComponent(lot)}`, ({ res, data }) => {
      if (res.status === 404) return { notFound: lot };
      if (!res.ok) return { error: res.status === 403 ? 'You don’t have access to the Lot Tracker.' : (data?.error || 'Lookup failed') };
      return { journey: data };
    });
  }, [lookup]);

  const search = useCallback((raw) => {
    const q = String(raw || '').trim();
    lookup(`/api/lots?resource=journey-search&q=${encodeURIComponent(q)}`, ({ res, data }) => (
      res.ok ? { results: data.results || [], q, limit: data.limit } : { error: data?.error || 'Search failed' }
    ));
  }, [lookup]);

  // A scanned sticker (or a typed lot number) opens the journey; anything else is a search.
  const submit = useCallback((raw) => {
    const text = String(raw || '').trim();
    if (!text) return;
    // Clear the box NOW (not when the answer arrives) so the next sticker can be scanned
    // straight away without its first characters being wiped mid-scan.
    setCode('');
    inputRef.current?.focus();
    if (looksLikeLotNumber(text)) {
      const lot = text.toUpperCase();
      if (lot === lotParam) openLot(lot); // same sticker scanned again → refresh it
      else setParams({ lot });
    } else {
      setParams({});
      search(text);
    }
  }, [search, setParams, openLot, lotParam]);
  useEffect(() => {
    if (!localStorage.getItem('user')) { navigate('/', { replace: true }); return; }
    if (!allowed) return;
    if (lotParam) openLot(lotParam);
    else setView((v) => (v?.journey || v?.notFound ? null : v)); // Back to a URL with no lot → no stale journey
  }, [allowed, lotParam, openLot, navigate]);

  if (!allowed) {
    return (
      <div className="min-h-screen bg-gray-100 p-6">
        <div className="mx-auto max-w-xl rounded-xl border bg-white p-6">
          <h1 className="text-xl font-bold">Lot Tracker</h1>
          <p className="mt-2 text-gray-700">The Lot Tracker is available to admin and superadmin users.</p>
          <Link to="/dashboard" className="mt-4 inline-block underline">Back to the dashboard</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100 p-4 sm:p-6">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-bold">Lot Tracker</h1>
          <Link to="/dashboard" className="text-sm underline">Dashboard</Link>
        </div>
        <p className="mt-2 text-sm text-gray-700">
          Scan a lot sticker with a USB or Bluetooth scanner or the camera, or type a lot number
          (e.g. <span className="font-mono">L00042</span>). You can also search by serial number, SKU, product name or invoice.
        </p>

        <form onSubmit={(e) => { e.preventDefault(); submit(code); }} className="mt-4 flex gap-2">
          <label htmlFor="lot-tracker-input" className="sr-only">Lot number or search</label>
          <input
            id="lot-tracker-input"
            ref={inputRef}
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Scan or type a lot number, or search…"
            className="min-w-0 flex-1 rounded-lg border p-4 text-lg font-mono"
          />
          <button type="button" onClick={() => setCamera(true)} className="rounded-lg border bg-white px-4 text-2xl hover:bg-gray-50" title="Scan with the camera" aria-label="Scan with the camera">
            📷
          </button>
          <button type="submit" className="rounded-lg px-5 font-medium text-white hover:opacity-90" style={{ backgroundColor: '#B50B1D' }}>
            Find
          </button>
        </form>

        {camera && (
          <CameraBarcodeScanner onResult={(text) => { setCamera(false); submit(text); }} onClose={() => setCamera(false)} />
        )}

        {loading && <div role="status" className="mt-6 text-gray-700">Looking up…</div>}

        {!loading && view?.notFound && (
          <div role="alert" className="mt-6 rounded-lg border border-red-300 bg-red-50 p-4 text-red-800">
            No lot found for <span className="font-mono font-semibold">{view.notFound}</span>.
          </div>
        )}
        {!loading && view?.error && (
          <div role="alert" className="mt-6 rounded-lg border border-red-300 bg-red-50 p-4 text-red-800">{view.error}</div>
        )}

        {!loading && view?.results && (
          <section className="mt-6 rounded-xl border bg-white p-4">
            <h2 className="text-base font-semibold">
              {view.results.length === 0 ? `No lots match “${view.q}”.` : `Lots matching “${view.q}”`}
            </h2>
            {view.results.length > 0 && (
              <ul aria-label="Search results" className="mt-3 divide-y">
                {view.results.map((r) => (
                  <li key={r.lot_number}>
                    <button type="button" onClick={() => setParams({ lot: r.lot_number })} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 py-2 text-left hover:bg-gray-50">
                      <span className="font-mono font-semibold">{r.lot_number}</span>
                      <span className="min-w-0 flex-1 text-sm">{r.product_name || r.product_sku}</span>
                      {r.serial_number && <span className="text-xs text-gray-600">serial {r.serial_number}</span>}
                      {r.invoice_id && <span className="text-xs text-gray-600">invoice {r.invoice_id}</span>}
                      <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_CLS[r.status] || 'bg-gray-100 text-gray-700'}`}>{r.status}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {view.results.length >= (view.limit || Infinity) && (
              <p className="mt-2 text-xs text-gray-600">Showing the first {view.limit} — add more detail to narrow it down.</p>
            )}
          </section>
        )}

        {!loading && view?.journey && <Journey journey={view.journey} />}
      </div>
    </div>
  );
}
