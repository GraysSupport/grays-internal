/**
 * PWA install helpers — pure, JSX-free, no React import.
 *
 * Kept free of JSX on purpose so scripts/podium-pwa-smoke.mjs can import this
 * module directly under node and assert the real decision logic rather than a
 * copy of it (same precedent as src/utils/lotLabels.js and src/utils/compose.js).
 */

/**
 * True for any iOS/iPadOS browser, where there is NO beforeinstallprompt event
 * and installing means Share > Add to Home Screen.
 *
 * Named "WebKit" rather than "Safari" on purpose: Chrome, Firefox and Edge on
 * iOS are all WebKit underneath and behave identically here, so this matches
 * them too — and the install copy must not name Safari specifically.
 *
 * iPadOS 13+ reports a desktop macOS user-agent, so a Mac UA with touch points
 * is treated as iPad — that is the only signal available without UA-CH.
 *
 * @param {string} userAgent
 * @param {boolean} hasTouch true when navigator.maxTouchPoints > 1
 */
export function isIosWebkit(userAgent = '', hasTouch = false) {
  const ua = String(userAgent);

  if (/iPhone|iPad|iPod/i.test(ua)) return true;

  // iPadOS 13+ masquerading as macOS.
  if (/Macintosh/i.test(ua) && hasTouch) return true;

  return false;
}

/**
 * True when the app is already running as an installed app rather than a tab.
 * Reads both the standard display-mode media query and the iOS-only
 * navigator.standalone flag.
 *
 * @param {object} win a window-like object
 */
export function isStandalone(win) {
  if (!win) return false;

  if (typeof win.matchMedia === 'function') {
    try {
      if (win.matchMedia('(display-mode: standalone)').matches) return true;
    } catch (err) {
      // matchMedia can throw on a malformed query in older engines — fall through.
    }
  }

  return Boolean(win.navigator && win.navigator.standalone);
}

/**
 * Decide what install affordance (if any) to render.
 *
 *   'android-install' — we hold a beforeinstallprompt; show the Install button.
 *   'ios-hint'        — iOS: show the Add-to-Home-Screen instructions.
 *   'hidden'          — already installed, or nothing useful to offer.
 *
 * @param {{userAgent?: string, standalone?: boolean, deferredPrompt?: object|null,
 *          installed?: boolean, hasTouch?: boolean}} state
 * @returns {'android-install'|'ios-hint'|'hidden'}
 */
export function installUiState(state = {}) {
  const {
    userAgent = '',
    standalone = false,
    deferredPrompt = null,
    installed = false,
    hasTouch = false,
  } = state;

  // Already an app on this device — nothing to offer.
  if (standalone || installed) return 'hidden';

  // A captured prompt is the strongest signal, and it is what actually installs.
  if (deferredPrompt) return 'android-install';

  // No prompt and never will be one: iOS installs manually.
  if (isIosWebkit(userAgent, hasTouch)) return 'ios-hint';

  // Desktop/unsupported browser, or the prompt has not fired yet.
  return 'hidden';
}

/**
 * Short, platform-correct install instructions for the iOS hint.
 * Says "your browser", not "Safari": Chrome and Edge on iOS reach the same
 * Add-to-Home-Screen flow, and naming Safari sends those users looking for an
 * app they are not in.
 */
export const IOS_INSTALL_STEPS = [
  'Tap the Share button in your browser’s toolbar.',
  'Scroll down and tap “Add to Home Screen”.',
  'Tap “Add” — the portal appears as an app.',
];
