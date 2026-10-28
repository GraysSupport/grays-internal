// G18 (owner, 28 Oct 2026) — "Dispatch evidence": photos and videos of each workorder item,
// saved to the SharePoint shared drive in a folder per workorder (named after the invoice) and a
// sub-folder per item. Used on the workorder page and, through DispatchEvidenceButton, on the
// To-Be-Booked and Schedule tabs.
//
// Files go from this browser STRAIGHT to SharePoint (a one-off upload link from the server), in
// 10 MB chunks with retries, so big phone videos work. The portal then records each file.
// Optional (owner decision 4): no "no evidence yet" badge, and the panel hides itself entirely
// when Microsoft isn't connected or the tables aren't migrated. OTHER items are not listed.
//
// Login expiry (1 h; the WK kiosk is never logged out): an upload that reached SharePoint but
// couldn't be recorded is kept in this browser (utils/dispatchEvidence pending) and recorded the
// next time this workorder's panel opens.

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { Camera, ExternalLink, Film, Image as ImageIcon, RotateCw, Trash2, X } from 'lucide-react';
import { authHeaders } from '../utils/auth';
import { endExpiredSession } from '../utils/session';
import {
  MAX_FILE_BYTES, isAllowedFileName, uploadInChunks, readPending, addPending, removePending, formatBytes,
} from '../utils/dispatchEvidence';

