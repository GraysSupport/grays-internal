import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';

const PAGE_SIZE = 20;

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString();
}

// format qty: no decimals if integer; otherwise show up to 2 decimals (trimmed)
function formatQty(q) {
  const n = Number(q);
  if (Number.isNaN(n)) return String(q ?? '');
  if (Number.isInteger(n)) return String(n);
  // trim trailing zeros but cap at 2 dp
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

// Build "Qty × Name" using product_name (fallback product_id)
function formatItemsFromItems(items) {
  if (!Array.isArray(items) || !items.length) return '—';
  return items
    .map((it) => `${formatQty(it.quantity)} × ${it.product_name || it.product_id || ''}`)
    .join(', ');
}

export default function ActiveWorkordersPage() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const navigate = useNavigate();

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      toast.loading('Loading work orders...', { id: 'wo-load' });
      try {
        const res = await fetch('/api/workorder');
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || 'Failed to load');

        const active = (data || []).filter(
          (w) => String(w.status || '').trim().toLowerCase() === 'work ordered'
        );

        if (mounted) setRows(active);
        toast.success('Work orders loaded', { id: 'wo-load' });
      } catch (e) {
        toast.error(e.message || 'Failed to load work orders', { id: 'wo-load' });
      } finally {
        if (mounted) setLoading(false);
      }
    };
    load();
    return () => {
      mounted = false;
    };
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((w) => {
      // Use items array so we can format qty as requested
      const itemsStr = formatItemsFromItems(w.items || []);
      return [
        w.invoice_id ?? '',
        w.customer_name ?? '',
        w.delivery_suburb ?? '',
        w.delivery_state ?? '',
        w.salesperson ?? '',
        w.notes ?? '',
        itemsStr,
      ]
        .join(' ')
        .toLowerCase()
        .includes(q);
    });
  }, [rows, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }, [filtered, page]);

  useEffect(() => {
    if (page > totalPages) setPage(1);
  }, [totalPages, page]);

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      {/* Header */}
      <header className="border-b bg-white">
        <div className="py-4 px-4">
          <h1 className="text-2xl font-semibold tracking-tight text-center">
            Delivery Operations
          </h1>
        </div>
      </header>

      {/* Main container with matching side paddings */}
      <div className="grid grid-cols-12 gap-6 py-6 px-4">
        {/* Sidebar */}
        <aside className="col-span-12 sm:col-span-3 lg:col-span-2">
          <div className="sticky top-6 rounded-xl border bg-white p-4">
            <div className="mb-4 font-semibold">Current</div>
            <nav className="space-y-1">
              <span className="block rounded-md bg-gray-100 px-3 py-2 text-sm font-medium">
                Current Operations
              </span>
              <Link
                to="/delivery_operations/to-be-booked"
                className="block rounded-md px-3 py-2 text-sm hover:bg-gray-50"
              >
                To Be Booked
              </Link>
              <Link
                to="/delivery_operations/schedule"
                className="block rounded-md px-3 py-2 text-sm hover:bg-gray-50"
              >
                Delivery Schedule
              </Link>
            </nav>
            <div className="my-4 h-px bg-gray-200" />
            <div className="mb-2 font-semibold">Completed</div>
            <nav className="space-y-1">
              <Link
                to="/delivery_operations/completed-operations"
                className="block rounded-md px-3 py-2 text-sm hover:bg-gray-50"
              >
                Operations Completed
              </Link>
              <Link
                to="/delivery_operations/completed-deliveries"
                className="block rounded-md px-3 py-2 text-sm hover:bg-gray-50"
              >
                Deliveries Completed
              </Link>
            </nav>
            <div className="my-4 h-px bg-gray-200" />
            <Link
              to="/dashboard"
              className="block rounded-md px-3 py-2 text-sm font-semibold text-red-600 hover:bg-red-50"
            >
              Exit
            </Link>
          </div>
        </aside>

        {/* Main */}
        <main className="col-span-12 sm:col-span-9 lg:col-span-10">
          <div className="rounded-xl border bg-white">
            {/* Toolbar: center header between search and button on sm+ */}
            <div className="border-b p-4 grid gap-3 grid-cols-1 sm:grid-cols-3 items-center">
              {/* Left: Search */}
              <div className="w-full sm:max-w-xs">
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search"
                  className="w-full rounded-lg border px-3 py-2 outline-none focus:ring-2 focus:ring-gray-300"
                />
              </div>

              {/* Center: Title */}
              <div className="hidden sm:flex justify-center">
                <h2 className="text-lg font-semibold">Current Operations</h2>
              </div>
              {/* Mobile title (stacked) */}
              <div className="sm:hidden">
                <h2 className="text-lg font-semibold">Current Operations</h2>
              </div>

              {/* Right: Create button */}
              <div className="flex sm:justify-end">
                <Link
                  to="/create_workorder"
                  className="inline-flex items-center rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-black/90"
                >
                  + Create New Work Order
                </Link>
              </div>
            </div>

            {/* Table */}
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 table-fixed">
                <thead className="bg-gray-100">
                  <tr className="text-left text-xs font-semibold uppercase tracking-wider text-gray-600">
                    <th className="px-4 py-3 w-20">Invoice</th>
                    <th className="px-4 py-3 w-28">WO Date</th>
                    <th className="px-4 py-3 w-36">Name</th>
                    <th className="px-4 py-3 w-28">Suburb</th>
                    <th className="px-4 py-3 w-20">State</th>
                    <th className="px-4 py-3">Items</th>
                    <th className="px-4 py-3 w-20">Sales</th>
                    <th className="px-4 py-3 w-28">Payment</th>
                    <th className="px-4 py-3 w-28">Target</th>
                    <th className="px-4 py-3 w-40">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {loading && (
                    <tr>
                      <td colSpan={10} className="px-4 py-6 text-center text-sm">
                        Loading…
                      </td>
                    </tr>
                  )}

                  {!loading && pageRows.length === 0 && (
                    <tr>
                      <td colSpan={10} className="px-4 py-6 text-center text-sm">
                        No active work orders.
                      </td>
                    </tr>
                  )}

                  {pageRows.map((w) => {
                    const itemsStr = formatItemsFromItems(w.items);

                    const hasDue =
                      w.outstanding_balance != null &&
                      Number(w.outstanding_balance) > 0;

                    return (
                      <tr
                        key={w.workorder_id}
                        className="cursor-pointer align-top odd:bg-white even:bg-gray-50 hover:bg-gray-100"
                        onClick={() => navigate(`/workorder/${w.workorder_id}`)}
                      >
                        <td className="px-4 py-3 text-sm font-medium w-20">
                          {w.invoice_id ?? '—'}
                        </td>
                        <td className="px-4 py-3 text-sm w-28">
                          {formatDate(w.date_created)}
                        </td>
                        <td className="px-4 py-3 text-sm w-36">
                          {w.customer_name ?? '—'}
                        </td>
                        <td className="px-4 py-3 text-sm w-28">
                          {w.delivery_suburb ?? '—'}
                        </td>
                        <td className="px-4 py-3 text-sm w-20">
                          {w.delivery_state ?? '—'}
                        </td>
                        <td className="px-4 py-3 text-sm whitespace-normal break-words">
                          {itemsStr}
                        </td>
                        <td className="px-4 py-3 text-sm w-20">
                          {w.salesperson ?? '—'}
                        </td>
                        <td className="px-4 py-3 text-sm w-28">
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
                        <td className="px-4 py-3 text-sm w-28">
                          {formatDate(w.estimated_completion)}
                        </td>
                        <td className="px-4 py-3 text-sm whitespace-normal break-words w-40">
                          {w.notes || '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="flex items-center justify-between border-t p-3 text-sm">
              <div className="text-gray-600">
                Showing{' '}
                <span className="font-medium">
                  {filtered.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1}
                </span>{' '}
                to{' '}
                <span className="font-medium">
                  {Math.min(page * PAGE_SIZE, filtered.length)}
                </span>{' '}
                of <span className="font-medium">{filtered.length}</span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  disabled={page === 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="rounded-md border px-3 py-1 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  ← Previous
                </button>
                <span className="mx-2 rounded-md bg-gray-900 px-3 py-1 text-white">
                  {page}
                </span>
                <button
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  className="rounded-md border px-3 py-1 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Next →
                </button>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
