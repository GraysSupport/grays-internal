import React, { useEffect, useRef, useState } from 'react';

// Centred result modal for the G5 workshop scan-in (workorder detail page). Replaces the
// bottom-right toasts that reported a scan's outcome: on a keyboard-wedge kiosk the tech is
// looking at the machine and the scanner, not the corner of the screen, so the result now lands
// dead-centre. It closes three ways — the Close button, the backdrop, or Escape — and otherwise
// auto-closes on a visible countdown (default 5s), so an unattended scan station clears itself.
//
// Self-contained on purpose: it owns the countdown so the parent just toggles `result` on/off,
// and so the timer/close behaviour is unit-testable without rendering the whole (fetch-heavy)
// workorder page.
//
//   result: null  → renders nothing
//   result: { kind: 'success' | 'warn' | 'error', title, detail? }

const KIND = {
  success: {
    band: 'border-green-600',
    badge: 'bg-green-100 text-green-800',
    icon: '✓', // ✓
  },
  warn: {
    band: 'border-amber-500',
    badge: 'bg-amber-100 text-amber-900',
    icon: '!', // !
  },
  error: {
    band: 'border-red-600',
    badge: 'bg-red-100 text-red-800',
    icon: '✕', // ✕
  },
};

export default function ScanResultModal({ result, onClose, autoCloseSeconds = 5 }) {
  const [secondsLeft, setSecondsLeft] = useState(autoCloseSeconds);
  // Keep the latest onClose without making it a timer dependency — a new function identity each
  // render must not restart the countdown (that would keep an unattended modal open forever).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Restart + run the countdown whenever a NEW result is shown. Keyed on the result object so a
  // second scan while the first modal is still up resets the clock rather than inheriting it.
  useEffect(() => {
    if (!result) return undefined;
    setSecondsLeft(autoCloseSeconds);
    const timer = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(timer);
          onCloseRef.current?.();
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [result, autoCloseSeconds]);

  // Escape closes it, like the portal's other dialogs. Bound on window (not the element) so it
  // still fires after a click has blurred focus to <body> — the same convention the inbox modals use.
  useEffect(() => {
    if (!result) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onCloseRef.current?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [result]);

  if (!result) return null;
  const style = KIND[result.kind] || KIND.error;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="scan-result-title"
      data-testid="scan-result-backdrop"
      onClick={onClose}
    >
      <div
        className={`w-full max-w-md rounded-2xl border-2 ${style.band} bg-white p-6 text-center shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className={`mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full text-4xl font-bold leading-none ${style.badge}`}
          aria-hidden="true"
        >
          {style.icon}
        </div>
        <h2 id="scan-result-title" className="text-xl font-bold text-gray-900 break-words">
          {result.title}
        </h2>
        {result.detail ? (
          <p className="mt-2 text-sm text-gray-600 break-words">{result.detail}</p>
        ) : null}
        {/* Deliberately NOT autoFocus'd. This is a keyboard-wedge kiosk: the scan <input> keeps
            focus while the modal is up, so the tech can scan the next lot straight away (its result
            simply replaces this one, resetting the countdown) instead of a scan landing on this
            button and its trailing Enter closing the modal and losing that scan. Escape / backdrop /
            the button / the countdown all still dismiss it. */}
        <button
          type="button"
          onClick={onClose}
          className="mt-6 w-full rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-400"
        >
          Close ({secondsLeft})
        </button>
        <p className="mt-2 text-xs text-gray-500">
          Closes automatically in {secondsLeft}s
        </p>
      </div>
    </div>
  );
}
