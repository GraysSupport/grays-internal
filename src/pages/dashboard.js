import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';

export default function Dashboard() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState([]);
  const [waitlist, setWaitlist] = useState([]);
  const navigate = useNavigate();

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
      await toast.promise(
        Promise.all([
          fetch('/api/products'),
          fetch('/api/waitlist')
        ])
          .then(async ([productsRes, waitlistRes]) => {
            const productsData = await productsRes.json();
            const waitlistData = await waitlistRes.json();

            setProducts(productsData);
            setWaitlist(waitlistData);
          }),
        {
          loading: 'Fetching dashboard data...',
          success: 'Data loaded successfully!',
          error: 'Failed to load data.',
        }
      );
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

  // ======= ANALYTICS ========
  const totalProducts = products.length;
  const inStockCount = products.filter(p => p.stock > 0).length;
  const outOfStockCount = products.filter(p => p.stock === 0).length;

  const totalWaitlist = waitlist.length;
  const uniqueWaitlistProducts = new Set(waitlist.map(w => w.product_sku)).size;
  const uniqueWaitlistCustomers = new Set(waitlist.map(w => w.customer_id)).size;
  const waitlistWithStock = waitlist.filter(w => w.stock > 0).length;

  const analyticsCard = (label, value, extraClasses = '', onClick = null) => (
    <div
      onClick={onClick}
      className={`bg-gray-50 p-4 rounded shadow transition cursor-pointer hover:shadow-md ${extraClasses}`}
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
          <Link to="/create_workorder" className="text-gray-700 hover:bg-gray-200 p-2 rounded">Create Workorder</Link>
          {user?.access === 'superadmin' && (
            <Link to="/register" className="text-gray-700 hover:bg-gray-200 p-2 rounded font-semibold">
              Register New User
            </Link>
          )}
          <button
            onClick={async () => {
              const user = JSON.parse(localStorage.getItem('user'));
              if (user) {
                await fetch('/api/access-log', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    userId: user.id,
                    description: 'User manually logged out',
                  }),
                });
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
