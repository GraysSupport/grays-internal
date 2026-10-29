import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { authHeaders } from '../utils/auth';
import { endExpiredSession } from '../utils/session';
import { formatWhen } from '../utils/lotTracker';
import {
  FREE_WEIGHT_CATEGORIES, MOVE_REASONS, LADDERS, categoryLabel, formatKg,
} from '../utils/freeWeights';

// G21 — the two Brand New Free Weights dialogs: "Update stock" on one weight (a logged move,
// plus that weight's history) and "Add / Edit product line" (the line + its weight ladder).
// Same dialog contract as ProductLotsModal: role="dialog" + aria-modal, Escape closes, Tab
// stays inside, focus returns to the button that opened it.

const PRIMARY = 'rounded bg-[#B50B1D] px-4 py-2 text-white hover:bg-[#8f0917] disabled:opacity-50';
const INPUT = 'w-full rounded border p-2';

function Dialog({ titleId, title, onClose, children, wide = false }) {
  const panelRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const opener = document.activeElement;
    panelRef.current?.querySelector('select, input, textarea, button')?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') { onCloseRef.current?.(); return; }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const items = panelRef.current.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select, textarea');
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
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={onClose}>
      <div
        ref={panelRef}
        className={`flex max-h-[90vh] w-full ${wide ? 'max-w-4xl' : 'max-w-lg'} flex-col overflow-y-auto rounded-lg bg-white p-6 shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={titleId} className="text-lg font-bold text-gray-900">{title}</h2>
        {children}
      </div>
    </div>
  );
}

async function send(url, method, body, navigate) {
  const res = await fetch(url, { method, headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
  if (res.status === 401) { endExpiredSession(navigate); return null; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Could not save');
  return data;
}

const reasonLabel = (key) => MOVE_REASONS.find((r) => r.key === key)?.label || key;

/* ---------- Update stock on one weight ---------- */
export function FreeWeightMoveDialog({ line, variant, onSaved, onClose }) {
  const navigate = useNavigate();
  const [reason, setReason] = useState('received');
  const [direction, setDirection] = useState('add'); // adjustment only
  const [qty, setQty] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [history, setHistory] = useState({ loading: true, moves: [], error: null });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/free-weights?resource=moves&variant_id=${variant.id}`, { headers: authHeaders() });
        if (res.status === 401) { endExpiredSession(navigate); return; }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not load the history');
        if (!cancelled) setHistory({ loading: false, moves: data.moves || [], error: null });
      } catch (err) {
        if (!cancelled) setHistory({ loading: false, moves: [], error: err.message });
      }
    })();
    return () => { cancelled = true; };
  }, [variant.id, navigate]);

  const sign = MOVE_REASONS.find((r) => r.key === reason)?.sign ?? 1;
  const save = async (e) => {
    e.preventDefault();
    const n = Number(qty);
    if (!Number.isInteger(n) || n < 1) { setError('Enter a whole number of units (1 or more)'); return; }
    const signed = sign === 0 && direction === 'out' ? -n : n;
    setSaving(true);
    setError(null);
    try {
      const data = await send('/api/free-weights?resource=move', 'POST',
        { variant_id: variant.id, qty: signed, reason, reference: reference.trim(), note: note.trim() }, navigate);
      if (data) onSaved(data.variant);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  const titleText = `${formatKg(variant.weight_kg)} — ${line.brand} ${line.name}`;
  return (
    <Dialog titleId="fw-move-title" title={titleText} onClose={onClose}>
      <p className="mt-1 text-sm text-gray-700">{variant.stock} on hand now</p>
      <form className="mt-4 space-y-3" onSubmit={save}>
        <label className="block text-sm">
          <span className="font-medium">Reason</span>
          <select className={INPUT} value={reason} onChange={(e) => setReason(e.target.value)}>
            {MOVE_REASONS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>
        </label>
        {sign === 0 && (
          <fieldset className="flex gap-4 text-sm">
            <legend className="sr-only">Direction</legend>
            <label className="flex items-center gap-1">
              <input type="radio" name="fw-direction" checked={direction === 'add'} onChange={() => setDirection('add')} /> Add
            </label>
            <label className="flex items-center gap-1">
              <input type="radio" name="fw-direction" checked={direction === 'out'} onChange={() => setDirection('out')} /> Take out
            </label>
          </fieldset>
        )}
        <label className="block text-sm">
          <span className="font-medium">Quantity</span>
          <input type="number" min="1" step="1" inputMode="numeric" className={INPUT} value={qty} onChange={(e) => setQty(e.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="font-medium">Invoice or PO number (optional)</span>
          <input className={INPUT} maxLength={200} value={reference} onChange={(e) => setReference(e.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="font-medium">Note (optional)</span>
          <input className={INPUT} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        {error && <p role="alert" className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded bg-gray-200 px-4 py-2 text-gray-900 hover:bg-gray-300">Cancel</button>
          <button type="submit" disabled={saving} className={PRIMARY}>Save stock change</button>
        </div>
      </form>

      <h3 className="mt-6 text-sm font-semibold text-gray-900">History</h3>
      {history.loading && <p className="text-sm text-gray-600">Loading history…</p>}
      {history.error && <p className="text-sm text-red-800">{history.error}</p>}
      {!history.loading && !history.error && history.moves.length === 0 && <p className="text-sm text-gray-600">No stock changes recorded yet.</p>}
      <ul className="mt-1 divide-y text-sm">
        {history.moves.map((m) => (
          <li key={m.id} className="py-1.5">
            <span className="font-semibold">{m.delta > 0 ? `+${m.delta}` : m.delta}</span>
            {' '}{reasonLabel(m.reason)}
            {m.reference && ` · ${m.reference}`}
            {' · '}{formatWhen(m.at)}
            {' · '}{m.user_name || m.user_id || 'Unknown'}
            {m.note && <span className="block text-gray-700">{m.note}</span>}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

/* ---------- Add / edit a product line ---------- */
const blankRow = (weight = '') => ({ key: Math.random().toString(36).slice(2), id: null, weight_kg: String(weight), price: '', unit_cost: '', reorder_level: '', sku: '', stock: '', active: true });
const fromVariant = (v) => ({
  key: `v${v.id}`, id: v.id, weight_kg: String(v.weight_kg), price: v.price == null ? '' : String(v.price),
  unit_cost: v.unit_cost == null ? '' : String(v.unit_cost), reorder_level: v.reorder_level == null ? '' : String(v.reorder_level),
  sku: v.sku || '', stock: '', active: v.active !== false,
});
const rowName = (r, i) => (r.weight_kg.trim() && Number(r.weight_kg) > 0 ? formatKg(r.weight_kg) : `row ${i + 1}`);
const optNum = (v) => (String(v).trim() === '' ? null : Number(v));

export function FreeWeightLineDialog({ line, canSeeCost, onSaved, onClose }) {
  const navigate = useNavigate();
  const editing = !!line;
  const [brand, setBrand] = useState(line?.brand || '');
  const [name, setName] = useState(line?.name || '');
  const [category, setCategory] = useState(line?.category || 'plate');
  const [notes, setNotes] = useState(line?.notes || '');
  const [rows, setRows] = useState(() => (editing ? line.variants.map(fromVariant) : [blankRow()]));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const setRow = (key, field, value) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, [field]: value } : r)));
  const useLadder = () => {
    setRows((rs) => {
      const kept = new Map(rs.filter((r) => r.weight_kg.trim()).map((r) => [Number(r.weight_kg), r]));
      const ladder = LADDERS[category].map((w) => kept.get(w) || blankRow(w));
      const extra = rs.filter((r) => r.id && !LADDERS[category].includes(Number(r.weight_kg))); // saved weights stay
      return [...ladder, ...extra].sort((a, b) => Number(a.weight_kg) - Number(b.weight_kg));
    });
  };

  const save = async (e) => {
    e.preventDefault();
    setError(null);
    if (!brand.trim() || !name.trim()) { setError('Enter the brand and the product name'); return; }
    const used = rows.filter((r) => r.id || r.weight_kg.trim() || r.price.trim());
    if (!used.length) { setError('Add at least one weight'); return; }
    for (const [i, r] of used.entries()) {
      const w = Number(r.weight_kg);
      if (!r.weight_kg.trim() || !Number.isFinite(w) || w <= 0) { setError(`Enter a weight in kg for row ${i + 1}`); return; }
      if (!r.price.trim() || !Number.isFinite(Number(r.price)) || Number(r.price) < 0) { setError(`Enter a price for ${formatKg(w)}`); return; }
    }
    const variants = used.map((r) => {
      const v = { weight_kg: Number(r.weight_kg), price: Number(r.price), reorder_level: optNum(r.reorder_level), sku: r.sku.trim() || null, active: r.active };
      if (canSeeCost) v.unit_cost = optNum(r.unit_cost);
      if (!editing) v.stock = optNum(r.stock) ?? 0;
      return v;
    });
    const body = { brand: brand.trim(), name: name.trim(), category, notes: notes.trim(), active: true, variants };
    setSaving(true);
    try {
      const data = editing
        ? await send(`/api/free-weights?resource=product&id=${line.id}`, 'PUT', body, navigate)
        : await send('/api/free-weights?resource=product', 'POST', body, navigate);
      if (data) onSaved(data);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  const ladder = LADDERS[category];
  return (
    <Dialog titleId="fw-line-title" title={editing ? `Edit ${line.brand} ${line.name}` : 'Add product line'} onClose={onClose} wide>
      <form className="mt-4 space-y-3" onSubmit={save}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="block text-sm">
            <span className="font-medium">Brand</span>
            <input className={INPUT} maxLength={80} value={brand} onChange={(e) => setBrand(e.target.value)} />
          </label>
          <label className="block text-sm">
            <span className="font-medium">Product name</span>
            <input className={INPUT} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="block text-sm">
            <span className="font-medium">Category</span>
            <select className={INPUT} value={category} onChange={(e) => setCategory(e.target.value)}>
              {FREE_WEIGHT_CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </label>
        </div>
        <label className="block text-sm">
          <span className="font-medium">Notes (optional)</span>
          <textarea rows={2} className={INPUT} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <h3 className="text-sm font-semibold text-gray-900">Weights</h3>
          {ladder && (
            <button type="button" onClick={useLadder} className="text-sm text-blue-700 underline">
              Use the {categoryLabel(category).toLowerCase()} ladder ({ladder[0]}–{ladder[ladder.length - 1]} kg)
            </button>
          )}
        </div>
        <p className="text-xs text-gray-600">
          Prices are AUD, GST inclusive.{editing ? ' Stock changes are made with “Update stock”, not here.' : ''}
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-700">
                <th className="px-1 py-1">Weight (kg)</th>
                <th className="px-1 py-1">Price</th>
                {canSeeCost && <th className="px-1 py-1">Unit cost</th>}
                <th className="px-1 py-1">Reorder level</th>
                {!editing && <th className="px-1 py-1">Opening stock</th>}
                <th className="px-1 py-1">SKU</th>
                <th className="px-1 py-1"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const n = rowName(r, i);
                return (
                  <tr key={r.key}>
                    <td className="px-1 py-1">
                      <input aria-label={`Weight (kg), row ${i + 1}`} inputMode="decimal" className={INPUT} value={r.weight_kg} disabled={!!r.id} onChange={(e) => setRow(r.key, 'weight_kg', e.target.value)} />
                    </td>
                    <td className="px-1 py-1">
                      <input aria-label={`Price for ${n}`} inputMode="decimal" className={INPUT} value={r.price} onChange={(e) => setRow(r.key, 'price', e.target.value)} />
                    </td>
                    {canSeeCost && (
                      <td className="px-1 py-1">
                        <input aria-label={`Unit cost for ${n}`} inputMode="decimal" className={INPUT} value={r.unit_cost} onChange={(e) => setRow(r.key, 'unit_cost', e.target.value)} />
                      </td>
                    )}
                    <td className="px-1 py-1">
                      <input aria-label={`Reorder level for ${n}`} inputMode="numeric" className={INPUT} value={r.reorder_level} onChange={(e) => setRow(r.key, 'reorder_level', e.target.value)} />
                    </td>
                    {!editing && (
                      <td className="px-1 py-1">
                        <input aria-label={`Opening stock for ${n}`} inputMode="numeric" className={INPUT} value={r.stock} onChange={(e) => setRow(r.key, 'stock', e.target.value)} />
                      </td>
                    )}
                    <td className="px-1 py-1">
                      <input aria-label={`SKU for ${n}`} className={INPUT} maxLength={60} value={r.sku} onChange={(e) => setRow(r.key, 'sku', e.target.value)} />
                    </td>
                    <td className="px-1 py-1 whitespace-nowrap">
                      {r.id ? (
                        <label className="flex items-center gap-1">
                          <input type="checkbox" checked={r.active} onChange={(e) => setRow(r.key, 'active', e.target.checked)} /> Stocked
                        </label>
                      ) : (
                        <button type="button" aria-label={`Remove ${n}`} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} className="text-blue-700 underline">
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <button type="button" onClick={() => setRows((rs) => [...rs, blankRow()])} className="text-sm text-blue-700 underline">+ Add weight</button>

        {error && <p role="alert" className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded bg-gray-200 px-4 py-2 text-gray-900 hover:bg-gray-300">Cancel</button>
          <button type="submit" disabled={saving} className={PRIMARY}>Save product line</button>
        </div>
      </form>
    </Dialog>
  );
}
