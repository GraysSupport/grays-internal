import { carrierColor } from '../utils/carrierColors';

// G24 (owner, 2 Nov 2026) — technicians, the workshop role and the WK kiosk may LOOK at To Be
// Booked, the Delivery Schedule and Deliveries Completed, but change nothing. The server sends
// them `balance_status` ('Paid' | 'Outstanding' | null) instead of the amount, and no delivery
// money or notes (lib/workshopAccess.js redactDelivery). These are the read-only cells.

export function ViewOnlyNotice() {
  return (
    <p className="mb-4 rounded-lg border border-gray-200 bg-gray-50 px-4 py-2 text-sm text-gray-700">
      View only — workshop logins can see these deliveries but can’t change them. Payment shows as Paid or Outstanding.
    </p>
  );
}

export function BalanceBadge({ status }) {
  if (status === 'Paid') {
    return (
      <span className="rounded-full bg-green-50 px-2.5 py-0.5 text-[11px] font-semibold text-green-700 ring-1 ring-inset ring-green-200">
        Paid
      </span>
    );
  }
  if (status === 'Outstanding') {
    return (
      <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-[11px] font-semibold text-amber-800 ring-1 ring-inset ring-amber-200">
        Outstanding
      </span>
    );
  }
  return <span className="text-gray-600">—</span>;
}

export function CarrierName({ name }) {
  const label = (name || '').trim();
  if (!label) return <span className="text-gray-600">—</span>;
  const bg = carrierColor(label);
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ring-black/10"
      style={bg ? { backgroundColor: bg } : undefined}
    >
      {label}
    </span>
  );
}

/** 'YYYY-MM-DD' (or an ISO timestamp) → "5 Nov 2026"; '—' when there is no date. */
export function fmtDay(value) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '—';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
