// lib/ecomAutoTicked.js — GS one-time popup for workorders the portal ticked by itself
// (owner, 26 Nov 2026).
//
// Once WOO_STOCK_SYNC_DRY_RUN is false, a successful website stock update ticks the
// workorder's E-Commerce flag automatically (lib/wooStock.js stamps ecommerce_auto_ticked_at),
// so it leaves GS's "Ecommerce checks pending" popup. GS still has to open each of those
// workorders ONCE to enter the sold items' values. This module lists the ones GS hasn't opened
// yet and remembers when GS opened each (ecommerce_auto_seen_at) — after that it never pops up
// again.
//
// Only GS (from the signed login token, never a client header) sees or clears the list.
// 42703-safe: before migration 0018 the list is empty and nothing is marked.

import { CANCELLED } from './workorderCancel.js';

const isMissingColumn = (e) => e?.code === '42703';

/** GS view only (owner: "make me a pop up as a GS view"). `auth` = rbac getAuthUser(req). */
export function canSeeEcomAutoPopup(auth) {
  return String(auth?.id ?? '').trim().toUpperCase() === 'GS';
}

/** Workorders ticked automatically, still ticked, not cancelled, not yet opened by GS. */
export async function listEcomAutoTicked(client) {
  try {
    const r = await client.query(
      `SELECT wo.workorder_id, wo.invoice_id, wo.status, wo.salesperson,
              wo.ecommerce_auto_ticked_at, c.name AS customer_name,
              COALESCE(
                json_agg(json_build_object(
                  'product_id',   wi.product_id,
                  'product_name', COALESCE(wi.custom_description, p.name, wi.product_id),
                  'quantity',     wi.quantity
                ) ORDER BY wi.workorder_items_id) FILTER (WHERE wi.workorder_items_id IS NOT NULL AND wi.status::text IS DISTINCT FROM 'Canceled'),
                '[]'::json
              ) AS items
         FROM workorder wo
         JOIN customers c ON c.id = wo.customer_id
         LEFT JOIN workorder_items wi ON wi.workorder_id = wo.workorder_id
         LEFT JOIN product p ON p.sku = wi.product_id
        WHERE wo.ecommerce_auto_ticked_at IS NOT NULL
          AND wo.ecommerce_auto_seen_at IS NULL
          AND wo.ecommerce IS TRUE
          AND wo.status::text <> $1
        GROUP BY wo.workorder_id, c.name
        ORDER BY wo.ecommerce_auto_ticked_at ASC`,
      [CANCELLED]
    );
    return { available: true, rows: r.rows };
  } catch (e) {
    if (isMissingColumn(e)) return { available: false, rows: [] };
    throw e;
  }
}

/** GS opened the workorder → it never pops up again. Idempotent; keeps the first opening time. */
export async function markEcomAutoSeen(client, workorderId) {
  const id = Number(workorderId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, status: 400, error: 'Missing or invalid workorder_id' };
  try {
    const r = await client.query(
      `UPDATE workorder SET ecommerce_auto_seen_at = NOW()
        WHERE workorder_id = $1 AND ecommerce_auto_ticked_at IS NOT NULL AND ecommerce_auto_seen_at IS NULL`,
      [id]
    );
    return { ok: true, available: true, marked: r.rowCount > 0 };
  } catch (e) {
    if (isMissingColumn(e)) return { ok: true, available: false, marked: false };
    throw e;
  }
}
