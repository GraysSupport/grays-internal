// src/components/PortalNav.js — F19 increment 2a: the portal nav, rendered twice.
//
// The desktop sidebar and the mobile drawer show the SAME items (src/utils/nav.js decides
// which), so the markup for a nav item lives here once. Below md the sidebar is hidden and the
// drawer is the only navigation there is — in an installed PWA there is no URL bar to fall
// back on, so "no nav" means "stuck".

import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import useDialog from '../hooks/useDialog';

const ITEM_CLASS = 'text-gray-700 hover:bg-gray-200 p-2 rounded';

/**
 * The list of nav links for a set of items from buildNavItems().
 * `onNavigate` fires when a link is followed — the drawer uses it to close itself.
 */
export function NavList({ items = [], onLogout, onNavigate, testId, className = '' }) {
  return (
    <nav data-testid={testId} className={`flex flex-col space-y-2 ${className}`}>
      {items.map((item) => {
        if (item.key === 'logout') {
          return (
            <button key={item.key} type="button" onClick={onLogout} className={`${ITEM_CLASS} text-left`}>
              {item.label}
            </button>
          );
        }
        return (
          <Link
            key={item.key}
            to={item.to}
            onClick={onNavigate}
            className={[
              ITEM_CLASS,
              item.emphasis ? 'font-semibold' : '',
              item.dot ? 'flex items-center gap-2' : '',
            ].filter(Boolean).join(' ')}
          >
            {item.dot ? <span className="inline-block w-2 h-2 rounded-full bg-black flex-shrink-0" /> : null}
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * The mobile drawer. A TRUE modal by F26's split: it has a full backdrop and nothing behind it
 * is meant to be reachable while it is open, so it gets role="dialog", aria-modal, the focus
 * trap from useDialog, and focus restore to the menu button.
 *
 * Escape is owned here rather than by the hook (F26 convention) — a menu should always close
 * on Escape, unlike ComposeModal which refuses while a send is in flight.
 */
export function MobileNavDrawer({ items, onLogout, onClose }) {
  const { ref } = useDialog();

  // Escape on the WINDOW, not on the dialog element — matching WorkorderModal, ComposeModal,
  // ProductLookupModal and CreateCustomerModal. The difference is not stylistic: in a real
  // browser a tap on a non-focusable part of the drawer (the "Grays Admin" heading, the p-4
  // padding — both large targets here) blurs to <body>, and a keydown at <body> never reaches
  // an element-bound handler, so Escape would silently stop working. jsdom does not reproduce
  // blur-to-body, so no test here can catch that; the precedent is the evidence.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Close if the viewport grows past the md breakpoint while the drawer is open — a phone
  // rotated to landscape, or a window widened. The drawer is `md:hidden`, so above md it would
  // otherwise stay MOUNTED but invisible, with useDialog's document-level Tab trap still live
  // and cycling focus through display:none links: keyboard navigation dead for the whole page,
  // with no visible control to escape it (the hamburger and backdrop are md:hidden too).
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia('(min-width: 768px)');
    if (mq.matches) onClose();
    const onChange = (e) => { if (e.matches) onClose(); };
    // addListener is the deprecated form; Safari only gained addEventListener on MediaQueryList
    // in 14, and this is the iOS-facing feature.
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else if (mq.removeListener) mq.removeListener(onChange);
    };
  }, [onClose]);

  return (
    // z-[60] deliberately exceeds the portal's shared z-50 overlay layer. The F19 install
    // banner (src/components/PwaPrompts.js) is `fixed bottom-4 left-4 z-50`, rendered globally
    // from App.js — i.e. OUTSIDE this page's tree and after it in DOM order — and it lands
    // inside the drawer's footprint. At z-50 it covers the bottom of the item list, which on a
    // small phone is where Logout sits, so the tap hits "Install app" instead. That only bites
    // a rep who has NOT installed the app yet — exactly the audience this increment is for.
    <div className="fixed inset-0 z-[60] md:hidden">
      <div
        data-testid="mobile-nav-backdrop"
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-nav-title"
        tabIndex={-1}
        className="absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-white shadow-xl flex flex-col overflow-y-auto"
      >
        <div className="p-4 border-b flex items-center justify-between">
          <span id="mobile-nav-title" className="font-bold text-lg">Grays Admin</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="text-gray-500 hover:text-gray-800 text-2xl leading-none px-2"
          >
            ×
          </button>
        </div>
        <NavList
          testId="mobile-nav"
          items={items}
          onLogout={onLogout}
          // Closing on navigate is not cosmetic: React Router swaps the page underneath without
          // unmounting this drawer, so without it the rep lands on the page they asked for with
          // the menu still covering it.
          onNavigate={onClose}
          className="p-4"
        />
      </div>
    </div>
  );
}

/** The hamburger. Hidden from md up, where the sidebar is visible instead. */
export function MobileNavButton({ onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Menu"
      className="md:hidden text-gray-700 hover:bg-gray-200 rounded p-2 -ml-2"
    >
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <line x1="3" y1="6" x2="21" y2="6" />
        <line x1="3" y1="12" x2="21" y2="12" />
        <line x1="3" y1="18" x2="21" y2="18" />
      </svg>
    </button>
  );
}
