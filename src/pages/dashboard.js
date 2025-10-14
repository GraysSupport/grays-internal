import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';

/** Small inline bar chart (no external deps) */
function BarChart({ data = [], onBarClick }) {
  const max = data.reduce((m, d) => Math.max(m, d.value), 0) || 1;
  return (
    <div className="space-y-2">
      {data.map((d) => {
        const clickable = typeof onBarClick === 'function';
        return (
          <div
            key={d.label}
            className={`flex items-center gap-3 ${clickable ? 'cursor-pointer group' : ''}`}
            onClick={clickable ? () => onBarClick(d.label) : undefined}
            onKeyDown={
              clickable ? (e) => (e.key === 'Enter' || e.key === ' ') && onBarClick(d.label) : undefined
            }
            role={clickable ? 'button' : undefined}
            tabIndex={clickable ? 0 : undefined}
            title={clickable ? `View ${d.label} “To Be Booked”` : String(d.value)}
          >
            <div className="w-16 text-sm text-gray-600">{d.label}</div>
            <div className="flex-1 bg-gray-100 rounded">
              <div
                className={`h-4 rounded ${clickable ? 'group-hover:opacity-90' : ''}`}
                style={{ width: `${(d.value / max) * 100}%`, background: 'linear-gradient(90deg,#6366f1,#22c55e)' }}
                aria-valuenow={d.value}
                aria-label={`${d.label}: ${d.value}`}
              />
            </div>
            <div className="w-8 text-right text-sm font-medium">{d.value}</div>
          </div>
        );
      })}
    </div>
  );
}

