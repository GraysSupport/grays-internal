import { useState } from 'react';
import toast from 'react-hot-toast';
import ProductForm from './productform';

export default function CreateProductModal({ isOpen, onClose, onCreated }) {
  const [loading, setLoading] = useState(false);

  const handleCreate = async (formData) => {
    const toastId = toast.loading('Creating product...');
    setLoading(true);
    try {
      const res = await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Creation failed');

      toast.success('Product created!', { id: toastId });
      onCreated(); // Refresh product list or navigate
      onClose();   // Close modal
    } catch (err) {
      toast.error(err.message, { id: toastId });
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex justify-center items-center z-50">
      <div className="bg-white rounded-lg shadow-md p-6 w-full max-w-lg relative">
        <button
          onClick={onClose}
          className="absolute top-2 right-2 text-gray-500 hover:text-red-600"
        >
          ✕
        </button>
        <h2 className="text-xl font-bold mb-4 text-center">Create New Product</h2>
        <ProductForm
          onSubmit={handleCreate}
          submitLabel={loading ? 'Creating...' : 'Create Product'}
        />
      </div>
    </div>
  );
}
