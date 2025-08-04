import { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import BackButton from '../../components/backbutton';

export default function CreateWaitlistPage() {
  const navigate = useNavigate();

  const [form, setForm] = useState({
    customer_id: '',
    product_sku: '',
    staff_id: '',
    status: 'Active',
  });

  const [customerInput, setCustomerInput] = useState('');
  const [productInput, setProductInput] = useState('');
  const [customers, setCustomers] = useState([]);
  const [products, setProducts] = useState([]);
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false);
  const [showProductDropdown, setShowProductDropdown] = useState(false);
  const [loading, setLoading] = useState(true);

  const customerRef = useRef(null);
  const productRef = useRef(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const res1 = await fetch('/api/customers');
        const res2 = await fetch('/api/products');
        const data1 = await res1.json();
        const data2 = await res2.json();
        if (!res1.ok || !res2.ok) throw new Error('Failed to fetch');
        setCustomers(data1);
        setProducts(data2);

        const stored = localStorage.getItem('user');
        if (stored) {
          const parsed = JSON.parse(stored);
          setForm((prev) => ({ ...prev, staff_id: parsed.id }));
        }

        setLoading(false);
      } catch (err) {
        toast.error(err.message);
        setLoading(false);
      }
    };

    fetchData();
  }, []);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (customerRef.current && !customerRef.current.contains(event.target)) {
        setShowCustomerDropdown(false);
      }
      if (productRef.current && !productRef.current.contains(event.target)) {
        setShowProductDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const toastId = toast.loading('Creating waitlist...');
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      toast.dismiss(toastId);
      if (!res.ok) throw new Error(data.error || 'Creation failed');
      toast.success('Waitlist entry added!');

      setForm((prev) => ({
        ...prev,
        customer_id: '',
        product_sku: '',
        status: 'Active',
      }));
      setCustomerInput('');
      setProductInput('');
      navigate('/waitlist');
    } catch (err) {
      toast.error(err.message, { id: toastId });
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-100 flex justify-center items-center">
        <div className="text-gray-600 text-lg font-medium">Loading form...</div>
      </div>
    );
  }

  return (
    <>
      <BackButton />
      <div className="min-h-screen bg-gray-100 flex justify-center items-center p-6">
        <div className="bg-white p-6 rounded shadow-md w-full max-w-lg">
          <h2 className="text-xl font-bold mb-4 text-center">Add to Waitlist</h2>
          <form onSubmit={handleSubmit} className="space-y-3 relative">

            {/* Customer Input */}
            <div className="relative" ref={customerRef}>
              <input
                type="text"
                placeholder="Search customer..."
                className="border p-2 rounded w-full"
                value={customerInput}
                onFocus={() => setShowCustomerDropdown(true)}
                onChange={(e) => {
                  setCustomerInput(e.target.value);
                  setShowCustomerDropdown(true);
                }}
                required
              />
              {showCustomerDropdown && (
                <div className="absolute z-10 bg-white border rounded w-full max-h-40 overflow-y-auto shadow">
                  {customers
                    .filter((c) =>
                      `${c.id} ${c.name}`.toLowerCase().includes(customerInput.toLowerCase())
                    )
                    .map((c) => (
                      <div
                        key={c.id}
                        onClick={() => {
                          setForm({ ...form, customer_id: c.id });
                          setCustomerInput(`${c.id} - ${c.name}`);
                          setShowCustomerDropdown(false);
                        }}
                        className="cursor-pointer px-2 py-1 hover:bg-gray-100"
                      >
                        {c.id} - {c.name}
                      </div>
                    ))}
                </div>
              )}
            </div>

            {/* Product Input */}
            <div className="relative" ref={productRef}>
              <input
                type="text"
                placeholder="Search product..."
                className="border p-2 rounded w-full"
                value={productInput}
                onFocus={() => setShowProductDropdown(true)}
                onChange={(e) => {
                  setProductInput(e.target.value);
                  setShowProductDropdown(true);
                }}
                required
              />
              {showProductDropdown && (
                <div className="absolute z-10 bg-white border rounded w-full max-h-40 overflow-y-auto shadow">
                  {products
                    .filter((p) =>
                      `${p.sku} ${p.name}`.toLowerCase().includes(productInput.toLowerCase())
                    )
                    .map((p) => (
                      <div
                        key={p.sku}
                        onClick={() => {
                          setForm({ ...form, product_sku: p.sku });
                          setProductInput(`${p.sku} - ${p.name}`);
                          setShowProductDropdown(false);
                        }}
                        className="cursor-pointer px-2 py-1 hover:bg-gray-100"
                      >
                        {p.sku} - {p.name}
                      </div>
                    ))}
                </div>
              )}
            </div>

            {/* Salesperson ID (read-only) */}
            <input
              type="text"
              disabled
              className="border p-2 rounded w-full bg-gray-100 text-gray-600 cursor-not-allowed"
              value={`${form.staff_id || 'Loading...'}`}
            />

            {/* Status Selector */}
            <select
              className="border p-2 rounded w-full"
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value })}
            >
              <option value="Active">Active</option>
              <option value="Notified">Notified</option>
              <option value="Archived">Archived</option>
            </select>

            <button
              type="submit"
              className="w-full bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600"
            >
              Save
            </button>
          </form>
        </div>
      </div>
    </>
  );
}
