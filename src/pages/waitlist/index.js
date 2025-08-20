import { useEffect, useState } from 'react';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import BackButton from '../../components/backbutton';
import { parseMaybeJson } from '../../utils/http';

export default function WaitlistPage() {
  const [waitlist, setWaitlist] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  // Read inStock param: true means only entries with stock > 0
  const inStockParam = searchParams.get('inStock');
  const inStockFilter =
    inStockParam === 'true' ? true : inStockParam === 'false' ? false : null;

  useEffect(() => {
    const stored = localStorage.getItem('user');
    if (!stored) {
      navigate('/');
      return;
    }

    const fetchData = async () => {
      toast.loading('Loading waitlist...', { id: 'waitlist-load' });
      try {
        const res = await fetch('/api/waitlist'); // server returns JSON list
        const data = await parseMaybeJson(res);
        if (!res.ok) throw new Error(data?.error || data?.raw || 'Failed to load waitlist');
        setWaitlist(Array.isArray(data) ? data : []);
        toast.success('Waitlist loaded!', { id: 'waitlist-load' });
      } catch (err) {
        toast.error(err.message, { id: 'waitlist-load' });
      }
    };
    fetchData();
  }, [navigate]);

  const handleStatusChange = async (id, newStatus) => {
    const toastId = toast.loading('Updating status...');
    try {
      // Use query param so it maps to /api/waitlist with ?id=
      const res = await fetch(`/api/waitlist?id=${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      const data = await parseMaybeJson(res);
      toast.dismiss(toastId);
      if (!res.ok) throw new Error(data?.error || data?.raw || 'Update failed');

      setWaitlist((prev) =>
        prev.map((entry) =>
          entry.waitlist_id === id ? { ...entry, status: newStatus } : entry
        )
      );
      toast.success('Status updated');
    } catch (err) {
      toast.error(err.message, { id: toastId });
    }
  };

  const handleNoteUpdate = async (entry, newNote) => {
    const toastId = toast.loading('Updating notes...');
    try {
      const res = await fetch(`/api/waitlist?id=${encodeURIComponent(entry.waitlist_id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: entry.status, notes: newNote }),
      });
      const data = await parseMaybeJson(res);
      toast.dismiss(toastId);
      if (!res.ok) throw new Error(data?.error || data?.raw || 'Note update failed');

      setWaitlist((prev) =>
        prev.map((e) =>
          e.waitlist_id === entry.waitlist_id ? { ...e, notes: newNote } : e
        )
      );
      toast.success('Notes updated');
    } catch (err) {
      toast.dismiss(toastId);
      toast.error(err.message);
    }
  };

  const filtered = waitlist.filter((w) => {
    // Only show active or notified (API already filters, but keep client safety)
    if (!['Active', 'Notified'].includes(w.status)) return false;

    // Filter by inStock param if set
    if (inStockFilter !== null) {
      if (inStockFilter && (w.stock ?? 0) <= 0) return false;
      if (!inStockFilter && (w.stock ?? 0) > 0) return false;
    }

    // Search term filter
    const entryText = `${w.customer_name} ${w.product_name} ${w.status}`.toLowerCase();
    const keywords = searchTerm.toLowerCase().split(' ').filter(Boolean);
    return keywords.every((kw) => entryText.includes(kw));
  });

  const grouped = filtered.reduce((acc, entry) => {
    if (!acc[entry.product_name])
      acc[entry.product_name] = { entries: [], stock: entry.stock ?? 0 };
    acc[entry.product_name].entries.push(entry);
    return acc;
  }, {});

  const sortedGroups = Object.entries(grouped).sort(([, a], [, b]) => b.stock - a.stock);

  return (
    <>
      <BackButton />
      <div className="min-h-screen bg-gray-100 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-center flex-1">Waitlist</h2>
          <Link
            to="/waitlist/create"
            className="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600"
          >
            + Add Entry
          </Link>
        </div>

        <input
          type="text"
          placeholder="Search by customer, product, or status"
          className="mb-4 p-2 border rounded w-full"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />

        {sortedGroups.length === 0 && (
          <p className="text-center text-gray-500">No waitlist entries found.</p>
        )}

        {sortedGroups.map(([product, { entries, stock }]) => (
          <div key={product} className="mb-8">
            <h3 className="text-lg font-semibold mb-2">
              {entries[0].product_sku} - {product} -{' '}
              <span className={stock === 0 ? 'text-red-500' : 'text-green-600'}>
                {stock === 0 ? 'Out of Stock' : `${stock} in Stock`}
              </span>
            </h3>

            <table className="w-full border text-sm mb-2">
              <thead className="bg-gray-100">
                <tr>
                  <th className="border px-4 py-2">Customer</th>
                  <th className="border px-4 py-2">Email</th>
                  <th className="border px-4 py-2">Phone</th>
                  <th className="border px-4 py-2">Status</th>
                  <th className="border px-4 py-2">Salesperson</th>
                  <th className="border px-4 py-2">Created</th>
                  <th className="border px-4 py-2">Notes</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.waitlist_id}>
                    <td className="border px-4 py-2">{entry.customer_name}</td>
                    <td className="border px-4 py-2">
                      <a
                        href={`mailto:${entry.customer_email}`}
                        className="text-blue-600 underline"
                      >
                        {entry.customer_email}
                      </a>
                    </td>
                    <td className="border px-4 py-2">{entry.customer_phone}</td>
                    <td className="border px-4 py-2">
                      <select
                        className="border p-1 rounded"
                        value={entry.status}
                        onChange={(e) => handleStatusChange(entry.waitlist_id, e.target.value)}
                      >
                        <option value="Active">Active</option>
                        <option value="Notified">Notified</option>
                        <option value="Archived">Archived</option>
                      </select>
                    </td>
                    <td className="border px-4 py-2">{entry.salesperson}</td>
                    <td className="border px-4 py-2">
                      {entry.waitlisted
                        ? new Date(entry.waitlisted.replace(' ', 'T')).toLocaleString()
                        : 'N/A'}
                    </td>
                    <td className="border px-4 py-2">
                      <textarea
                        className="border rounded px-2 py-1 w-full"
                        defaultValue={entry.notes || ''}
                        rows={2}
                        onKeyDown={async (e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            await handleNoteUpdate(entry, e.target.value);
                          }
                        }}
                        onBlur={async (e) => {
                          if ((entry.notes || '') !== e.target.value) {
                            await handleNoteUpdate(entry, e.target.value);
                          }
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </>
  );
}
