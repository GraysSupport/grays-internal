// src/utils/activityLine.js — one Activity Log row on the workorder page.
//
// G25 (17 Nov 2026): website-stock entries carry their whole message in notes_log ("which SKU,
// what happened"). The log used to print notes_log for manual notes only, so these rows read
// as a bare "WEBSITE_STOCK_SYNC - WB". Lines GS must act on are tone 'warn'.

const NEEDS_HUMAN = /NOT updated|update by hand|check the stock by hand|failed|didn't confirm/i;

export function activityLine(l) {
  if (l.event_type === 'NOTE_ADDED' && (l.notes_log || '').trim()) {
    return { text: `${l.ts}   NOTE_ADDED - ${l.user_id}`, note: l.notes_log, tone: 'normal' };
  }
  if (l.event_type === 'WEBSITE_STOCK_SYNC') {
    const msg = (l.notes_log || '').trim();
    return {
      text: `${l.ts}   Website stock - ${l.user_id}${msg ? `: ${msg}` : ''}`,
      tone: NEEDS_HUMAN.test(msg) ? 'warn' : 'normal',
    };
  }
  const text = l.workorder_items_id
    ? `${l.ts}   ${l.product_name ?? '(Item)'} — ${l.event_type}${l.current_item_status ? `: ${l.current_item_status}` : ''} - ${l.user_id}`
    : `${l.ts}   ${l.event_type} - ${l.user_id}`;
  return { text, tone: 'normal' };
}
