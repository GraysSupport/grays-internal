// lib/waitlistNotify.js — Waitlist back-in-stock SMS automation (feature F8a).
//
// When incoming stock is credited (the superadmin "apply inventory" action on a
// collection), any customer sitting on the `waitlist` for a SKU that has just come back
// into stock is texted from the SHARED Grays number (P9 — system notification, not a rep
// 1:1). Today this is fully manual; F8a automates it (execution-plan §F8a).
//
// Design guarantees:
//  - BEST-EFFORT / NON-BLOCKING: notify runs AFTER the inventory-apply transaction has
//    committed and NEVER throws — an SMS or Podium failure must never roll back or block
//    the inventory credit. All errors are swallowed + logged; the caller gets counts.
//  - IDEMPOTENT: each waitlist row is claimed once via an integration_sync_log row with a
//    unique reference_id (ON CONFLICT DO NOTHING on uq_sync_ref), and the waitlist row is
//    flipped Active → Notified, so a re-apply (or a second collection with the same SKU)
//    never double-texts the same person for the same waitlist entry.
//  - P1: only ENVELOPE metadata (waitlist_id / customer_id / sku / collection_id) is
//    logged — never the rendered SMS body.
//  - Mock-first: sendSystemSms() short-circuits to the typed Podium mock when
//    PODIUM_MOCK=true, so nothing actually sends until creds + PODIUM_MOCK=false.

import { sendSystemSms } from './podium.js';

/**
 * The customer-facing SMS copy. On brand: phone 1300 769 556 primary; no "used /
 * second-hand" language. Copy is a sensible default — flagged for human sign-off before
 * live send (the send itself is gated behind PODIUM_MOCK=false, a human config flip).
 */
export function backInStockMessage(productName) {
  const name = (productName && String(productName).trim()) || 'the item you were waiting for';
  return `Good news from Grays Fitness! ${name} is back in stock. Call 1300 769 556 to secure yours — first in, first served.`;
}

/**
 * Notify Active waitlist rows for the given SKUs that stock is back.
 * @param {object} client  an OPEN pg client (used post-commit; each statement autocommits)
 * @param {string[]} skus  SKUs that just transitioned back into stock
 * @param {object} [opts]  { collectionId, send } — send lets the smoke inject a fake sender
 * @returns {Promise<{notified:number, skipped:number, failed:number}>}
 */
export async function notifyWaitlistBackInStock(client, skus, opts = {}) {
  const { collectionId = null, send } = opts;
  const sendSms = send || sendSystemSms;
  const out = { notified: 0, skipped: 0, failed: 0 };

  const list = [...new Set((skus || []).map((s) => String(s).toUpperCase()).filter(Boolean))];
  if (!list.length) return out;

  // Active waitlist rows for these SKUs, with the customer's phone + the product name.
  let rows = [];
  try {
    const r = await client.query(
      `SELECT w.waitlist_id, w.customer_id, w.product_sku,
              c.name  AS customer_name, c.phone AS customer_phone,
              p.name  AS product_name
         FROM waitlist w
         JOIN customers c ON c.id = w.customer_id
         LEFT JOIN product p ON upper(p.sku) = upper(w.product_sku)
        WHERE w.status = 'Active'
          AND upper(w.product_sku) = ANY($1)
        ORDER BY w.waitlisted ASC, w.waitlist_id ASC`,
      [list]
    );
    rows = r.rows || [];
  } catch (err) {
    // waitlist/customers/product absent (bare DB) or any query error — degrade silently.
    if (err?.code !== '42P01') console.error('waitlist notify: lookup failed', err);
    return out;
  }

  for (const row of rows) {
    const refId = `waitlist_back_in_stock:${row.waitlist_id}`;
    try {
      // Claim the audit row first — the unique (source, reference_id) index makes this the
      // idempotency gate: rowCount 0 ⇒ already handled ⇒ skip.
      const claim = await client.query(
        `INSERT INTO integration_sync_log (source, direction, event_type, reference_id, status, payload)
         VALUES ('podium', 'outbound', 'waitlist.back_in_stock', $1, 'pending', $2)
         ON CONFLICT (source, reference_id) WHERE reference_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [refId, JSON.stringify({
          waitlist_id: row.waitlist_id,
          customer_id: row.customer_id,
          sku: row.product_sku,
          collection_id: collectionId,
        })]
      );
      if (!claim.rowCount) { out.skipped += 1; continue; }
      const logId = claim.rows[0].id;

      const phone = (row.customer_phone || '').toString().trim();
      if (!phone) {
        await client.query(`UPDATE integration_sync_log SET status = 'skipped', error = 'no phone on customer' WHERE id = $1`, [logId]);
        out.skipped += 1;
        continue;
      }

      await sendSms({ to: phone, body: backInStockMessage(row.product_name) });

      // Mark sent + retire the waitlist row so it never re-fires.
      await client.query(`UPDATE integration_sync_log SET status = 'sent' WHERE id = $1`, [logId]);
      await client.query(`UPDATE waitlist SET status = 'Notified' WHERE waitlist_id = $1 AND status = 'Active'`, [row.waitlist_id]);
      out.notified += 1;
    } catch (err) {
      out.failed += 1;
      console.error(`waitlist notify: send failed for waitlist ${row.waitlist_id}`, err);
      try {
        await client.query(
          `UPDATE integration_sync_log SET status = 'failed', error = $2
            WHERE source = 'podium' AND reference_id = $1`,
          [refId, String(err?.message || err).slice(0, 500)]
        );
      } catch { /* best-effort audit; ignore */ }
    }
  }
  return out;
}
