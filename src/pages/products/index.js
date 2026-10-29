import { useEffect, useMemo, useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import BackButton from '../../components/backbutton';
import HomeButton from '../../components/homebutton';
import CreateProductModal from '../../components/CreateProductModal';
import ProductLotsModal from '../../components/ProductLotsModal';
import { getRoles, hasAnyRole } from '../../utils/auth';
import { LOT_TRACKER_ROLES } from '../../utils/lotTracker';
import FreeWeightsTab from '../../components/FreeWeightsTab';

// G21 (owner, 29 Oct 2026): two tabs — the existing stock list, and the separate Brand New
// Free Weights stock. The tab lives in the URL (?tab=free-weights) so it can be linked.
const TABS = [
  { key: 'current', label: 'Current stock' },
  { key: 'free-weights', label: 'Brand New Free Weights' },
];

function ProductTabs({ active, onSelect }) {
  return (
    // Centred (owner, 30 Oct 2026): left-aligned tabs sat under the fixed Home / Back buttons.
    <div role="tablist" aria-label="Products" className="mb-4 flex justify-center gap-1 border-b border-gray-300">
      {TABS.map((t) => (
        <button
          key={t.key}
          id={`products-tab-${t.key}`}
          type="button"
          role="tab"
          aria-selected={active === t.key}
          aria-controls={`products-panel-${t.key}`}
          onClick={() => onSelect(t.key)}
          className={`-mb-px border-b-2 px-4 py-2 text-sm font-semibold ${active === t.key ? 'border-[#B50B1D] text-gray-900' : 'border-transparent text-gray-700 hover:text-gray-900'}`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export default function ProductsPage() {
  const storedUser = useMemo(() => {
    try { return JSON.parse(localStorage.getItem('user') || 'null'); }
    catch { return null; }
  }, []);
  const isSuperadmin = String(storedUser?.access || '').toLowerCase() === 'superadmin';
  const [products, setProducts] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab') === 'free-weights' ? 'free-weights' : 'current';
  // Only `tab` changes — anything else in the URL (e.g. ?inStock=) is kept.
  const selectTab = (key) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    if (key === 'free-weights') next.set('tab', 'free-weights');
    else next.delete('tab');
    return next;
  });
  const [showModal, setShowModal] = useState(false);
  // "View Lots" (in-stock lot numbers per product) — same roles as the Lot Tracker; the server decides.
  const canViewLots = hasAnyRole(getRoles(), LOT_TRACKER_ROLES);
  const [lotsProduct, setLotsProduct] = useState(null);
  const PRODUCTS_PER_PAGE = 20;

  const inStockParam = searchParams.get('inStock');
  const inStockFilter = inStockParam === 'true' ? true : inStockParam === 'false' ? false : null;

  const navigate = useNavigate();

  const fetchProducts = useCallback(async () => {
    toast.loading('Loading products...', { id: 'product-load' });
    try {
      const res = await fetch('/api/products', {
        headers: {
          'x-user-access': String(storedUser?.access || ''),
        },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load');
      setProducts(data);
      toast.success('Products loaded!', { id: 'product-load' });
    } catch (err) {
      toast.error(err.message, { id: 'product-load' });
    }
  }, [storedUser?.access]);

  useEffect(() => {
    const stored = localStorage.getItem('user');
    if (!stored) {
      navigate('/');
      return;
    }
    if (tab === 'current') fetchProducts();
  }, [navigate, fetchProducts, tab]);

  const filteredProducts = products.filter((product) => {
    const productText = `${product.sku} ${product.name} ${product.brand}`.toLowerCase();
    const keywords = searchTerm.toLowerCase().split(' ').filter(Boolean);
    if (!keywords.every((keyword) => productText.includes(keyword))) return false;

    if (inStockFilter !== null) {
      if (inStockFilter && product.stock <= 0) return false;
      if (!inStockFilter && product.stock > 0) return false;
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

  const escapeCsv = (val) => {
    if (val === null || val === undefined) return '""';
    const s = String(val).replace(/"/g, '""');
    return `"${s}"`; // always-quote for safety
  };

  const exportToCsv = () => {
    // Use the filtered (but unpaginated) list
    const rows = filteredProducts;

    if (!rows.length) {
      toast.error('No products to export.');
      return;
    }

    const headers = isSuperadmin
      ? ['SKU', 'Name', 'Brand', 'Stock', 'Price', 'Cost']
      : ['SKU', 'Name', 'Brand', 'Stock', 'Price'];
    const lines = [headers.map(escapeCsv).join(',')];

    for (const p of rows) {
      const line = [
        escapeCsv(p.sku),
        escapeCsv(p.name),
        escapeCsv(p.brand),
        escapeCsv(p.stock ?? ''),
        escapeCsv(Number.isFinite(Number(p.price)) ? Number(p.price).toFixed(2) : (p.price ?? '')),
      ];

      if (isSuperadmin) {
        line.push(
          escapeCsv(Number.isFinite(Number(p.avg_cost)) ? Number(p.avg_cost).toFixed(2) : (p.avg_cost ?? ''))
        );
      }

      lines.push(line.join(','));
    }

    const csv = lines.join('\r\n');
    const bom = '\uFEFF'; // helps Excel open UTF-8 correctly
    const blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `products_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success('CSV downloaded.');
  };

  return (
    <>
      <div className="fixed top-4 left-6 z-50 flex gap-2">
        <HomeButton />
        <BackButton />
      </div>
      {showModal && (
        <CreateProductModal
          isOpen={showModal}
          onClose={() => setShowModal(false)}
          onCreated={fetchProducts}
        />
      )}
      {lotsProduct && (
        <ProductLotsModal product={lotsProduct} onClose={() => setLotsProduct(null)} />
      )}

      {/* max-sm:pt-16 clears the fixed Home/Back overlay above (F19 incr 2d). */}
      <div className="min-h-screen bg-gray-100 p-6 max-sm:pt-16">
        <ProductTabs active={tab} onSelect={selectTab} />
        {tab === 'free-weights' ? (
          <div role="tabpanel" id="products-panel-free-weights" aria-labelledby="products-tab-free-weights">
            <h2 className="mb-4 text-center text-xl font-bold">Brand New Free Weights</h2>
            <FreeWeightsTab />
          </div>
        ) : (
        <div role="tabpanel" id="products-panel-current" aria-labelledby="products-tab-current">
        <div className="flex items-center justify-between mb-4">
          <div className="flex-1 text-center">
            <h2 className="text-xl font-bold">Products</h2>
          </div>
          <div className="flex-shrink-0 flex gap-2">
            <button
              onClick={exportToCsv}
              disabled={filteredProducts.length === 0}
              className="bg-gray-200 text-gray-900 px-4 py-2 rounded hover:bg-gray-300 disabled:opacity-50"
            >
              Export CSV
            </button>
            <button
              onClick={() => setShowModal(true)}
              className="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600"
            >
              + Add Product
            </button>
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

        <div className="overflow-x-auto">
        <table className="w-full border text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="border px-4 py-2">SKU</th>
              <th className="border px-4 py-2">Name</th>
              <th className="border px-4 py-2">Brand</th>
              <th className="border px-4 py-2">Stock</th>
              <th className="border px-4 py-2">Price</th>
              {isSuperadmin && <th className="border px-4 py-2">Cost</th>}
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
                {isSuperadmin && (
                  <td className="border px-4 py-2">
                    {p.avg_cost == null ? '—' : `$${Number(p.avg_cost).toFixed(2)}`}
                  </td>
                )}
                <td className="border px-4 py-2 text-center align-middle whitespace-nowrap">
                  <Link className="text-blue-600 underline" to={`/products/${encodeURIComponent(p.sku)}/edit`}>Edit</Link>
                  {canViewLots && (
                    <button
                      type="button"
                      onClick={() => setLotsProduct(p)}
                      aria-label={`View Lots for ${p.sku}`}
                      className="ml-3 text-blue-600 underline"
                    >
                      View Lots
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {currentProducts.length === 0 && (
              <tr>
                <td colSpan={isSuperadmin ? 7 : 6} className="text-center p-4 text-gray-500">
                  No products found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>

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
        )}
      </div>
    </>
  );
}