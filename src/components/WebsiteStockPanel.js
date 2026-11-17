import { useState } from 'react';
import toast from 'react-hot-toast';
import { identityHeaders } from '../utils/workshopAccess';
import { websiteRowLabel, websiteStockSummary, canRetryWebsiteStock } from '../utils/websiteStock';

// G25 increment 2 (owner, 17 Nov 2026): what happened to the website stock for each item on this
// workorder, and a "Retry website update" button. The server only sends `website_stock` to
// superadmins (incl. GS) and the marketing lead, so nobody else ever sees this panel.

const TONE = {
  ok: 'text-green-800',
  warn: 'text-amber-800',
  muted: 'text-gray-600',
};
const BADGE = {
  done: 'border-green-200 bg-green-50 text-green-800',
  needs_you: 'border-amber-300 bg-amber-50 text-amber-800',
  retrying: 'border-amber-300 bg-amber-50 text-amber-800',
  dry_run: 'border-gray-200 bg-gray-50 text-gray-700',
  none: 'border-gray-200 bg-gray-50 text-gray-700',
};

export default function WebsiteStockPanel({ workorderId, rows, items = [], onChanged }) {
  const [busy, setBusy] = useState(false);
  if (!Array.isArray(rows)) return null;

  const summary = websiteStockSummary(rows);
  const nameFor = (sku) => items.find((it) => it.product_id === sku)?.product_name;

  const retry = async () => {
    setBusy(true);
    const id = toast.loading('Retrying website update…');
    try {
      const r = await fetch(`/api/workorder?id=${encodeURIComponent(workorderId)}&resource=website-retry`, {
        method: 'POST',
        headers: identityHeaders({ 'Content-Type': 'application/json' }),
        body: '{}',
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data?.error || 'Retry failed');
      if (data.nothingToRetry) toast.success('Nothing left that can be retried', { id });
      else {
        const s = data.summary || {};
        const parts = [s.sent && `${s.sent} sent`, s.dryRun && `${s.dryRun} dry run`, s.failed && `${s.failed} still failing`, s.needsHuman && `${s.needsHuman} need you`].filter(Boolean);
        toast.success(parts.length ? `Website: ${parts.join(', ')}` : 'Retry done', { id });
      }
    } catch (e) {
      toast.error(e.message || 'Retry failed', { id });
    } finally {
      setBusy(false);
      onChanged?.();
    }
  };

  return (
    <section className="mb-4 rounded-lg border bg-white p-3" aria-labelledby="wo-website-stock">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="wo-website-stock" className="text-sm font-semibold text-gray-900">Website stock</h2>
          <span className={`rounded border px-2 py-0.5 text-xs ${BADGE[summary.state]}`}>{summary.text}</span>
        </div>
        {canRetryWebsiteStock(rows) && (
          <button
            type="button"
            onClick={retry}
            disabled={busy}
            className="rounded border border-gray-300 bg-white px-3 py-1 text-sm text-gray-900 hover:bg-gray-50 disabled:opacity-50"
          >
            {busy ? 'Retrying…' : 'Retry website update'}
          </button>
        )}
      </div>
      {rows.length > 0 && (
        <ul className="mt-2 divide-y divide-gray-100 text-sm">
          {rows.map((r) => {
            const l = websiteRowLabel(r);
            const name = nameFor(r.sku);
            return (
              <li key={r.id} className="flex flex-wrap gap-x-3 py-1">
                <span className="font-mono text-gray-900">{r.sku}</span>
                {name && name !== r.sku && <span className="text-gray-600">{name}</span>}
                <span className={TONE[l.tone]}>{l.text}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
