import { Link, useLocation } from 'react-router-dom';

export default function PelotonTabs({ className = '' }) {
  const { pathname } = useLocation();
  const path = pathname.replace(/\/+$/, '') || '/';

  const isActive = {
    stock:            path === '/peloton',
    salesOrders:      path.startsWith('/peloton/sales-orders'),
    purchaseOrders:   path.startsWith('/peloton/purchase-orders'),
    deliveryCalendar: path.startsWith('/peloton/delivery-calendar'),
  };

  const tabCls = (active) =>
    [
      'px-3 py-2 text-sm rounded-xl transition whitespace-nowrap',
      active
        ? 'bg-gray-100 ring-1 ring-inset ring-gray-300 font-medium'
        : 'hover:bg-gray-50 text-gray-700',
    ].join(' ');

  return (
    <div className={`sticky bottom-0 z-30 border-t bg-white shadow-lg flex-shrink-0 ${className}`}>
      <div className="px-3 py-2">
        <nav className="flex items-center gap-1 overflow-x-auto whitespace-nowrap">
          <span className="ml-1 mr-2 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
            Peloton
          </span>

          <Link to="/peloton" className={tabCls(isActive.stock)} aria-current={isActive.stock ? 'page' : undefined}>
            Stock
          </Link>

          <Link to="/peloton/sales-orders" className={tabCls(isActive.salesOrders)} aria-current={isActive.salesOrders ? 'page' : undefined}>
            Sales Orders
          </Link>

          <Link to="/peloton/purchase-orders" className={tabCls(isActive.purchaseOrders)} aria-current={isActive.purchaseOrders ? 'page' : undefined}>
            Purchase Orders
          </Link>

          <Link to="/peloton/delivery-calendar" className={tabCls(isActive.deliveryCalendar)} aria-current={isActive.deliveryCalendar ? 'page' : undefined}>
            Delivery Calendar
          </Link>

          <div className="mx-2 h-6 w-px bg-gray-200" />

          <Link to="/dashboard" className="px-3 py-2 text-sm rounded-xl hover:bg-red-50 text-red-600 font-semibold">
            Exit
          </Link>
        </nav>
      </div>
    </div>
  );
}
