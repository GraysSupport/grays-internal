// F26 — the focus behaviour every true modal in the portal needs, in one place.
//
// Written as a hook rather than a <Modal> wrapper component on purpose: the four overlays in
// the inbox have quite different chrome (a form, two read-only panels, a popover) and
// rewriting them into a shared shell would be a large refactor of a file that is under
// active review. A hook changes each modal by two lines and leaves its markup alone.
//
// WHAT THIS DOES NOT DO: it does not own Escape. ComposeModal must refuse Escape while a send
// is in flight (or the rep loses a typed draft with a request already on the wire), while the
// read-only lookups should always close. That difference is real, so each modal keeps its own
// Escape handler and this hook stays focused on focus.

import { useCallback, useEffect, useRef, useState } from 'react';

// Tab order, as the browser sees it. `:not([disabled])` matters — ComposeModal disables its
// Cancel button mid-send, and a trap that tried to focus a disabled element would land
// nowhere and effectively drop the user out of the dialog.
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableWithin(root) {
  if (!root) return [];
  // Filtered on ATTRIBUTES, not on layout. The obvious check here is `offsetParent !== null`
  // to skip display:none — and it is a trap: jsdom has no layout engine, so offsetParent is
  // ALWAYS null and that filter silently discards every candidate. The trap is quiet, because
  // the two dialogs whose first control carries autoFocus still looked like they focused
  // correctly while this hook was doing nothing at all. Attributes behave the same in jsdom
  // and in the browser, and these dialogs don't hide controls with CSS anyway.
  return Array.from(root.querySelectorAll(FOCUSABLE)).filter(
    (el) => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true',
  );
}

/**
 * Wires up modal focus behaviour and returns the ref to put on the dialog element.
 *
 * - moves focus into the dialog when it opens (first focusable, else the dialog itself)
 * - keeps Tab / Shift+Tab inside it
 * - restores focus to whatever was focused before it opened, when it unmounts
 */
export default function useDialog() {
  const ref = useRef(null);
  // Captured during the FIRST RENDER via a lazy useState initialiser — deliberately not in the
  // effect below. React applies `autoFocus` during commit, which is BEFORE effects run, so
  // capturing in the effect records whichever control inside the dialog just took focus
  // instead of the opener outside it. Restoring then targets a node that is about to be
  // detached, `document.contains` says no, the restore is skipped, and focus silently falls to
  // <body>. That is a real bug this hook shipped with for exactly one test run.
  const [restoreTo] = useState(() => (typeof document === 'undefined' ? null : document.activeElement));

  useEffect(() => {
    const node = ref.current;
    const first = focusableWithin(node)[0];
    if (first) first.focus();
    else if (node) node.focus();

    return () => {
      // Only restore if the opener is still in the document — it may have been removed by the
      // very action that closed the dialog, and focusing a detached node throws focus to
      // <body>, which is worse than leaving it alone.
      if (restoreTo && typeof restoreTo.focus === 'function' && document.contains(restoreTo)) {
        restoreTo.focus();
      }
    };
  }, [restoreTo]);

  const onKeyDown = useCallback((e) => {
    if (e.key !== 'Tab') return;
    const items = focusableWithin(ref.current);
    if (items.length === 0) {
      // Nothing to move to — keep focus here rather than letting it escape to the page behind.
      e.preventDefault();
      return;
    }
    const firstItem = items[0];
    const lastItem = items[items.length - 1];
    const active = document.activeElement;

    // Wrap at both ends. The `!contains` case matters: if focus somehow starts outside (a
    // click on the backdrop, say), Tab pulls it back in rather than continuing down the page.
    if (e.shiftKey && (active === firstItem || !ref.current?.contains(active))) {
      e.preventDefault();
      lastItem.focus();
    } else if (!e.shiftKey && (active === lastItem || !ref.current?.contains(active))) {
      e.preventDefault();
      firstItem.focus();
    }
  }, []);

  return { ref, onKeyDown };
}
