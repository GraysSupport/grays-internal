import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import BackButton from '../../components/backbutton';
import CreateCustomerModal from '../../components/CreateCustomerModal';
import { useNavigate, Link } from 'react-router-dom';

export default function CustomersPage() {
  const [customers, setCustomers] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [showModal, setShowModal] = useState(false);

  const CUSTOMERS_PER_PAGE = 20;
  const navigate = useNavigate();

  useEffect(() => {
    const stored = localStorage.getItem('user');
    if (!stored) {
      navigate('/');
      return;
    }
    fetchCustomers(); // only runs if user exists
  }, [navigate]);

  const fetchCustomers = async () => {
    toast.loading('Loading customers...', { id: 'customer-load' });
    try {
      const res = await fetch('/api/customers');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load customers');
      setCustomers(Array.isArray(data) ? data : []);
      toast.success('Customers loaded!', { id: 'customer-load' });
    } catch (err) {
      toast.error(err.message, { id: 'customer-load' });
    }
  };

  const filtered = customers.filter((c) =>
    `${c.name} ${c.email} ${c.phone}`.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const totalPages = Math.ceil(filtered.length / CUSTOMERS_PER_PAGE) || 1;
  const currentCustomers = filtered.slice(
    (currentPage - 1) * CUSTOMERS_PER_PAGE,
    currentPage * CUSTOMERS_PER_PAGE
  );

  const goToPage = (page) => {
    if (page >= 1 && page <= totalPages) setCurrentPage(page);
  };

  return (
    <>
      <BackButton />
      <div className="min-h-screen bg-gray-100 p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex-1 text-center">
            <h2 className="text-xl font-bold">Customers</h2>
          </div>
          <div className="flex-shrink-0">
            <button
              onClick={() => setShowModal(true)}
              className="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600"
            >
              + Add Customer
            </button>
          </div>
        </div>

        {showModal && (
          <CreateCustomerModal
            onClose={() => setShowModal(false)}
            onSuccess={() => {
              setShowModal(false);
              fetchCustomers();
            }}
          />
        )}

        <input
          type="text"
          placeholder="Search by name, email, or phone"
          className="mb-4 p-2 border rounded w-full"
          value={searchTerm}
          onChange={(e) => {
            setSearchTerm(e.target.value);
            setCurrentPage(1);
          }}
        />

        <table className="w-full border text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="border px-4 py-2">Name</th>
              <th className="border px-4 py-2">Email</th>
              <th className="border px-4 py-2">Phone</th>
              <th className="border px-4 py-2">Address</th>
              <th className="border px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {currentCustomers.map((c) => (
              <tr key={c.id}>
                <td className="border px-4 py-2">{c.name}</td>
                <td className="border px-4 py-2">{c.email}</td>
                <td className="border px-4 py-2">{c.phone}</td>
                <td className="border px-4 py-2">{c.address}</td>
                <td className="border px-4 py-2 text-blue-600 underline text-center">
                  <Link to={`/customers/${c.id}/edit`}>Edit</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-4 flex justify-between items-center">
          <button
            onClick={() => goToPage(currentPage - 1)}
            disabled={currentPage === 1}
            className="px-3 py-1 border rounded disabled:opacity-50"
          >
            Previous
          </button>
          <div className="text-sm text-gray-600">
            Page {currentPage} of {totalPages}
          </div>
          <button
            onClick={() => goToPage(currentPage + 1)}
            disabled={currentPage === totalPages}
            className="px-3 py-1 border rounded disabled:opacity-50"
          >
            Next
          </button>
        </div>
      </div>
    </>
  );
}
