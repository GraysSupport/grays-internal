// G28 (owner, 10 Nov 2026) — "I want the pictures to just open up as a popup instead of
// redirecting the users to the sharepoint link which isn't accessible when not logged in."
//
// A full-screen viewer for dispatch evidence and before-refurbishment photos/videos. The file is
// shown from a short-lived pre-authenticated Microsoft link that the portal asks for at the
// moment it is opened (`fetchLink(file)` → { kind: 'image' | 'video', url }), so no SharePoint
// login is needed. Previous / Next (buttons or ← →), Esc or ✕ closes. Keys stop here, so the
// evidence pop-up behind it does not also close.

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';

const when = (iso) => {
  try {
    return new Intl.DateTimeFormat('en-AU', {
      timeZone: 'Australia/Melbourne', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return '';
  }
};
const FOCUSABLE = 'a[href], button:not([disabled]), video, [tabindex]:not([tabindex="-1"])';

export default function EvidenceViewer({ files, index = 0, fetchLink, onClose }) {
  const [at, setAt] = useState(index);
  const [link, setLink] = useState(null);
  const [error, setError] = useState(null);
  const retried = useRef(false);
  const box = useRef(null);
  const closeBtn = useRef(null);
  const file = files[at];

  const load = useCallback(async () => {
    setLink(null);
    setError(null);
    try {
      setLink(await fetchLink(file));
    } catch (e) {
      setError(e?.message || 'Could not open this file');
    }
  }, [file, fetchLink]);

  useEffect(() => {
    retried.current = false;
    load();
  }, [load]);

  // Focus moves into the viewer and back to whatever opened it.
  useEffect(() => {
    const back = document.activeElement;
    closeBtn.current?.focus();
    return () => back?.focus?.();
  }, []);

  // The link expires after about an hour: on a load error, ask for a fresh one once.
  const onMediaError = () => {
    if (retried.current) { setError('This file could not be shown. Close and try again.'); return; }
    retried.current = true;
    load();
  };

  const go = (d) => setAt((i) => Math.min(files.length - 1, Math.max(0, i + d)));
  const onKeyDown = (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); go(1); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); return; }
    if (e.key === 'Tab' && box.current) {
      const els = [...box.current.querySelectorAll(FOCUSABLE)];
      if (!els.length) return;
      const first = els[0];
      const last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  const stop = (e) => e.stopPropagation();

  if (!file) return null;
  const by = [file.uploaded_by_name || file.uploaded_by, when(file.uploaded_at)].filter(Boolean).join(' · ');
  const btn = 'inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80 disabled:opacity-30';

  return createPortal(
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
    <div className="no-row-nav fixed inset-0 z-[120] flex items-center justify-center bg-black/90 p-2 sm:p-4" onClick={stop}>
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-label={file.file_name}
        onKeyDown={onKeyDown}
        className="flex h-full w-full max-w-6xl flex-col"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 py-2 text-white">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{file.file_name}</div>
            <div className="text-xs text-white">{by}{by ? ' · ' : ''}{at + 1} of {files.length}</div>
          </div>
          <button ref={closeBtn} type="button" aria-label="Close photo" onClick={onClose} className={btn}>
            <X size={22} aria-hidden="true" />
          </button>
        </div>

        <div className="relative flex min-h-0 flex-1 items-center justify-center">
          {error && <p role="alert" className="rounded bg-white px-4 py-3 text-sm text-red-700">{error}</p>}
          {!error && !link && <p className="text-sm text-white">Loading…</p>}
          {!error && link?.kind === 'video' && (
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <video key={link.url} src={link.url} controls playsInline className="max-h-full max-w-full" onError={onMediaError} />
          )}
          {!error && link?.kind === 'image' && (
            <img key={link.url} src={link.url} alt={file.file_name} className="max-h-full max-w-full object-contain" onError={onMediaError} />
          )}
          {files.length > 1 && (
            <>
              <button type="button" aria-label="Previous" disabled={at === 0} onClick={() => go(-1)} className={`${btn} absolute left-1 top-1/2 -translate-y-1/2`}>
                <ChevronLeft size={26} aria-hidden="true" />
              </button>
              <button type="button" aria-label="Next" disabled={at === files.length - 1} onClick={() => go(1)} className={`${btn} absolute right-1 top-1/2 -translate-y-1/2`}>
                <ChevronRight size={26} aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
