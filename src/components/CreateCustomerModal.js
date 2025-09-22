// components/CreateCustomerModal.js
import React, { useEffect, useState } from 'react';
import toast from 'react-hot-toast';

export default function CreateCustomerModal({
  onClose,
  onSuccess,
  // NEW:
  mode = 'create',            // 'create' | 'edit'
  customerId = null,          // when editing
  initialForm = null          // seed values when editing
}) {
  const [form, setForm] = useState({
    name: '',
    email: '',
    phone: '',
    address: '',
    notes: '',
  });

  // Seed form for edit mode
  useEffect(() => {
    if (initialForm) {
      setForm({
        name: initialForm.name ?? '',
        email: initialForm.email ?? '',
        phone: initialForm.phone ?? '',
        address: initialForm.address ?? '',
        notes: initialForm.notes ?? '',
      });
    }
  }, [initialForm]);

  // Close on Escape
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleSubmit = async (e) => {
    e.preventDefault();

    const isEdit = mode === 'edit' || !!customerId;
    const toastId = toast.loading(isEdit ? 'Updating customer...' : 'Creating customer...');

    try {
      const url = isEdit
        ? `/api/customers?id=${encodeURIComponent(customerId)}`
        : '/api/customers';

      const res = await fetch(url, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });

      const data = await res.json().catch(() => ({}));
      toast.dismiss(toastId);

      if (!res.ok) throw new Error(data.error || (isEdit ? 'Update failed' : 'Create failed'));

      toast.success(isEdit ? 'Customer updated!' : 'Customer created!');

      // Pass the updated/created row back (so caller can update UI)
      onSuccess?.(data);
      onClose?.();
    } catch (err) {
      toast.error(err.message, { id: toastId });
    }
  };

  const title = (mode === 'edit' || customerId) ? 'Edit Customer' : 'Create New Customer';

  return (
    <div
      className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-white p-6 rounded shadow-md w-full max-w-lg relative"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute top-2 right-2 text-gray-600 hover:text-black"
          aria-label="Close"
        >
          &times;
        </button>

        <h2 className="text-xl font-bold mb-4 text-center">{title}</h2>

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
            {(mode === 'edit' || customerId) ? 'Save Changes' : 'Create Customer'}
          </button>
        </form>
      </div>
    </div>
  );
}
