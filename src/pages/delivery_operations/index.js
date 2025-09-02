import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString();
}
function formatQty(q) {
  const n = Number(q);
  if (Number.isNaN(n)) return String(q ?? '');
  if (Number.isInteger(n)) return String(n);
  return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
function formatItemsFromItems(items) {
  if (!Array.isArray(items) || !items.length) return '—';
  return items.map((it) => `${formatQty(it.quantity)} × ${it.product_name || it.product_id || ''}`).join(', ');
}
function formatTechnicians(techs) {
  if (!Array.isArray(techs) || !techs.length) return '—';
  return techs.map((t) => t?.name || '').filter(Boolean).join(', ');
}

export default function ActiveWorkordersPage() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({
    state: '',
    salesperson: '',
    payment: '',
    technician: ''
  });
  const [technicians, setTechnicians] = useState([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const navigate = useNavigate();

  // Fetch technicians for dropdown
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

  // Fetch workorders with filters
  useEffect(() => {
    const stored = localStorage.getItem('user');
    if (!stored) {
      navigate('/');
      return;
    }

    let mounted = true;
    (async () => {
      setLoading(true);
      toast.loading('Loading work orders...', { id: 'wo-load' });

      try {
        // Map human-readable status to backend enum
        const STATUS_MAP = {
        'Work Ordered': 'Work Ordered',
        'Completed': 'Completed',
        'Not in Workshop': 'Not in Workshop',
        'In Workshop': 'In Workshop'
      };

        const params = new URLSearchParams();

        // Default status
        const statusEnum = STATUS_MAP['Work Ordered']; // → "Work Ordered"
        params.append('status', encodeURIComponent(statusEnum));

        // Add other filters dynamically
        Object.entries(filters).forEach(([k, v]) => {
          if (v) params.append(k, v);
        });

        const res = await fetch(`/api/workorder?${params.toString()}`);
        const data = await res.json();

        if (!res.ok) throw new Error(data?.error || 'Failed to load work orders');
        if (mounted) setRows(data);

        toast.success('Work orders loaded', { id: 'wo-load' });
      } catch (e) {
        toast.error(e.message || 'Failed to load work orders', { id: 'wo-load' });
      } finally {
        if (mounted) setLoading(false);
      }
    })();

    return () => { mounted = false; };
  }, [navigate, filters]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = q
      ? rows.filter((w) => {
          const itemsStr = formatItemsFromItems(w.items || []);
          return [
            w.invoice_id ?? '',
            w.customer_name ?? '',
            w.delivery_suburb ?? '',
            w.delivery_state ?? '',
            w.salesperson ?? '',
            w.notes ?? '',
            itemsStr,
          ].join(' ').toLowerCase().includes(q);
        })
      : rows;

    const toTime = (d) => {
      if (!d) return Number.POSITIVE_INFINITY;
      const t = new Date(d).getTime();
      return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
    };

    return [...base].sort((a, b) => {
      const targetDiff = toTime(a.estimated_completion) - toTime(b.estimated_completion);
      if (targetDiff !== 0) return targetDiff;
      return toTime(a.date_created) - toTime(b.date_created);
    });
  }, [rows, search]);

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      {/* Header */}
      <header className="border-b bg-white">
        <div className="py-4 px-4 flex items-center justify-between gap-4">
          <button
            type="button"
            onClick={() => setSidebarOpen((s) => !s)}
            className="rounded-lg border px-3 py-2 hover:bg-gray-50"
            title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
          >
            <div className="space-y-1">
              <span className="block h-0.5 w-5 bg-gray-700"></span>
              <span className="block h-0.5 w-5 bg-gray-700"></span>
              <span className="block h-0.5 w-5 bg-gray-700"></span>
            </div>
          </button>
          <h1 className="text-2xl font-semibold tracking-tight flex-1 text-center">
            Delivery Operations
          </h1>
          <div className="w-[40px]" />
        </div>
      </header>

      <div className="grid grid-cols-12 gap-6 py-6 px-4">
        {/* Sidebar */}
        {sidebarOpen && (
          <aside className="col-span-12 sm:col-span-3 lg:col-span-2">
            <div className="sticky top-6 rounded-xl border bg-white p-4">
              <div className="mb-4 font-semibold">Current</div>
              <nav className="space-y-1">
                <span className="block rounded-md bg-gray-100 px-3 py-2 text-sm font-medium">
                  Current Operations
                </span>
                <Link to="/delivery_operations/to-be-booked" className="block rounded-md px-3 py-2 text-sm hover:bg-gray-50">
                  To Be Booked
                </Link>
                <Link to="/delivery_operations/schedule" className="block rounded-md px-3 py-2 text-sm hover:bg-gray-50">
                  Delivery Schedule
                </Link>
                <Link to="/delivery_operations/current-collections" className="block rounded-md px-3 py-2 text-sm hover:bg-gray-50">
                  Current Collections
                </Link>
              </nav>
              <div className="my-4 h-px bg-gray-200" />
              <div className="mb-2 font-semibold">Completed</div>
              <nav className="space-y-1">
                <Link to="/delivery_operations/completed-operations" className="block rounded-md px-3 py-2 text-sm hover:bg-gray-50">
                  Operations Completed
                </Link>
                <Link to="/delivery_operations/completed-deliveries" className="block rounded-md px-3 py-2 text-sm hover:bg-gray-50">
                  Deliveries Completed
                </Link>
                <Link to="/delivery_operations/completed-collections" className="block rounded-md px-3 py-2 text-sm hover:bg-gray-50">
                  Collections Completed
                </Link>
              </nav>
              <div className="my-4 h-px bg-gray-200" />
              <Link to="/dashboard" className="block rounded-md px-3 py-2 text-sm font-semibold text-red-600 hover:bg-red-50">
                Exit
              </Link>
            </div>
          </aside>
        )}

        {/* Main */}
        <main className={sidebarOpen ? 'col-span-12 sm:col-span-9 lg:col-span-10' : 'col-span-12'}>
          <div className="rounded-xl border bg-white">
            {/* Toolbar */}
            <div className="border-b p-4 grid gap-3 grid-cols-1 lg:grid-cols-5 items-center">
              {/* Search */}
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search"
                className="w-full rounded-lg border px-3 py-2 outline-none focus:ring-2 focus:ring-gray-300"
              />

              {/* State */}
              <select
                value={filters.state}
                onChange={(e) => setFilters(f => ({ ...f, state: e.target.value }))}
                className="rounded-lg border px-3 py-2"
              >
                <option value="">All States</option>
                <option value="NSW">NSW</option>
                <option value="VIC">VIC</option>
                <option value="QLD">QLD</option>
                <option value="SA">SA</option>
                <option value="WA">WA</option>
                <option value="TAS">TAS</option>
                <option value="NT">NT</option>
              </select>

              {/* Salesperson */}
              <input
                type="text"
                value={filters.salesperson}
                onChange={(e) => setFilters(f => ({ ...f, salesperson: e.target.value }))}
                placeholder="Salesperson"
                className="rounded-lg border px-3 py-2"
              />

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

              {/* Technician */}
              <select
                value={filters.technician}
                onChange={(e) => setFilters(f => ({ ...f, technician: e.target.value }))}
                className="rounded-lg border px-3 py-2"
              >
                <option value="">All Technicians</option>
                {technicians.map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              <div className="flex justify-end col-span-1 sm:col-span-3 mt-2">
                <Link
                  to="/create_workorder"
                  className="inline-flex items-center rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-black/90"
                >
                  + Create New Work Order
                </Link>
              </div>
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
                      const techsStr = formatTechnicians(w.technicians);
                      const hasDue = w.outstanding_balance != null && Number(w.outstanding_balance) > 0;
                      const rowCls = idx % 2 ? 'bg-gray-50' : 'bg-white';
                      return (
                        <tr
                          key={w.workorder_id}
                          className={`${rowCls} cursor-pointer align-top hover:bg-gray-100`}
                          onClick={() => navigate(`./workorder/${w.workorder_id}`)}
                        >
                          <td className="px-3 py-2 text-sm font-medium w-20">{w.invoice_id ?? '—'}</td>
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
                          <td className="px-3 py-2 text-sm w-28 whitespace-pre-wrap break-words">
                            {techsStr}
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
    </div>
  );
}
