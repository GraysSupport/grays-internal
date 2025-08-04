import toast from 'react-hot-toast';
import { useNavigate } from 'react-router-dom';
import ProductForm from '../../components/productform';
import BackButton from '../../components/backbutton';

export default function CreateProductPage() {
  const navigate = useNavigate();

  const handleCreate = async (formData) => {
    const toastId = toast.loading('Creating product...');
    try {
      const res = await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Creation failed');
      toast.success('Product created!', { id: toastId });
      navigate('/products');
    } catch (err) {
      toast.error(err.message, { id: toastId });
    }
  };

  return (
    <>
      <BackButton />
      <div className="bg-gray-100 min-h-screen p-8 flex justify-center items-center">
        <div className="bg-white p-6 rounded shadow-md w-full max-w-lg">
            <h2 className="text-xl font-bold text-center mb-4">Create New Product</h2>
          <ProductForm onSubmit={handleCreate} submitLabel="Create Product" />
        </div>
      </div>
    </>
  );
}
