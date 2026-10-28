// G18 (owner, 28 Oct 2026) — "Dispatch evidence": photos and videos of each workorder item,
// saved to the SharePoint shared drive in a folder per workorder (named after the invoice) and a
// sub-folder per item. Used on the workorder page, in the Lot Tracker (read-only, one item) and,
// through DispatchEvidenceButton, on the To-Be-Booked and Schedule tabs.
//
// Files go from this browser STRAIGHT to SharePoint (a one-off upload link from the server), in
// 10 MB chunks that resume after a dropped connection, so big phone videos work on warehouse
// signal. One upload runs at a time. The portal then records each file ("complete").
// Optional (owner decision 4): no "no evidence yet" badge — on a page the panel hides itself when
// Microsoft isn't connected, the tables aren't migrated, or nothing needs evidence (OTHER items).
//
// Never lose a file that reached SharePoint: before recording it, it is kept in this browser for
// this user (utils/dispatchEvidence pending). If the 1-hour login runs out or the connection
// drops, it is recorded the next time this user opens any evidence panel. Retry after a failed
// record only records — it never sends the file again. Closing the dialog cancels uploads.

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Camera, ExternalLink, Film, FolderOpen, Image as ImageIcon, RotateCw, Trash2, X } from 'lucide-react';
import { authHeaders, getStoredUser } from '../utils/auth';
import { endExpiredSession, keepSessionAlive } from '../utils/session';
import {
  MAX_FILE_BYTES, isAllowedFileName, uploadInChunks, addPending, removePending, pendingFor, pendingKey, formatBytes,
} from '../utils/dispatchEvidence';

