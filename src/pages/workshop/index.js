import { useCallback, useEffect, useRef, useState } from 'react';

const TECH_BADGE_COLORS = {
  Joe: '#F4B084',
  Eden: '#FFFFCF',
  Toby: '#FEFE41',
  Lino: '#BDD7EE',
  Brett: '#CDCFD0',
};

function techBadgeColor(name) {
  return TECH_BADGE_COLORS[name] || '#E5E7EB';
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

function formatItems(items) {
  if (!Array.isArray(items) || !items.length) return '—';
  return items
    .map((it) => {
      const qty = Number(it.quantity);
      const qtyStr = Number.isInteger(qty) ? String(qty) : qty.toFixed(2);
      const name = it.product_name || '—';
      const cond = it.condition ? ` (${it.condition})` : '';
      return `${qtyStr} × ${name}${cond}`;
    })
    .join(', ');
}

export default function WorkshopPage() {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [flash, setFlash] = useState(false);
  const seenIds = useRef(new Set());

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch('/api/workorder?status=Work%20Ordered');
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed');

      const incoming = data.map((w) => w.workorder_id);
      if (seenIds.current.size > 0) {
        const newOnes = incoming.filter((id) => !seenIds.current.has(id));
        if (newOnes.length > 0) setFlash(true);
      }
      seenIds.current = new Set(incoming);

      setJobs(data);
    } catch (e) {
      console.error('Workshop poll error:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchJobs();
    const interval = setInterval(fetchJobs, 30_000);
    return () => clearInterval(interval);
  }, [fetchJobs]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(false), 3000);
    return () => clearTimeout(t);
  }, [flash]);

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col">
      <div className="bg-gray-900 px-6 py-4 flex items-center justify-between">
        <span className="font-bold text-lg">🔧 Workshop Run Sheet</span>
        <div className="flex items-center gap-4 text-xs text-gray-400">
          <span>Auto-refresh: 30s</span>
          <span>{jobs.length} job{jobs.length !== 1 ? 's' : ''}</span>
        </div>
      </div>

      {flash && (
        <div className="bg-green-500 text-white text-center py-2 text-sm font-semibold">
          ✅ New job added to the queue
        </div>
      )}

      {loading ? (
        <div className="flex-1 flex items-center justify-center text-gray-400">
          Loading jobs…
        </div>
      ) : jobs.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-gray-400">
          No active work orders
        </div>
      ) : (
        <div className="p-6 grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {jobs.map((w) => (
            <div
              key={w.workorder_id}
              className={`rounded-xl border bg-gray-900 p-4 flex flex-col gap-2 shadow ${
                w.important ? 'border-amber-400 border-2' : 'border-gray-700'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-bold text-white">{w.invoice_id}</span>
                {w.important && (
                  <span className="bg-amber-400 text-gray-900 text-xs font-bold px-2 py-0.5 rounded">
                    ⚑ IMPORTANT
                  </span>
                )}
              </div>

              <div className="text-sm text-gray-300">{w.customer_name}</div>

              <div className="text-xs text-gray-400 leading-relaxed">
                {formatItems(w.items)}
              </div>

              <div className="flex flex-wrap gap-1">
                {w.technicians && w.technicians.length > 0 ? (
                  w.technicians.map((t) => (
                    <span
                      key={t.name}
                      style={{ backgroundColor: techBadgeColor(t.name) }}
                      className="text-gray-900 text-xs font-semibold px-2 py-0.5 rounded-full"
                    >
                      {t.name}
                    </span>
                  ))
                ) : (
                  <span className="text-xs text-gray-500">—</span>
                )}
              </div>

              <div className="flex items-center justify-between">
                <span className="text-xs bg-blue-900 text-blue-200 px-2 py-0.5 rounded">
                  {w.status}
                </span>
                <span className="text-xs text-gray-400">
                  Est: {formatDate(w.estimated_completion)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
