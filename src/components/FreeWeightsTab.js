import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { authHeaders } from '../utils/auth';
import { endExpiredSession } from '../utils/session';
import {
  FREE_WEIGHT_CATEGORIES, categoryLabel, formatKg, formatAud, stockStatus, filterProducts, buildCsv,
} from '../utils/freeWeights';
import { FreeWeightMoveDialog, FreeWeightLineDialog } from './FreeWeightDialogs';

// G21 (owner, 29 Oct 2026) — the "Brand New Free Weights" tab on the Products page: a stock list
// kept apart from the refurbished-equipment products, counted per individual weight. One card
// per product line, one chip per weight (stock on hand, price, low/out-of-stock label). Stock
// only changes through "Update stock" (a logged move); lines are added/edited in a dialog.
// The server (lib/freeWeights.js) decides who may see it and who sees cost.

const STATUS_LABEL = {
  out: { text: 'Out of stock', icon: '✕', cls: 'border-red-300 bg-red-50 text-red-800' },
  low: { text: 'Low stock', icon: '⚠', cls: 'border-amber-300 bg-amber-50 text-amber-900' },
};
const PRIMARY = 'rounded bg-[#B50B1D] px-4 py-2 text-white hover:bg-[#8f0917] disabled:opacity-50';

export default function FreeWeightsTab() {
  const navigate = useNavigate();
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [term, setTerm] = useState('');
  const [category, setCategory] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [moving, setMoving] = useState(null); // { line, variant }
  const [editing, setEditing] = useState(null); // { line } or { line: null } for a new line

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/free-weights?resource=list', { headers: authHeaders() });
      if (res.status === 401) { endExpiredSession(navigate); return; }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not load the free weights');
      setState({ loading: false, error: null, data });
    } catch (err) {
      setState({ loading: false, error: err.message || 'Could not load the free weights', data: null });
    }
  }, [navigate]);

  useEffect(() => { load(); }, [load]);

  const data = state.data;
  // Built-ins plus any category staff have added (owner revision, 30 Oct 2026).
  const categories = data?.categories?.length ? data.categories : FREE_WEIGHT_CATEGORIES;
  const shown = useMemo(
    () => filterProducts((data?.products || []).filter((p) => p.active !== false), { term, category, lowOnly, categories }),
    [data, term, category, lowOnly, categories],
  );
  const onCategoriesChange = (next) => setState((s) => ({ ...s, data: { ...s.data, categories: next } }));

  // Patch the one weight and the totals in place (units, and for superadmin the value at cost
  // or the "no cost set" count) rather than reloading the whole list.
  const onMoved = (variant) => {
    const before = moving?.variant;
    const delta = variant.stock - (before?.stock ?? variant.stock);
    setState((s) => {
      const t = { ...s.data.totals, units: s.data.totals.units + delta };
      if (s.data.can_see_cost) {
        if (before?.unit_cost == null) t.units_without_cost = (t.units_without_cost || 0) + delta;
        else t.value_at_cost = Math.round(((t.value_at_cost || 0) + delta * before.unit_cost) * 100) / 100;
      }
      return {
        ...s,
        data: {
          ...s.data,
          products: s.data.products.map((p) => ({
            ...p,
            variants: p.variants.map((v) => (v.id === variant.id ? { ...v, stock: variant.stock } : v)),
          })),
          totals: t,
        },
      };
    });
    setMoving(null);
  };

  const exportCsv = () => {
    const csv = buildCsv(shown, { canSeeCost: !!data?.can_see_cost, categories });
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `free_weights_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (state.loading) return <p className="text-sm text-gray-600">Loading free weights…</p>;
  if (state.error) return <p role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800">{state.error}</p>;
  if (!data.available) {
    return (
      <p className="rounded border bg-white p-4 text-sm text-gray-700">
        Brand New Free Weights stock is not set up on this database yet.
      </p>
    );
  }

  const totals = data.totals || { units: 0 };
  // The server is the authority (403 on any change); a missing flag means view only.
  const canChange = data.can_change === true;
  return (
    <div>
      {moving && (
        <FreeWeightMoveDialog line={moving.line} variant={moving.variant} readOnly={!canChange} onSaved={onMoved} onClose={() => setMoving(null)} />
      )}
      {canChange && editing && (
        <FreeWeightLineDialog
          line={editing.line}
          canSeeCost={!!data.can_see_cost}
          categories={categories}
          onCategoriesChange={onCategoriesChange}
          onSaved={(next) => { setState({ loading: false, error: null, data: next }); setEditing(null); }}
          onClose={() => setEditing(null)}
        />
      )}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-gray-700">
          Brand new stock, counted per individual weight. <span className="font-semibold">{totals.units} units on hand</span>
          {data.can_see_cost && (
            <>
              {' · '}Value at cost: {formatAud(totals.value_at_cost)}
              {totals.units_without_cost > 0 && ` (${totals.units_without_cost} units have no cost set)`}
            </>
          )}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={exportCsv}
            disabled={shown.length === 0}
            aria-label="Export free weights CSV"
            className="rounded bg-gray-200 px-4 py-2 text-gray-900 hover:bg-gray-300 disabled:opacity-50"
          >
            Export CSV
          </button>
          {canChange && <button type="button" onClick={() => setEditing({ line: null })} className={PRIMARY}>+ Add product line</button>}
        </div>
      </div>

      {!canChange && (
        <p className="mb-4 rounded border border-gray-300 bg-gray-50 p-2 text-sm text-gray-700">
          View only — only superadmin, admin, logistics and sales logins can change free weights.
        </p>
      )}

      <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto] sm:items-center">
        <input
          type="text"
          aria-label="Search free weights"
          placeholder="Search by brand, name or weight (e.g. 20kg)"
          className="w-full rounded border p-2"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
        />
        <label className="flex items-center gap-2 text-sm">
          <span>Category</span>
          <select className="rounded border p-2" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All</option>
            {categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} />
          Low stock only
        </label>
      </div>

      {shown.length === 0 && (
        <p className="rounded border bg-white p-4 text-center text-sm text-gray-600">
          {data.products.length ? 'No free weights match.' : 'No free weights yet — add the first product line.'}
        </p>
      )}

      <div className="space-y-3">
        {shown.map((line) => {
          const title = `${line.brand} ${line.name}`;
          const weights = line.variants.filter((v) => v.active !== false);
          return (
            <article key={line.id} aria-label={title} className="rounded-xl border bg-white p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 className="text-base font-semibold text-gray-900">{title}</h3>
                  <p className="text-xs text-gray-600">
                    {categoryLabel(line.category, categories)}
                    {(line.category === 'plate' || line.category === 'bumper') && ' · counted each plate, not in pairs'}
                  </p>
                  {line.notes && <p className="mt-1 text-sm text-gray-700">{line.notes}</p>}
                </div>
                {canChange && <button
                  type="button"
                  onClick={() => setEditing({ line })}
                  aria-label={`Edit ${title}`}
                  className="text-sm text-blue-700 underline"
                >
                  Edit
                </button>}
              </div>
              <ul className="mt-3 flex flex-wrap gap-2">
                {weights.map((v) => {
                  const status = STATUS_LABEL[stockStatus(v)];
                  return (
                    <li key={v.id} aria-label={formatKg(v.weight_kg)} className={`min-w-[8.5rem] rounded-lg border p-2 text-sm ${status ? status.cls : 'border-gray-300 bg-gray-50 text-gray-900'}`}>
                      <div className="font-semibold">{formatKg(v.weight_kg)}</div>
                      <div>{v.stock} on hand</div>
                      <div>{formatAud(v.price)}</div>
                      {status && <div className="font-semibold"><span aria-hidden="true">{status.icon} </span>{status.text}</div>}
                      <button
                        type="button"
                        onClick={() => setMoving({ line, variant: v })}
                        aria-label={`${canChange ? 'Update stock' : 'History'} — ${title} ${formatKg(v.weight_kg)}`}
                        className="mt-1 text-xs text-blue-700 underline"
                      >
                        {canChange ? 'Update stock' : 'History'}
                      </button>
                    </li>
                  );
                })}
                {weights.length === 0 && <li className="text-sm text-gray-600">No weights stocked.</li>}
              </ul>
            </article>
          );
        })}
      </div>
    </div>
  );
}
