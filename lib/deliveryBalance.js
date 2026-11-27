// lib/deliveryBalance.js — SEC1 (27 Nov 2026): "balance paid in full before dispatch" is now
// enforced on the server (before, only the screens checked it). A balance under half a cent is paid.
export const PAID_EPSILON = 0.005;

/** What the delivery's workorder still owes (0 when paid, unknown, or there is no workorder). */
export async function balanceOwing(client, workorderId) {
  if (workorderId == null || workorderId === '') return 0;
  const r = await client.query('SELECT outstanding_balance FROM workorder WHERE workorder_id = $1', [Number(workorderId)]);
  const n = Number(r.rows?.[0]?.outstanding_balance ?? 0);
  return Number.isFinite(n) && n > PAID_EPSILON ? Math.round(n * 100) / 100 : 0;
}

/** AUD, no decimals on whole dollars ("$1,795"), cents when there are some ("$2,125.50"). */
export function owingMessage(amount) {
  const whole = Math.round(amount * 100) % 100 === 0;
  const money = `$${amount.toLocaleString('en-AU', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 })}`;
  return `Cannot set to "Delivery Completed": ${money} is still owing. The balance must be paid in full before dispatch.`;
}
