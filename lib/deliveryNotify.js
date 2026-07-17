// lib/deliveryNotify.js — Delivery-booked SMS (feature F8b).
//
// When a delivery is booked, the customer is texted from the SHARED Grays number (P9) that
// their order is booked — with the delivery date when there is one (execution-plan §F8b).
//
// ⚠️ CONFIRMED BY A HUMAN, NOT AUTOMATIC (Nick, 17 Jul 2026). This originally fired
// automatically the moment a delivery hit "Booked for Delivery". It no longer does:
// booking now RETURNS a preview, the logistics user reads the exact text, and explicitly
// sends or declines it. Nothing reaches a customer without someone clicking Send.
//
//   previewDeliveryBookedSms()  — read-only; what the confirmation panel shows. Never sends.
//   notifyDeliveryBooked()      — the confirmed send ("Send text").
//   declineDeliveryBookedSms()  — the recorded decline ("Don't send").
//
// Design:
//  - BEST-EFFORT / NON-BLOCKING: never throws. A Podium/SMS failure can't undo the booking
//    (the booking transaction has already committed by the time any of this runs).
//  - AT-MOST-ONCE: each delivery is claimed via an integration_sync_log row (reference_id
//    `delivery_booked:<delivery_id>` on uq_sync_ref). The gate is deliberately "was it
//    SENT", not "was it claimed" — a DECLINED text was never sent, so it can still be sent
//    later, while a row already marked 'sent' can never be reopened. That's what makes the
//    confirmation panel safe: a double-click or a second confirm cannot double-text.
//  - P1: only envelope metadata (delivery_id / customer_id / invoice_id) is logged, never
//    the rendered SMS body.
//  - Mock-first via sendSystemSms (short-circuits to the Podium mock when PODIUM_MOCK=true).

import { sendSystemSms } from './podium.js';

// The one place the claim/reclaim is expressed. ON CONFLICT ... DO UPDATE ... WHERE
// status <> 'sent' is the atomic gate: rowCount 0 ⇒ already sent ⇒ refuse.
const CLAIM_SQL = `
  INSERT INTO integration_sync_log (source, direction, event_type, reference_id, status, payload)
  VALUES ('podium', 'outbound', 'delivery.booked', $1, 'pending', $2)
  ON CONFLICT (source, reference_id) WHERE reference_id IS NOT NULL
  DO UPDATE SET status = 'pending', error = NULL
  WHERE integration_sync_log.status <> 'sent'
  RETURNING id`;

const DELIVERY_SELECT = `
  SELECT d.delivery_id, d.customer_id, d.invoice_id, d.delivery_status,
         to_char(d.delivery_date, 'DD Mon YYYY') AS delivery_date,
         c.name AS customer_name, c.phone AS customer_phone
    FROM delivery d
    JOIN customers c ON c.id = d.customer_id
   WHERE d.delivery_id = $1`;

/** Load the delivery + customer for a booking text. Returns null on any problem. */
async function loadBooking(client, deliveryId) {
  const id = Number(deliveryId);
  if (!Number.isFinite(id)) return null;
  try {
    const r = await client.query(DELIVERY_SELECT, [id]);
    return r.rows[0] || null;
  } catch (err) {
    if (err?.code !== '42P01') console.error('delivery notify: lookup failed', err);
    return null;
  }
}

/**
 * What the confirmation panel shows before anything is sent. READ-ONLY: it must never
 * claim or send, because the whole point is that the human decides afterwards.
 * @returns {Promise<{eligible:boolean, delivery_id?:number, customer_name?:string,
 *                    to?:string, body?:string, reason?:string}>}
 */
export async function previewDeliveryBookedSms(client, deliveryId) {
  const row = await loadBooking(client, deliveryId);
  if (!row) return { eligible: false, reason: 'Delivery not found' };
  if (row.delivery_status !== 'Booked for Delivery') {
    return { eligible: false, reason: `Delivery is ${row.delivery_status}, not booked` };
  }
  const to = (row.customer_phone || '').toString().trim();
  if (!to) {
    return { eligible: false, customer_name: row.customer_name, reason: 'No phone number on this customer' };
  }
  return {
    eligible: true,
    delivery_id: row.delivery_id,
    customer_name: row.customer_name,
    to,
    body: deliveryBookedMessage({ invoiceId: row.invoice_id, deliveryDate: row.delivery_date }),
  };
}

/**
 * "Don't send" — record that a human declined the text. Nothing is sent. Audited (and
 * attributed) so the Integrations log shows the text was a decision, not a failure.
 * Because the claim gate is "was it sent", a declined text can still be sent later.
 */
export async function declineDeliveryBookedSms(client, deliveryId, opts = {}) {
  const { actorId } = opts;
  const out = { notified: 0, skipped: 0, failed: 0 };
  const row = await loadBooking(client, deliveryId);
  if (!row) return out;

  try {
    const claim = await client.query(CLAIM_SQL, [
      `delivery_booked:${row.delivery_id}`,
      JSON.stringify({ delivery_id: row.delivery_id, customer_id: row.customer_id, invoice_id: row.invoice_id }),
    ]);
    if (!claim.rowCount) { out.skipped += 1; return out; } // already sent — nothing to decline
    await client.query(
      `UPDATE integration_sync_log SET status = 'skipped', error = $1 WHERE id = $2`,
      [`declined by ${actorId || 'unknown'}`, claim.rows[0].id]
    );
    out.skipped += 1;
  } catch (err) {
    console.error(`delivery notify: recording decline failed for delivery ${deliveryId}`, err);
  }
  return out;
}

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
 * Send the booking text — the CONFIRMED send, i.e. a human clicked "Send text" on the
 * confirmation panel. Best-effort — NEVER throws.
 * @param {object} client     an OPEN pg client (used post-commit; each statement autocommits)
 * @param {number} deliveryId the booked delivery
 * @param {object} [opts]     { send, actorId } — send lets the smoke inject a fake sender
 * @returns {Promise<{notified:number, skipped:number, failed:number, alreadySent?:boolean}>}
 */
export async function notifyDeliveryBooked(client, deliveryId, opts = {}) {
  const { send } = opts;
  const sendSms = send || sendSystemSms;
  const out = { notified: 0, skipped: 0, failed: 0 };

  const row = await loadBooking(client, deliveryId);
  if (!row) return out;
  // Defensive: only text for an actually-booked delivery.
  if (row.delivery_status !== 'Booked for Delivery') { out.skipped += 1; return out; }

  const refId = `delivery_booked:${row.delivery_id}`;
  let logId = null;
  let sent = false;
  try {
    // Claim (or reclaim a declined/failed row). rowCount 0 ⇒ already 'sent' ⇒ refuse:
    // this is what stops a double-click on the panel from double-texting.
    const claim = await client.query(CLAIM_SQL, [
      refId,
      JSON.stringify({
        delivery_id: row.delivery_id,
        customer_id: row.customer_id,
        invoice_id: row.invoice_id,
      }),
    ]);
    if (!claim.rowCount) { out.skipped += 1; out.alreadySent = true; return out; }
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
      console.error(`delivery notify: post-send bookkeeping failed for delivery ${row.delivery_id}`, err);
    } else {
      out.failed += 1;
      console.error(`delivery notify: send failed for delivery ${row.delivery_id}`, err);
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
