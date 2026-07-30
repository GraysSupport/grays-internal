// F19 increment 2d — the fixed Home/Back overlay must not sit on top of the page's content.
//
// THE BUG: thirteen pages pin `<HomeButton/><BackButton/>` to the viewport corner with
// `fixed top-4 left-6 z-50`. At a desktop width the pair floats over empty background — the
// headings are centred far to its right. At 375px the same centred heading lands directly
// underneath it. A real Chrome at 375×812 measured the overlay painting on top of the page's
// own <h2> on five pages, and on register.js's "Register" TAB BUTTON — which is worse than
// cosmetic: `document.elementFromPoint` returned the overlay there, so the tap opens Home.
//
// WHY THIS TEST EXISTS ALONGSIDE scripts/podium-responsive-smoke.mjs: the smoke is a source
// scan and can only prove a clearance class is written down somewhere below the overlay. This
// proves it is on the element that actually has to move — the one that CONTAINS the heading —
// in the rendered DOM, after JSX nesting and conditional rendering. A `max-sm:pt-16` parked on
// an unrelated sibling passes the scan and fails here.
//
// What it CANNOT prove: that anything visually overlapped. jsdom has no layout engine, so every
// rect in here is zero. The geometry is measured in a real browser and reported in the PR
// (28 routes, before → after); repo-ifying that browser pass is backlog row F38.

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ProductsPage from '../products/index';
import WaitlistPage from '../waitlist/index';
import EditCustomerPage from '../customers/edit';
import RegisterPage from '../register';

jest.mock('react-hot-toast', () => ({
  __esModule: true,
  default: { loading: jest.fn(), success: jest.fn(), error: jest.fn(), dismiss: jest.fn() },
}));

// Below `sm` (639px and down) the content must clear the overlay. `pt-16`/`py-16` are the
// unconditional form the three already-clear pages (inbox, leads, settings) use.
const CLEARANCE = /\b(max-sm:)?(pt|py|mt)-16\b/;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const TOKEN = `${b64({ alg: 'none' })}.${b64({ id: 'GS', access: 'superadmin', roles: ['superadmin'] })}.sig`;

const PRODUCTS = [{ sku: 'LIF-95T', brand: 'Life Fitness', name: '95T Treadmill', stock: 3, price: 6995, status: 'Available' }];
const CUSTOMER = { id: 26, name: 'Jane Citizen', email: 'jane@example.com', phone: '0400111222', address: '12 Example St' };

function mockFetch() {
  return jest.fn(async (url) => {
    const u = String(url);
    // customers/edit reads the body through parseMaybeJson (text-then-parse), so the stub has
    // to answer both shapes.
    const json = (body) => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
    if (u.includes('/api/products')) return json(PRODUCTS);
    if (u.includes('/api/customers')) return json(CUSTOMER);
    if (u.includes('/api/waitlist')) return json([]);
    return json([]);
  });
}

beforeEach(() => {
  localStorage.setItem('token', TOKEN);
  localStorage.setItem('user', JSON.stringify({ id: 'GS', name: 'Nick', access: 'superadmin', roles: ['superadmin'] }));
  global.fetch = mockFetch();
});

afterEach(() => {
  localStorage.clear();
  jest.clearAllMocks();
});

/** The overlay as the pages render it: a position-fixed box holding Home and Back. */
function overlayIn(container) {
  return Array.from(container.querySelectorAll('div')).find(
    (d) => /\bfixed\b/.test(d.className || '') && /\btop-4\b/.test(d.className || ''),
  );
}

/** The nearest ancestor of `el` (or `el` itself) that declares clearance for the overlay. */
function clearanceAncestor(el) {
  for (let node = el; node; node = node.parentElement) {
    if (CLEARANCE.test(node.className || '')) return node;
  }
  return null;
}

const renderPage = (ui) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('F19 incr 2d — content clears the fixed Home/Back overlay on a phone', () => {
  test('products: the heading sits inside an element that clears the overlay', async () => {
    const { container } = renderPage(<ProductsPage />);
    await waitFor(() => expect(container.querySelector('tbody tr')).toBeTruthy());

    expect(overlayIn(container)).toBeTruthy();
    const clearance = clearanceAncestor(screen.getByRole('heading', { name: 'Products' }));
    expect(clearance).not.toBeNull();
    // The clearance must be on the CONTENT side, not on the overlay itself — padding the
    // overlay moves the buttons, not the heading they cover.
    expect(clearance.contains(overlayIn(container))).toBe(false);
  });

  test('waitlist: same shape, and the clearance element is not the overlay', async () => {
    const { container } = renderPage(<WaitlistPage />);
    const heading = await screen.findByRole('heading', { name: 'Waitlist' });

    const clearance = clearanceAncestor(heading);
    expect(clearance).not.toBeNull();
    expect(clearance).not.toBe(overlayIn(container));
    expect(clearance.contains(heading)).toBe(true);
  });

  test('customers/edit: the clearance is on the card, the one page that renders the overlay INSIDE its container', async () => {
    // This page's grey page container wraps the overlay, so clearance there would read as
    // "handled" while the card it is meant to move stays put in the DOM the test can see.
    const { container } = render(
      <MemoryRouter initialEntries={['/customers/26/edit']}>
        <Routes>
          <Route path="/customers/:id/edit" element={<EditCustomerPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const heading = await screen.findByRole('heading', { name: 'Edit Customer' });

    const clearance = clearanceAncestor(heading);
    expect(clearance).not.toBeNull();
    expect(clearance.contains(overlayIn(container))).toBe(false);
  });

  test('register: the tab BUTTON the overlay covered is inside the cleared element', async () => {
    // The sharpest of the four: on the other pages the overlay covered a heading (unreadable);
    // here it covered a control (untappable — the tap opened Home instead of the tab).
    const { container } = renderPage(<RegisterPage />);
    // Two controls are named "Register": the tab (first in DOM) and the form's submit button
    // at the bottom of the card. The overlay covered the TAB.
    const tabs = await screen.findAllByRole('button', { name: 'Register' });
    const tab = tabs[0];

    const clearance = clearanceAncestor(tab);
    expect(clearance).not.toBeNull();
    expect(clearance.contains(overlayIn(container))).toBe(false);
  });

  test('the pages still render their content — the clearance did not break them', async () => {
    renderPage(<ProductsPage />);
    expect(await screen.findByText('95T Treadmill')).toBeInTheDocument();
  });
});
