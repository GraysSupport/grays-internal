import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';

export default function Dashboard() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState([]);
  const [waitlist, setWaitlist] = useState([]);
  const navigate = useNavigate();

  // --- helpers ---
  const ensureArray = (data) =>
    Array.isArray(data) ? data : (data && typeof data === 'object' ? [data] : []);

  useEffect(() => {
    const storedUser = localStorage.getItem('user');
    if (!storedUser) {
      navigate('/');
      return;
    }
    const parsed = JSON.parse(storedUser);
    setUser(parsed);
    setLoading(false);
  }, [navigate]);

  useEffect(() => {
    const fetchData = async () => {
      const load = Promise.all([
        fetch('/api/products', { method: 'GET' }),
        fetch('/api/waitlist', { method: 'GET' }),
      ])
        .then(async ([productsRes, waitlistRes]) => {
          // Parse bodies first
          const [productsData, waitlistData] = await Promise.all([
            productsRes.json().catch(() => null),
            waitlistRes.json().catch(() => null),
          ]);

          // Validate status codes
          if (!productsRes.ok) {
            console.error('Products API error:', productsData);
            throw new Error(productsData?.error || `Products HTTP ${productsRes.status}`);
          }
          if (!waitlistRes.ok) {
            console.error('Waitlist API error:', waitlistData);
            throw new Error(waitlistData?.error || `Waitlist HTTP ${waitlistRes.status}`);
          }

          // Shape check + normalize to arrays
          const safeProducts = ensureArray(productsData);
          const safeWaitlist = ensureArray(waitlistData);

          setProducts(safeProducts);
          setWaitlist(safeWaitlist);
        });

      await toast.promise(load, {
        loading: 'Fetching dashboard data...',
        success: 'Data loaded successfully!',
        error: 'Failed to load data.',
      }).catch((_e) => {
        // Keep state as arrays to avoid render crashes
        setProducts([]);
        setWaitlist([]);
      });
    };

    fetchData();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-100">
        <div className="text-lg font-medium text-gray-600">Loading...</div>
      </div>
    );
  }

  // ======= ANALYTICS (defensive) ========
  const p = Array.isArray(products) ? products : [];
  const w = Array.isArray(waitlist) ? waitlist : [];

  const totalProducts = p.length;
  const inStockCount = p.filter((x) => Number(x?.stock) > 0).length;
  const outOfStockCount = p.filter((x) => Number(x?.stock) === 0).length;

  const totalWaitlist = w.length;
  const uniqueWaitlistProducts = new Set(w.map((x) => x?.product_sku)).size;
  const uniqueWaitlistCustomers = new Set(w.map((x) => x?.customer_id)).size;
  const waitlistWithStock = w.filter((x) => Number(x?.stock) > 0).length;

  const analyticsCard = (label, value, extraClasses = '', onClick = null) => (
    <div
      onClick={onClick || undefined}
      className={`bg-gray-50 p-4 rounded shadow transition ${onClick ? 'cursor-pointer hover:shadow-md' : ''} ${extraClasses}`}
    >
      <h3 className="font-medium">{label}</h3>
      <p className="text-2xl font-bold">{value}</p>
    </div>
  );

  return (
    <div className="flex h-screen bg-gray-100">
      {/* Sidebar */}
      <aside className="w-64 bg-white shadow-md hidden md:block">
        <div className="p-6 font-bold text-xl border-b">Grays Admin</div>
        <nav className="mt-4 flex flex-col space-y-2 px-4">
          <Link to="/dashboard" className="text-gray-700 hover:bg-gray-200 p-2 rounded">Dashboard</Link>
          <Link to="/settings" className="text-gray-700 hover:bg-gray-200 p-2 rounded">Account Settings</Link>
          <Link to="/products" className="text-gray-700 hover:bg-gray-200 p-2 rounded">Products</Link>
          <Link to="/customers" className="text-gray-700 hover:bg-gray-200 p-2 rounded">Customers</Link>
          <Link to="/waitlist" className="text-gray-700 hover:bg-gray-200 p-2 rounded">Waitlist</Link>
          {user?.access === 'superadmin' && (
            <Link to="/delivery_operations" className="text-gray-700 hover:bg-gray-200 p-2 rounded">Delivery Operations</Link>
          )}
          {user?.access === 'superadmin' && (
            <Link to="/register" className="text-gray-700 hover:bg-gray-200 p-2 rounded font-semibold">
              Register New User
            </Link>
          )}
          <button
            onClick={async () => {
              const u = JSON.parse(localStorage.getItem('user') || 'null');
              if (u) {
                try {
                  await fetch('/api/access-log', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      userId: u.id,
                      description: 'User manually logged out',
                    }),
                  });
                } catch {}
              }
              localStorage.removeItem('user');
              localStorage.removeItem('token');
              localStorage.removeItem('sessionExpiry');
              toast('Logged out');
              navigate('/');
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
            <h2 className="text-xl font-bold mb-4">Dashboard Analytics</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {analyticsCard('Total Products', totalProducts, '', () => navigate('/products'))}
              {analyticsCard('In Stock', inStockCount, 'text-green-700', () => navigate('/products?inStock=true'))}
              {analyticsCard('Out of Stock', outOfStockCount, 'text-red-700', () => navigate('/products?inStock=false'))}
              {analyticsCard('Total Waitlist Entries', totalWaitlist, '', () => navigate('/waitlist'))}
              {analyticsCard('Products Waitlisted', uniqueWaitlistProducts)}
              {analyticsCard('Customers Waitlisted', uniqueWaitlistCustomers)}
              {analyticsCard('Waitlist in Stock', waitlistWithStock, 'text-green-700', () => navigate('/waitlist?inStock=true'))}
            </div>
          </div>

          <br />

          <div className="bg-white p-6 rounded shadow-md">
            <h2 className="text-xl font-bold mb-4">Workshop Analytics</h2>
            <h3 className='italic'>Under construction...</h3>
          </div>
        </main>
      </div>
    </div>
  );
}
