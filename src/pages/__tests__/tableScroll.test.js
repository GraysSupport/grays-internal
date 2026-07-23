// F19 increment 2b — a wide table must not drag the whole page sideways on a phone.
//
// THE BUG: five of the portal's table pages rendered a multi-column <table> with no
// horizontally-scrollable ancestor. A table is the one element that cannot be squeezed — seven
// columns of names, emails and SKUs put its min-content width well past a 375px viewport — so
// the DOCUMENT BODY scrolled instead, taking every heading, filter and button with it. On
// collections/[id] the table carries a hard `min-w-[900px]`, so there was no width at which
// that page was readable at all, and peloton's table sat in `overflow-hidden`, which is worse
// than scrolling: the right-hand columns were simply unreachable.
//
// WHY THIS TEST EXISTS ALONGSIDE scripts/podium-responsive-smoke.mjs: that smoke is a source
// scan, and a source scan can only prove the wrapper is written down. This proves it is really
// the table's parent in the RENDERED DOM — after JSX nesting, conditional rendering and the
// data actually arriving. The two catch different mistakes: a wrapper that never renders
// because it sits inside a false branch would pass the scan and fail here.
//
// What it CANNOT prove: that anything visually overflowed. jsdom has no layout engine (the F26
// build learned this when `offsetParent` turned out to be permanently null), so every width in
// here would read as zero. Presence and parentage are the honest assertions; the browser
// spot-check is called out in the PR.

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CustomersPage from '../customers/index';
import ProductsPage from '../products/index';
import PelotonPage from '../peloton/index';

jest.mock('react-hot-toast', () => ({
  __esModule: true,
  default: { loading: jest.fn(), success: jest.fn(), error: jest.fn(), dismiss: jest.fn() },
}));

const CUSTOMERS = [
  {
    id: 1,
    name: 'Melbourne Strength Collective',
    customer_type: 'Business',
    email: 'accounts@melbournestrengthcollective.com.au',
    phone: '0412 345 678',
    address: '14 Cavendish Court, Altona North VIC 3025',
  },
];

const PRODUCTS = [
  {
    sku: 'LIF-95T-SE3HD',
    brand: 'Life Fitness',
    name: '95T Treadmill with Discover SE3 HD console',
    stock: 3,
    price: 6995,
    status: 'Available',
  },
];

// Peloton reads the Winnings feed. Only the shape matters here — the page renders one row per
// entry, and the row is what has to end up inside a scroller.
const WINNINGS = [
  {
    CustomerSKU: 'PEL-BIKE-PLUS',
    SKUDescription: 'Peloton Bike+ (refurbished)',
    StorageLocation: 'A-12-3',
    UnrestrictedUse: 4,
    InTransit: 2,
  },
];

function mockFetch() {
  return jest.fn(async (url) => {
    const u = String(url);
    const json = (body) => ({ ok: true, status: 200, json: async () => body });
    if (u.includes('/api/customers')) return json(CUSTOMERS);
    if (u.includes('/api/products')) return json(PRODUCTS);
    if (u.includes('/api/winnings')) return json({ results: WINNINGS, facilityName: 'NSW', env: 'test', fetchedAt: '2026-07-23T00:00:00Z' });
    return json([]);
  });
}

/** The nearest ancestor that can actually scroll the table horizontally. */
function horizontalScrollAncestor(el) {
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (/\boverflow-(x-)?(auto|scroll)\b/.test(node.className || '')) return node;
  }
  return null;
}

beforeEach(() => {
  localStorage.setItem('user', JSON.stringify({ id: 'GS', name: 'Nick', access: 'superadmin' }));
  global.fetch = mockFetch();
});

afterEach(() => {
  localStorage.clear();
  jest.clearAllMocks();
});

const renderPage = (ui) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('F19 incr 2b — wide tables scroll themselves, not the page', () => {
  test('the customers table has a horizontally scrollable ancestor', async () => {
    const { container } = renderPage(<CustomersPage />);
    await screen.findByText('Melbourne Strength Collective');

    const table = container.querySelector('table');
    expect(table).toBeTruthy();
    expect(horizontalScrollAncestor(table)).not.toBeNull();
  });

  test('the scroller is the table’s direct parent, so nothing sits outside it', async () => {
    // If the wrapper were an outer container with the heading and filters inside it too, the
    // page would scroll those off-screen alongside the table — the defect, differently shaped.
    const { container } = renderPage(<CustomersPage />);
    await screen.findByText('Melbourne Strength Collective');

    const table = container.querySelector('table');
    expect(table.parentElement.className).toMatch(/\boverflow-x-auto\b/);
  });

  test('the products table has a horizontally scrollable ancestor', async () => {
    const { container } = renderPage(<ProductsPage />);
    await waitFor(() => expect(container.querySelector('tbody tr')).toBeTruthy());

    const table = container.querySelector('table');
    expect(horizontalScrollAncestor(table)).not.toBeNull();
  });

  test('peloton’s table scrolls rather than being clipped by its overflow-hidden shell', async () => {
    // The sharpest of the five. Its table sat directly inside `overflow-hidden`, which reads as
    // "handled" and is the worst case: columns past the viewport cannot be reached by ANY
    // gesture. It is also the only one of the five whose wrapper renders inside a conditional
    // (`{!loading && rows.length > 0 && …}`), which is precisely the case a source scan cannot
    // see and this suite can — so this test is pointed here rather than at a second customers
    // assertion, per code review.
    const { container } = renderPage(<PelotonPage />);
    await waitFor(() => expect(container.querySelector('tbody tr')).toBeTruthy());

    const scroller = horizontalScrollAncestor(container.querySelector('table'));
    expect(scroller).not.toBeNull();
    expect(scroller.className).not.toMatch(/\boverflow-hidden\b/);
    // The rounded-corner clip must still be there, wrapping the scroller.
    expect(scroller.parentElement.className).toMatch(/\boverflow-hidden\b/);
  });

  test('the table still renders its data — the wrapper did not break the page', async () => {
    renderPage(<CustomersPage />);
    expect(await screen.findByText('accounts@melbournestrengthcollective.com.au')).toBeInTheDocument();
    expect(screen.getByText('0412 345 678')).toBeInTheDocument();
  });
});
