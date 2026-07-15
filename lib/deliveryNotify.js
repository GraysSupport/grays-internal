// lib/deliveryNotify.js — Delivery-booked SMS automation (feature F8b).
//
// When a delivery transitions INTO "Booked for Delivery" (delivery.js POST-as-booked or
// PUT status change), the customer is texted from the SHARED Grays number (P9) that their
// order is booked — with the delivery date when there is one. Automates a manual step
// (execution-plan §F8b). Same design as F8a's waitlist notifier:
//  - BEST-EFFORT / NON-BLOCKING: called AFTER the delivery transaction commits and NEVER
//    throws, so a Podium/SMS failure can't undo or block the booking.
//  - IDEMPOTENT / at-most-once: each delivery is claimed once via an integration_sync_log
//    row (reference_id `delivery_booked:<delivery_id>`, ON CONFLICT DO NOTHING on
//    uq_sync_ref). No `notified` column exists on delivery, so the claim IS the sole gate
//    — a re-book after an un-book won't re-text (acceptable; never double-text a customer).
//  - P1: only envelope metadata (delivery_id / customer_id / invoice_id) is logged, never
//    the rendered SMS body.
//  - Mock-first via sendSystemSms (short-circuits to the Podium mock when PODIUM_MOCK=true).

import { sendSystemSms } from './podium.js';

/**
 * Customer-facing SMS copy. On brand: phone 1300 769 556 primary; no "used / second-hand".
 * With a date it names the delivery date; without one (e.g. Customer Collect / date TBC) it
 * says we'll be in touch. Copy is a default — flagged for human sign-off before live send.
 */
export function deliveryBookedMessage({ invoiceId, deliveryDate } = {}) {
  const inv = invoiceId ? ` (invoice ${invoiceId})` : '';
  if (deliveryDate && String(deliveryDate).trim()) {
    return `Good news from Grays Fitness! Your order${inv} is booked for delivery on ${deliveryDate}. Questions? Call 1300 769 556.`;
  }
  return `Good news from Grays Fitness! Your order${inv} is booked — we'll be in touch to arrange your delivery. Questions? Call 1300 769 556.`;
}

/**
 * Text the customer that their delivery is booked. Best-effort — NEVER throws.
 * @param {object} client     an OPEN pg client (used post-commit; each statement autocommits)
 * @param {number} deliveryId the delivery that just became "Booked for Delivery"
 * @param {object} [opts]     { send } — lets the smoke inject a fake sender
 * @returns {Promise<{notified:number, skipped:number, failed:number}>}
 */
export async function notifyDeliveryBooked(client, deliveryId, opts = {}) {
  const { send } = opts;
  const sendSms = send || sendSystemSms;
  const out = { notified: 0, skipped: 0, failed: 0 };

  const id = Number(deliveryId);
  if (!Number.isFinite(id)) return out;

  // The delivery + its customer's phone + a formatted date.
  let row = null;
  try {
    const r = await client.query(
      `SELECT d.delivery_id, d.customer_id, d.invoice_id, d.delivery_status,
              to_char(d.delivery_date, 'DD Mon YYYY') AS delivery_date,
              c.name AS customer_name, c.phone AS customer_phone
         FROM delivery d
         JOIN customers c ON c.id = d.customer_id
        WHERE d.delivery_id = $1`,
      [id]
    );
    row = r.rows[0] || null;
  } catch (err) {
    if (err?.code !== '42P01') console.error('delivery notify: lookup failed', err);
    return out;
  }
  if (!row) return out;
  // Defensive: only text for an actually-booked delivery.
  if (row.delivery_status !== 'Booked for Delivery') { out.skipped += 1; return out; }

  const refId = `delivery_booked:${row.delivery_id}`;
  let logId = null;
  let sent = false;
  try {
    // Claim once — the unique (source, reference_id) index gates re-sends (at-most-once).
    const claim = await client.query(
      `INSERT INTO integration_sync_log (source, direction, event_type, reference_id, status, payload)
       VALUES ('podium', 'outbound', 'delivery.booked', $1, 'pending', $2)
       ON CONFLICT (source, reference_id) WHERE reference_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [refId, JSON.stringify({
        delivery_id: row.delivery_id,
        customer_id: row.customer_id,
        invoice_id: row.invoice_id,
      })]
    );
    if (!claim.rowCount) { out.skipped += 1; return out; }
    logId = claim.rows[0].id;

    const phone = (row.customer_phone || '').toString().trim();
    if (!phone) {
      await client.query(`UPDATE integration_sync_log SET status = 'skipped', error = 'no phone on customer' WHERE id = $1`, [logId]);
      out.skipped += 1;
      return out;
    }

    await sendSms({ to: phone, body: deliveryBookedMessage({ invoiceId: row.invoice_id, deliveryDate: row.delivery_date }) });
    sent = true; // SMS is away — never relabel 'failed' past here.

    await client.query(`UPDATE integration_sync_log SET status = 'sent' WHERE id = $1`, [logId]);
    out.notified += 1;
  } catch (err) {
    if (sent) {
      out.notified += 1;
      console.error(`delivery notify: post-send bookkeeping failed for delivery ${id}`, err);
    } else {
      out.failed += 1;
      console.error(`delivery notify: send failed for delivery ${id}`, err);
      if (logId) {
        try {
          await client.query(`UPDATE integration_sync_log SET status = 'failed', error = $1 WHERE id = $2`,
            [String(err?.message || err).slice(0, 500), logId]);
        } catch { /* best-effort audit; ignore */ }
      }
    }
  }
  return out;
}