const BRAND_RED = '#B50B1D';
const NO_CONNECTION = 'No connection — check the signal and tap Retry';
const when = (iso) => {
  try {
    return new Intl.DateTimeFormat('en-AU', {
      timeZone: 'Australia/Melbourne', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return '';
  }
};
const isVideo = (name, mime) => /^video\//.test(mime || '') || /\.(mp4|mov|m4v)$/i.test(name || '');

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function api(resource, { method = 'GET', body, query = {} } = {}) {
  const qs = new URLSearchParams({ resource, ...query });
  let res;
  try {
    res = await fetch(`/api/evidence?${qs}`, {
      method,
      headers: authHeaders(body ? { 'Content-Type': 'application/json' } : {}),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError(NO_CONNECTION, 0);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(json?.error || `Request failed (HTTP ${res.status})`, res.status);
  return json;
}

// By name the size goes too: SharePoint renames on a clash, so the server checks it is this file.
const completeBody = (woId, itemId, { driveItemId, fileName, size }) => ({
  workorder_id: woId, workorder_items_id: itemId, ...(driveItemId ? { drive_item_id: driveItemId } : { file_name: fileName, size }),
});

// One "record the saved uploads" pass at a time per browser (StrictMode / two panels).
let flushing = null;

/** The workorder-header button (owner, 28 Oct 2026): once dispatched, open the evidence folder. */
export function EvidenceFolderLink({ info }) {
  if (!info?.dispatched || !info?.folder_url) return null;
  return (
    <a
      href={info.folder_url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex min-h-[44px] items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-white hover:opacity-90"
      style={{ backgroundColor: BRAND_RED }}
    >
      <FolderOpen size={16} aria-hidden="true" /> Open dispatch evidence folder
    </a>
  );
}

let nextKey = 1;

export default function DispatchEvidencePanel({ workorderId, onChanged, onBusyChange, itemId, readOnly = false, inDialog = false }) {
  const navigate = useNavigate();
  const woId = Number(workorderId);
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [, setTick] = useState(0);
  const jobs = useRef([]); // live upload jobs (mutable: Retry must see what already happened)
  const queue = useRef(Promise.resolve());
  const abort = useRef(new AbortController());
  const mounted = useRef(true);
  const ended = useRef(false);
  const thumbsReloaded = useRef(false);
  const flushed = useRef(false);

  const rerender = useCallback(() => { if (mounted.current) setTick((t) => t + 1); }, []);
  const update = useCallback((job, patch) => { Object.assign(job, patch); rerender(); }, [rerender]);

  const expire = useCallback(() => {
    if (ended.current || !mounted.current) return;
    ended.current = true;
    endExpiredSession(navigate);
  }, [navigate]);

  const load = useCallback(async () => {
    try {
      const d = await api('list', { query: { workorder_id: String(woId) } });
      if (!mounted.current) return null;
      setData(d);
      setLoadError(null);
      return d;
    } catch (e) {
      if (e.status === 401) { expire(); return null; }
      if (mounted.current) setLoadError(e.message);
      return null;
    }
  }, [woId, expire]);

  // Record this user's saved uploads (any workorder) — only where they could upload in the
  // first place, so a viewer on a shared tablet never touches someone else's.
  const flushPending = useCallback(async () => {
    const me = getStoredUser()?.id;
    const mine = pendingFor(me);
    if (!mine.length) return;
    let recorded = 0;
    let here = false;
    for (const p of mine) {
      try {
        await api('complete', {
          method: 'POST',
          body: completeBody(Number(p.workorder_id), Number(p.workorder_items_id), { driveItemId: p.drive_item_id, fileName: p.file_name, size: p.size }),
        });
        removePending(pendingKey(p));
        recorded += 1;
        if (Number(p.workorder_id) === woId) here = true;
      } catch (e) {
        if (e.status === 401) { expire(); return; }
        if (e.status === 400 || e.status === 404) removePending(pendingKey(p)); // will never succeed
        // 403 / 5xx / no connection: keep it for next time.
      }
    }
    if (recorded && mounted.current) {
      setNotice(`${recorded} upload${recorded === 1 ? '' : 's'} saved before your login expired — recorded now.`);
      if (here) { await load(); onChanged?.(); }
    }
  }, [woId, expire, load, onChanged]);

  useEffect(() => {
    mounted.current = true;
    // A new controller per mount: StrictMode (dev) and a change of workorder run the cleanup below
    // and then mount again, and an aborted controller would leave every upload "waiting".
    abort.current = new AbortController();
    const ctl = abort.current;
    const live = jobs.current; // the same array for the panel's life (jobs are pushed into it)
    (async () => {
      const d = await load();
      if (d?.can_upload && !readOnly && !flushed.current) {
        flushed.current = true;
        flushing = (flushing || Promise.resolve()).then(flushPending).finally(() => { flushing = null; });
      }
    })();
    return () => {
      mounted.current = false;
      // Closing / leaving cancels uploads in flight, and tells SharePoint to drop their sessions.
      ctl.abort();
      for (const j of live) {
        if (j.status === 'uploading' && j.session?.url && !j.driveItemId) {
          fetch(j.session.url, { method: 'DELETE' }).catch(() => {});
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [woId]);

  const busy = jobs.current.some((j) => j.status === 'uploading' || j.status === 'queued');
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => {
    if (!busy) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);

  // One file. Each step is skipped when an earlier attempt already got that far.
  const process = useCallback(async (job) => {
    const signal = abort.current.signal;
    if (signal.aborted) return 'aborted';
    update(job, { status: 'uploading', error: null });
    keepSessionAlive();
    try {
      const fresh = job.session && Date.parse(job.session.expiresAt) > Date.now() + 60 * 1000;
      // The last chunk already went and the link is (nearly) gone: record it by name — re-uploading
      // would put a second copy in SharePoint.
      if (!job.driveItemId && !job.maybeName && job.finalSent && !fresh && job.session?.fileName) job.maybeName = job.session.fileName;
      if (!job.driveItemId && !job.maybeName) {
        let item = null;
        const progress = (p) => { keepSessionAlive(); update(job, { progress: p }); };
        const sent = () => { job.finalSent = true; };
        if (fresh) {
          try {
            item = await uploadInChunks({ file: job.file, uploadUrl: job.session.url, chunkBytes: job.session.chunk, onProgress: progress, signal, resume: true, finalSent: job.finalSent, onFinalSent: sent });
          } catch (e) {
            if (e.code !== 'expired') throw e;
            job.session = null;
          }
        }
        if (!item) {
          if (!job.session || !fresh) {
            const s = await api('upload-session', {
              method: 'POST',
              body: { workorder_id: woId, workorder_items_id: job.itemId, file_name: job.file.name, size: job.file.size },
            });
            job.session = { url: s.upload_url, expiresAt: s.expires_at, fileName: s.file_name, chunk: s.chunk_bytes };
            job.finalSent = false;
            item = await uploadInChunks({ file: job.file, uploadUrl: job.session.url, chunkBytes: job.session.chunk, onProgress: progress, signal, onFinalSent: sent });
          }
        }
        job.driveItemId = item.id;
      }
      update(job, { status: 'recording', progress: 1 });
      const ref = { driveItemId: job.driveItemId, fileName: job.maybeName, size: job.file.size };
      const entry = {
        workorder_id: woId, workorder_items_id: job.itemId, user_id: getStoredUser()?.id || null,
        ...(ref.driveItemId ? { drive_item_id: ref.driveItemId } : { file_name: ref.fileName, size: ref.size }),
      };
      addPending(entry);
      await api('complete', { method: 'POST', body: completeBody(woId, job.itemId, ref) });
      removePending(pendingKey(entry));
      update(job, { status: 'done' });
      return 'done';
    } catch (e) {
      if (e.code === 'aborted' || signal.aborted) return 'aborted';
      if (e.status === 401) { expire(); return 'expired'; }
      if (e.code === 'maybe-committed' && job.session?.fileName) {
        // The last chunk landed but its reply was lost: record it by the name it was given.
        job.maybeName = job.session.fileName;
        return process(job);
      }
      if (e.status === 400 && job.maybeName && !job.driveItemId) {
        // Looked up by name and SharePoint hasn't got it: it never arrived, so Retry sends it afresh.
        Object.assign(job, { maybeName: null, session: null, finalSent: false });
        update(job, { status: 'error', error: `${job.file.name} didn't reach SharePoint — tap Retry to send it again`, canRetry: true });
        return 'error';
      }
      const removedByServer = e.status === 400 && job.driveItemId;
      update(job, { status: 'error', error: e.message, canRetry: !removedByServer });
      return 'error';
    }
  }, [woId, update, expire]);

  const enqueue = useCallback((job) => {
    queue.current = queue.current.then(async () => {
      const r = await process(job);
      if (r === 'done' && mounted.current) { await load(); onChanged?.(); }
    });
  }, [process, load, onChanged]);

  const onPick = (pickedItemId) => (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = ''; // the same file can be picked again
    for (const file of files) {
      const job = { key: nextKey++, itemId: pickedItemId, file, progress: 0, status: 'queued', canRetry: false };
      if (!isAllowedFileName(file.name)) Object.assign(job, { status: 'error', error: `${file.name}: only photos and videos can be uploaded` });
      else if (file.size > MAX_FILE_BYTES) Object.assign(job, { status: 'error', error: `${file.name} is over 300 MB` });
      else if (!file.size) Object.assign(job, { status: 'error', error: `${file.name} is empty` });
      jobs.current.push(job);
      if (job.status === 'queued') enqueue(job);
    }
    rerender();
  };

  const retry = (job) => { update(job, { status: 'queued', error: null }); enqueue(job); };

  const remove = async (f) => {
    if (!window.confirm(`Delete ${f.file_name}? It goes to the SharePoint recycle bin.`)) return;
    setDeleting(f.id);
    try {
      await api('file', { method: 'DELETE', query: { id: String(f.id) } });
      await load();
      onChanged?.();
    } catch (e) {
      if (e.status === 401) return expire();
      setLoadError(e.message);
    } finally {
      if (mounted.current) setDeleting(null);
    }
  };

  // Graph thumbnail links are short-lived: if one has gone stale, fetch fresh ones once.
  const onThumbError = () => {
    if (thumbsReloaded.current) return;
    thumbsReloaded.current = true;
    load();
  };

  const say = (text) => (inDialog ? <p className="py-6 text-center text-sm text-gray-600">{text}</p> : null);
  if (!data) {
    if (loadError) {
      return (
        <div className={inDialog ? 'py-6 text-center' : 'mt-4'}>
          <p className="text-sm text-red-700">Dispatch evidence: {loadError}</p>
          <button type="button" onClick={load} className="mt-2 inline-flex min-h-[44px] items-center gap-1 rounded border px-3 text-sm hover:bg-gray-50">
            <RotateCw size={14} aria-hidden="true" /> Try again
          </button>
        </div>
      );
    }
    return say('Loading…');
  }
  if (!data.configured || !data.available) return say("Dispatch evidence isn't set up yet.");
  const items = (data.items || []).filter((i) => itemId == null || i.workorder_items_id === Number(itemId));
  if (readOnly && !items.some((i) => i.files.length)) return null; // Lot Tracker: nothing to show
  if (!items.length) return say('No items on this order need dispatch evidence.');
  const canUpload = data.can_upload && !readOnly;
  const canDelete = data.can_delete && !readOnly;

  return (
    <section aria-label="Dispatch evidence" className={inDialog ? 'mt-3' : 'mt-6 rounded-xl border bg-white p-3'}>
      {!inDialog && (
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-semibold">Dispatch evidence</h2>
          {data.folder_url && !readOnly && (
            <a href={data.folder_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-gray-700 underline">
              Open folder in SharePoint <ExternalLink size={14} aria-hidden="true" />
            </a>
          )}
        </div>
      )}
      {canUpload && <p className="mb-3 text-sm text-gray-600">Photos and videos of each item before it leaves. Up to 300 MB per file.</p>}
      {notice && <p className="mb-2 rounded border border-green-200 bg-green-50 p-2 text-sm text-green-800" role="status">{notice}</p>}
      {loadError && <p className="mb-2 text-sm text-red-700">{loadError}</p>}

      <ul className="space-y-3">
        {items.map((item) => {
          const mine = jobs.current.filter((j) => j.itemId === item.workorder_items_id && j.status !== 'done');
          return (
            <li key={item.workorder_items_id} className={readOnly ? '' : 'rounded-lg border p-3'}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                {!readOnly && <div className="font-medium">{item.label}</div>}
                {readOnly && item.folder_url && (
                  <a href={item.folder_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-gray-700 underline">
                    Open in SharePoint <ExternalLink size={14} aria-hidden="true" />
                  </a>
                )}
                {canUpload && (
                  <label
                    className="inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-white hover:opacity-90 focus-within:ring-2 focus-within:ring-offset-2"
                    style={{ backgroundColor: BRAND_RED }}
                  >
                    <Camera size={16} aria-hidden="true" /> Add photos / videos
                    <input
                      type="file"
                      accept="image/*,video/*"
                      multiple
                      className="sr-only"
                      aria-label={`Add photos or videos for ${item.label}`}
                      onChange={onPick(item.workorder_items_id)}
                    />
                  </label>
                )}
              </div>

              {item.files.length > 0 && (
                <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
                  {item.files.map((f) => (
                    <li key={f.id} className="text-xs text-gray-600">
                      <a href={f.web_url || undefined} target="_blank" rel="noreferrer" className="block aspect-square overflow-hidden rounded border bg-gray-50">
                        {f.thumbnail_url ? (
                          <img src={f.thumbnail_url} alt={f.file_name} className="h-full w-full object-cover" loading="lazy" onError={onThumbError} />
                        ) : (
                          <span className="flex h-full w-full items-center justify-center text-gray-500" title={f.file_name}>
                            {isVideo(f.file_name, f.mime_type) ? <Film size={28} aria-hidden="true" /> : <ImageIcon size={28} aria-hidden="true" />}
                          </span>
                        )}
                      </a>
                      <div className="mt-1 flex items-start justify-between gap-1">
                        <span>{f.uploaded_by_name || f.uploaded_by || '—'} · {when(f.uploaded_at)}{isVideo(f.file_name, f.mime_type) ? ' · video' : ''}</span>
                        {canDelete && (
                          <button
                            type="button"
                            aria-label={`Delete ${f.file_name}`}
                            disabled={deleting === f.id}
                            onClick={() => remove(f)}
                            className="-m-2 rounded p-2 text-gray-500 hover:bg-gray-100 hover:text-red-700 disabled:opacity-50"
                          >
                            <Trash2 size={16} aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              {mine.length > 0 && (
                <ul className="mt-3 space-y-2" aria-label={`Uploads for ${item.label}`}>
                  {mine.map((j) => (
                    <li key={j.key} className="text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate">
                          {j.file.name} <span className="text-gray-500">({formatBytes(j.file.size)}){j.status === 'queued' ? ' · waiting' : j.status === 'recording' ? ' · saving' : ''}</span>
                        </span>
                        {j.status === 'error' && j.canRetry && (
                          <button
                            type="button"
                            aria-label={`Retry ${j.file.name}`}
                            onClick={() => retry(j)}
                            className="inline-flex min-h-[44px] items-center gap-1 rounded border px-3 text-sm hover:bg-gray-50"
                          >
                            <RotateCw size={14} aria-hidden="true" /> Retry
                          </button>
                        )}
                      </div>
                      {j.status === 'error' ? (
                        <p className="text-red-700" role="alert">{j.error}</p>
                      ) : (
                        <div
                          className="mt-1 h-2 overflow-hidden rounded bg-gray-200"
                          role="progressbar"
                          aria-label={`Uploading ${j.file.name}`}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={Math.round((j.progress || 0) * 100)}
                        >
                          <div className="h-full" style={{ width: `${Math.round((j.progress || 0) * 100)}%`, backgroundColor: BRAND_RED }} />
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * A small "Evidence" button for a delivery row; opens the panel in a dialog. Every click and key
 * inside is stopped here: React bubbles portal events to the row, whose click opens the workorder.
 */
// Workorder header (owner, 29 Oct 2026): a "Dispatch evidence (N)" button that opens the evidence
// in a pop-up instead of listing it on the page, plus the folder button once dispatched. Hidden
// while Microsoft isn't set up or no item needs evidence (as the inline panel was).
export function WorkorderEvidence({ workorderId, invoiceId, onChanged }) {
  const [info, setInfo] = useState(null);
  const alive = useRef(true);
  const reload = useCallback(async () => {
    try {
      const d = await api('list', { query: { workorder_id: String(workorderId) } });
      if (alive.current) setInfo(d);
    } catch { /* the pop-up says why when it is opened */ }
  }, [workorderId]);
  useEffect(() => {
    alive.current = true;
    reload();
    return () => { alive.current = false; };
  }, [reload]);

  if (!info?.configured || !info?.available || !info.items?.length) return null;
  const count = info.items.reduce((n, i) => n + (i.files?.length || 0), 0);
  const changed = () => { reload(); onChanged?.(); };
  return (
    <>
      <EvidenceFolderLink info={info} />
      <DispatchEvidenceButton
        workorderId={workorderId}
        invoiceId={invoiceId}
        onChanged={changed}
        label={`Dispatch evidence (${count})`}
        className="inline-flex min-h-[44px] items-center gap-2 rounded-md border px-3 py-1 text-sm hover:bg-gray-50"
      />
    </>
  );
}

export function DispatchEvidenceButton({ workorderId, invoiceId, onChanged, label = 'Evidence', className }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const opener = useRef(null);
  const closeBtn = useRef(null);
  const dialog = useRef(null);
  const stop = (e) => e.stopPropagation();
  const name = invoiceId || `WO ${workorderId}`;

  const close = useCallback(() => {
    if (busy && !window.confirm('Uploads are still running — close anyway? They will be cancelled.')) return;
    setOpen(false);
    setBusy(false);
  }, [busy]);

  // Focus moves into the dialog on open and back to the Evidence button on close.
  useEffect(() => {
    if (!open) return undefined;
    const back = opener.current;
    closeBtn.current?.focus();
    return () => back?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [open, close]);

  // Keep Tab inside the dialog.
  const trap = (e) => {
    stop(e);
    if (e.key !== 'Tab' || !dialog.current) return;
    const els = [...dialog.current.querySelectorAll(FOCUSABLE)];
    if (!els.length) return;
    const first = els[0];
    const last = els[els.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  return (
    <>
      <button
        ref={opener}
        type="button"
        aria-label={`Dispatch evidence for invoice ${name}`}
        onClick={(e) => { stop(e); setOpen(true); }}
        onKeyDown={stop}
        className={`no-row-nav ${className || 'mt-1 inline-flex min-h-[44px] items-center gap-1 rounded border px-3 font-sans text-xs text-gray-700 hover:bg-gray-50'}`}
      >
        <Camera size={14} aria-hidden="true" /> {label}
      </button>
      {open && createPortal(
        // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
        <div
          className="no-row-nav fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:items-center"
          onClick={stop}
          onKeyDown={trap}
        >
          <div ref={dialog} role="dialog" aria-modal="true" aria-label={`Dispatch evidence — invoice ${name}`} className="w-full max-w-3xl rounded-lg bg-white p-4 shadow-xl">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-lg font-semibold">Dispatch evidence — {name}</h2>
              <button ref={closeBtn} type="button" aria-label="Close" onClick={close} className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded hover:bg-gray-100">
                <X size={20} aria-hidden="true" />
              </button>
            </div>
            <DispatchEvidencePanel workorderId={workorderId} onBusyChange={setBusy} onChanged={onChanged} inDialog />
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
