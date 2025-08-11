import React, { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import BackButton from '../components/backbutton';
import CreateCustomerModal from '../components/CreateCustomerModal';

export default function CreateWorkorderPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    invoice_id: '',
    customer_id: '',
    salesperson: '',
    delivery_suburb: '',
    delivery_state: '',
    delivery_charged: '',
    notes: '',
    lead_time: '',
    estimated_complete: '',
    status: 'Workordered',
    items: [
      { product_id: '', quantity: '', condition: '', technician_id: '', status: '' }
    ]
  });

  const [customerInput, setCustomerInput] = useState('');
  const [customers, setCustomers] = useState([]);
  const [products, setProducts] = useState([]);
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false);
  const [showCustomerModal, setShowCustomerModal] = useState(false);
  const [loading, setLoading] = useState(true);

  const customerRef = useRef(null);

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

      // Get salesperson from logged-in user
      const stored = localStorage.getItem('user');
      if (stored) {
        const parsed = JSON.parse(stored);
        setForm(f => ({ ...f, salesperson: parsed.name }));
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
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const addItemRow = () => {
    setForm(f => ({
      ...f,
      items: [...f.items, { product_id: '', quantity: '', condition: '', technician_id: '', status: '' }]
    }));
  };

  const updateItem = (index, key, value) => {
    setForm(f => {
      const updatedItems = [...f.items];
      updatedItems[index][key] = value;
      return { ...f, items: updatedItems };
    });
  };

  const handleSubmit = async e => {
    e.preventDefault();
    const toastId = toast.loading('Creating workorder...');
    try {
      const res = await fetch('/api/workorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      toast.dismiss(toastId);
      if (!res.ok) throw new Error(data.error || 'Creation failed');
      toast.success('Workorder created!');
      navigate('/workorders');
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
      {showCustomerModal && (
        <CreateCustomerModal
          onClose={() => setShowCustomerModal(false)}
          onSuccess={async () => {
            await fetchData();
            setShowCustomerModal(false);
          }}
        />
      )}

      <div className="min-h-screen bg-gray-100 flex justify-center items-center p-6">
        <div className="bg-white p-6 rounded shadow-md w-full max-w-4xl">
          <h2 className="text-xl font-bold mb-4 text-center">New Workorder</h2>
          <form onSubmit={handleSubmit} className="space-y-4">

            {/* Invoice ID */}
            <input
              type="text"
              placeholder="Invoice ID"
              className="border p-2 rounded w-full"
              value={form.invoice_id}
              onChange={e => setForm(f => ({ ...f, invoice_id: e.target.value }))}
              required
            />

            {/* Customer Search */}
            <div className="relative" ref={customerRef}>
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
                    .filter(c => `${c.id} ${c.name}`.toLowerCase().includes(customerInput.toLowerCase()))
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
                onClick={() => setShowCustomerModal(true)}
              >
                Can't find customer? Add one
              </div>
            </div>

            {/* Delivery Details */}
            <input
              type="text"
              placeholder="Delivery Suburb"
              className="border p-2 rounded w-full"
              value={form.delivery_suburb}
              onChange={e => setForm(f => ({ ...f, delivery_suburb: e.target.value }))}
            />
            <input
              type="text"
              placeholder="Delivery State"
              className="border p-2 rounded w-full"
              value={form.delivery_state}
              onChange={e => setForm(f => ({ ...f, delivery_state: e.target.value }))}
            />
            <input
              type="number"
              placeholder="Delivery Charged ($)"
              className="border p-2 rounded w-full"
              value={form.delivery_charged}
              onChange={e => setForm(f => ({ ...f, delivery_charged: e.target.value }))}
            />

            {/* Lead Time & Estimated Completion */}
            <input
              type="text"
              placeholder="Lead Time"
              className="border p-2 rounded w-full"
              value={form.lead_time}
              onChange={e => setForm(f => ({ ...f, lead_time: e.target.value }))}
            />
            <input
              type="date"
              className="border p-2 rounded w-full"
              value={form.estimated_complete}
              onChange={e => setForm(f => ({ ...f, estimated_complete: e.target.value }))}
            />

            {/* Workorder Items */}
            <div>
              <h3 className="font-semibold mb-2">Items</h3>
              {form.items.map((item, index) => (
                <div key={index} className="grid grid-cols-5 gap-2 mb-2">
                  <select
                    className="border p-2 rounded"
                    value={item.product_id}
                    onChange={e => updateItem(index, 'product_id', e.target.value)}
                  >
                    <option value="">Select Product</option>
                    {products.map(p => (
                      <option key={p.sku} value={p.sku}>
                        {p.sku} - {p.name}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    placeholder="Qty"
                    className="border p-2 rounded"
                    value={item.quantity}
                    onChange={e => updateItem(index, 'quantity', e.target.value)}
                  />
                  <input
                    type="text"
                    placeholder="Condition"
                    className="border p-2 rounded"
                    value={item.condition}
                    onChange={e => updateItem(index, 'condition', e.target.value)}
                  />
                  <input
                    type="text"
                    placeholder="Technician ID"
                    className="border p-2 rounded"
                    value={item.technician_id}
                    onChange={e => updateItem(index, 'technician_id', e.target.value)}
                  />
                  <input
                    type="text"
                    placeholder="Status"
                    className="border p-2 rounded"
                    value={item.status}
                    onChange={e => updateItem(index, 'status', e.target.value)}
                  />
                </div>
              ))}
              <button
                type="button"
                className="text-blue-600 mt-1"
                onClick={addItemRow}
              >
                + Add another product
              </button>
            </div>

            {/* Notes */}
            <textarea
              placeholder="Notes"
              className="border p-2 rounded w-full"
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
            />

            <button type="submit" className="w-full bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600">
              Save Workorder
            </button>
          </form>
        </div>
      </div>
    </>
  );
}