const BRAND_RED = '#B50B1D';
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
  const res = await fetch(`/api/evidence?${qs}`, {
    method,
    headers: authHeaders(body ? { 'Content-Type': 'application/json' } : {}),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(json?.error || `Request failed (HTTP ${res.status})`, res.status);
  return json;
}

let nextKey = 1;

export default function DispatchEvidencePanel({ workorderId, onChanged, onBusyChange }) {
  const navigate = useNavigate();
  const woId = Number(workorderId);
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [uploads, setUploads] = useState([]); // { key, itemId, file, status, progress, error, canRetry }
  const [deleting, setDeleting] = useState(null);
  const ended = useRef(false);

  const expire = useCallback(() => {
    if (ended.current) return;
    ended.current = true;
    endExpiredSession(navigate);
  }, [navigate]);

  const load = useCallback(async () => {
    try {
      setData(await api('list', { query: { workorder_id: String(woId) } }));
      setLoadError(null);
    } catch (e) {
      if (e.status === 401) return expire();
      setLoadError(e.message);
    }
  }, [woId, expire]);

  // Record anything a previous session uploaded but could not record, then list.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const p of readPending().filter((x) => Number(x.workorder_id) === woId)) {
        try {
          await api('complete', { method: 'POST', body: { workorder_id: woId, workorder_items_id: p.workorder_items_id, drive_item_id: p.drive_item_id } });
          removePending(p.drive_item_id);
        } catch (e) {
          if (e.status === 401) return expire();
          if (e.status >= 400 && e.status < 500) removePending(p.drive_item_id); // never going to succeed
        }
      }
      if (!cancelled) await load();
    })();
    return () => { cancelled = true; };
  }, [woId, load, expire]);

  const busy = uploads.some((u) => u.status === 'uploading' || u.status === 'queued');
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => {
    if (!busy) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);

  const update = (key, patch) => setUploads((list) => list.map((u) => (u.key === key ? { ...u, ...patch } : u)));

  // One file: session → SharePoint → record. Returns 'done' | 'error' | 'expired'.
  const runUpload = useCallback(async (u) => {
    update(u.key, { status: 'uploading', progress: 0, error: null });
    try {
      const s = await api('upload-session', {
        method: 'POST',
        body: { workorder_id: woId, workorder_items_id: u.itemId, file_name: u.file.name, size: u.file.size },
      });
      const item = await uploadInChunks({
        file: u.file, uploadUrl: s.upload_url, chunkBytes: s.chunk_bytes,
        onProgress: (p) => update(u.key, { progress: p }),
      });
      addPending({ workorder_id: woId, workorder_items_id: u.itemId, drive_item_id: item.id, file_name: item.name });
      await api('complete', { method: 'POST', body: { workorder_id: woId, workorder_items_id: u.itemId, drive_item_id: item.id } });
      removePending(item.id);
      update(u.key, { status: 'done', progress: 1 });
      return 'done';
    } catch (e) {
      if (e.status === 401) { expire(); return 'expired'; }
      update(u.key, { status: 'error', error: e.message, canRetry: true });
      return 'error';
    }
  }, [woId, expire]);

  const runAll = useCallback(async (list) => {
    let any = false;
    for (const u of list) {
      const r = await runUpload(u);
      if (r === 'expired') return;
      if (r === 'done') any = true;
    }
    if (any) { await load(); onChanged?.(); }
  }, [runUpload, load, onChanged]);

  const onPick = (itemId) => (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = ''; // the same file can be picked again
    const entries = files.map((file) => {
      const base = { key: nextKey++, itemId, file, progress: 0 };
      if (!isAllowedFileName(file.name)) return { ...base, status: 'error', error: `${file.name}: only photos and videos can be uploaded` };
      if (file.size > MAX_FILE_BYTES) return { ...base, status: 'error', error: `${file.name} is over 300 MB` };
      if (!file.size) return { ...base, status: 'error', error: `${file.name} is empty` };
      return { ...base, status: 'queued' };
    });
    setUploads((list) => [...list, ...entries]);
    runAll(entries.filter((x) => x.status === 'queued'));
  };

  const retry = async (u) => {
    const r = await runUpload(u);
    if (r === 'done') { await load(); onChanged?.(); }
  };

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
      setDeleting(null);
    }
  };

  if (loadError && !data) return <p className="mt-4 text-sm text-red-700">Dispatch evidence: {loadError}</p>;
  if (!data || !data.configured || !data.available || !data.items?.length) return null;

  return (
    <section aria-label="Dispatch evidence" className="mt-6 rounded-xl border bg-white p-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">Dispatch evidence</h2>
        {data.folder_url && (
          <a href={data.folder_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-gray-700 underline">
            Open folder in SharePoint <ExternalLink size={14} aria-hidden="true" />
          </a>
        )}
      </div>
      <p className="mb-3 text-sm text-gray-600">Photos and videos of each item before it leaves. Up to 300 MB per file.</p>
      {loadError && <p className="mb-2 text-sm text-red-700">{loadError}</p>}

      <ul className="space-y-3">
        {data.items.map((item) => {
          const mine = uploads.filter((u) => u.itemId === item.workorder_items_id && u.status !== 'done');
          return (
            <li key={item.workorder_items_id} className="rounded-lg border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-medium">{item.label}</div>
                {data.can_upload && (
                  <label
                    className="inline-flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-white hover:opacity-90 focus-within:ring-2 focus-within:ring-offset-2"
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
                          <img src={f.thumbnail_url} alt={f.file_name} className="h-full w-full object-cover" loading="lazy" />
                        ) : (
                          <span className="flex h-full w-full items-center justify-center text-gray-500" title={f.file_name}>
                            {isVideo(f.file_name, f.mime_type) ? <Film size={28} aria-hidden="true" /> : <ImageIcon size={28} aria-hidden="true" />}
                          </span>
                        )}
                      </a>
                      <div className="mt-1 flex items-start justify-between gap-1">
                        <span>{f.uploaded_by_name || f.uploaded_by || '—'} · {when(f.uploaded_at)}{isVideo(f.file_name, f.mime_type) ? ' · video' : ''}</span>
                        {data.can_delete && (
                          <button
                            type="button"
                            aria-label={`Delete ${f.file_name}`}
                            disabled={deleting === f.id}
                            onClick={() => remove(f)}
                            className="rounded p-0.5 text-gray-500 hover:bg-gray-100 hover:text-red-700 disabled:opacity-50"
                          >
                            <Trash2 size={14} aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              {mine.length > 0 && (
                <ul className="mt-3 space-y-2" aria-label={`Uploads for ${item.label}`}>
                  {mine.map((u) => (
                    <li key={u.key} className="text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate">{u.file.name} <span className="text-gray-500">({formatBytes(u.file.size)})</span></span>
                        {u.status === 'error' && u.canRetry && (
                          <button
                            type="button"
                            aria-label={`Retry ${u.file.name}`}
                            onClick={() => retry(u)}
                            className="inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs hover:bg-gray-50"
                          >
                            <RotateCw size={12} aria-hidden="true" /> Retry
                          </button>
                        )}
                      </div>
                      {u.status === 'error' ? (
                        <p className="text-red-700" role="alert">{u.error}</p>
                      ) : (
                        <div
                          className="mt-1 h-2 overflow-hidden rounded bg-gray-200"
                          role="progressbar"
                          aria-label={`Uploading ${u.file.name}`}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={Math.round((u.progress || 0) * 100)}
                        >
                          <div className="h-full" style={{ width: `${Math.round((u.progress || 0) * 100)}%`, backgroundColor: BRAND_RED }} />
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

/**
 * A small "Evidence" button for a delivery row; opens the panel in a dialog. Every click and key
 * inside is stopped here: React bubbles portal events to the row, whose click opens the workorder.
 */
export function DispatchEvidenceButton({ workorderId, invoiceId }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const stop = (e) => e.stopPropagation();
  const close = () => {
    if (busy && !window.confirm('Uploads are still running — close anyway? They will stop.')) return;
    setOpen(false);
  };
  const name = invoiceId || `WO ${workorderId}`;
  return (
    <>
      <button
        type="button"
        aria-label={`Dispatch evidence for invoice ${name}`}
        onClick={(e) => { stop(e); setOpen(true); }}
        onKeyDown={stop}
        className="no-row-nav mt-1 inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-sans text-[11px] text-gray-700 hover:bg-gray-50"
      >
        <Camera size={12} aria-hidden="true" /> Evidence
      </button>
      {open && createPortal(
        // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
        <div
          className="no-row-nav fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:items-center"
          onClick={stop}
          onKeyDown={(e) => { stop(e); if (e.key === 'Escape') close(); }}
        >
          <div role="dialog" aria-modal="true" aria-label={`Dispatch evidence — invoice ${name}`} className="w-full max-w-3xl rounded-lg bg-white p-4 shadow-xl">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Dispatch evidence — {name}</h2>
              <button type="button" aria-label="Close" onClick={close} className="rounded p-1 hover:bg-gray-100">
                <X size={18} aria-hidden="true" />
              </button>
            </div>
            <DispatchEvidencePanel workorderId={workorderId} onBusyChange={setBusy} />
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
