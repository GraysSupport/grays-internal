import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import CollectionModal from '../../components/CollectionModal';
import DeliveryTabs from '../../components/DeliveryTabs';

const PAGE_SIZE = 30; // tweak as you like

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

export default function CompletedCollectionsPage() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editRow, setEditRow] = useState(null);
  const [page, setPage] = useState(1);

  const load = async () => {
    setLoading(true);
    toast.loading('Loading completed collections…', { id: 'colc-load' });
    try {
      const res = await fetch('/api/collections?completed=true');
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed to load');
      setRows(data || []);
      toast.success('Loaded', { id: 'colc-load' });
    } catch (e) {
      toast.error(e.message || 'Failed to load', { id: 'colc-load' });
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  // filter + sort (DESC by collection_date only)
  const filteredSorted = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = q
      ? rows.filter((r) =>
          [r.name, r.suburb, r.state, r.description, r.removalist_name, r.notes]
            .filter(Boolean).join(' ').toLowerCase().includes(q)
        )
      : rows;

    return [...base].sort((a, b) => {
      const ta = new Date(a.collection_date || 0).getTime();
      const tb = new Date(b.collection_date || 0).getTime();
      const va = Number.isNaN(ta) ? 0 : ta;
      const vb = Number.isNaN(tb) ? 0 : tb;
      return vb - va; // DESC
    });
  }, [rows, search]);

  // pagination
  const totalPages = Math.max(1, Math.ceil(filteredSorted.length / PAGE_SIZE));
  const pageRows = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filteredSorted.slice(start, start + PAGE_SIZE);
  }, [filteredSorted, page]);

  useEffect(() => {
    if (page > totalPages) setPage(1);
  }, [totalPages, page]);

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 flex flex-col">
      <header className="border-b bg-white">
        <div className="py-4 px-4">
          <h1 className="text-2xl font-semibold tracking-tight text-center">Delivery Operations</h1>
        </div>
      </header>

      <div className="grid grid-cols-12 gap-6 py-6 px-4 flex-1">
        <main className="col-span-12">
          <div className="rounded-xl border bg-white">
            <div className="border-b p-4 grid gap-3 grid-cols-1 sm:grid-cols-3 items-center">
              <div className="w-full sm:max-w-xs">
                <input
                  type="text"
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                  placeholder="Search"
                  className="w-full rounded-lg border px-3 py-2 outline-none focus:ring-2 focus:ring-gray-300"
                />
              </div>
              <div className="hidden sm:flex justify-center">
                <h2 className="text-lg font-semibold">Completed Collections</h2>
              </div>
              <div className="sm:hidden"><h2 className="text-lg font-semibold">Completed Collections</h2></div>
            </div>

            <div className="overflow-x-auto max-h-[70vh] overflow-y-auto">
              <table className="min-w-full divide-y divide-gray-200 table-fixed">
                <thead className="bg-gray-100 sticky top-0 z-10">
                  <tr className="text-left text-xs font-semibold uppercase tracking-wider text-gray-600">
                    <th className="px-4 py-3 w-40">Name</th>
                    <th className="px-4 py-3 w-28">Suburb</th>
                    <th className="px-4 py-3 w-20">State</th>
                    <th className="px-4 py-3">Description</th>
                    <th className="px-4 py-3 w-40">Carrier</th>
                    <th className="px-4 py-3 w-32">Collection Date</th>
                    <th className="px-4 py-3 w-48">Notes</th>
                    <th className="px-4 py-3 w-24">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {loading && (
                    <tr><td colSpan={8} className="px-4 py-6 text-center text-sm">Loading…</td></tr>
                  )}
                  {!loading && pageRows.length === 0 && (
                    <tr><td colSpan={8} className="px-4 py-6 text-center text-sm">No completed collections.</td></tr>
                  )}

                  {!loading && pageRows.map((r) => (
                    <tr key={r.id} className="align-top odd:bg-white even:bg-gray-50 hover:bg-gray-100">
                      <td className="px-4 py-3 text-sm w-40">{r.name}</td>
                      <td className="px-4 py-3 text-sm w-28">{r.suburb || '—'}</td>
                      <td className="px-4 py-3 text-sm w-20">{r.state || '—'}</td>
                      <td className="px-4 py-3 text-sm whitespace-normal break-words">{r.description || '—'}</td>
                      <td className="px-4 py-3 text-sm w-40">{r.removalist_name || '—'}</td>
                      <td className="px-4 py-3 text-sm w-32">{formatDate(r.collection_date)}</td>
                      <td className="px-4 py-3 text-sm w-48 whitespace-normal break-words">{r.notes || '—'}</td>
                      <td className="px-4 py-3 text-sm w-24">
                        <button
                          className="rounded-md border px-3 py-1 hover:bg-gray-50"
                          onClick={() => { setEditRow(r); setModalOpen(true); }}
                        >
                          Edit
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="flex items-center justify-between border-t p-3 text-sm">
              <div className="text-gray-600">
                Showing{' '}
                <span className="font-medium">
                  {filteredSorted.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1}
                </span>{' '}
                to{' '}
                <span className="font-medium">
                  {Math.min(page * PAGE_SIZE, filteredSorted.length)}
                </span>{' '}
                of <span className="font-medium">{filteredSorted.length}</span>
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

          <CollectionModal
            open={modalOpen}
            initial={editRow}
            onClose={() => setModalOpen(false)}
            onSaved={() => load()}
          />
        </main>
      </div>

      <DeliveryTabs />
    </div>
  );
}
