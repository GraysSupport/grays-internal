// F19 increment 2e — a form control must not sit in a grid track narrower than a third of its
// row on a phone.
//
// THE BUG: create_workorder.js's item row is `grid grid-cols-5`, unconditional, so it stays five
// columns wide at every viewport. Chrome at 375×812 measured the row at 279px and its controls at
// 107 / 49 / 49 / 49px — the Qty input, the Condition select and the technician search each had
// 31px of text area at a 16px font. The Condition select's own label ("Select Condition") needs
// 116px: its scrollWidth was 128px inside a 47px box.
//
// WHY THIS TEST EXISTS ALONGSIDE scripts/podium-formgrid-smoke.mjs: the smoke is a source scan
// over `src/pages/**`. This runs the same rule over the RENDERED DOM, after JSX nesting,
// fragments and conditional branches have been resolved — the layer where the source scan is
// guessing. A rewrite that moved the controls into a nested wrapper would satisfy the scan's
// text and still crush them here.
//
// What it CANNOT prove: that anything was actually too narrow. jsdom has no layout engine, so
// every width in it is zero. The pixel numbers above come from a real browser and are reported
// in the PR (375 / 640 / 768 / 1280, before → after).

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CreateWorkorderPage from '../create_workorder';

jest.mock('react-hot-toast', () => ({
  __esModule: true,
  default: { loading: jest.fn(), success: jest.fn(), error: jest.fn(), dismiss: jest.fn() },
}));

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const TOKEN = `${b64({ alg: 'none' })}.${b64({ id: 'GS', access: 'superadmin', roles: ['superadmin'] })}.sig`;

const PRODUCTS = [{ sku: 'LIF-95T', brand: 'Life Fitness', name: '95T Treadmill', stock: 3, price: 6995 }];
const USERS = [{ id: 'GS', name: 'Nick', access: 'superadmin' }];

beforeEach(() => {
  localStorage.setItem('token', TOKEN);
  localStorage.setItem('user', JSON.stringify({ id: 'GS', name: 'Nick', access: 'superadmin', roles: ['superadmin'] }));
  global.fetch = jest.fn(async (url) => {
    const u = String(url);
    const body = u.includes('/api/products') ? PRODUCTS : u.includes('/api/users') ? USERS : [];
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  });
});

afterEach(() => {
  localStorage.clear();
  jest.clearAllMocks();
});

// --- the rule, over real DOM nodes -----------------------------------------------------------
//
// Deliberately not imported from the smoke script: that module runs its whole suite at import
// time. These are the DOM equivalents — `classList` rather than a source parse.

/** Tailwind applies an unprefixed utility at every width; a prefixed one only from its breakpoint up. */
const baseUtility = (el, prefix) =>
  Array.from(el.classList).find((c) => c.startsWith(`${prefix}-`) && !c.includes(':'));

const baseGridCols = (el) => {
  if (!el.classList.contains('grid') && !el.classList.contains('inline-grid')) return null;
  const cls = baseUtility(el, 'grid-cols');
  const n = cls ? Number(cls.slice('grid-cols-'.length)) : NaN;
  return Number.isInteger(n) && n >= 2 ? n : null;
};

const baseColSpan = (el, cols) => {
  if (el.classList.contains('col-span-full')) return cols;
  const cls = baseUtility(el, 'col-span');
  const n = cls ? Number(cls.slice('col-span-'.length)) : NaN;
  return Number.isInteger(n) ? n : 1;
};

const CONTROLS = 'input, select, textarea';

/** Every form control the rendered page puts in less than a third of a base-tier grid row. */
function crushedControls(container) {
  const out = [];
  for (const grid of container.querySelectorAll('*')) {
    const cols = baseGridCols(grid);
    if (!cols) continue;
    for (const child of grid.children) {
      const control = child.matches(CONTROLS) ? child : child.querySelector(CONTROLS);
      if (!control) continue;
      const span = baseColSpan(child, cols);
      if (span * 3 < cols) {
        out.push(`${control.tagName.toLowerCase()}[${control.placeholder || control.name || ''}] in ${span}/${cols}`);
      }
    }
  }
  return out;
}

const renderPage = () => render(<MemoryRouter><CreateWorkorderPage /></MemoryRouter>);

describe('F19 incr 2e — no form control is crushed into a sliver of a row on a phone', () => {
  test('the create-workorder item row stacks at the base tier', async () => {
    const { container } = renderPage();
    const qty = await screen.findByPlaceholderText('Qty');

    // Without this the assertion below could pass on a page that rendered no row at all — the
    // shape of vacuous green this project keeps finding. The row must exist AND be a grid.
    const row = qty.parentElement;
    expect(row.classList.contains('grid')).toBe(true);

    expect(crushedControls(container)).toEqual([]);
  });

  test('the row still restores its five columns above the phone breakpoint', async () => {
    // The cheapest way to make the test above pass is to delete the desktop layout. Chrome at
    // 1280px measured the original row at 1104px with tracks 437/214/214/214, and it must keep
    // them: `md:` and not `sm:` because 640px was measured with the Condition select still
    // clipped (100px box, 128px of content).
    renderPage();
    const row = (await screen.findByPlaceholderText('Qty')).parentElement;

    expect(row.classList.contains('md:grid-cols-5')).toBe(true);
    const productCell = row.firstElementChild;
    expect(productCell.querySelector('input')).toHaveAttribute('placeholder', 'Search product...');
    expect(productCell.classList.contains('md:col-span-2')).toBe(true);
  });

  test('the row still renders every control it had', async () => {
    renderPage();

    expect(await screen.findByPlaceholderText('Qty')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search product...')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search technician...')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('option', { name: 'Select Condition' })).toBeInTheDocument());
  });
});
