// src/components/EcomAutoTickedPopup.js — GS one-time popup (owner, 26 Nov 2026).
//
// Once the website dry run is off, a successful website stock update ticks the E-Commerce flag
// by itself, so those workorders leave the "Ecommerce checks pending" popup. GS still has to
// open each one ONCE to enter the sold items' values. This popup lists them; opening a workorder
// clears it for good (the workorder page tells the server — src/utils/ecomAutoTicked.js).
// The server only answers GS; anyone else gets 403 and sees nothing.
import { useEffect, useState } from 'react';
import { identityHeaders } from '../utils/workshopAccess';
import { formatSoldItems, formatTickedAt } from '../utils/ecomAutoTicked';

export default function EcomAutoTickedPopup({ onOpen }) {
  const [rows, setRows] = useState([]);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch('/api/workorder?resource=ecommerce-auto-ticked', { headers: identityHeaders() });
        if (!r.ok) return;
        const data = await r.json();
        if (alive && Array.isArray(data?.rows)) setRows(data.rows);
      } catch {
        // Best-effort: the popup is a reminder, never a blocker.
      }
    })();
    return () => { alive = false; };
  }, []);

  if (!open || rows.length === 0) return null;

  return (
    <div className="fixed inset-0 z-[2100] bg-black/40 flex items-center justify-center p-4" onMouseDown={() => setOpen(false)}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ecom-auto-title"
        className="w-full max-w-3xl rounded-xl bg-white shadow-lg border"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="border-b p-4 flex items-start justify-between gap-4">
          <div>
            <h2 id="ecom-auto-title" className="text-lg font-semibold">Website stock updated automatically</h2>
            <p className="text-sm text-gray-600">
              The website stock for these workorders was updated and E-Commerce was ticked off for you.
              Open each one to enter the value of the sold items. Once you've opened a workorder it won't show here again.
            </p>
          </div>
          <button className="rounded-md border px-3 py-1 text-sm hover:bg-gray-50" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>

        <div className="p-4 max-h-[60vh] overflow-auto">
          <div className="overflow-x-auto rounded-lg border">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-100">
                <tr className="text-left text-xs font-semibold uppercase tracking-wider text-gray-600">
                  <th className="px-3 py-2 w-28">Invoice</th>
                  <th className="px-3 py-2">Customer</th>
                  <th className="px-3 py-2">Sold items</th>
                  <th className="px-3 py-2 w-32">Website updated</th>
                  <th className="px-3 py-2 w-24">Open</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((w) => (
                  <tr key={w.workorder_id} className="bg-white align-top">
                    <td className="px-3 py-2 text-sm font-medium">{w.invoice_id ?? '—'}</td>
                    <td className="px-3 py-2 text-sm">{w.customer_name ?? '—'}</td>
                    <td className="px-3 py-2 text-sm">{formatSoldItems(w.items)}</td>
                    <td className="px-3 py-2 text-xs text-gray-600">{formatTickedAt(w.ecommerce_auto_ticked_at)}</td>
                    <td className="px-3 py-2 text-sm">
                      <button
                        className="rounded-md bg-[#B50B1D] px-3 py-1 text-white text-sm hover:bg-[#9a0918]"
                        aria-label={`Open ${w.invoice_id ?? `workorder ${w.workorder_id}`}`}
                        onClick={() => { setOpen(false); onOpen(Number(w.workorder_id)); }}
                      >
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
