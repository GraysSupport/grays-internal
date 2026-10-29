// G19 (owner, 29 Oct 2026) — "when logged in as technicians or workshop or any other roles aside
// from superadmin, admin, logistics and sales, the statistics in the home page doesn't seem to be
// showing any numbers from the workorders, stock etc. Fix this as a priority."
//
// THE BUG: G17 made the dashboard skip ALL its data loads for a workshop login (technician /
// workshop role / the WK kiosk), but still drew the "Delivery & Operations" panel — so every card
// read 0. And the five loads were one Promise.all: one refused or failing endpoint blanked the
// numbers from the other four as well.
//
// WHAT THESE TESTS PIN:
//  - workshop logins see real job + stock counts (not zeros);
//  - they still never load or see the waitlist (customer email + phone — G17 stays intact), and
//    their workorder / delivery loads identify the caller so the server redacts money + contact;
//  - one failing endpoint only hides its own cards, and says so instead of showing a fake 0.

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Dashboard from '../dashboard';

const PAST = '2020-01-15';
const FUTURE = '2099-01-15';
const todayISO = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const DATA = {
  products: [
    { sku: 'A', name: 'Treadmill', stock: 2, price: 1795 },
    { sku: 'B', name: 'Rower', stock: 0, price: 995 },
    { sku: 'C', name: 'Bench', stock: 5, price: 295 },
  ],
  waitlist: [{ product_sku: 'B', customer_id: 7, stock: 0, coming_in_date: FUTURE }],
  workorder: [
    { workorder_id: 1, status: 'Work Ordered', estimated_completion: PAST, important_flag: true, date_created: new Date().toISOString() },
    { workorder_id: 2, status: 'Work Ordered', estimated_completion: FUTURE, important_flag: false, date_created: new Date().toISOString() },
    { workorder_id: 3, status: 'Completed', estimated_completion: PAST, important_flag: true, date_created: new Date().toISOString() },
  ],
  delivery: [
    { delivery_id: 1, delivery_status: 'To Be Booked', delivery_state: 'VIC' },
    { delivery_id: 2, delivery_status: 'To Be Booked', delivery_state: 'NSW' },
    { delivery_id: 3, delivery_status: 'Booked for Delivery', delivery_date: todayISO(), removalist_id: 3 },
  ],
  collections: [],
};

const KEYS = ['products', 'waitlist', 'workorder', 'delivery', 'collections'];
const keyOf = (url) => KEYS.find((k) => String(url).includes(`/api/${k}`));

/** fetch mock: every endpoint answers with DATA, except the ones listed in `fail` (HTTP 500). */
function mockFetch({ fail = [] } = {}) {
  return jest.fn(async (url) => {
    const key = keyOf(url);
    if (fail.includes(key)) {
      return { ok: false, status: 500, json: async () => ({ error: 'boom' }), text: async () => 'boom' };
    }
    const body = key ? DATA[key] : {};
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  });
}

function renderAs(user) {
  localStorage.setItem('user', JSON.stringify(user));
  return render(
    <MemoryRouter>
      <Dashboard />
    </MemoryRouter>,
  );
}

/** The number shown on an analytics card, by its heading. */
const card = (label) => screen.getByRole('heading', { name: label, level: 3 }).parentElement;
const cardValue = (label) => card(label).querySelector('p').textContent;
const fetchedKeys = () => global.fetch.mock.calls.map(([url]) => keyOf(url));
const callFor = (key) => global.fetch.mock.calls.find(([url]) => keyOf(url) === key);

const TECHNICIAN = { id: 'TC', name: 'Tech', access: 'technician', roles: ['technician'] };
const WORKSHOP = { id: 'WS', name: 'Workshop', access: 'staff', roles: ['workshop'] };
const WK = { id: 'WK', name: 'Workshop kiosk', access: 'admin', roles: ['admin'] };
const STAFF = { id: 'ST', name: 'Staff', access: 'staff', roles: ['staff'] };
const SUPERADMIN = { id: 'NK', name: 'Nick', access: 'superadmin', roles: ['superadmin'] };

