import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';

export default function Dashboard() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState([]);
  const [waitlist, setWaitlist] = useState([]);
  const [workorders, setWorkorders] = useState([]);     
  const [deliveries, setDeliveries] = useState([]);     
  const [collections, setCollections] = useState([]);   
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
        fetch('api/workorder', {method: 'GET'}),
        fetch('api/delivery', {method: 'GET'}),
        fetch('/api/collections?completed=false', {method: 'GET'})
      ])
        .then(async ([productsRes, waitlistRes, woRes, delRes, colRes]) => {
          // Parse bodies first
          const [productsData, waitlistData, woData, delData, colData] = await Promise.all([
            productsRes.json().catch(() => null),
            waitlistRes.json().catch(() => null),
            woRes.json().catch(() => null),
            delRes.json().catch(() => null),
            colRes.json().catch(() => null),
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
          if (!woRes.ok) {
            console.error('Workorder API error:', woData);
            throw new Error(woData?.error || `Workorder HTTP ${woRes.status}`);
          }
          if (!delRes.ok) {
            console.error('Delivery API error:', delData);
            throw new Error(delData?.error || `Delivery HTTP ${delRes.status}`);
          }
          if (!colRes.ok) {
            console.error('Collections API error:', colData);
            throw new Error(colData?.error || `Collections HTTP ${colRes.status}`);
          }

          // Shape check + normalize to arrays
          const safeProducts = ensureArray(productsData);
          const safeWaitlist = ensureArray(waitlistData);
          const safeWOs = ensureArray(woData);      
          const safeDeliveries = ensureArray(delData); 
          const safeCollections = ensureArray(colData); 

          setProducts(safeProducts);
          setWaitlist(safeWaitlist);
          setWorkorders(safeWOs);        
          setDeliveries(safeDeliveries); 
          setCollections(safeCollections); 
        });

      await toast.promise(load, {
        loading: 'Fetching dashboard data...',
        success: 'Data loaded successfully!',
        error: 'Failed to load data.',
      }).catch((_e) => {
        // Keep state as arrays to avoid render crashes
        setProducts([]);
        setWaitlist([]);
        setWorkorders([]);    
        setDeliveries([]);    
        setCollections([]);   
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
  const wo = Array.isArray(workorders) ? workorders : [];     // NEW
  const d  = Array.isArray(deliveries) ? deliveries : [];     // NEW
  const c  = Array.isArray(collections) ? collections : [];   // NEW

  const totalProducts = p.length;
  const inStockCount = p.filter((x) => Number(x?.stock) > 0).length;
  const outOfStockCount = p.filter((x) => Number(x?.stock) === 0).length;

  const totalWaitlist = w.length;
  const uniqueWaitlistProducts = new Set(w.map((x) => x?.product_sku)).size;
  const uniqueWaitlistCustomers = new Set(w.map((x) => x?.customer_id)).size;
  const waitlistWithStock = w.filter((x) => Number(x?.stock) > 0).length;

  // ---- Workshop metrics ----
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const toISODate = (d) => {
    if (!d) return null;
    const dt = new Date(d);
    if (Number.isNaN(dt.getTime())) return null;
    return dt.toISOString().slice(0, 10);
  };
  const isPast = (dateStr) => {
    const dt = new Date(dateStr);
    if (Number.isNaN(dt.getTime())) return false;
    dt.setHours(0, 0, 0, 0);
    return dt.getTime() < today.getTime();
  };
  const inNextDays = (dateStr, days) => {
    const dt = new Date(dateStr);
    if (Number.isNaN(dt.getTime())) return false;
    dt.setHours(0,0,0,0);
    const max = new Date(today);
    max.setDate(max.getDate() + days);
    return dt >= today && dt <= max;
  };

  // Workorders
  const activeWorkorders = wo.filter((x) => x?.status === 'Work Ordered').length;
  const pastTargetWOs = wo.filter(
    (x) => x?.status !== 'Completed' && x?.estimated_completion && isPast(x.estimated_completion)
  ).length;

  // Deliveries
  const toBeBooked = d.filter((x) => x?.delivery_status === 'To Be Booked').length;
  const todayISO = toISODate(today);
  const goingOutToday = d.filter(
    (x) => x?.delivery_status === 'Booked for Delivery' && x?.delivery_date === todayISO
  ).length;

  // Collections (upcoming = within 7 days and not Completed)
  const upcomingCollections = c.filter(
    (x) => x?.status !== 'Completed' && x?.collection_date && inNextDays(x.collection_date, 7)
  ).length;
  const collectionsNoDate = c.filter((x) => x?.status !== 'Completed' && !x?.collection_date).length;

  // Optional extras
  const inWorkshopItems = wo.reduce((acc, row) => {
    const items = Array.isArray(row?.items) ? row.items : [];
    return acc + items.filter((it) => it?.status === 'In Workshop').length;
  }, 0);
  const completedButUndelivered = wo.filter((x) => x?.status === 'Completed')
    .map((x) => x.workorder_id)
    .filter((id) => !d.some((del) => Number(del?.workorder_id) === Number(id)))
    .length;

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
          {/* Always visible */}
          <Link to="/dashboard" className="text-gray-700 hover:bg-gray-200 p-2 rounded">
            Dashboard
          </Link>
          <Link to="/settings" className="text-gray-700 hover:bg-gray-200 p-2 rounded">
            Account Settings
          </Link>

          {/* Not visible to technician */}
          {user?.access !== 'technician' && (
            <>
              <Link to="/products" className="text-gray-700 hover:bg-gray-200 p-2 rounded">
                Products
              </Link>
              <Link to="/customers" className="text-gray-700 hover:bg-gray-200 p-2 rounded">
                Customers
              </Link>
              <Link to="/waitlist" className="text-gray-700 hover:bg-gray-200 p-2 rounded">
                Waitlist
              </Link>
            </>
          )}

          {/* Delivery Ops: visible to everyone */}
          <Link to="/delivery_operations" className="text-gray-700 hover:bg-gray-200 p-2 rounded">
            Delivery Operations
          </Link>

          {/* Only superadmin */}
          {user?.access === 'superadmin' && (
            <Link
              to="/register"
              className="text-gray-700 hover:bg-gray-200 p-2 rounded font-semibold"
            >
              Register New User
            </Link>
          )}

          {/* Logout */}
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
          {user?.access !== 'technician' && (
            <>
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
          </>
          )}

          <br />

          <div className="bg-white p-6 rounded shadow-md">
            <h2 className="text-xl font-bold mb-4">Workshop Analytics</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {analyticsCard('Active Workorders', activeWorkorders, '', () => navigate('/delivery_operations'))}
              {analyticsCard('Past Target Date', pastTargetWOs, 'text-red-700', () => navigate('/delivery_operations?tab=workorders&filter=pastTarget'))}
              {analyticsCard('Deliveries To Be Booked', toBeBooked, '', () => navigate('/delivery_operations?tab=deliveries'))}
              {analyticsCard('Deliveries Going Out Today', goingOutToday, 'text-blue-700', () => navigate('/delivery_operations?tab=deliveries&date=today'))}
              {analyticsCard('Upcoming Collections (7d)', upcomingCollections, '', () => navigate('/delivery_operations?tab=collections'))}
              {analyticsCard('Collections w/ No Date', collectionsNoDate, 'text-amber-700', () => navigate('/delivery_operations?tab=collections&filter=noDate'))}
              {analyticsCard('Items In Workshop', inWorkshopItems)}
              {analyticsCard('Completed WOs (No Delivery)', completedButUndelivered, 'text-amber-700')}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
