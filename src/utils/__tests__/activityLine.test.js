import { activityLine } from '../activityLine';

// G25 (owner, 17 Nov 2026): on workorder 755 the website-stock lines showed only
// "WEBSITE_STOCK_SYNC - WB" — the note saying which SKU and what happened was dropped,
// because the Activity Log printed notes_log for manual notes only.

const base = { id: 1, ts: '17-Nov-2026 12:52:39', user_id: 'WB' };

test('a website-stock entry shows its note (which SKU and what happened)', () => {
  const r = activityLine({ ...base, event_type: 'WEBSITE_STOCK_SYNC', notes_log: 'Website stock updated automatically: FW-129 3 → 2' });
  expect(r.text).toBe('17-Nov-2026 12:52:39   Website stock - WB: Website stock updated automatically: FW-129 3 → 2');
  expect(r.tone).toBe('normal');
});

test('an item GS must update by hand is flagged', () => {
  const r = activityLine({ ...base, event_type: 'WEBSITE_STOCK_SYNC', notes_log: 'Website stock NOT updated for G25-NOWEB: SKU not on the website — update by hand' });
  expect(r.text).toContain('G25-NOWEB: SKU not on the website — update by hand');
  expect(r.tone).toBe('warn');
});

test.each([
  ['Website stock update failed for FW-129: Website returned 503 — will retry'],
  ["Website stock for FW-129: The website didn't confirm the change (Website timed out) — check the stock by hand"],
])('failures are flagged too: %s', (note) => {
  expect(activityLine({ ...base, event_type: 'WEBSITE_STOCK_SYNC', notes_log: note }).tone).toBe('warn');
});

test('a manual note keeps its existing look', () => {
  const r = activityLine({ ...base, user_id: 'GS', event_type: 'NOTE_ADDED', notes_log: 'Call before delivery' });
  expect(r.note).toBe('Call before delivery');
  expect(r.text).toBe('17-Nov-2026 12:52:39   NOTE_ADDED - GS');
});

test('item and workorder events are unchanged', () => {
  expect(activityLine({ ...base, user_id: 'GS', event_type: 'ITEM_STATUS_CHANGED', workorder_items_id: 9, product_name: 'Stepmill', current_item_status: 'In Workshop' }).text)
    .toBe('17-Nov-2026 12:52:39   Stepmill — ITEM_STATUS_CHANGED: In Workshop - GS');
  expect(activityLine({ ...base, user_id: 'GS', event_type: 'WORKORDER_CREATED' }).text)
    .toBe('17-Nov-2026 12:52:39   WORKORDER_CREATED - GS');
});
