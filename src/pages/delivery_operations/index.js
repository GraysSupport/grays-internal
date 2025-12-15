import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import toast from 'react-hot-toast';
import { SlidersHorizontal } from 'lucide-react';
import DeliveryTabs from '../../components/DeliveryTabs';

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

export default function ActiveWorkordersPage() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({ state: '', salesperson: '', payment: '', technicians: [] });
  const [technicians, setTechnicians] = useState([]);
  const [salespeople, setSalespeople] = useState([]);
  const [showFilters, setShowFilters] = useState(false);

  // ✅ user + GS popup
  const [user, setUser] = useState(null);
  const isGS = user?.id === 'GS';
  const [showEcomPopup, setShowEcomPopup] = useState(false);

  const navigate = useNavigate();

  // URL filter support
  const location = useLocation();
  const urlParams = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const routerFilter = urlParams.get('filter'); // "past-target" | "important" | null

  // today helper
  const today = useMemo(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }, []);

  // Load user
  useEffect(() => {
    const stored = localStorage.getItem('user');
    if (!stored) { navigate('/'); return; }
    try {
      setUser(JSON.parse(stored));
    } catch {
      navigate('/');
    }
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

  useEffect(() => {
    const stored = localStorage.getItem('user');
    if (!stored) { navigate('/'); return; }

    let mounted = true;
    (async () => {
      setLoading(true);
      toast.loading('Loading work orders...', { id: 'wo-load' });

      try {
        const res = await fetch('/api/workorder?status=Work%20Ordered');
        const data = await res.json();

        if (!res.ok) throw new Error(data?.error || 'Failed to load work orders');
        if (mounted) {
          setRows(data);
          const uniqueSales = [...new Set(data.map(w => w.salesperson).filter(Boolean))].sort();
          setSalespeople(uniqueSales);

          // ✅ GS-only auto popup if any ecommerce=false
          if (isGS) {
            const unChecked = (data || []).filter(w => w?.ecommerce === false);
            if (unChecked.length > 0) setShowEcomPopup(true);
          }
        }

        toast.success('Work orders loaded', { id: 'wo-load' });
      } catch (e) {
        toast.error(e.message || 'Failed to load work orders', { id: 'wo-load' });
      } finally {
        if (mounted) setLoading(false);
      }
    })();

    return () => { mounted = false; };
  }, [navigate, isGS]);

  const ecommerceUnchecked = useMemo(() => {
    return (rows || []).filter(w => w?.ecommerce === false);
  }, [rows]);

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
    if (filters.payment === 'Paid') base = base.filter(w => Number(w.outstanding_balance) <= 0);
    else if (filters.payment === 'Outstanding') base = base.filter(w => Number(w.outstanding_balance) > 0);
    if (filters.technicians.length > 0) {
      base = base.filter(w => (w.technicians || []).some(t => filters.technicians.includes(String(t.id))));
    }

    // sort
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

    // URL router filter
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
      filters.payment ||
      (filters.technicians && filters.technicians.length > 0) ||
      routerFilter
    );
  }, [search, filters, routerFilter]);

  const handlePrint = () => {
    const fullCols = [
      { key: 'invoice', header: 'Invoice', get: (w) => w.invoice_id ?? '—' },
      { key: 'woDate', header: 'WO Date', get: (w) => formatDate(w.date_created) },
      { key: 'name', header: 'Name', get: (w) => w.customer_name ?? '—' },
      { key: 'suburb', header: 'Suburb', get: (w) => w.delivery_suburb ?? '—' },
      { key: 'state', header: 'State', get: (w) => w.delivery_state ?? '—' },
      { key: 'items', header: 'Items', get: (w) => formatItemsFromItems(w.items) },
      { key: 'sales', header: 'Sales', get: (w) => w.salesperson ?? '—' },
      {
        key: 'payment', header: 'Payment',
        get: (w) => {
          const due = Number(w.outstanding_balance);
          if (isNaN(due)) return '—';
          return due > 0 ? `$${due.toFixed(2)}` : 'Paid';
        }
      },
      { key: 'techs', header: 'Technicians', get: (w) => formatTechnicians(w.technicians) },
      { key: 'target', header: 'Target', get: (w) => formatDate(w.estimated_completion) },
      { key: 'notes', header: 'Notes', get: (w) => w.notes || '—' }
    ];

    const compactCols = [
      { key: 'invoice', header: 'Invoice', get: (w) => w.invoice_id ?? '—' },
      { key: 'woDate', header: 'WO Date', get: (w) => formatDate(w.date_created) },
      { key: 'name', header: 'Name', get: (w) => w.customer_name ?? '—' },
      { key: 'suburb', header: 'Suburb', get: (w) => w.delivery_suburb ?? '—' },
      { key: 'state', header: 'State', get: (w) => w.delivery_state ?? '—' },
      { key: 'items', header: 'Items', get: (w) => formatItemsFromItems(w.items) },
      { key: 'sales', header: 'Sales', get: (w) => w.salesperson ?? '—' },
      { key: 'techs', header: 'Technicians', get: (w) => formatTechnicians(w.technicians) },
      { key: 'target', header: 'Target', get: (w) => formatDate(w.estimated_completion) },
      { key: 'notes', header: 'Notes', get: (w) => w.notes || '—' }
    ];

    const cols = filtersActive ? compactCols : fullCols;
    const title = `Active Work Orders${filtersActive ? ' (Filtered)' : ''}`;

    const rowsHtml = (filtered || [])
      .map(w => {
        const tds = cols.map(c => `<td>${escapeHtml(String(c.get(w) ?? ''))}</td>`).join('');
        const impClass = w.important_flag ? ' row-important' : '';
        return `<tbody class="row-block${impClass}"><tr>${tds}</tr></tbody>`;
      })
      .join('');

    const thead = `<thead><tr>${cols.map(c => `<th>${c.header}</th>`).join('')}</tr></thead>`;

    const now = new Date();
    const meta = `${now.toLocaleString()}${buildFilterSummary(filters, search)}${routerFilter ? ` • Filter=${routerFilter}` : ''}`;

    const html = `
      <!doctype html>
      <html>
      <head>
      <meta charset="utf-8" />
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
        tfoot { display: table-footer-group; }
        tbody { break-inside: avoid-page; page-break-inside: avoid; }
        tr, th, td { break-inside: avoid-page; page-break-inside: avoid; }
        .footer { margin-top: 8px; font-size:10px; color:#777; }
        tbody.row-important td { background:#eee !important; }
      </style>
      </head>
      <body>
        <h1>${title}</h1>
        <div class="meta">Printed: ${escapeHtml(meta)}</div>
        <table>
            ${thead}
            ${rowsHtml || `<tbody><tr><td colspan="${cols.length}">No active work orders.</td></tr></tbody>`}
        </table>
        <script>window.onload = () => window.print();</script>
      </body>
      </html>`.trim();

    const win = window.open('', '_blank');
    if (!win) return;
    win.document.open();
    win.document.write(html);
    win.document.close();
  };

  function escapeHtml(s) {
    return s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
      .replaceAll('"','&quot;').replaceAll("'",'&#039;');
  }
  function buildFilterSummary(f, q) {
    const parts = [];
    if (q && q.trim()) parts.push(`Search="${q.trim()}"`);
    if (f.state) parts.push(`State=${f.state}`);
    if (f.salesperson) parts.push(`Salesperson=${f.salesperson}`);
    if (f.payment) parts.push(`Payment=${f.payment}`);
    if (f.technicians?.length) parts.push(`Technicians=${f.technicians.length} selected`);
    return parts.length ? ` • ${parts.join(' • ')}` : '';
  }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 flex flex-col">
      {/* Header */}
      <header className="border-b bg-white">
        <div className="py-4 px-4 flex items-center justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">Delivery Operations</h1>
          <button
            onClick={() => setShowFilters(f => !f)}
            className="rounded-lg border px-3 py-2 hover:bg-gray-50 flex items-center gap-1"
          >
            <SlidersHorizontal size={16} />
            Filters
          </button>
        </div>
      </header>

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
              <Link
                to="/create_workorder"
                className="ml-auto inline-flex items-center rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-black/90"
              >
                + Create New Work Order
              </Link>

              <button
                onClick={handlePrint}
                className="inline-flex items-center rounded-lg border px-4 py-2 text-sm font-medium hover:bg-gray-50"
                title={filtersActive ? 'Print filtered columns' : 'Print full table'}
              >
                🖨️ Print {filtersActive ? 'Filtered' : 'All'}
              </button>
            </div>

            {/* Filters */}
            {showFilters && (
              <div className="p-4 grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-4">
                {/* State */}
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

                {/* Salesperson */}
                <select
                  value={filters.salesperson}
                  onChange={(e) => setFilters(f => ({ ...f, salesperson: e.target.value }))}
                  className="rounded-lg border px-3 py-2"
                >
                  <option value="">All Salespeople</option>
                  {salespeople.map(s => (<option key={s} value={s}>{s}</option>))}
                </select>

                {/* Payment */}
                <select
                  value={filters.payment}
                  onChange={(e) => setFilters(f => ({ ...f, payment: e.target.value }))}
                  className="rounded-lg border px-3 py-2"
                >
                  <option value="">All Payments</option>
                  <option value="Paid">Paid</option>
                  <option value="Outstanding">Outstanding</option>
                </select>

                {/* Technicians */}
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
                                  : f.technicians.filter(x => x !== id)
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
                      <th className="px-3 py-2 w-28">Payment</th>
                      <th className="px-3 py-2 w-28">Technicians</th>
                      <th className="px-3 py-2 w-28">Target</th>
                      <th className="px-3 py-2 w-40">Notes</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {loading && (
                      <tr><td colSpan={11} className="px-3 py-6 text-center text-sm">Loading…</td></tr>
                    )}
                    {!loading && filtered.length === 0 && (
                      <tr><td colSpan={11} className="px-3 py-6 text-center text-sm">No active work orders.</td></tr>
                    )}
                    {!loading && filtered.map((w, idx) => {
                      const itemsStr = formatItemsFromItems(w.items);
                      const hasDue = w.outstanding_balance != null && Number(w.outstanding_balance) > 0;
                      const rowCls = idx % 2 ? 'bg-gray-50' : 'bg-white';
                      const isImportant = !!w.important_flag;
                      const overlayStyle = isImportant ? { boxShadow: 'inset 0 0 0 9999px rgba(251,191,36,0.25)' } : undefined;

                      return (
                        <tr
                          key={w.workorder_id}
                          className={`${rowCls} cursor-pointer align-top hover:bg-gray-100`}
                          onClick={() => navigate(`./workorder/${w.workorder_id}`)}
                          style={overlayStyle}
                          title={isImportant ? 'Important work order' : undefined}
                        >
                          <td className="px-3 py-2 text-sm font-medium w-20">
                            {w.invoice_id ?? '—'}
                            {isImportant && (
                              <span className="ml-2 inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800 ring-1 ring-inset ring-amber-200 align-middle">
                                Important
                              </span>
                            )}
                            {isGS && w?.ecommerce === false && (
                              <span className="ml-2 inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-800 ring-1 ring-inset ring-red-200 align-middle">
                                Ecom Pending
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
                            {hasDue ? (
                              <span className="inline-flex items-center rounded-full bg-red-50 px-2.5 py-0.5 text-xs font-semibold text-red-700 ring-1 ring-inset ring-red-200">
                                ${Number(w.outstanding_balance).toFixed(2)}
                              </span>
                            ) : (
                              <span className="inline-flex items-center rounded-full bg-green-50 px-2.5 py-0.5 text-xs font-semibold text-green-700 ring-1 ring-inset ring-green-200">
                                Paid
                              </span>
                            )}
                          </td>
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
                          <td className="px-3 py-2 text-sm w-28">{formatDate(w.estimated_completion)}</td>
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

      {/* ✅ GS popup for ecommerce=false */}
      {isGS && showEcomPopup && ecommerceUnchecked.length > 0 && (
        <div
          className="fixed inset-0 z-[2000] bg-black/40 flex items-center justify-center p-4"
          onMouseDown={() => setShowEcomPopup(false)}
        >
          <div
            className="w-full max-w-3xl rounded-xl bg-white shadow-lg border"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="border-b p-4 flex items-center justify-between">
              <div>
                <div className="text-lg font-semibold">Ecommerce checks pending</div>
                <div className="text-sm text-gray-600">
                  These workorders have <span className="font-mono">ecommerce = false</span> (not checked off).
                </div>
              </div>
              <button
                className="rounded-md border px-3 py-1 text-sm hover:bg-gray-50"
                onClick={() => setShowEcomPopup(false)}
              >
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
                      <th className="px-3 py-2 w-20">State</th>
                      <th className="px-3 py-2 w-28">Target</th>
                      <th className="px-3 py-2 w-24">Open</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {ecommerceUnchecked.map((w) => (
                      <tr key={w.workorder_id} className="bg-white">
                        <td className="px-3 py-2 text-sm font-medium">{w.invoice_id ?? '—'}</td>
                        <td className="px-3 py-2 text-sm">{w.customer_name ?? '—'}</td>
                        <td className="px-3 py-2 text-sm">{w.delivery_state ?? '—'}</td>
                        <td className="px-3 py-2 text-sm">{formatDate(w.estimated_completion)}</td>
                        <td className="px-3 py-2 text-sm">
                          <button
                            className="rounded-md bg-gray-900 px-3 py-1 text-white text-sm hover:bg-black/90"
                            onClick={() => {
                              setShowEcomPopup(false);
                              navigate(`./workorder/${w.workorder_id}`);
                            }}
                          >
                            Open
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-3 text-xs text-gray-500">
                Tip: open each workorder and use the “Check Ecommerce” button to mark it off.
              </div>
            </div>
          </div>
        </div>
      )}

      <DeliveryTabs />
    </div>
  );
}
