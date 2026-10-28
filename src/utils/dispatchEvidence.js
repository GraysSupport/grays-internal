// G18 (owner, 28 Oct 2026) — shared bits of dispatch evidence: photos + videos of each workorder
// item, saved to the SharePoint shared drive. Pure and JSX-free (the smoke loads it in node).
// Mirrors lib/dispatchEvidence.js — scripts/ops-dispatch-evidence-smoke.mjs pins the two equal.
// The server is the real authority on every rule here; these only decide what to show.

import { hasAnyRole } from './auth.js';

export const EVIDENCE_UPLOAD_ROLES = ['logistics', 'admin', 'superadmin', 'technician', 'workshop'];
export const EVIDENCE_DELETE_ROLES = ['superadmin'];
export const WORKSHOP_ACCOUNT_ID = 'WK';
export const MAX_FILE_BYTES = 300 * 1024 * 1024;
export const ALLOWED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'mp4', 'mov', 'm4v'];
// "OTHER equipment doesn't require any evidence pictures" (owner, 28 Oct 2026).
export const NO_EVIDENCE_SKUS = ['OTHER'];

export function isAllowedFileName(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name ?? ''));
  return !!m && ALLOWED_EXTENSIONS.includes(m[1].toLowerCase());
}

export function needsEvidence(item) {
  return !NO_EVIDENCE_SKUS.includes(String(item?.product_id ?? '').trim().toUpperCase());
}

export function canUploadEvidence(user, roles) {
  if (String(user?.id || '').toUpperCase() === WORKSHOP_ACCOUNT_ID) return true;
  return hasAnyRole(roles, EVIDENCE_UPLOAD_ROLES);
}

export function formatBytes(n) {
  const b = Number(n) || 0;
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(b / 1024))} KB`;
}

const RETRIES = 3; // per chunk, on a dropped connection or a SharePoint 5xx
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * PUT `file` to a SharePoint upload-session URL in chunks. The URL is pre-authorised: NO
 * Authorization header (Graph rejects one). Each chunk is retried RETRIES times with a short
 * back-off. Resolves with the created drive item ({ id, name, … }).
 */
export async function uploadInChunks({ file, uploadUrl, chunkBytes, fetch: doFetch = fetch, onProgress, sleep = defaultSleep, signal }) {
  const total = file.size;
  let start = 0;
  while (start < total) {
    const end = Math.min(start + chunkBytes, total) - 1;
    let res = null;
    for (let attempt = 0; ; attempt += 1) {
      try {
        res = await doFetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Range': `bytes ${start}-${end}/${total}` },
          body: file.slice(start, end + 1),
          signal,
        });
        if (res.status < 500) break;
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        res = null;
      }
      if (attempt >= RETRIES) {
        throw new Error(res ? `SharePoint refused the upload (HTTP ${res.status})` : 'The connection dropped during the upload');
      }
      await sleep(1000 * (attempt + 1));
    }
    const json = await res.json().catch(() => ({}));
    if (res.status === 200 || res.status === 201) {
      onProgress?.(1);
      return json;
    }
    if (res.status !== 202) {
      throw new Error(res.status === 404 ? 'The upload link expired — try again' : `SharePoint refused the upload (HTTP ${res.status})`);
    }
    // Continue from where SharePoint says it is (normally end + 1).
    const next = Number(String(json?.nextExpectedRanges?.[0] ?? '').split('-')[0]);
    start = Number.isFinite(next) && next > start ? next : end + 1;
    onProgress?.(start / total);
  }
  throw new Error('The upload finished without SharePoint confirming the file');
}

// Uploaded to SharePoint but not yet recorded by the portal (the 1-hour login ran out between
// the upload and `complete`). Kept in this browser and recorded the next time the panel opens.
// endExpiredSession() removes only token/user/sessionExpiry, so this outlives it.
const PENDING_KEY = 'grays.dispatchEvidence.pending';

export function readPending() {
  try {
    const v = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function writePending(list) {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(list)); } catch { /* storage full / blocked */ }
}
export function addPending(entry) {
  writePending([...readPending().filter((p) => p.drive_item_id !== entry.drive_item_id), entry]);
}
export function removePending(driveItemId) {
  writePending(readPending().filter((p) => p.drive_item_id !== driveItemId));
}
