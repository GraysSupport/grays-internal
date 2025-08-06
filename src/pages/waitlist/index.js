import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import BackButton from '../../components/backbutton';

export default function WaitlistPage() {
  const [waitlist, setWaitlist] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchParams] = useSearchParams();

  // Read inStock param: true means only entries with stock > 0
  const inStockParam = searchParams.get('inStock');
  const inStockFilter = inStockParam === 'true' ? true : inStockParam === 'false' ? false : null;

  useEffect(() => {
    const fetchData = async () => {
      toast.loading('Loading waitlist...', { id: 'waitlist-load' });
      try {
        const res = await fetch('/api/waitlist');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to load waitlist');
        setWaitlist(data);
        toast.success('Waitlist loaded!', { id: 'waitlist-load' });
      } catch (err) {
        toast.error(err.message, { id: 'waitlist-load' });
      }
    };
    fetchData();
  }, []);

  const handleStatusChange = async (id, newStatus) => {
    const toastId = toast.loading('Updating status...');
    try {
      const res = await fetch(`/api/waitlist/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      const data = await res.json();
      toast.dismiss(toastId);
      if (!res.ok) throw new Error(data.error || 'Update failed');

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

  const filtered = waitlist.filter((w) => {
    // Only show active or notified
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
    if (!acc[entry.product_name]) acc[entry.product_name] = { entries: [], stock: entry.stock ?? 0 };
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
              {product} -{' '}
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
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.waitlist_id}>
                    <td className="border px-4 py-2">{entry.customer_name}</td>
                    <td className="border px-4 py-2">
                      <a href={`mailto:${entry.customer_email}`} className="text-blue-600 underline">
                        {entry.customer_email}
                      </a>
                    </td>
                    <td className="border px-4 py-2">{entry.customer_phone}</td>
                    <td className="border px-4 py-2">
                      <select
                        className="border p-1 rounded"
                        value={entry.status}
                        onChange={(e) =>
                          handleStatusChange(entry.waitlist_id, e.target.value)
                        }
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
