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

// ---- Chunked upload (Microsoft Graph upload-session protocol) ----

/** code: 'network' | 'refused' | 'expired' | 'maybe-committed' | 'aborted' */
export class UploadError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Waits between failed attempts: warehouse signal drops for 10–30 s at a time (Phase 2 review).
const BACKOFF_MS = [2000, 4000, 8000, 16000, 30000, 30000];
const CHUNK_TIMEOUT_MS = 2 * 60 * 1000; // a stalled connection fails instead of hanging forever
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
function defaultWaitOnline(signal) {
  if (typeof navigator === 'undefined' || navigator.onLine !== false) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { window.removeEventListener('online', done); signal?.removeEventListener('abort', done); resolve(); };
    window.addEventListener('online', done);
    signal?.addEventListener('abort', done);
  });
}

/** Run `fn(innerSignal)` with a timeout, aborting early if `outer` aborts. */
async function withTimeout(outer, ms, fn) {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  outer?.addEventListener('abort', onAbort);
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fn(ctl.signal);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onAbort);
  }
}

const nextFrom = (json) => {
  const n = Number(String(json?.nextExpectedRanges?.[0] ?? '').split('-')[0]);
  return Number.isFinite(n) && json?.nextExpectedRanges?.length ? n : null;
};

/**
 * PUT `file` to a SharePoint upload-session URL in chunks; resolves with the drive item.
 *
 * The URL is pre-authorised — NO Authorization header (Graph rejects one). After any failure
 * (dropped connection, timeout, 5xx, 429, a range conflict) it ASKS SharePoint where it got to
 * (GET uploadUrl → nextExpectedRanges) and carries on from there, rather than re-sending a chunk
 * SharePoint may already have. If the session is gone after the final chunk was sent, the file
 * was probably committed and only its reply was lost → UploadError('maybe-committed'): the caller
 * records it by the name upload-session gave it. `resume: true` starts by asking (Retry);
 * `finalSent` says an earlier attempt already sent the last chunk, `onFinalSent` reports it.
 */
export async function uploadInChunks({
  file, uploadUrl, chunkBytes, fetch: doFetch = fetch, onProgress, sleep = defaultSleep,
  waitOnline = defaultWaitOnline, signal, resume = false, timeoutMs = CHUNK_TIMEOUT_MS,
  finalSent: sentBefore = false, onFinalSent,
}) {
  const total = file.size;
  const aborted = () => new UploadError('aborted', 'The upload was cancelled');
  let start = 0;
  let finalSent = sentBefore;
  let failures = 0;
  let stalls = 0;

  // Where SharePoint is: { gone: true } | { next } | null (couldn't ask).
  const status = async () => {
    try {
      const r = await withTimeout(signal, timeoutMs, (s) => doFetch(uploadUrl, { method: 'GET', headers: {}, signal: s }));
      if (r.status === 404) return { gone: true };
      if (!r.ok) return null;
      return { next: nextFrom(await r.json().catch(() => ({}))) };
    } catch {
      if (signal?.aborted) throw aborted();
      return null;
    }
  };
  const goneError = () => (finalSent
    ? new UploadError('maybe-committed', 'SharePoint may already have the file')
    : new UploadError('expired', 'The upload link expired — tap Retry to start again'));

  if (resume) {
    const st = await status();
    if (st?.gone) throw goneError();
    if (st?.next != null) start = st.next;
  }

  for (;;) {
    if (signal?.aborted) throw aborted();
    const from = start;
    const end = Math.min(from + chunkBytes, total) - 1;
    if (end === total - 1 && !finalSent) { finalSent = true; onFinalSent?.(); }
    let res = null;
    try {
      res = await withTimeout(signal, timeoutMs, (s) => doFetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Range': `bytes ${from}-${end}/${total}` },
        body: file.slice(from, end + 1),
        signal: s,
      }));
    } catch {
      if (signal?.aborted) throw aborted();
      res = null; // dropped connection or timeout
    }

    if (res && (res.status === 200 || res.status === 201)) {
      onProgress?.(1);
      return res.json().catch(() => ({}));
    }
    if (res && res.status === 202) {
      const next = nextFrom(await res.json().catch(() => ({})));
      const to = next ?? end + 1;
      stalls = to > start ? 0 : stalls + 1;
      if (stalls > BACKOFF_MS.length) throw new UploadError('refused', 'SharePoint stopped accepting the upload — tap Retry');
      start = to;
      failures = 0;
      onProgress?.(start / total);
      continue;
    }
    const retryable = !res || res.status >= 500 || [404, 408, 409, 416, 429].includes(res.status);
    if (!retryable) throw new UploadError('refused', `SharePoint refused the upload (HTTP ${res.status})`);

    const st = await status();
    if (st?.gone) throw goneError();
    if (st?.next != null && st.next > start) { start = st.next; failures = 0; onProgress?.(start / total); continue; }
    if (failures >= BACKOFF_MS.length) {
      throw res
        ? new UploadError('refused', `SharePoint kept refusing the upload (HTTP ${res.status}) — tap Retry`)
        : new UploadError('network', 'No connection — check the signal and tap Retry');
    }
    const retryAfter = res?.status === 429 ? Number(res.headers?.get?.('retry-after')) : NaN;
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : BACKOFF_MS[failures]);
    failures += 1;
    await waitOnline(signal);
    if (st?.next != null) start = st.next;
  }
}

// Uploaded to SharePoint but not yet recorded by the portal (the 1-hour login ran out between
// the upload and `complete`, or the connection dropped). Kept in this browser PER USER — shared
// tablets and the WK kiosk must not record one person's evidence under another's name — and
// recorded the next time that user opens any evidence panel. Entries older than PENDING_DAYS are
// dropped. endExpiredSession() removes only token/user/sessionExpiry, so this outlives it.
const PENDING_KEY = 'grays.dispatchEvidence.pending';
export const PENDING_DAYS = 7;

/** One id per file: the drive item id, or `name:<file_name>` when only the name is known. */
export const pendingKey = (p) => p.drive_item_id || `name:${p.file_name}`;

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
  const key = pendingKey(entry);
  writePending([...readPending().filter((p) => pendingKey(p) !== key), { saved_at: Date.now(), ...entry }]);
}
export function removePending(key) {
  writePending(readPending().filter((p) => pendingKey(p) !== key));
}
/** This user's entries still worth trying; quietly drops anyone's that are too old. */
export function pendingFor(userId, now = Date.now()) {
  const cutoff = now - PENDING_DAYS * 24 * 60 * 60 * 1000;
  const all = readPending();
  const fresh = all.filter((p) => !(Number(p.saved_at) < cutoff));
  if (fresh.length !== all.length) writePending(fresh);
  const me = String(userId || '').toUpperCase();
  return me ? fresh.filter((p) => String(p.user_id || '').toUpperCase() === me) : [];
}
