// lib/workorderCancel.js — G23 (owner, 30 Oct 2026): cancelling and reopening a workorder.
//
// Owner decisions:
//  • Cancelling cancels every live item (status 'Canceled', the existing item spelling), returns
//    its stock (custom items hold none) and frees any lot assigned to it (back to In Stock,
//    unlinked). Each item remembers its status in workorder_items.status_before_cancel.
//  • Reopening (Cancelled → Work Ordered) puts those items back and takes the stock again.
//    Items removed BEFORE the cancel have no marker and stay removed. Freed lots are not
//    re-assigned automatically — the log says so.
//  • Only superadmin / admin / logistics / sales may cancel or reopen (JWT roles, server-side).
//  • A workorder that already has a delivery cannot be cancelled until the delivery is removed.
// Both run inside the caller's transaction; a refusal throws CancelRefused (caller rolls back).

export const CANCELLED = 'Cancelled';
export const WORKORDER_CANCEL_ROLES = ['superadmin', 'admin', 'logistics', 'sales'];

export class CancelRefused extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function cancelWorkorder(client, { id, actorId, logEvent, adjustProductStock }) {
  const delivery = await client.query(`SELECT delivery_id FROM delivery WHERE workorder_id = $1 LIMIT 1`, [id]);
  if (delivery.rowCount) {
    throw new CancelRefused(409, 'This workorder already has a delivery — remove the delivery first, then cancel the workorder');
  }

  const { rows: live } = await client.query(
    `SELECT workorder_items_id, product_id, quantity, is_custom, status
       FROM workorder_items WHERE workorder_id = $1 AND status <> 'Canceled'
      ORDER BY workorder_items_id FOR UPDATE`,
    [id]
  );
  const itemIds = live.map((r) => Number(r.workorder_items_id));
  for (const row of live) {
    if (!row.is_custom) await adjustProductStock(client, row.product_id, +Number(row.quantity));
  }

  let lotNumbers = [];
  if (itemIds.length) {
    await client.query(
      `UPDATE workorder_items SET status_before_cancel = status, status = 'Canceled' WHERE workorder_items_id = ANY($1::int[])`,
      [itemIds]
    );
    for (const itemId of itemIds) {
      await logEvent(client, { workorder_id: id, workorder_items_id: itemId, event_type: 'ITEM_STATUS_CHANGED', user_id: actorId, item_status: 'Canceled' });
    }
    const lots = await client.query(
      `UPDATE product_lots SET status = 'In Stock', workorder_items_id = NULL, updated_at = NOW()
        WHERE workorder_items_id = ANY($1::int[]) AND status = 'Assigned'
        RETURNING lot_number`,
      [itemIds]
    );
    lotNumbers = lots.rows.map((r) => r.lot_number);
  }

  await client.query(`UPDATE workorder SET status = 'Cancelled' WHERE workorder_id = $1`, [id]);
  const parts = [`Workorder cancelled — ${itemIds.length} item(s) cancelled and their stock returned`];
  if (lotNumbers.length) parts.push(`lot(s) back in stock: ${lotNumbers.join(', ')}`);
  await logEvent(client, { workorder_id: id, event_type: 'WORKORDER_STATUS_CHANGED', user_id: actorId, notes_log: `${parts.join('; ')}.` });
  return { items: itemIds.length, lots: lotNumbers };
}

export async function reopenCancelledWorkorder(client, { id, actorId, logEvent, adjustProductStock }) {
  const { rows: back } = await client.query(
    `SELECT workorder_items_id, product_id, quantity, is_custom, status_before_cancel
       FROM workorder_items WHERE workorder_id = $1 AND status = 'Canceled' AND status_before_cancel IS NOT NULL
      ORDER BY workorder_items_id FOR UPDATE`,
    [id]
  );
  // Throws "Insufficient stock …" when a machine went elsewhere meanwhile; the caller answers 409.
  for (const row of back) {
    if (!row.is_custom) await adjustProductStock(client, row.product_id, -Number(row.quantity));
  }
  const itemIds = back.map((r) => Number(r.workorder_items_id));
  if (itemIds.length) {
    await client.query(
      `UPDATE workorder_items SET status = status_before_cancel, status_before_cancel = NULL WHERE workorder_items_id = ANY($1::int[])`,
      [itemIds]
    );
    for (const row of back) {
      await logEvent(client, { workorder_id: id, workorder_items_id: Number(row.workorder_items_id), event_type: 'ITEM_STATUS_CHANGED', user_id: actorId, item_status: row.status_before_cancel });
    }
  }
  await client.query(`UPDATE workorder SET status = 'Work Ordered' WHERE workorder_id = $1`, [id]);
  await logEvent(client, {
    workorder_id: id, event_type: 'WORKORDER_STATUS_CHANGED', user_id: actorId,
    notes_log: `Workorder reopened from Cancelled — ${itemIds.length} item(s) restored and their stock taken again. Lots freed at the cancel are not re-assigned; assign them again if needed.`,
  });
  return { items: itemIds.length };
}
