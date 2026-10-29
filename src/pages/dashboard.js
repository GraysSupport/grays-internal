import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { getRoles } from '../utils/auth';
import { currentUserIsWorkshop, identityHeaders } from '../utils/workshopAccess';
import { buildNavItems } from '../utils/nav';
import { MobileNavButton, MobileNavDrawer, NavList } from '../components/PortalNav';

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
  // G17/G19: workshop logins (technician / workshop role / the WK kiosk, by id) see the job and
  // stock numbers but never the waitlist, and their cards don't link to pages they can't open.
  const isWorkshop = currentUserIsWorkshop();
  // F19 incr 2a: the nav items — and every role gate that decides which ones appear — now live
  // in utils/nav.js, because the desktop sidebar and the mobile drawer both render them.
  const navItems = useMemo(() => buildNavItems({ user, roles: getRoles() }), [user]);
  const [navOpen, setNavOpen] = useState(false);
  // Stable identity: the drawer subscribes to Escape and to a matchMedia change with this in
  // the dependency array, so an inline arrow would resubscribe on every dashboard render.
  const closeNav = useCallback(() => setNavOpen(false), []);

  // base datasets
  const [products, setProducts] = useState([]);
  const [waitlist, setWaitlist] = useState([]);
  const [workorders, setWorkorders] = useState([]);
  const [deliveries, setDeliveries] = useState([]);
  const [collections, setCollections] = useState([]);
  // G19: sources that failed to load — their cards say "Not available" instead of a fake 0.
  const [failed, setFailed] = useState(() => new Set());
  const [loaded, setLoaded] = useState(false);

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

  // Lifted out of the sidebar's onClick so the drawer's Logout runs the SAME code, not a copy.
  // In an installed PWA (F19 incr 1) this is the only way to sign out — there is no URL bar.
  const handleLogout = useCallback(async () => {
    const u = JSON.parse(localStorage.getItem('user') || 'null');
    if (u) {
      try {
        await fetch('/api/access-log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: u.id, description: 'User manually logged out' }),
        });
      } catch {}
    }
    localStorage.removeItem('user');
    localStorage.removeItem('token');
    localStorage.removeItem('sessionExpiry');
    toast('Logged out');
    navigate('/');
  }, [navigate]);

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
    let alive = true;
    let toastId;
    const fetchData = async () => {
      // G19: every source loads on its own, so one refused or failing endpoint only hides its
      // own cards. Workshop logins (G17) skip the waitlist — it carries every waitlisted
      // customer's email + phone and the server refuses it — and their workorder / delivery
      // loads identify the caller so the server redacts money + customer contact.
      const sources = [
        { key: 'products', url: '/api/products', set: setProducts },
        { key: 'waitlist', url: '/api/waitlist', set: setWaitlist, office: true },
        { key: 'workorder', url: '/api/workorder', set: setWorkorders, identify: true }, // all WOs (we’ll compute active subset)
        { key: 'delivery', url: '/api/delivery', set: setDeliveries, identify: true },
        { key: 'collections', url: '/api/collections', set: setCollections },
      ].filter((s) => !(s.office && currentUserIsWorkshop()));

      const loadOne = async (s) => {
        const res = await fetch(s.url, { method: 'GET', ...(s.identify ? { headers: identityHeaders() } : {}) });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error || `${s.key} HTTP ${res.status}`);
        if (alive) s.set(ensureArray(data));
      };

      toastId = toast.loading('Fetching dashboard data...');
      const results = await Promise.allSettled(sources.map(loadOne));
      if (!alive) return;
      const down = sources.filter((_, i) => results[i].status === 'rejected').map((s) => s.key);
      setFailed(new Set(down));
      setLoaded(true);
      if (down.length) toast.error('Some dashboard numbers could not be loaded.', { id: toastId });
      else toast.success('Data loaded successfully!', { id: toastId });
    };

    fetchData();
    // Leaving the page mid-load: drop the results and don't leave the toast spinning elsewhere.
    return () => {
      alive = false;
      if (toastId) toast.dismiss(toastId);
    };
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
  const waitlistComingIn = w.filter((x) => Number(x?.stock) === 0 && x?.coming_in_date).length;

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

  // G19: a count reads "…" while loading and "Not available" if its source failed — never a
  // fake 0.
  const NOT_AVAILABLE = 'Not available';
  const shown = (source, value) => (!loaded ? '…' : failed.has(source) ? NOT_AVAILABLE : value);
  // Links: workshop logins can't open Products, the Waitlist, the Schedule or To-Be-Booked
  // (G17 blockWorkshop); they CAN open Current Workorders and Collections — except the WK
  // kiosk, whose ops entry is /workshop.
  const isKiosk = String(user?.id || '').toUpperCase() === 'WK' || user?.email === 'workshop@graysfitness.com.au';
  const officeLink = (fn) => (isWorkshop ? null : fn);
  const opsLink = (fn) => (isKiosk ? null : fn);

  const analyticsCard = (label, value, extraClasses = '', onClick = null) => (
    <div
      onClick={onClick || undefined}
      className={`bg-gray-50 p-4 rounded shadow transition ${onClick ? 'cursor-pointer hover:shadow-md' : ''} ${extraClasses}`}
    >
      <h3 className="font-medium">{label}</h3>
      {value === NOT_AVAILABLE ? (
        <p className="text-base font-medium text-gray-600">
          {NOT_AVAILABLE}<span className="sr-only"> — this number could not be loaded</span>
        </p>
      ) : (
        <p className="text-2xl font-bold">{value}</p>
      )}
    </div>
  );

  return (
    <div className="flex h-screen bg-gray-100">
      {/* Sidebar */}
      <aside className="w-64 bg-white shadow-md hidden md:block">
        <div className="p-6 font-bold text-xl border-b">Grays Admin</div>
        <NavList testId="sidebar-nav" items={navItems} onLogout={handleLogout} className="mt-4 px-4" />
      </aside>

      {/* Mobile drawer — the only navigation below md. Mounted only while open so useDialog
          captures the opener and can restore focus to it (F26 convention). */}
      {navOpen && (
        <MobileNavDrawer items={navItems} onLogout={handleLogout} onClose={closeNav} />
      )}

      {/* Main */}
      <div className="flex-1 flex flex-col">
        <header className="bg-white shadow-md p-4 flex items-center gap-2">
          <MobileNavButton onClick={() => setNavOpen(true)} />
          <h1 className="text-lg font-semibold truncate">Hello, {user?.name || 'Guest'}</h1>
        </header>

        <main className="flex-1 p-4 md:p-6 overflow-auto">
          {/* G19: stock numbers for everyone; the waitlist cards (customer contact) are never
              shown to workshop logins (technician / workshop / the WK kiosk — G17). */}
          <div className="bg-white p-6 rounded shadow-md">
            <h2 className="text-xl font-bold mb-4">Dashboard Analytics</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {analyticsCard('Total Products', shown('products', totalProducts), '', officeLink(() => navigate('/products')))}
              {analyticsCard('In Stock', shown('products', inStockCount), 'text-green-700', officeLink(() => navigate('/products?inStock=true')))}
              {analyticsCard('Out of Stock', shown('products', outOfStockCount), 'text-red-700', officeLink(() => navigate('/products?inStock=false')))}
              {!isWorkshop && (
                <>
                  {analyticsCard('Total Waitlist Entries', shown('waitlist', totalWaitlist), '', () => navigate('/waitlist'))}
                  {analyticsCard('Products Waitlisted', shown('waitlist', uniqueWaitlistProducts))}
                  {analyticsCard('Customers Waitlisted', shown('waitlist', uniqueWaitlistCustomers))}
                  {analyticsCard('Waitlist in Stock', shown('waitlist', waitlistWithStock), 'text-green-700', () => navigate('/waitlist?inStock=true'))}
                  {analyticsCard('Waitlist Coming In', shown('waitlist', waitlistComingIn), 'text-amber-700')}
                </>
              )}
            </div>
          </div>
          <br />

          {/* Workshop / Ops Analytics */}
          <div className="bg-white p-6 rounded shadow-md">
            <h2 className="text-xl font-bold mb-4">Delivery & Operations Analytics</h2>

            {/* KPI grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
              {analyticsCard('Active Workorders', shown('workorder', activeWOs.length), '', opsLink(() => navigate('/delivery_operations')))}
              {analyticsCard('Past Target (Active WOs)', shown('workorder', pastTargetWOs.length), 'text-red-700', opsLink(() => navigate('/delivery_operations/?filter=past-target')))}
              {analyticsCard('Important Workorders', shown('workorder', importantWOs.length), 'text-purple-700', opsLink(() => navigate('/delivery_operations/?filter=important')))}
              {analyticsCard('Deliveries Today (Booked)', shown('delivery', deliveriesToday.length), '', officeLink(() => navigate('/delivery_operations/schedule?when=today')))}
              {analyticsCard('Deliveries This Week (Booked)', shown('delivery', deliveriesThisWeek.length), '', officeLink(() => navigate('/delivery_operations/schedule?when=this-week')))}
              {analyticsCard('Customer Collect (Booked)', shown('delivery', customerCollectCount), '', officeLink(() => navigate('/delivery_operations/schedule?filter=customer-collect')))}
              {analyticsCard('Collections This Week', shown('collections', collectionsThisWeek.length), '', opsLink(() => navigate('/delivery_operations/current-collections?when=this-week')))}
              {analyticsCard('Collections Next Week', shown('collections', collectionsNextWeek.length), '', opsLink(() => navigate('/delivery_operations/current-collections?when=next-week')))}
              {analyticsCard(`Workorders in ${today.getFullYear()}`, shown('workorder', totalWOsThisYear))}
            </div>

            {/* Chart */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
              <div className="bg-gray-50 rounded p-4">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-semibold">Deliveries “To Be Booked” by State</h3>
                  {!isWorkshop && (
                    <button
                      className="text-xs text-blue-600 hover:underline"
                      onClick={() => navigate('/delivery_operations/to-be-booked')}
                    >
                      View all
                    </button>
                  )}
                </div>

                {failed.has('delivery') ? (
                  <div className="text-sm text-gray-600">Deliveries could not be loaded.</div>
                ) : !loaded ? (
                  <div className="text-sm text-gray-600">Loading…</div>
                ) : tbbByStateData.length ? (
                  <BarChart
                    data={tbbByStateData}
                    onBarClick={isWorkshop ? undefined : (state) => navigate(`/delivery_operations/to-be-booked?state=${encodeURIComponent(state)}`)}
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
                    <span className="font-medium">Past Target WOs:</span> {shown('workorder', pastTargetWOs.length)}
                  </li>
                  <li>
                    <span className="font-medium">Important WOs:</span> {shown('workorder', importantWOs.length)}
                  </li>
                  <li>
                    <span className="font-medium">To Be Booked Deliveries:</span> {shown('delivery', toBeBooked.length)}
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