beforeEach(() => {
  global.fetch = mockFetch();
});

afterEach(() => {
  localStorage.clear();
  jest.resetAllMocks();
});

describe.each([
  ['a technician', TECHNICIAN],
  ['the workshop role', WORKSHOP],
  ['the WK kiosk (an admin login, restricted by id)', WK],
])('G19 — %s sees real numbers, not zeros', (_name, who) => {
  test('workorder, delivery and stock counts are filled in', async () => {
    renderAs(who);
    await waitFor(() => expect(cardValue('Active Workorders')).toBe('2'));
    expect(cardValue('Past Target (Active WOs)')).toBe('1');
    expect(cardValue('Important Workorders')).toBe('1');
    expect(cardValue('Deliveries Today (Booked)')).toBe('1');
    expect(cardValue('Total Products')).toBe('3');
    expect(cardValue('In Stock')).toBe('2');
    expect(cardValue('Out of Stock')).toBe('1');
    expect(screen.getByText(/To Be Booked Deliveries:/).parentElement).toHaveTextContent('2');
  });

  test('the waitlist is never loaded or shown (customer contact — G17)', async () => {
    renderAs(who);
    await waitFor(() => expect(cardValue('Active Workorders')).toBe('2'));
    expect(fetchedKeys()).not.toContain('waitlist');
    expect(screen.queryByRole('heading', { name: /waitlist/i })).not.toBeInTheDocument();
  });

  test('workorder and delivery loads identify the caller so the server redacts money', async () => {
    renderAs(who);
    await waitFor(() => expect(cardValue('Active Workorders')).toBe('2'));
    for (const key of ['workorder', 'delivery']) {
      const [, init] = callFor(key);
      expect(init.headers['X-User-Id']).toBe(who.id);
    }
  });

  test('cards do not link to pages a workshop login cannot open', async () => {
    renderAs(who);
    await waitFor(() => expect(cardValue('Active Workorders')).toBe('2'));
    expect(card('Total Products')).not.toHaveClass('cursor-pointer');
    expect(card('Active Workorders')).not.toHaveClass('cursor-pointer');
  });
});

describe('G19 — office logins are unchanged', () => {
  test('a superadmin still gets every card, waitlist included', async () => {
    renderAs(SUPERADMIN);
    await waitFor(() => expect(cardValue('Active Workorders')).toBe('2'));
    expect(cardValue('Total Waitlist Entries')).toBe('1');
    expect(cardValue('Total Products')).toBe('3');
    expect(card('Active Workorders')).toHaveClass('cursor-pointer');
  });

  test('a staff login gets the full dashboard', async () => {
    renderAs(STAFF);
    await waitFor(() => expect(cardValue('Total Waitlist Entries')).toBe('1'));
    expect(cardValue('Active Workorders')).toBe('2');
  });
});

describe('G19 — one failing source only hides its own numbers', () => {
  test('a failing waitlist does not blank the workorder and stock cards', async () => {
    global.fetch = mockFetch({ fail: ['waitlist'] });
    renderAs(SUPERADMIN);
    await waitFor(() => expect(cardValue('Active Workorders')).toBe('2'));
    expect(cardValue('Total Products')).toBe('3');
    expect(cardValue('Total Waitlist Entries')).toMatch(/not available/i);
  });

  test('a failing workorder load says so instead of showing 0', async () => {
    global.fetch = mockFetch({ fail: ['workorder'] });
    renderAs(TECHNICIAN);
    await waitFor(() => expect(cardValue('Total Products')).toBe('3'));
    expect(cardValue('Active Workorders')).toMatch(/not available/i);
    expect(cardValue('Deliveries Today (Booked)')).toBe('1');
  });
});
