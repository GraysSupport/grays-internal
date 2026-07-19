import React, { useEffect, useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { installUiState, isStandalone, IOS_INSTALL_STEPS } from '../utils/pwa';
import { applyUpdate } from '../serviceWorkerRegistration';

const DISMISS_KEY = 'pwaInstallDismissedAt';
// Re-offer the install a fortnight after a dismissal rather than never again —
// staff change phones, and a permanently hidden button is unfindable.
const DISMISS_FOR_MS = 14 * 24 * 60 * 60 * 1000;

function wasRecentlyDismissed() {
  try {
    const at = parseInt(localStorage.getItem(DISMISS_KEY), 10);
    return Boolean(at) && Date.now() - at < DISMISS_FOR_MS;
  } catch (err) {
    return false;
  }
}

/**
 * Install affordance + new-version toast for the installable portal (F19).
 *
 * Rendered once from App so it is available on every page, including the login
 * screen — reps install the app before they have a session.
 */
export default function PwaPrompts() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [installed, setInstalled] = useState(false);
  const [dismissed, setDismissed] = useState(wasRecentlyDismissed);
  const [showIosSheet, setShowIosSheet] = useState(false);

  // Capture Chrome's install prompt so we can trigger it from our own button.
  useEffect(() => {
    const onBeforeInstallPrompt = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferredPrompt(null);
      setShowIosSheet(false);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  // A new service worker is waiting — offer the refresh rather than forcing it.
  useEffect(() => {
    const showUpdateToast = (registration) => {
      toast(
        (t) => (
          <span className="flex items-center gap-3">
            <span>A new version is available.</span>
            <button
              type="button"
              onClick={() => {
                toast.dismiss(t.id);
                applyUpdate(registration);
              }}
              className="rounded bg-[#B50B1D] px-3 py-1 text-white hover:opacity-90"
            >
              Refresh
            </button>
          </span>
        ),
        { duration: Infinity, id: 'pwa-update' },
      );
    };

    const onUpdateReady = (event) => showUpdateToast(event.detail);
    window.addEventListener('pwa:update-ready', onUpdateReady);

    // The worker may have finished installing before this component mounted.
    if (window.__pwaWaitingRegistration) {
      showUpdateToast(window.__pwaWaitingRegistration);
    }

    return () => window.removeEventListener('pwa:update-ready', onUpdateReady);
  }, []);

  const handleInstall = useCallback(async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    try {
      await deferredPrompt.userChoice;
    } catch (err) {
      // The browser may reject if the prompt was already consumed; either way
      // it can only be used once.
    }
    setDeferredPrompt(null);
  }, [deferredPrompt]);

  const handleDismiss = useCallback(() => {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch (err) {
      // Private mode / storage full — dismissing for this session is enough.
    }
    setDismissed(true);
    setShowIosSheet(false);
  }, []);

  const state = installUiState({
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    standalone: isStandalone(typeof window !== 'undefined' ? window : null),
    deferredPrompt,
    installed,
    hasTouch: typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1,
  });

  if (state === 'hidden' || dismissed) return null;

  return (
    <div className="fixed bottom-4 left-4 z-50 max-w-xs">
      {showIosSheet && (
        <div className="mb-2 rounded-lg border border-gray-200 bg-white p-4 shadow-lg">
          <p className="mb-2 text-sm font-semibold text-gray-900">
            Install Grays Portal
          </p>
          <ol className="list-decimal space-y-1 pl-4 text-sm text-gray-700">
            {IOS_INSTALL_STEPS.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      )}

      <div className="flex items-center gap-2 rounded-lg bg-white p-2 shadow-lg ring-1 ring-gray-200">
        <button
          type="button"
          onClick={state === 'ios-hint' ? () => setShowIosSheet((v) => !v) : handleInstall}
          className="rounded bg-[#B50B1D] px-3 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          {state === 'ios-hint' ? 'Install on iPhone' : 'Install app'}
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss install prompt"
          className="rounded px-2 py-2 text-sm text-gray-500 hover:bg-gray-100"
        >
          Not now
        </button>
      </div>
    </div>
  );
}