export default function Dashboard() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // base datasets
  const [products, setProducts] = useState([]);
  const [waitlist, setWaitlist] = useState([]);
  const [workorders, setWorkorders] = useState([]);
  const [deliveries, setDeliveries] = useState([]);
  const [collections, setCollections] = useState([]);

  const navigate = useNavigate();

  // --- helpers ---
  const ensureArray = (data) =>
    Array.isArray(data) ? data : (data && typeof data === 'object' ? [data] : []);

  const parseISO = (d) => {
    if (!d) return null;
    const x = new Date(d);
    return Number.isNaN(x.getTime()) ? null : x;
  };

  // date bounds (Australia/Melbourne assumed by browser; good enough for dashboard)
  const today = useMemo(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }, []);

  const weekBounds = useMemo(() => {
    // Week starts Monday
    const d = new Date(today);
    const day = (d.getDay() + 6) % 7; // 0..6 (Mon..Sun)
    const start = new Date(d);
    start.setDate(d.getDate() - day);
    const end = new Date(start);
    end.setDate(start.getDate() + 7); // exclusive
    return { start, end };
  }, [today]);

  const nextWeekBounds = useMemo(() => {
    const start = new Date(weekBounds.end);
    const end = new Date(start);
    end.setDate(start.getDate() + 7); // exclusive
    return { start, end };
  }, [weekBounds]);

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
        fetch('/api/workorder', { method: 'GET' }),      // all WOs (we’ll compute active subset)
        fetch('/api/delivery', { method: 'GET' }),
        fetch('/api/collections', { method: 'GET' }),    // all collections
      ])
        .then(async ([productsRes, waitlistRes, woRes, delRes, colRes]) => {
          const [productsData, waitlistData, woData, delData, colData] = await Promise.all([
            productsRes.json().catch(() => null),
            waitlistRes.json().catch(() => null),
            woRes.json().catch(() => null),
            delRes.json().catch(() => null),
            colRes.json().catch(() => null),
          ]);

          if (!productsRes.ok) throw new Error(productsData?.error || `Products HTTP ${productsRes.status}`);
          if (!waitlistRes.ok) throw new Error(waitlistData?.error || `Waitlist HTTP ${waitlistRes.status}`);
          if (!woRes.ok) throw new Error(woData?.error || `Workorder HTTP ${woRes.status}`);
          if (!delRes.ok) throw new Error(delData?.error || `Delivery HTTP ${delRes.status}`);
          if (!colRes.ok) throw new Error(colData?.error || `Collections HTTP ${colRes.status}`);

          setProducts(ensureArray(productsData));
          setWaitlist(ensureArray(waitlistData));
          setWorkorders(ensureArray(woData));
          setDeliveries(ensureArray(delData));
          setCollections(ensureArray(colData));
        });

      await toast.promise(load, {
        loading: 'Fetching dashboard data...',
        success: 'Data loaded successfully!',
        error: 'Failed to load data.',
      }).catch(() => {
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

  // ======= PRODUCT / WAITLIST (existing) ========
  const p = Array.isArray(products) ? products : [];
  const w = Array.isArray(waitlist) ? waitlist : [];

  const totalProducts = p.length;
  const inStockCount = p.filter((x) => Number(x?.stock) > 0).length;
  const outOfStockCount = p.filter((x) => Number(x?.stock) === 0).length;

  const totalWaitlist = w.length;
  const uniqueWaitlistProducts = new Set(w.map((x) => x?.product_sku)).size;
  const uniqueWaitlistCustomers = new Set(w.map((x) => x?.customer_id)).size;
  const waitlistWithStock = w.filter((x) => Number(x?.stock) > 0).length;

  // ======= WORKORDER / DELIVERY / COLLECTION ANALYTICS ========
  const allWOs = Array.isArray(workorders) ? workorders : [];
  const allDeliveries = Array.isArray(deliveries) ? deliveries : [];
  const allCollections = Array.isArray(collections) ? collections : [];

  // Active workorders (not Completed)
  const activeWOs = allWOs.filter((wo) => String(wo?.status) !== 'Completed');

  // Past target date (estimated_completion < today)
  const pastTargetWOs = activeWOs.filter((wo) => {
    const d = parseISO(wo?.estimated_completion);
    return d && d < today;
  });

  // Important workorders (flag)
  const importantWOs = activeWOs.filter((wo) => !!wo?.important_flag);

  // Deliveries "To Be Booked" by state (sorted by state)
  const toBeBooked = allDeliveries.filter((d) => d?.delivery_status === 'To Be Booked');
  const tbbByStateMap = toBeBooked.reduce((acc, d) => {
    const st = (d?.delivery_state || 'NA').toUpperCase();
    acc[st] = (acc[st] || 0) + 1;
    return acc;
  }, {});
  const tbbByStateData = Object.keys(tbbByStateMap)
    .sort() // alphabetical state sort
    .map((state) => ({ label: state, value: tbbByStateMap[state] }));

  // Deliveries scheduled today / this week (Booked for Delivery)
  const booked = allDeliveries.filter((d) => d?.delivery_status === 'Booked for Delivery');
  const isSameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  const deliveriesToday = booked.filter((d) => {
    const dd = parseISO(d?.delivery_date);
    return dd && isSameDay(dd, today);
  });

  const deliveriesThisWeek = booked.filter((d) => {
    const dd = parseISO(d?.delivery_date);
    return dd && dd >= weekBounds.start && dd < weekBounds.end;
  });

  // Customer Collect (removalist_id = 15), status in Booked for Delivery or To Be Booked
  const CUSTOMER_COLLECT_ID = 15;
  const ccStatuses = new Set(['Booked for Delivery']);
  const customerCollectCount = allDeliveries.filter(
    (d) => Number(d?.removalist_id) === CUSTOMER_COLLECT_ID && ccStatuses.has(String(d?.delivery_status))
  ).length;

  // Collections this week / next week (use collection_date)
  const collectionsThisWeek = allCollections.filter((c) => {
    const dd = parseISO(c?.collection_date);
    return dd && dd >= weekBounds.start && dd < weekBounds.end;
  });
  const collectionsNextWeek = allCollections.filter((c) => {
    const dd = parseISO(c?.collection_date);
    return dd && dd >= nextWeekBounds.start && dd < nextWeekBounds.end;
  });

  // Total workorders so far this year (by date_created)
  const currentYear = today.getFullYear();
  const totalWOsThisYear = allWOs.filter((wo) => {
    const d = parseISO(wo?.date_created);
    return d && d.getFullYear() === currentYear;
  }).length;

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
              <br />
            </>
          )}

          {/* Workshop / Ops Analytics */}
          <div className="bg-white p-6 rounded shadow-md">
            <h2 className="text-xl font-bold mb-4">Delivery & Operations Analytics</h2>

            {/* KPI grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
              {analyticsCard('Active Workorders', activeWOs.length, '', () => navigate('/delivery_operations'))}
              {analyticsCard('Past Target (Active WOs)', pastTargetWOs.length, 'text-red-700', () => navigate('/delivery_operations/?filter=past-target'))}
              {analyticsCard('Important Workorders', importantWOs.length, 'text-purple-700', () => navigate('/delivery_operations/?filter=important'))}
              {analyticsCard('Deliveries Today (Booked)', deliveriesToday.length, '', () => navigate('/delivery_operations/schedule?when=today'))}
              {analyticsCard('Deliveries This Week (Booked)', deliveriesThisWeek.length, '', () => navigate('/delivery_operations/schedule?when=this-week'))}
              {analyticsCard('Customer Collect (Booked)', customerCollectCount, '', () => navigate('/delivery_operations/schedule?filter=customer-collect'))}
              {analyticsCard('Collections This Week', collectionsThisWeek.length, '', () => navigate('/delivery_operations/current-collections?when=this-week'))}
              {analyticsCard('Collections Next Week', collectionsNextWeek.length, '', () => navigate('/delivery_operations/current-collections?when=next-week'))}
              {analyticsCard(`Workorders in ${today.getFullYear()}`, totalWOsThisYear)}
            </div>

            {/* Chart */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
              <div className="bg-gray-50 rounded p-4">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-semibold">Deliveries “To Be Booked” by State</h3>
                  <button
                    className="text-xs text-blue-600 hover:underline"
                    onClick={() => navigate('/delivery_operations/to-be-booked')}
                  >
                    View all
                  </button>
                </div>

                {tbbByStateData.length ? (
                  <BarChart
                    data={tbbByStateData}
                    onBarClick={(state) => navigate(`/delivery_operations/to-be-booked?state=${encodeURIComponent(state)}`)}
                  />
                ) : (
                  <div className="text-sm text-gray-500">No “To Be Booked” deliveries.</div>
                )}
              </div>

              {/* Quick lists (optional): Past target WOs / Important WOs preview */}
              <div className="bg-gray-50 rounded p-4">
                <h3 className="font-semibold mb-2">TL;DR</h3>
                <ul className="text-sm space-y-1 list-disc list-inside">
                  <li>
                    <span className="font-medium">Past Target WOs:</span> {pastTargetWOs.length}
                  </li>
                  <li>
                    <span className="font-medium">Important WOs:</span> {importantWOs.length}
                  </li>
                  <li>
                    <span className="font-medium">To Be Booked Deliveries:</span> {toBeBooked.length}
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}