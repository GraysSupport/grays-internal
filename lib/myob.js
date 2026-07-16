// lib/myob.js — MYOB seam for the funnel Quote → Payment → Workorder steps (F7).
//
// The funnel is shaped around the real "MYOB in the middle" workflow (execution-plan
// §1c / §5 P6): a salesperson raises a Quote/Invoice in MYOB (step 3), the customer
// pays (step 4), and logistics creates the workorder from the confirmed payment (step 5).
// MYOB itself is a LATER phase — for now every MYOB call is a **stub behind the
// `FEATURE_MYOB` flag** (default off). With the flag off, the rep records the invoice
// number they raised in MYOB by hand; with it on (future), `createInvoice()` will call
// MYOB and return the number automatically (the eventual one-click chat → invoice).
//
// Keeping the seam isolated here means the live swap is a single-file change: implement
// the real MYOB AccountRight/Business API calls, flip `FEATURE_MYOB=true`, and every
// caller (F7a raise-quote, F7c confirm-payment) picks it up with no other change.

/** True only when the MYOB integration is explicitly enabled. Default: off (stub mode). */
export function isMyobEnabled() {
  return String(process.env.FEATURE_MYOB).toLowerCase() === 'true';
}

/** Thrown when a MYOB call is attempted while the integration is disabled. Callers catch
 *  this and fall back to the manual path (rep supplies the invoice number). */
export class MyobDisabledError extends Error {
  constructor(message = 'MYOB integration is disabled (FEATURE_MYOB=false)') {
    super(message);
    this.name = 'MyobDisabledError';
    this.code = 'MYOB_DISABLED';
  }
}

/**
 * Raise a Quote/Invoice in MYOB and return its invoice number (step 3).
 *
 * STUB: while `FEATURE_MYOB` is off this throws `MyobDisabledError` so the caller uses
 * the manual invoice number the rep typed. The live implementation (a later phase) will
 * POST to the MYOB API using `details` (customer, line items / order total) and return
 * `{ invoiceId, orderTotal }`.
 *
 * @param {object} [details] - { customerId?, orderTotal?, valueEst?, productInterest? }
 * @returns {Promise<{ invoiceId: string, orderTotal: number|null }>}
 */
export async function createInvoice(details = {}) {
  if (!isMyobEnabled()) {
    throw new MyobDisabledError();
  }
  // FUTURE (MYOB phase): call the MYOB API here and return the real invoice number.
  // e.g. const inv = await myobClient.createSaleInvoice({ ... }); return { invoiceId: inv.Number, orderTotal: inv.TotalAmount };
  void details;
  throw new Error('MYOB live integration is not yet implemented');
}
