import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import toast from 'react-hot-toast';
import { SlidersHorizontal } from 'lucide-react';

const REFRESH_INTERVAL = 30_000;

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

function formatQty(q) {
  const n = Number(q);
  if (Number.isNaN(n)) return String(q ?? '');
  if (Number.isInteger(n)) return String(n);
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
function formatItemsFromItems(items) {
  if (!Array.isArray(items) || !items.length) return '—';
  return items
    .map((it) => {
      const qty = formatQty(it.quantity);
      const name = it.product_name || it.product_id || '';
      const cond = it.condition || '';
      return `${qty} × ${name}${cond ? ` (${cond})` : ''}`;
    })
    .join(', ');
}
function formatTechnicians(techs) {
  if (!Array.isArray(techs) || !techs.length) return '—';
  return techs.map((t) => t?.name || '').filter(Boolean).join(', ');
}

const TECH_BADGE_COLORS = { Joe: '#F4B084', Eden: '#FFFFCF', Toby: '#FEFE41', Lino: '#BDD7EE', Brett: '#CDCFD0' };
function techColor(name) { return TECH_BADGE_COLORS[name] || '#E5E7EB'; }

// Due-date severity — returns one of 6 keys or null (no date)
const SEVERITY = {
  overdue:     { rowCls: 'bg-red-100',     label: 'Overdue',        dot: 'bg-red-500',    text: 'text-red-700'    },
  today:       { rowCls: 'bg-orange-100',  label: 'Due Today',      dot: 'bg-orange-500', text: 'text-orange-700' },
  imminent:    { rowCls: 'bg-amber-50',    label: 'Due in 1–2 days',dot: 'bg-amber-400',  text: 'text-amber-700'  },
  soon:        { rowCls: 'bg-yellow-50',   label: 'Due in 3–5 days',dot: 'bg-yellow-400', text: 'text-yellow-700' },
  upcoming:    { rowCls: 'bg-sky-50',      label: 'Due in 6–14 days',dot:'bg-sky-400',    text: 'text-sky-700'    },
  comfortable: { rowCls: '',               label: '15+ days away',  dot: 'bg-green-400',  text: 'text-green-700'  },
};

function getDueSeverity(iso, today) {
  if (!iso) return null;
  const due = new Date(iso);
  if (Number.isNaN(due.getTime())) return null;
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  const diffDays = Math.ceil((dueDay - today) / 86_400_000);
  if (diffDays < 0)   return 'overdue';
  if (diffDays === 0) return 'today';
  if (diffDays <= 2)  return 'imminent';
  if (diffDays <= 5)  return 'soon';
  if (diffDays <= 14) return 'upcoming';
  return 'comfortable';
}

export default function WorkshopPage() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({ state: '', salesperson: '', technicians: [] });
  const [technicians, setTechnicians] = useState([]);
  const [salespeople, setSalespeople] = useState([]);
  const [showFilters, setShowFilters] = useState(false);
  const [flash, setFlash] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const seenIds = useRef(new Set());

  const navigate = useNavigate();
  const location = useLocation();
  const urlParams = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const routerFilter = urlParams.get('filter');

  const today = useMemo(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }, []);

  useEffect(() => {
    const stored = localStorage.getItem('user');
    if (!stored) { navigate('/'); return; }
  }, [navigate]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/workorder?technicians=1');
        const data = await res.json();
        if (res.ok) setTechnicians(data);
      } catch (e) {
        console.error('Failed to load technicians', e);
      }
    })();
  }, []);

  const fetchJobs = useCallback(async (silent = false) => {
    const stored = localStorage.getItem('user');
    if (!stored) { navigate('/'); return; }

    if (!silent) {
      setLoading(true);
      toast.loading('Loading work orders...', { id: 'wo-load' });
    }

    try {
      const res = await fetch('/api/workorder?status=Work%20Ordered');
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed to load work orders');

      // Detect new jobs on background refreshes
      if (silent && seenIds.current.size > 0) {
        const incoming = data.map((w) => w.workorder_id);
        const newOnes = incoming.filter((id) => !seenIds.current.has(id));
        if (newOnes.length > 0) setFlash(true);
      }
      seenIds.current = new Set(data.map((w) => w.workorder_id));

      setRows(data);
      const uniqueSales = [...new Set(data.map(w => w.salesperson).filter(Boolean))].sort();
      setSalespeople(uniqueSales);
      setLastRefreshed(new Date());

      if (!silent) toast.success('Work orders loaded', { id: 'wo-load' });
    } catch (e) {
      if (!silent) toast.error(e.message || 'Failed to load work orders', { id: 'wo-load' });
    } finally {
      if (!silent) setLoading(false);
    }
  }, [navigate]);

  // Initial load
  useEffect(() => {
    fetchJobs(false);
  }, [fetchJobs]);

  // Auto-refresh every 30s (silent)
  useEffect(() => {
    const interval = setInterval(() => fetchJobs(true), REFRESH_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchJobs]);

  // Auto-clear flash after 3s
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(false), 3000);
    return () => clearTimeout(t);
  }, [flash]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();

    let base = rows.filter((w) => {
      const itemsStr = formatItemsFromItems(w.items || []);
      const haystack = [
        w.invoice_id ?? '',
        w.customer_name ?? '',
        w.delivery_suburb ?? '',
        w.delivery_state ?? '',
        w.salesperson ?? '',
        w.notes ?? '',
        itemsStr,
      ].join(' ').toLowerCase();
      return !q || haystack.includes(q);
    });

    if (filters.state) base = base.filter(w => w.delivery_state === filters.state);
    if (filters.salesperson) base = base.filter(w => w.salesperson === filters.salesperson);
    if (filters.technicians.length > 0) {
      base = base.filter(w => (w.technicians || []).some(t => filters.technicians.includes(String(t.id))));
    }

    const toTime = (d) => {
      if (!d) return Number.POSITIVE_INFINITY;
      const t = new Date(d).getTime();
      return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
    };
    let out = [...base].sort((a, b) => {
      const targetDiff = toTime(a.estimated_completion) - toTime(b.estimated_completion);
      if (targetDiff !== 0) return targetDiff;
      return toTime(a.date_created) - toTime(b.date_created);
    });

    if (routerFilter === 'past-target') {
      out = out.filter((wo) => {
        const d = wo?.estimated_completion ? new Date(wo.estimated_completion) : null;
        return d && d < today;
      });
    } else if (routerFilter === 'important') {
      out = out.filter((wo) => !!wo?.important_flag);
    }

    return out;
  }, [rows, search, filters, routerFilter, today]);

  const filtersActive = useMemo(() => {
    return Boolean(
      search.trim() ||
      filters.state ||
      filters.salesperson ||
      (filters.technicians && filters.technicians.length > 0) ||
      routerFilter
    );
  }, [search, filters, routerFilter]);

  const handlePrint = () => {
    const cols = [
      { key: 'invoice', header: 'Invoice', get: (w) => w.invoice_id ?? '—' },
      { key: 'woDate', header: 'WO Date', get: (w) => formatDate(w.date_created) },
      { key: 'name', header: 'Name', get: (w) => w.customer_name ?? '—' },
      { key: 'suburb', header: 'Suburb', get: (w) => w.delivery_suburb ?? '—' },
      { key: 'state', header: 'State', get: (w) => w.delivery_state ?? '—' },
      { key: 'items', header: 'Items', get: (w) => formatItemsFromItems(w.items) },
      { key: 'sales', header: 'Sales', get: (w) => w.salesperson ?? '—' },
      { key: 'techs', header: 'Technicians', get: (w) => formatTechnicians(w.technicians) },
      { key: 'target', header: 'Target', get: (w) => formatDate(w.estimated_completion) },
      { key: 'notes', header: 'Notes', get: (w) => w.notes || '—' },
    ];

    const PRINT_SEVERITY_BG = {
      overdue:     '#fee2e2',
      today:       '#fed7aa',
      imminent:    '#fef3c7',
      soon:        '#fefce8',
      upcoming:    '#e0f2fe',
      comfortable: '',
    };

    const title = `Workshop Run Sheet${filtersActive ? ' (Filtered)' : ''}`;
    const rowsHtml = (filtered || [])
      .map(w => {
        const sev = getDueSeverity(w.estimated_completion, today);
        const rowBg = sev ? PRINT_SEVERITY_BG[sev] : '';
        const bgStyle = rowBg ? ` style="background:${rowBg}"` : '';
        const tds = cols.map(c => `<td>${escapeHtml(String(c.get(w) ?? ''))}</td>`).join('');
        const impClass = w.important_flag ? ' row-important' : '';
        return `<tbody class="row-block${impClass}"><tr${bgStyle}>${tds}</tr></tbody>`;
      })
      .join('');
    const thead = `<thead><tr>${cols.map(c => `<th>${c.header}</th>`).join('')}</tr></thead>`;
    const now = new Date();
    const meta = `${now.toLocaleString()}${routerFilter ? ` • Filter=${routerFilter}` : ''}`;

    const html = `
      <!doctype html><html><head><meta charset="utf-8" />
      <title>${title}</title>
      <style>
        @media print { @page { size: A4 landscape; margin: 5mm; } }
        body { font-family: system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif; color:#111; }
        h1 { margin:0 0 4px; font-size:18px; }
        .meta { margin:0 0 12px; font-size:11px; color:#555; }
        table { border-collapse: collapse; width: 100%; }
        th, td { border:1px solid #ddd; padding:6px 8px; font-size:13px; vertical-align:top; }
        th { background:#f3f4f6; text-align:left; }
        tr:nth-child(even) td { background:#fafafa; }
        thead { display: table-header-group; }
        tbody { break-inside: avoid-page; page-break-inside: avoid; }
        tbody.row-important td { background:#eee !important; }
      </style>
      </head><body>
        <h1>${title}</h1>
        <div class="meta">Printed: ${escapeHtml(meta)}</div>
        <table>${thead}${rowsHtml || `<tbody><tr><td colspan="${cols.length}">No active work orders.</td></tr></tbody>`}</table>
        <script>window.onload = () => window.print();</script>
      </body></html>`.trim();

    const win = window.open('', '_blank');
    if (!win) return;
    win.document.open();
    win.document.write(html);
    win.document.close();
  };

  function escapeHtml(s) {
    return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 flex flex-col">
      {/* Header */}
      <header className="border-b bg-white">
        <div className="py-4 px-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">Workshop Run Sheet</h1>
            {lastRefreshed && (
              <span className="text-xs text-gray-400">
                Last refreshed: {lastRefreshed.toLocaleTimeString()} · Auto-refresh: 30s
              </span>
            )}
          </div>
          <button
            onClick={() => setShowFilters(f => !f)}
            className="rounded-lg border px-3 py-2 hover:bg-gray-50 flex items-center gap-1"
          >
            <SlidersHorizontal size={16} />
            Filters
          </button>
        </div>
      </header>

      {/* New job flash */}
      {flash && (
        <div className="bg-green-500 text-white text-center py-2 text-sm font-semibold">
          ✅ New job added to the queue
        </div>
      )}

      {/* Main content */}
      <div className="grid grid-cols-12 gap-6 py-6 px-4 flex-1">
        <main className="col-span-12">
          <div className="rounded-xl border bg-white">
            {/* Toolbar */}
            <div className="border-b p-4 flex flex-col lg:flex-row gap-3 items-center">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search"
                className="w-full lg:w-64 rounded-lg border px-3 py-2 outline-none focus:ring-2 focus:ring-gray-300"
              />
              <button
                onClick={handlePrint}
                className="ml-auto inline-flex items-center rounded-lg border px-4 py-2 text-sm font-medium hover:bg-gray-50"
                title={filtersActive ? 'Print filtered columns' : 'Print all'}
              >
                🖨️ Print {filtersActive ? 'Filtered' : 'All'}
              </button>
            </div>

            {/* Filters */}
            {showFilters && (
              <div className="p-4 grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
                <select
                  value={filters.state}
                  onChange={(e) => setFilters(f => ({ ...f, state: e.target.value }))}
                  className="rounded-lg border px-3 py-2"
                >
                  <option value="">All States</option>
                  <option value="VIC">VIC</option>
                  <option value="NSW">NSW</option>
                  <option value="ACT">ACT</option>
                  <option value="QLD">QLD</option>
                  <option value="SA">SA</option>
                  <option value="WA">WA</option>
                  <option value="TAS">TAS</option>
                  <option value="NT">NT</option>
                </select>

                <select
                  value={filters.salesperson}
                  onChange={(e) => setFilters(f => ({ ...f, salesperson: e.target.value }))}
                  className="rounded-lg border px-3 py-2"
                >
                  <option value="">All Salespeople</option>
                  {salespeople.map(s => (<option key={s} value={s}>{s}</option>))}
                </select>

                <div className="border rounded-lg p-2">
                  <div className="font-medium text-sm mb-1">Technicians</div>
                  <div className="max-h-28 overflow-y-auto space-y-1">
                    {technicians.map(t => (
                      <label key={t.id} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={filters.technicians.includes(String(t.id))}
                          onChange={(e) => {
                            setFilters(f => {
                              const id = String(t.id);
                              return {
                                ...f,
                                technicians: e.target.checked
                                  ? [...f.technicians, id]
                                  : f.technicians.filter(x => x !== id),
                              };
                            });
                          }}
                        />
                        {t.name}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Severity legend */}
            <div className="px-4 pt-3 pb-1 flex flex-wrap gap-x-4 gap-y-1">
              {Object.entries(SEVERITY).map(([key, s]) => (
                <span key={key} className="flex items-center gap-1.5 text-xs text-gray-600">
                  <span className={`inline-block w-2.5 h-2.5 rounded-full ${s.dot}`} />
                  {s.label}
                </span>
              ))}
              <span className="flex items-center gap-1.5 text-xs text-gray-400 ml-2 border-l pl-3">
                ★ = Important
              </span>
            </div>

            {/* Table */}
            <div className="p-4">
              <div className="overflow-x-auto rounded-lg border">
                <table className="min-w-full divide-y divide-gray-200 table-fixed">
                  <thead className="bg-gray-100">
                    <tr className="text-left text-xs font-semibold uppercase tracking-wider text-gray-600">
                      <th className="px-3 py-2 w-20">Invoice</th>
                      <th className="px-3 py-2 w-28">WO Date</th>
                      <th className="px-3 py-2 w-36">Name</th>
                      <th className="px-3 py-2 w-28">Suburb</th>
                      <th className="px-3 py-2 w-20">State</th>
                      <th className="px-3 py-2">Items</th>
                      <th className="px-3 py-2 w-20">Sales</th>
                      <th className="px-3 py-2 w-28">Technicians</th>
                      <th className="px-3 py-2 w-28">Target</th>
                      <th className="px-3 py-2 w-40">Notes</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {loading && (
                      <tr><td colSpan={10} className="px-3 py-6 text-center text-sm">Loading…</td></tr>
                    )}
                    {!loading && filtered.length === 0 && (
                      <tr><td colSpan={10} className="px-3 py-6 text-center text-sm">No active work orders.</td></tr>
                    )}
                    {!loading && filtered.map((w) => {
                      const itemsStr = formatItemsFromItems(w.items);
                      const isImportant = !!w.important_flag;
                      const severityKey = getDueSeverity(w.estimated_completion, today);
                      const severityRowCls = severityKey ? SEVERITY[severityKey].rowCls : 'bg-white';
                      // Important adds a left amber border on top of the severity colour
                      const importantCls = isImportant ? 'border-l-4 border-amber-400' : '';

                      return (
                        <tr
                          key={w.workorder_id}
                          className={`${severityRowCls} ${importantCls} cursor-pointer align-top hover:brightness-95`}
                          onClick={() => navigate(`/delivery_operations/workorder/${w.workorder_id}`)}
                          title={isImportant ? 'Important work order' : undefined}
                        >
                          <td className="px-3 py-2 text-sm font-medium w-20">
                            {isImportant && <span className="mr-1">★</span>}
                            {w.invoice_id ?? '—'}
                            {isImportant && (
                              <span className="ml-1 inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800 ring-1 ring-inset ring-amber-200 align-middle">
                                Important
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-sm w-28">{formatDate(w.date_created)}</td>
                          <td className="px-3 py-2 text-sm w-36">{w.customer_name ?? '—'}</td>
                          <td className="px-3 py-2 text-sm w-28">{w.delivery_suburb ?? '—'}</td>
                          <td className="px-3 py-2 text-sm w-20">{w.delivery_state ?? '—'}</td>
                          <td className="px-3 py-2 text-sm whitespace-pre-wrap break-words">{itemsStr}</td>
                          <td className="px-3 py-2 text-sm w-20">{w.salesperson ?? '—'}</td>
                          <td className="px-3 py-2 text-sm w-28">
                            {(w.technicians && w.technicians.length) ? (
                              <div className="flex flex-wrap gap-1">
                                {w.technicians.map((t) => {
                                  const name = t?.name || '';
                                  const bg = techColor(name);
                                  return (
                                    <span
                                      key={name}
                                      className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset"
                                      style={{ backgroundColor: bg, color: '#111', borderColor: 'rgba(0,0,0,0.08)' }}
                                      title={name}
                                    >
                                      {name}
                                    </span>
                                  );
                                })}
                              </div>
                            ) : '—'}
                          </td>
                          <td className={`px-3 py-2 text-sm w-28 font-medium ${severityKey ? SEVERITY[severityKey].text : ''}`}>
                            {formatDate(w.estimated_completion)}
                          </td>
                          <td className="px-3 py-2 text-sm whitespace-pre-wrap break-words w-40">{w.notes || '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </main>
      </div>

      {/* Exit-only footer */}
      <div className="sticky bottom-0 z-30 border-t bg-white shadow-lg">
        <div className="px-3 py-2 flex items-center justify-end">
          <a
            href="/dashboard"
            className="px-4 py-2 text-sm rounded-xl hover:bg-red-50 text-red-600 font-semibold"
          >
            Exit
          </a>
        </div>
      </div>
    </div>
  );
}
