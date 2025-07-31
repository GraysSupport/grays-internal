import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

export default function Dashboard() {
  const [user, setUser] = useState(null);
  const [products, setProducts] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  const PRODUCTS_PER_PAGE = 20;

  useEffect(() => {
    const storedUser = localStorage.getItem('user');
    if (!storedUser) {
      navigate('/');
      return;
    }

    const parsed = JSON.parse(storedUser);
    setUser(parsed);

    const fetchProducts = async () => {
      try {
        const res = await fetch('/api/products');
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`HTTP ${res.status}: ${text}`);
        }

        const data = await res.json();
        if (!Array.isArray(data)) {
          throw new Error('Expected an array of products');
        }

        setProducts(data);
      } catch (err) {
        console.error('Failed to fetch products:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchProducts();
  }, [navigate]);

  const filteredProducts = products.filter((product) =>
    `${product.sku} ${product.name} ${product.brand}`
      .toLowerCase()
      .includes(searchTerm.toLowerCase())
  );

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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-100">
        <div className="text-lg font-medium text-gray-600">Loading products...</div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-gray-100">
      {/* Sidebar */}
      <aside className="w-64 bg-white shadow-md hidden md:block">
        <div className="p-6 font-bold text-xl border-b">Grays Admin</div>
        <nav className="mt-4 flex flex-col space-y-2 px-4">
          <Link to="/dashboard" className="text-gray-700 hover:bg-gray-200 p-2 rounded">Dashboard</Link>
          <Link to="/settings" className="text-gray-700 hover:bg-gray-200 p-2 rounded">Account Settings</Link>
          <button
            onClick={() => {
              localStorage.removeItem('user');
              localStorage.removeItem('token');
              navigate('/login');
            }}
            className="text-gray-700 hover:bg-gray-200 p-2 rounded text-left"
          >
            Logout
          </button>
        </nav>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col">
        <header className="bg-white shadow-md p-4 flex justify-between items-center">
          <h1 className="text-lg font-semibold">Hello, {user?.name || 'Guest'}</h1>
        </header>

        <main className="flex-1 p-6 overflow-auto">
          <div className="bg-white p-6 rounded shadow-md">
            <h2 className="text-xl font-bold mb-4">Products List</h2>

            <input
              type="text"
              placeholder="Search by SKU, name, or brand"
              className="mb-4 p-2 border rounded w-full"
              value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value);
                setCurrentPage(1); // Reset page on search
              }}
            />

            {currentProducts.length === 0 ? (
              <p className="text-gray-600">No products found.</p>
            ) : (
              <>
                <table className="min-w-full border border-gray-300 text-sm text-left">
                  <thead className="bg-gray-100">
                    <tr>
                      <th className="px-4 py-2 border">SKU</th>
                      <th className="px-4 py-2 border">Name</th>
                      <th className="px-4 py-2 border">Brand</th>
                      <th className="px-4 py-2 border">Stock</th>
                      <th className="px-4 py-2 border">Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {currentProducts.map((product) => (
                      <tr key={product.sku} className="hover:bg-gray-50">
                        <td className="px-4 py-2 border">{product.sku}</td>
                        <td className="px-4 py-2 border">{product.name}</td>
                        <td className="px-4 py-2 border">{product.brand}</td>
                        <td className="px-4 py-2 border">{product.stock}</td>
                        <td className="px-4 py-2 border">${product.price}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {/* Pagination Controls */}
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
                    disabled={currentPage === totalPages}
                    className="px-3 py-1 border rounded disabled:opacity-50"
                  >
                    Next
                  </button>
                </div>
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
