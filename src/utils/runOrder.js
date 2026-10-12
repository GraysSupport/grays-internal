// G9 (Nick, 28 Sep 2026) — the pure logic behind drag-to-reorder on the delivery schedule.
//
// A RUN is one carrier on one day. Stops can be reordered within a run and never moved
// between runs: a drop on another carrier or another day is refused (the server enforces the
// same rule — lib/deliveryRunOrder.js). The saved order is `delivery.run_order`; rows that
// were never ordered (null) keep the schedule's existing default, after the ordered ones.

// Who may reorder. Mirrors RUN_ORDER_ROLES in lib/deliveryRunOrder.js; the server is the
// real authority. `admin` is here because prod has no `logistics` users (PR #107).
export const RUN_ORDER_ROLES = ['logistics', 'admin', 'superadmin'];

const dayOf = (row) => String(row?.delivery_date || '').slice(0, 10);

/** The run a delivery belongs to: carrier + day. '' when it has no day (can't be ordered). */
export function runKey(row) {
  const day = dayOf(row);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return '';
  return `${row.removalist_id == null ? 'none' : Number(row.removalist_id)}|${day}`;
}

/** May `from` be dropped on `to`? Only within the same run. */
export function sameRun(from, to) {
  const key = runKey(from);
  return key !== '' && key === runKey(to);
}

/**
 * Sort comparator WITHIN a date block: carrier name, then saved stop order (unordered rows
 * last), then customer name — so an unordered schedule looks exactly as it did before G9.
 */
export function compareStops(order = {}) {
  return (a, b) => {
    const carrier = (a.removalist_name || '').localeCompare(b.removalist_name || '');
    if (carrier !== 0) return carrier;
    const ao = order[a.delivery_id];
    const bo = order[b.delivery_id];
    if (ao != null && bo != null && ao !== bo) return ao - bo;
    if (ao != null && bo == null) return -1;
    if (ao == null && bo != null) return 1;
    return String(a.customer_name || '').localeCompare(String(b.customer_name || ''));
  };
}

/** The run's stops, in the order they are shown. */
export function stopsInRun(rows, row, order = {}) {
  const key = runKey(row);
  if (!key) return [];
  return rows.filter((r) => runKey(r) === key).sort(compareStops(order));
}

/**
 * Move `fromId` to where `toId` is, within the same run. Returns the run's new complete id
 * order (what the PUT sends), or null when the move isn't allowed / changes nothing.
 */
export function moveStop(rows, order, fromId, toId) {
  const from = rows.find((r) => r.delivery_id === fromId);
  const to = rows.find((r) => r.delivery_id === toId);
  if (!from || !to || fromId === toId || !sameRun(from, to)) return null;
  const ids = stopsInRun(rows, from, order).map((r) => r.delivery_id);
  const fromIdx = ids.indexOf(fromId);
  const toIdx = ids.indexOf(toId);
  ids.splice(fromIdx, 1);
  ids.splice(toIdx, 0, fromId);
  return ids;
}

/** The neighbour a Move up / Move down button would swap with (null at the ends of a run). */
export function neighbourInRun(rows, order, row, dir) {
  const stops = stopsInRun(rows, row, order);
  const idx = stops.findIndex((r) => r.delivery_id === row.delivery_id);
  if (idx < 0) return null;
  return stops[dir === 'up' ? idx - 1 : idx + 1] || null;
}

/** The PUT body for a run's new order. */
export function runOrderPayload(row, ids) {
  return {
    removalist_id: row.removalist_id == null ? null : Number(row.removalist_id),
    delivery_date: dayOf(row),
    delivery_ids: ids,
  };
}
