// lib/reviewNotify.js — Review-request automation (feature F8c).
//
// When a workorder is BOTH completed and paid in full, ask the customer for a Google
// review via Podium's review-invite API (execution-plan §F8c, §15.4
// `POST /v4/reviews/invites`). Podium composes and sends the invite itself — we only
// nominate the contact — so unlike F8a/F8b there is no SMS copy of ours to sign off.
//
// Design guarantees (mirrors the F8a waitlist pattern):
//  - BEST-EFFORT / NON-BLOCKING: runs AFTER the workorder transaction has committed and
//    NEVER throws — a Podium failure must never roll back or block a workorder update.
//  - IDEMPOTENT / AT-MOST-ONCE: each workorder is claimed once via an integration_sync_log
//    row with a unique reference_id (ON CONFLICT DO NOTHING on uq_sync_ref), so a customer
//    is never invited twice for the same order however many times the workorder is edited.
//  - ELIGIBILITY IS RE-CHECKED FROM THE DB, and an INELIGIBLE workorder is never claimed —
//    the claim would otherwise poison the later, genuine completed+paid moment.
//  - P1: only ENVELOPE metadata (workorder/customer/contact ids) is logged.
//  - AT-MOST-ONCE, so an invite that fails outright is NOT auto-retried: the claim row
//    persists with status 'failed'. That is the safer default for customer contact, but a
//    review invite matters more to the business than a convenience SMS — if the failure
//    rate ever justifies it, a sweeper over status IN ('pending','failed') is the escape
//    hatch (same trade-off as, and deliberately consistent with, F8a).
//  - Mock-first: requestReview() short-circuits to the typed Podium mock when
//    PODIUM_MOCK=true, so nothing actually sends until creds + PODIUM_MOCK=false.

import { requestReview } from './podium.js';

/**
 * Ask for a review if (and only if) the workorder is completed AND fully paid.
 *
 * Called from both edges of that condition — the workorder completing, and the balance
 * reaching zero — because the canonical Grays flow pays the balance in full AFTER the
 * workshop finishes and BEFORE dispatch, so "paid" is usually the LAST of the two to
 * land. Whichever edge fires, the shared claim key keeps it at-most-once.
 *
 * @param {object} client       an OPEN pg client (used post-commit; statements autocommit)
 * @param {number|string} workorderId
 * @param {object} [opts]       { send } — send lets the smoke inject a fake sender
 * @returns {Promise<{notified:number, skipped:number, failed:number}>}
 */
export async function notifyReviewRequest(client, workorderId, opts = {}) {
  const { send } = opts;
  const sendInvite = send || ((payload) => requestReview(null, payload));
  const out = { notified: 0, skipped: 0, failed: 0 };

  if (!workorderId) return out;

  // Re-read the authoritative state post-commit: the request that triggered us may have
  // changed the status, the balance, or neither.
  let row = null;
  try {
    const r = await client.query(
      `SELECT wo.workorder_id, wo.status, wo.outstanding_balance, wo.customer_id,
              c.phone AS customer_phone,
              c.podium_contact_id
         FROM workorder wo
         JOIN customers c ON c.id = wo.customer_id
        WHERE wo.workorder_id = $1`,
      [workorderId]
    );
    row = r.rowCount ? r.rows[0] : null;
  } catch (err) {
    // workorder/customers absent (bare DB) or any query error — degrade silently.
    if (err?.code !== '42P01') console.error('review notify: lookup failed', err);
    return out;
  }
  if (!row) return out;

  // Eligibility. Deliberately NOT claimed when ineligible — an early claim would block the
  // genuine invite later (e.g. completed today, balance paid tomorrow).
  // `<= 0` so an overpayment/credit still counts as nothing-owing; the explicit null guard
  // is defence in depth (the column is NOT NULL today, but Number(null) is 0, which would
  // read as "paid in full" and burn the one claim we get).
  const completed = String(row.status) === 'Completed';
  const paid = row.outstanding_balance != null && Number(row.outstanding_balance) <= 0;
  if (!completed || !paid) return out;

  const refId = `review_request:${row.workorder_id}`;
  let logId = null;
  let sent = false;
  try {
    // Claim the audit row first — the unique (source, reference_id) index makes this the
    // idempotency gate: rowCount 0 ⇒ already invited ⇒ skip.
    const claim = await client.query(
      `INSERT INTO integration_sync_log (source, direction, event_type, reference_id, status, payload)
       VALUES ('podium', 'outbound', 'workorder.review_request', $1, 'pending', $2)
       ON CONFLICT (source, reference_id) WHERE reference_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [refId, JSON.stringify({
        workorder_id: row.workorder_id,
        customer_id: row.customer_id,
        contact_uid: row.podium_contact_id || null,
      })]
    );
    if (!claim.rowCount) { out.skipped += 1; return out; }
    logId = claim.rows[0].id;

    // Podium needs someone to invite: the linked contact (F4 bridge) is the durable
    // reference; a raw phone number is the fallback for an unbridged customer.
    const contactUid = (row.podium_contact_id || '').toString().trim();
    const phone = (row.customer_phone || '').toString().trim();
    if (!contactUid && !phone) {
      await client.query(
        `UPDATE integration_sync_log SET status = 'skipped', error = 'no podium contact or phone on customer' WHERE id = $1`,
        [logId]
      );
      out.skipped += 1;
      return out;
    }

    await sendInvite(contactUid ? { contactUid } : { channel: phone });
    sent = true; // past this point the invite is away — never relabel it 'failed'.

    await client.query(`UPDATE integration_sync_log SET status = 'sent' WHERE id = $1`, [logId]);
    out.notified += 1;
  } catch (err) {
    if (sent) {
      // The invite DID go out; only the post-send bookkeeping failed. Count it notified and
      // keep the audit honest — the claim row still blocks any re-send (at-most-once).
      out.notified += 1;
      console.error(`review notify: post-send bookkeeping failed for workorder ${row.workorder_id}`, err);
    } else {
      out.failed += 1;
      console.error(`review notify: invite failed for workorder ${row.workorder_id}`, err);
      if (logId) {
        try {
          await client.query(
            `UPDATE integration_sync_log SET status = 'failed', error = $1 WHERE id = $2`,
            [String(err?.message || err).slice(0, 500), logId]
          );
        } catch { /* best-effort audit; ignore */ }
      }
    }
  }
  return out;
}
