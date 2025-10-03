import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom'; // ⬅️ add this
import toast from 'react-hot-toast';
import CollectionModal from '../../components/CollectionModal';
import DeliveryTabs from '../../components/DeliveryTabs';

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

export default function CurrentCollectionsPage() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editRow, setEditRow] = useState(null);

  const navigate = useNavigate(); // ⬅️ init

  const load = async () => {
    setLoading(true);
    toast.loading('Loading collections…', { id: 'col-load' });
    try {
      const res = await fetch('/api/collections?completed=false');
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed to load collections');
      setRows(data || []);
      toast.success('Collections loaded', { id: 'col-load' });
    } catch (e) {
      toast.error(e.message || 'Failed to load', { id: 'col-load' });
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = q
      ? rows.filter((r) =>
          [r.name, r.suburb, r.state, r.description, r.removalist_name, r.notes, r.status]
            .filter(Boolean).join(' ').toLowerCase().includes(q)
        )
      : rows;

    // ASC by collection_date (nulls last), then name
    const toTime = (d) => {
      if (!d) return Number.POSITIVE_INFINITY;
      const t = new Date(d).getTime();
      return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
    };
    return [...base].sort((a,b) => {
      const dt = toTime(a.collection_date) - toTime(b.collection_date);
      if (dt !== 0) return dt;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
  }, [rows, search]);

  // helper to navigate to edit page
  const goEdit = (id) => {
    if (!id) return;
    navigate(`/delivery_operations/collections/${id}`);
  };

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 flex flex-col">
      <header className="border-b bg-white">
        <div className="py-4 px-4">
          <h1 className="text-2xl font-semibold tracking-tight text-center">Delivery Operations</h1>
        </div>
      </header>

      <div className="grid grid-cols-12 gap-6 py-6 px-4 flex-1">
        {/* Main */}
        <main className="col-span-12">
          <div className="rounded-xl border bg-white">
            <div className="border-b p-4 grid gap-3 grid-cols-1 sm:grid-cols-3 items-center">
              <div className="w-full sm:max-w-xs">
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search"
                  className="w-full rounded-lg border px-3 py-2 outline-none focus:ring-2 focus:ring-gray-300"
                />
              </div>
              <div className="hidden sm:flex justify-center">
                <h2 className="text-lg font-semibold">Collections</h2>
              </div>
              <div className="sm:hidden"><h2 className="text-lg font-semibold">Collections</h2></div>
              <div className="flex sm:justify-end">
                <button
                  onClick={() => { setEditRow(null); setModalOpen(true); }}
                  className="inline-flex items-center rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-black/90"
                >
                  + Create New Collection
                </button>
              </div>
            </div>

            {/* Table */}
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
                    <th className="px-4 py-3 w-28">Status</th>
                    <th className="px-4 py-3 w-24">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {loading && (
                    <tr><td colSpan={9} className="px-4 py-6 text-center text-sm">Loading…</td></tr>
                  )}
                  {!loading && filtered.length === 0 && (
                    <tr><td colSpan={9} className="px-4 py-6 text-center text-sm">No collections.</td></tr>
                  )}

                  {!loading && filtered.map((r) => (
                    <tr
                      key={r.id}
                      className="align-top odd:bg-white even:bg-gray-50 hover:bg-gray-100 cursor-pointer"
                      onClick={() => goEdit(r.id)}               // ⬅️ row click navigates
                      tabIndex={0}                                 // ⬅️ keyboard focusable
                      onKeyDown={(e) => { if (e.key === 'Enter') goEdit(r.id); }} // ⬅️ enter to open
                      role="button"                                // ⬅️ accessibility hint
                    >
                      <td className="px-4 py-3 text-sm w-40">{r.name}</td>
                      <td className="px-4 py-3 text-sm w-28">{r.suburb || '—'}</td>
                      <td className="px-4 py-3 text-sm w-20">{r.state || '—'}</td>
                      <td className="px-4 py-3 text-sm whitespace-normal break-words">{r.description || '—'}</td>
                      <td className="px-4 py-3 text-sm w-40">{r.removalist_name || '—'}</td>
                      <td className="px-4 py-3 text-sm w-32">{formatDate(r.collection_date)}</td>
                      <td className="px-4 py-3 text-sm w-48 whitespace-normal break-words">{r.notes || '—'}</td>
                      <td className="px-4 py-3 text-sm w-28">{r.status}</td>
                      <td className="px-4 py-3 text-sm w-24">
                        <button
                          className="rounded-md border px-3 py-1 hover:bg-gray-50"
                          onClick={(e) => { e.stopPropagation(); setEditRow(r); setModalOpen(true); }} // ⬅️ prevent row nav
                        >
                          Edit
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
