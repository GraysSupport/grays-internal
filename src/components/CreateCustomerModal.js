import { useState } from 'react';
import toast from 'react-hot-toast';

export default function CreateCustomerModal({ onClose, onSuccess }) {
  const [form, setForm] = useState({
    name: '',
    email: '',
    phone: '',
    address: '',
    notes: '',
  });

  const handleSubmit = async (e) => {
    e.preventDefault();
    const toastId = toast.loading('Creating customer...');
    try {
      const res = await fetch('/api/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      toast.dismiss(toastId);
      if (!res.ok) throw new Error(data.error || 'Create failed');
      toast.success('Customer created!');
      onSuccess();  // Refresh customer list or similar
      onClose();    // Close the modal
    } catch (err) {
      toast.error(err.message, { id: toastId });
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50">
      <div className="bg-white p-6 rounded shadow-md w-full max-w-lg relative">
        <button
          onClick={onClose}
          className="absolute top-2 right-2 text-gray-600 hover:text-black"
        >
          &times;
        </button>
        <h2 className="text-xl font-bold mb-4 text-center">Create New Customer</h2>
        <form onSubmit={handleSubmit} className="space-y-3">
          {['name', 'email', 'phone', 'address', 'notes'].map((field) => (
            <input
              key={field}
              type="text"
              placeholder={field.charAt(0).toUpperCase() + field.slice(1)}
              className="border p-2 rounded w-full"
              value={form[field]}
              onChange={(e) => setForm({ ...form, [field]: e.target.value })}
            />
          ))}
          <button
            type="submit"
            className="w-full bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600"
          >
            Create Customer
          </button>
        </form>
      </div>
    </div>
  );
}
