import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import BackButton from '../../components/backbutton';
import ProductForm from '../../components/productform';

export default function EditProductPage() {
  const { sku } = useParams();
  const navigate = useNavigate();

  const [product, setProduct] = useState(null);

  useEffect(() => {
    const fetchProduct = async () => {
      if (!sku) return toast.error('Missing SKU in URL');

      try {
        const res = await fetch(`/api/products/${encodeURIComponent(sku)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Product fetch failed');

        setProduct(data);
      } catch (err) {
        toast.error(err.message);
      }
    };

    fetchProduct();
  }, [sku]);

  const handleUpdate = async (updatedForm) => {
    const toastId = toast.loading('Updating product...');
    try {
      const res = await fetch(`/api/products/${encodeURIComponent(sku)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedForm),
      });

      const data = await res.json();
      toast.dismiss(toastId);

      if (!res.ok) throw new Error(data.error || 'Update failed');
      toast.success('Product updated!');
      navigate('/products');
    } catch (err) {
      toast.error(err.message, { id: toastId });
    }
  };

  if (!product) {
    return (
      <div className="h-screen flex justify-center items-center bg-gray-100 text-gray-600">
        Loading product...
      </div>
    );
  }

  return (
    <>
    <BackButton />
    <div className="flex items-center justify-center min-h-screen bg-gray-100">
        <div className="bg-white p-6 rounded shadow-md w-full max-w-lg">
        <h1 className="text-xl font-bold mb-4 text-center">Edit Product: {sku}</h1>
        <ProductForm
            initialValues={product}
            onSubmit={handleUpdate}
            submitLabel="Save Changes"
        />
        </div>
    </div>
    </>
  );
}