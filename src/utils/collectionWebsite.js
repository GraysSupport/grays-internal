// src/utils/collectionWebsite.js — G25e2: wording for the collection page's "Apply Stock to
// Website" dialog. The data comes from GET /api/collections?resource=website&id= (superadmin
// incl. GS + the marketing lead only).

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The confirmation before anything is sent (item count + total quantity). */
export function sendConfirmText({ items, units, dryRun = false }) {
  const what = `${plural(items, 'item', 'items')} (${plural(units, 'unit', 'units')})`;
  if (dryRun) return `Dry run: record ${what} as "would send" — nothing is written to the website?`;
  return `Send ${what} to the website?`;
}

/** E-D5: any status is allowed, with a warning before Completed. */
export function notCompletedWarning(status) {
  if (status === 'Completed') return null;
  return `This collection is not Completed yet (status: ${status || 'unknown'}). You can still send it, e.g. to list stock before it arrives.`;
}

/** E-D7: the reminder next to "Apply Stock & Cost". */
export function reminderText(n) {
  const k = Number(n) || 0;
  if (k <= 0) return null;
  return `${plural(k, 'item', 'items')} not on the website yet`;
}

export function canTick(item) {
  return item?.state === 'ok' && Number(item?.remaining) > 0;
}
