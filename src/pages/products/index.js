import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import BackButton from '../../components/backbutton';

export default function ProductsPage() {
  const [products, setProducts] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [searchParams] = useSearchParams();
  const PRODUCTS_PER_PAGE = 20;

  // Read inStock param as boolean or null if not present
  const inStockParam = searchParams.get('inStock');
  const inStockFilter = inStockParam === 'true' ? true : inStockParam === 'false' ? false : null;

  useEffect(() => {
    fetchProducts();
  }, []);

  const fetchProducts = async () => {
    toast.loading('Loading products...', { id: 'product-load' });
    try {
      const res = await fetch('/api/products');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load');
      setProducts(data);
      toast.success('Products loaded!', { id: 'product-load' });
    } catch (err) {
      toast.error(err.message, { id: 'product-load' });
    }
  };

  // Filter by search term and stock filter
  const filteredProducts = products.filter((product) => {
    // Search filter
    const productText = `${product.sku} ${product.name} ${product.brand}`.toLowerCase();
    const keywords = searchTerm.toLowerCase().split(' ').filter(Boolean);
    if (!keywords.every((keyword) => productText.includes(keyword))) return false;

    // Stock filter if set
    if (inStockFilter !== null) {
      if (inStockFilter && product.stock <= 0) return false;    // inStock=true means stock > 0 only
      if (!inStockFilter && product.stock > 0) return false;    // inStock=false means stock = 0 only
    }

    return true;
  });

  const totalPages = Math.ceil(filteredProducts.length / PRODUCTS_PER_PAGE);
  const currentProducts = filteredProducts.slice(
    (currentPage - 1) * PRODUCTS_PER_PAGE,
    currentPage * PRODUCTS_PER_PAGE
  );

  const goToPage = (page) => {
    if (page >= 1 && page <= totalPages) {
      setCurrentPage(page);
    }
  };

  return (
    <>
      <BackButton />
      <div className="min-h-screen bg-gray-100 p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex-1 text-center">
            <h2 className="text-xl font-bold">Products</h2>
          </div>
          <div className="flex-shrink-0">
            <Link
              to="/products/create"
              className="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600"
            >
              + Add Product
            </Link>
          </div>
        </div>

        <input
          type="text"
          placeholder="Search by SKU, name, or brand"
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
              <th className="border px-4 py-2">SKU</th>
              <th className="border px-4 py-2">Name</th>
              <th className="border px-4 py-2">Brand</th>
              <th className="border px-4 py-2">Stock</th>
              <th className="border px-4 py-2">Price</th>
              <th className="border px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {currentProducts.map((p) => (
              <tr key={p.sku}>
                <td className="border px-4 py-2">{p.sku}</td>
                <td className="border px-4 py-2">{p.name}</td>
                <td className="border px-4 py-2">{p.brand}</td>
                <td className="border px-4 py-2">{p.stock}</td>
                <td className="border px-4 py-2">${p.price}</td>
                <td className="border px-4 py-2 text-blue-600 underline text-center align-middle">
                  <Link to={`/products/${p.sku}/edit`}>Edit</Link>
                </td>
              </tr>
            ))}
            {currentProducts.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center p-4 text-gray-500">
                  No products found.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {/* Pagination */}
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
            disabled={currentPage === totalPages || totalPages === 0}
            className="px-3 py-1 border rounded disabled:opacity-50"
          >
            Next
          </button>
        </div>
      </div>
    </>
  );
}
