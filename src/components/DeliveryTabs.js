import { Link, useLocation } from 'react-router-dom';

export default function DeliveryTabs({ className = '' }) {
  const { pathname } = useLocation();

  // Normalize trailing slash (so "/delivery_operations/" matches "/delivery_operations")
  const path = pathname.replace(/\/+$/, '') || '/';

  const isActive = {
    current: path === '/delivery_operations',
    toBeBooked: path.startsWith('/delivery_operations/to-be-booked'),
    schedule: path.startsWith('/delivery_operations/schedule'),
    currentCollections: path.startsWith('/delivery_operations/current-collections'),

    completedOps: path.startsWith('/delivery_operations/completed-operations'),
    completedDeliveries: path.startsWith('/delivery_operations/completed-deliveries'),
    completedCollections: path.startsWith('/delivery_operations/completed-collections'),
  };

  const tabCls = (active) =>
    [
      'px-3 py-2 text-sm rounded-xl transition',
      active
        // ACTIVE: bg + subtle ring; no base `border` so others don’t show outlines
        ? 'bg-gray-100 ring-1 ring-inset ring-gray-300 font-medium'
        // INACTIVE
        : 'hover:bg-gray-50 text-gray-700',
    ].join(' ');

  return (
    <div className={`sticky bottom-0 z-30 border-t bg-white shadow-lg ${className}`}>
      <div className="px-3 py-2">
        <nav className="flex items-center gap-1 overflow-x-auto whitespace-nowrap">
          {/* Current */}
          <span className="ml-1 mr-2 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
            Current
          </span>

          <Link
            to="/delivery_operations"
            className={tabCls(isActive.current)}
            aria-current={isActive.current ? 'page' : undefined}
            title="Current Operations"
          >
            Current Operations
          </Link>

          <Link
            to="/delivery_operations/to-be-booked"
            className={tabCls(isActive.toBeBooked)}
            aria-current={isActive.toBeBooked ? 'page' : undefined}
          >
            To Be Booked
          </Link>

          <Link
            to="/delivery_operations/schedule"
            className={tabCls(isActive.schedule)}
            aria-current={isActive.schedule ? 'page' : undefined}
          >
            Delivery Schedule
          </Link>

          <Link
            to="/delivery_operations/current-collections"
            className={tabCls(isActive.currentCollections)}
            aria-current={isActive.currentCollections ? 'page' : undefined}
          >
            Current Collections
          </Link>

          {/* Divider */}
          <div className="mx-2 h-6 w-px bg-gray-200" />

          {/* Completed */}
          <span className="mr-2 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
            Completed
          </span>

          <Link
            to="/delivery_operations/completed-operations"
            className={tabCls(isActive.completedOps)}
            aria-current={isActive.completedOps ? 'page' : undefined}
          >
            Operations Completed
          </Link>

          <Link
            to="/delivery_operations/completed-deliveries"
            className={tabCls(isActive.completedDeliveries)}
            aria-current={isActive.completedDeliveries ? 'page' : undefined}
          >
            Deliveries Completed
          </Link>

          <Link
            to="/delivery_operations/completed-collections"
            className={tabCls(isActive.completedCollections)}
            aria-current={isActive.completedCollections ? 'page' : undefined}
          >
            Collections Completed
          </Link>

          {/* Exit */}
          <div className="mx-2 h-6 w-px bg-gray-200" />
          <Link
            to="/dashboard"
            className="px-3 py-2 text-sm rounded-xl hover:bg-red-50 text-red-600 font-semibold"
          >
            Exit
          </Link>
        </nav>
      </div>
    </div>
  );
}
