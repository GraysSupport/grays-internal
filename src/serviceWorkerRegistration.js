/**
 * Service worker registration.
 *
 * Deliberately minimal (no CRA/Workbox template): registers /service-worker.js,
 * and reports a waiting worker so the app can offer "a new version is
 * available" instead of stranding installed users on a stale bundle.
 *
 * The worker is only registered in production builds — in development CRA
 * serves unhashed assets and a cached shell makes changes appear not to apply.
 */

/**
 * @param {{onUpdate?: (registration: ServiceWorkerRegistration) => void,
 *          onSuccess?: (registration: ServiceWorkerRegistration) => void}} config
 */
export function register(config = {}) {
  if (typeof window === 'undefined') return;
  if (process.env.NODE_ENV !== 'production') return;
  if (!('serviceWorker' in navigator)) return;

  // A service worker cannot control pages outside its origin+scope.
  const publicUrl = new URL(process.env.PUBLIC_URL || '/', window.location.href);
  if (publicUrl.origin !== window.location.origin) return;

  window.addEventListener('load', () => {
    const swUrl = `${process.env.PUBLIC_URL || ''}/service-worker.js`;

    navigator.serviceWorker
      .register(swUrl)
      .then((registration) => {
        // Already waiting when we loaded (user opened a second tab).
        if (registration.waiting && navigator.serviceWorker.controller) {
          if (config.onUpdate) config.onUpdate(registration);
        }

        registration.onupdatefound = () => {
          const installing = registration.installing;
          if (!installing) return;

          installing.onstatechange = () => {
            if (installing.state !== 'installed') return;

            if (navigator.serviceWorker.controller) {
              // Old content is still being served by the active worker.
              if (config.onUpdate) config.onUpdate(registration);
            } else if (config.onSuccess) {
              // First install — content is cached for offline use.
              config.onSuccess(registration);
            }
          };
        };
      })
      .catch((error) => {
        // Never let a failed registration break the app: the portal must work
        // perfectly well without offline support.
        // eslint-disable-next-line no-console
        console.error('Service worker registration failed:', error);
      });
  });
}

/**
 * Tell a waiting worker to activate, then reload once it takes control.
 * Called when the user accepts the update toast.
 */
export function applyUpdate(registration) {
  if (!registration || !registration.waiting) {
    window.location.reload();
    return;
  }

  let reloaded = false;
  const reloadOnce = () => {
    if (reloaded) return;
    reloaded = true;
    navigator.serviceWorker.removeEventListener('controllerchange', reloadOnce);
    window.location.reload();
  };

  navigator.serviceWorker.addEventListener('controllerchange', reloadOnce);

  // If the waiting worker never activates, the user has dismissed the toast and
  // has no way back to it — reload anyway rather than stranding them.
  setTimeout(reloadOnce, 3000);

  registration.waiting.postMessage({ type: 'SKIP_WAITING' });
}

export function unregister() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.ready
    .then((registration) => registration.unregister())
    .catch(() => undefined);
}
