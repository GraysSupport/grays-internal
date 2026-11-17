// G28 (owner, 10 Nov 2026) — "I want the pictures to just open up as a popup instead of
// redirecting the users to the sharepoint link which isn't accessible when not logged in."
//
// A full-screen viewer for dispatch evidence and before-refurbishment photos/videos. The file is
// shown from a short-lived pre-authenticated Microsoft link that the portal asks for at the
// moment it is opened (`fetchLink(file)` → { kind: 'image' | 'video', url }), so no SharePoint
// login is needed. Previous / Next (buttons or ← →), Esc or ✕ closes.
//
// Review fixes (10 Nov 2026): a late reply for an earlier file is ignored (no wrong photo under
// another file's name); keys are caught at the window in the capture phase while the viewer is
// open, so Esc never also closes the evidence pop-up behind — even after a click on the photo or
// backdrop moved focus; the page behind is not scrollable; an unplayable video says so and offers
// a Download link instead of re-asking for a link that would not help.

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react';

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
// Microsoft's links last about an hour: older than this, a load error is probably expiry.
const LINK_FRESH_MS = 50 * 60 * 1000;

export default function EvidenceViewer({ files, index = 0, fetchLink, onClose }) {
  const [at, setAt] = useState(index);
  const [link, setLink] = useState(null); // { fileId, kind, url, at }
  const [error, setError] = useState(null);
  const retried = useRef(false);
  const request = useRef(0);
  const box = useRef(null);
  const closeBtn = useRef(null);
  const file = files[at];

  const load = useCallback(async () => {
    const mine = ++request.current;
    setLink(null);
    setError(null);
    try {
      const got = await fetchLink(file);
      if (mine !== request.current) return; // a later file was opened meanwhile
      setLink({ ...got, fileId: file.id, at: Date.now() });
    } catch (e) {
      if (mine !== request.current) return;
      setError(e?.message || 'Could not open this file');
    }
  }, [file, fetchLink]);

  useEffect(() => {
    retried.current = false;
    load();
  }, [load]);

  // Focus moves into the viewer and back to whatever opened it; the page behind does not scroll.
  useEffect(() => {
    const back = document.activeElement;
    closeBtn.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
      back?.focus?.();
    };
  }, []);

  const go = useCallback((d) => setAt((i) => Math.min(files.length - 1, Math.max(0, i + d))), [files.length]);

  // Esc / ← / → wherever focus is (a click on the photo or backdrop moves it to <body>). Window,
  // capture phase: runs before the evidence pop-up's document listener, which never sees the key.
  useEffect(() => {
    const onKey = (e) => {
      const keys = { Escape: () => onClose(), ArrowRight: () => go(1), ArrowLeft: () => go(-1) };
      if (!keys[e.key]) return;
      e.preventDefault();
      e.stopPropagation();
      keys[e.key]();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [go, onClose]);

  const onMediaError = (isVideo) => {
    const stale = link && Date.now() - link.at > LINK_FRESH_MS;
    if (!retried.current && (stale || !isVideo)) {
      retried.current = true; // probably an expired link: ask once for a fresh one
      load();
      return;
    }
    setError(isVideo
      ? "This video can't play in this browser (iPhone videos need a newer PC). Use Download to open it."
      : 'This photo could not be shown. Close and try again.');
  };

  // Tab stays inside the viewer (the evidence pop-up behind has its own trap; keep ours first).
  const onKeyDown = (e) => {
    e.stopPropagation();
    if (e.key !== 'Tab' || !box.current) return;
    const els = [...box.current.querySelectorAll(FOCUSABLE)];
    if (!els.length) { e.preventDefault(); box.current.focus(); return; }
    const first = els[0];
    const last = els[els.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === box.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  const stop = (e) => e.stopPropagation();
  // A click anywhere keeps focus in the viewer.
  const keepFocus = (e) => {
    e.stopPropagation();
    if (box.current && !box.current.contains(document.activeElement)) box.current.focus();
  };

  if (!file) return null;
  const by = [file.uploaded_by_name || file.uploaded_by, when(file.uploaded_at)].filter(Boolean).join(' · ');
  const btn = 'inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80 disabled:opacity-30';
  const current = link && link.fileId === file.id ? link : null;

  return createPortal(
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events
    <div className="no-row-nav fixed inset-0 z-[120] flex items-center justify-center bg-black/90 p-2 sm:p-4" onClick={stop} onMouseUp={keepFocus}>
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-label={file.file_name}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="flex h-full w-full max-w-6xl flex-col outline-none"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 py-2 text-white">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{file.file_name}</div>
            <div className="text-xs text-white">{by}{by ? ' · ' : ''}{at + 1} of {files.length}</div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {current?.kind === 'video' && (
              <a href={current.url} className={btn} aria-label="Download video" download>
                <Download size={20} aria-hidden="true" />
              </a>
            )}
            <button ref={closeBtn} type="button" aria-label="Close photo" onClick={onClose} className={btn}>
              <X size={22} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="relative flex min-h-0 flex-1 items-center justify-center">
          {error && <p role="alert" className="max-w-md rounded bg-white px-4 py-3 text-sm text-red-700">{error}</p>}
          {!error && !current && <p className="text-sm text-white">Loading…</p>}
          {!error && current?.kind === 'video' && (
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <video key={current.url} src={current.url} controls playsInline className="max-h-full max-w-full" onError={() => onMediaError(true)} />
          )}
          {!error && current?.kind === 'image' && (
            <img key={current.url} src={current.url} alt={file.file_name} className="max-h-full max-w-full object-contain" onError={() => onMediaError(false)} />
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
