import React, { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import BackButton from '../../components/backbutton';
import CreateCustomerModal from '../../components/CreateCustomerModal';

export default function CreateWaitlistPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    customer_id: '',
    product_sku: '',
    staff_id: '',
    status: 'Active'
  });
  const [customerInput, setCustomerInput] = useState('');
  const [productInput, setProductInput] = useState('');
  const [customers, setCustomers] = useState([]);
  const [products, setProducts] = useState([]);
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false);
  const [showProductDropdown, setShowProductDropdown] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);

  const customerRef = useRef(null);
  const productRef = useRef(null);

  const fetchData = async () => {
    try {
      const [cRes, pRes] = await Promise.all([
        fetch('/api/customers'),
        fetch('/api/products')
      ]);
      const [cData, pData] = await Promise.all([cRes.json(), pRes.json()]);
      if (!cRes.ok || !pRes.ok) throw new Error('Failed to fetch data');
      setCustomers(cData);
      setProducts(pData);

      const stored = localStorage.getItem('user');
      if (stored) {
        const parsed = JSON.parse(stored);
        setForm(f => ({ ...f, staff_id: parsed.id }));
      }

      setLoading(false);
    } catch (err) {
      toast.error(err.message);
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  useEffect(() => {
    const handleClickOutside = e => {
      if (customerRef.current && !customerRef.current.contains(e.target)) {
        setShowCustomerDropdown(false);
      }
      if (productRef.current && !productRef.current.contains(e.target)) {
        setShowProductDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSubmit = async e => {
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
      {showModal && (
        <CreateCustomerModal
          onClose={() => setShowModal(false)}
          onSuccess={async () => {
            await fetchData();
            setShowModal(false);
          }}
        />
      )}
      <div className="min-h-screen bg-gray-100 flex justify-center items-center p-6">
        <div className="bg-white p-6 rounded shadow-md w-full max-w-lg">
          <h2 className="text-xl font-bold mb-4 text-center">Add to Waitlist</h2>
          <form onSubmit={handleSubmit} className="space-y-3 relative">

            {/* Customer Input */}
            <div className="relative mb-1" ref={customerRef}>
              <input
                type="text"
                placeholder="Search customer..."
                className="border p-2 rounded w-full"
                value={customerInput}
                onFocus={() => setShowCustomerDropdown(true)}
                onChange={e => {
                  setCustomerInput(e.target.value);
                  setShowCustomerDropdown(true);
                }}
                required
              />
              {showCustomerDropdown && (
                <div className="absolute z-10 bg-white border rounded w-full max-h-40 overflow-y-auto shadow">
                  {customers
                    .filter(c => {
                      const text = `${c.id} ${c.name}`.toLowerCase();
                      const keywords = customerInput.toLowerCase().split(' ').filter(Boolean);
                      return keywords.every(kw => text.includes(kw));
                    })
                    .map(c => (
                      <div
                        key={c.id}
                        onClick={() => {
                          setForm(f => ({ ...f, customer_id: c.id }));
                          setCustomerInput(`${c.id} - ${c.name}`);
                          setShowCustomerDropdown(false);
                        }}
                        className="cursor-pointer px-2 py-1 hover:bg-gray-100"
                      >
                        {c.id} - {c.name}
                      </div>
                    ))
                  }
                </div>
              )}
              <div
                className="text-sm mt-1 text-blue-600 hover:underline cursor-pointer"
                onClick={() => setShowModal(true)}
              >
                Can't find customer? Add one
              </div>
            </div>

            {/* Product Input */}
            <div className="relative mb-1" ref={productRef}>
              <input
                type="text"
                placeholder="Search product..."
                className="border p-2 rounded w-full"
                value={productInput}
                onFocus={() => setShowProductDropdown(true)}
                onChange={e => {
                  setProductInput(e.target.value);
                  setShowProductDropdown(true);
                }}
                required
              />
              {showProductDropdown && (
                <div className="absolute z-10 bg-white border rounded w-full max-h-40 overflow-y-auto shadow">
                  {products
                    .filter(p => {
                      const text = `${p.sku} ${p.name}`.toLowerCase();
                      const keywords = productInput.toLowerCase().split(' ').filter(Boolean);
                      return keywords.every(kw => text.includes(kw));
                    })
                    .map(p => (
                      <div
                        key={p.sku}
                        onClick={() => {
                          setForm(f => ({ ...f, product_sku: p.sku }));
                          setProductInput(`${p.sku} - ${p.name}`);
                          setShowProductDropdown(false);
                        }}
                        className="cursor-pointer px-2 py-1 hover:bg-gray-100"
                      >
                        {p.sku} - {p.name}
                      </div>
                    ))
                  }
                </div>
              )}
              <div className="text-sm mt-1 text-blue-600 hover:underline cursor-pointer" onClick={() => navigate('/products/create')}>
                Can't find product? Add one
              </div>
            </div>

            {/* Salesperson ID */}
            <input
              type="text"
              disabled
              className="border p-2 rounded w-full bg-gray-100 text-gray-600 cursor-not-allowed"
              value={form.staff_id || 'Loading...'}
            />

            {/* Status Selector */}
            <select
              className="border p-2 rounded w-full"
              value={form.status}
              onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
            >
              <option value="Active">Active</option>
              <option value="Notified">Notified</option>
              <option value="Archived">Archived</option>
            </select>

            <button type="submit" className="w-full bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600">
              Save
            </button>
          </form>
        </div>
      </div>
    </>
  );
}
