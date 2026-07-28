// F19 increment 2c — the Peloton header must not drag the page sideways on a phone.
//
// THE BUG, MEASURED NOT GUESSED: at a 375px viewport /peloton had a document scrollWidth of
// 441px — the page scrolled sideways by 66px, taking the table, the filters and the heading
// with it. The cause is the page <header>: a single `flex items-center gap-3` row holding the
// back/home buttons, a 300px PELOTON pill + "Winnings Warehouse Stock" title, an env badge and
// an `ml-auto` Refresh button. Flex items do not wrap unless told to, so the row simply ran
// past the viewport. Adding `flex-wrap` took the overflow to 0 and left the desktop header
// untouched (still one 60px line at 1280px).
//
// WHY THIS DEFECT SURVIVED INCREMENT 2b: 2b's guard (scripts/podium-responsive-smoke.mjs) checks
// that wide <table>s sit inside a horizontal scroller, and its own header names the gap it
// cannot see — "a wide non-table element ... would still break F19's acceptance line and pass
// every check here". This is exactly that: the table on /peloton is correctly wrapped; the
// HEADER above it is what overflowed.
//
// WHY THIS TEST IS STRUCTURAL AND NOT A MEASUREMENT: jsdom has no layout engine (F26 learned
// this when offsetParent turned out to be permanently null), so every width in here reads as
// zero and no jsdom test can prove anything overflowed. The measurement was taken in a real
// browser at 375px against the production build; this test pins the structural fix that
// measurement produced, so it cannot be silently reverted.
//
// WHY NOT A REPO-WIDE "every flex header must wrap" RULE: the portal's five other flex headers
// all measured CLEAN at 375px, and a blanket source rule would have reported five false
// positives — the F19 2b review's lesson that a guard's only value is being trustworthy. They
// are clean for two DIFFERENT reasons, neither of which a class-list rule can see:
//   - dashboard.js:292 and inbox.js:1207 contain their own titles — `truncate` on the h1, and
//     `min-w-0 flex-1` on the title wrapper respectively — so the row shrinks instead of running
//     past the viewport. Peloton's title group has neither, which is the real asymmetry.
//   - the three inbox modal headers (inbox.js:1888/2027/2154) simply hold little enough content
//     to fit at 375px.
// So whether a flex header overflows depends on containment and content width, not on the
// presence of `flex-wrap`. The honest guard for this defect class is the browser measurement;
// this file pins the one defect it found.

import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PelotonPage from '../peloton/index';

jest.mock('react-hot-toast', () => ({
  __esModule: true,
  default: { loading: jest.fn(), success: jest.fn(), error: jest.fn(), dismiss: jest.fn() },
}));

// Field names are the ones peloton/index.js actually reads. Note SOInTransit + STOInTransit,
// which the page sums (index.js:285) — tableScroll.test.js's copy of this fixture carries an
// `InTransit` key that no code consumes, which reads as coverage it does not provide.
const WINNINGS = [
  {
    CustomerSKU: 'PEL-BIKE-PLUS',
    SKUDescription: 'Peloton Bike+ (refurbished)',
    StorageLocation: 'A-12-3',
    UnrestrictedUse: 4,
    SOInTransit: 2,
    STOInTransit: 1,
  },
];

beforeEach(() => {
  localStorage.setItem('user', JSON.stringify({ id: 'GS', name: 'Nick', access: 'superadmin' }));
  global.fetch = jest.fn(async (url) => {
    const u = String(url);
    const json = (body) => ({ ok: true, status: 200, json: async () => body });
    if (u.includes('/api/winnings')) {
      return json({
        results: WINNINGS,
        facilityName: 'NSW',
        env: 'test',
        fetchedAt: '2026-07-23T00:00:00Z',
      });
    }
    return json([]);
  });
});

afterEach(() => {
  localStorage.clear();
  jest.clearAllMocks();
});

describe('F19 incr 2c — the Peloton header wraps instead of overflowing the viewport', () => {
  test('the page header is a flex row that is allowed to wrap', async () => {
    const { container } = render(
      <MemoryRouter>
        <PelotonPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(container.querySelector('tbody tr')).toBeTruthy());

    const header = container.querySelector('header');
    expect(header).toBeTruthy();

    // EXACT TOKEN MATCHING, NOT REGEX — both regexes this replaces were untrustworthy, and a
    // guard that passes for the wrong reason is worse here than no guard at all:
    //   /\bflex\b/      is satisfied by `flex-wrap` and by `flex-shrink-0`, both already on this
    //                   header, so deleting the standalone `flex` class — which turns the header
    //                   into a block box and makes `flex-wrap` inert — left the suite GREEN.
    //   /\bflex-wrap\b/ matches INSIDE `flex-wrap-reverse` (`-` is a non-word character, so the
    //                   \b after "wrap" is satisfied), so the one variant the comment claimed to
    //                   reject was in fact accepted.
    // Both were caught by mutation in code review, not by reasoning about the regexes.
    const classes = new Set(header.className.split(/\s+/));

    // It is a flex row (if this ever stops being true the overflow analysis above no longer
    // applies and this test should be re-derived rather than patched).
    expect(classes.has('flex')).toBe(true);
    // ...and it must be permitted to wrap. `flex-wrap-reverse` would also wrap, but would put
    // the Refresh button above the title, so it is deliberately not accepted here.
    expect(classes.has('flex-wrap')).toBe(true);
  });

  test('the header still holds the Refresh control it was overflowing because of', async () => {
    // Guards the lazy "fix": deleting the ml-auto group would also take the overflow to zero.
    const { container, getByRole } = render(
      <MemoryRouter>
        <PelotonPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(container.querySelector('tbody tr')).toBeTruthy());

    const header = container.querySelector('header');
    const refresh = getByRole('button', { name: /refresh/i });
    expect(header.contains(refresh)).toBe(true);
  });
});
