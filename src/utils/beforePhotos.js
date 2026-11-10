// G27 (owner, 10 Nov 2026) — shared bits of before-refurbishment photos (per lot). Pure and
// JSX-free (the smoke loads it in node). Mirrors lib/beforePhotos.js; the server decides.

/** Is the lot on a workorder item (tagged as sold)? Same rule as the server's isPlaced. */
export function isPlaced(lot) {
  return lot?.status === 'Assigned' && lot.workorder_items_id != null && lot.workorder_id != null;
}

/** "Before photos (3)" — the button label on the workorder lot row. */
export function beforePhotosLabel(count) {
  const n = Number(count) || 0;
  return n ? `Before photos (${n})` : 'Before photos';
}
