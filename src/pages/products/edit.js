import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import BackButton from '../../components/backbutton';
import ProductForm from '../../components/productform';
import { parseMaybeJson } from '../../utils/http';

export default function EditProductPage() {
  const { sku } = useParams();
  const navigate = useNavigate();

  const [product, setProduct] = useState(null);

  useEffect(() => {
    const fetchProduct = async () => {
      if (!sku) return toast.error('Missing SKU in URL');

      try {
        // CHANGED: use ?sku= instead of /:sku so it hits /api/products
        const res = await fetch(`/api/products?sku=${encodeURIComponent(sku)}`);
        const data = await parseMaybeJson(res);
        if (!res.ok) {
          const msg =
            data?.error || data?.raw || `HTTP ${res.status} while fetching product`;
          throw new Error(msg);
        }
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
      // CHANGED: PUT to /api/products?sku=...
      const res = await fetch(`/api/products?sku=${encodeURIComponent(sku)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedForm),
      });

      const data = await parseMaybeJson(res);
      toast.dismiss(toastId);

      if (!res.ok) {
        const msg = data?.error || data?.raw || 'Update failed';
        throw new Error(msg);
      }
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
