import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { identityHeaders } from '../utils/workshopAccess';
import { sendConfirmText, notCompletedWarning, reminderText, canTick } from '../utils/collectionWebsite';

// G25e2 (owner, 19 Nov 2026): "Apply Stock to Website" on the individual collection page.
// The server only answers superadmins (incl. GS) and the marketing lead (GM) — for anyone else
// this renders nothing. Workshop logins never reach collections (G24 / G17).

const TONE = { ok: 'text-green-800', warn: 'text-amber-800', muted: 'text-gray-600' };

export default function CollectionWebsitePanel({ collectionId }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  const [ticked, setTicked] = useState(() => new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/collections?resource=website&id=${encodeURIComponent(collectionId)}`, { headers: identityHeaders() });
      if (!r.ok) { setData(null); return; } // not allowed / not found → nothing shown
      setData(await r.json());
    } catch {
      setData(null);
    }
  }, [collectionId]);

  useEffect(() => { load(); }, [load]);

  if (!data || data.ready === false) return null; // hidden until database update 0017

  const items = Array.isArray(data.items) ? data.items : [];
  const tickable = items.filter(canTick);
  // Rows a press would retry (waiting / failed / handed back by a lookup or the daily job) —
  // counted by the server across every row, not just each line's latest.
  const retryable = Number(data.retryable) > 0;
  const reminder = reminderText(data.notOnWebsite);
  const warning = notCompletedWarning(data.status);

  const send = async (all) => {
    const chosen = all ? tickable : tickable.filter((it) => ticked.has(it.collection_items_id));
    const units = chosen.reduce((s, it) => s + Number(it.remaining || 0), 0);
    if (!chosen.length && !(all && retryable)) { toast.error('Nothing to send'); return; }
    const question = chosen.length ? sendConfirmText({ items: chosen.length, units, dryRun: data.dryRun }) : 'Retry the website update for the items that failed?';
    // eslint-disable-next-line no-alert
    if (!window.confirm(`${question}${warning ? `\n\n${warning}` : ''}`)) return;
    setBusy(true);
    const id = toast.loading('Sending to the website…');
    try {
      const r = await fetch(`/api/collections?resource=website-apply&id=${encodeURIComponent(collectionId)}`, {
        method: 'POST',
        headers: identityHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(all ? { all: true } : { item_ids: chosen.map((it) => it.collection_items_id) }),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out?.error || 'Send failed');
      const s = out.summary || {};
      const parts = [s.sent && `${s.sent} updated`, s.drafts && `${s.drafts} draft${s.drafts === 1 ? '' : 's'} created`, s.dryRun && `${s.dryRun} dry run`,
        s.failed && `${s.failed} failed (press again later)`, s.needsHuman && `${s.needsHuman} need you`, s.waiting && `${s.waiting} still waiting`].filter(Boolean);
      toast.success(parts.length ? `Website: ${parts.join(', ')}` : 'Nothing new to send', { id });
      setTicked(new Set());
    } catch (e) {
      toast.error(e.message || 'Send failed', { id });
    } finally {
      setBusy(false);
      load();
    }
  };

  const toggle = (itemId) => setTicked((prev) => {
    const next = new Set(prev);
    if (next.has(itemId)) next.delete(itemId); else next.add(itemId);
    return next;
  });

  return (
    <section className="rounded border bg-white" aria-labelledby="collection-website">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id="collection-website" className="font-semibold text-gray-900">Website stock</h3>
          {reminder && <span className="rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs text-amber-800">{reminder}</span>}
          {data.dryRun && data.available && <span className="rounded border border-gray-200 bg-gray-50 px-2 py-0.5 text-xs text-gray-700">Dry run — nothing is written to the website</span>}
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={!data.available}
          aria-expanded={open}
          aria-controls="collection-website-dialog"
          title={data.available ? '' : data.reason || ''}
          className="rounded bg-[#B50B1D] px-4 py-1.5 text-sm font-medium text-white hover:bg-[#930917] disabled:cursor-not-allowed disabled:opacity-50"
        >
          Apply Stock to Website
        </button>
      </div>
      {!data.available && data.reason && <p className="px-3 py-2 text-sm text-gray-600">{data.reason}.</p>}

      {open && data.available && (
        <div id="collection-website-dialog" className="space-y-2 p-3">
          {warning && <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">{warning}</p>}
          <p className="text-sm text-gray-600">
            Sends what hasn't gone to the website yet. Apply Stock &amp; Cost (portal stock) is separate and never changes the website.
          </p>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-gray-600">
                  <th className="p-2"><span className="sr-only">Tick</span></th>
                  <th className="p-2">SKU</th>
                  <th className="p-2">Product</th>
                  <th className="p-2 text-right">Qty</th>
                  <th className="p-2 text-right">Sent</th>
                  <th className="p-2 text-right">Left to send</th>
                  <th className="p-2">Website</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {items.map((it) => {
                  const skip = it.state === 'skip';
                  return (
                    <tr key={it.collection_items_id} className={skip ? 'text-gray-500' : 'text-gray-900'}>
                      <td className="p-2">
                        <input
                          type="checkbox"
                          aria-label={`Send ${it.sku}`}
                          disabled={!canTick(it) || busy}
                          checked={ticked.has(it.collection_items_id)}
                          onChange={() => toggle(it.collection_items_id)}
                        />
                      </td>
                      <td className="p-2 font-mono">{it.sku}</td>
                      <td className="p-2">{it.name || '—'}</td>
                      <td className="p-2 text-right">{it.quantity}</td>
                      <td className="p-2 text-right">{skip ? '—' : it.applied}</td>
                      <td className="p-2 text-right">{skip ? '—' : it.remaining}</td>
                      <td className={`p-2 ${TONE[it.tone] || TONE.muted}`}>
                        {it.note || (skip ? 'Not synced' : '')}
                        {it.adminUrl && (
                          <>
                            {' '}
                            <a href={it.adminUrl} target="_blank" rel="noopener noreferrer" className="underline">Open in wp-admin</a>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={() => send(false)}
              disabled={busy || !ticked.size}
              className="rounded border border-gray-300 bg-white px-4 py-1.5 text-sm text-gray-900 hover:bg-gray-50 disabled:opacity-50"
            >
              Send ticked ({ticked.size})
            </button>
            <button
              type="button"
              onClick={() => send(true)}
              disabled={busy || (!tickable.length && !retryable)}
              className="rounded bg-[#B50B1D] px-4 py-1.5 text-sm font-medium text-white hover:bg-[#930917] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {tickable.length || !retryable ? 'Send all remaining' : 'Retry failed'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
