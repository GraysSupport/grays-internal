import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ToBeBookedPage from '../delivery_operations/to-be-booked';
import SchedulePage from '../delivery_operations/schedule';
import CompletedDeliveriesPage from '../delivery_operations/completed-deliveries';
import CurrentCollectionsPage from '../delivery_operations/current-collections';
import CompletedCollectionsPage from '../delivery_operations/completed-collections';
import CollectionDetailPage from '../delivery_operations/collections/[id]';
import DeliveryTabs from '../../components/DeliveryTabs';

// G24 (owner, 2 Nov 2026) — technicians may look at To Be Booked, the Delivery Schedule and
// Deliveries Completed, but change nothing. The balance is Paid / Outstanding only (no dollars),
// and delivery charged vs quoted is not shown. They don't get the collections tabs.

jest.mock('react-hot-toast', () => {
  const t = Object.assign(jest.fn(), { success: jest.fn(), error: jest.fn(), loading: jest.fn(() => 'id') });
  return { __esModule: true, default: t, toast: t, Toaster: () => null };
});

function login({ id, access, roles }) {
  const b64 = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  localStorage.setItem('token', `${b64({ alg: 'none' })}.${b64({ id, roles })}.sig`);
  localStorage.setItem('user', JSON.stringify({ id, name: id, access, roles }));
}
const TECH = { id: 'ED', access: 'technician', roles: ['technician'] };
const WK = { id: 'WK', access: 'admin', roles: ['admin'] };
const ADMIN = { id: 'GA', access: 'admin', roles: ['admin'] };

const BASE = {
  workorder_id: 41, invoice_id: '19422', customer_name: 'Dana Customer', delivery_suburb: 'Altona North',
  delivery_state: 'VIC', removalist_id: 3, removalist_name: 'Jets', delivery_date: '2026-11-05',
  delivery_type: 'Standard', items_text: '1 × Life Fitness 95X (Reco)',
};
// What the server sends a workshop login: redacted, with balance_status instead of the amount.
const AS_TECH = (status, balance) => ({ ...BASE, delivery_id: 9, delivery_status: status, balance_status: balance });
// What it sends an admin.
const AS_ADMIN = (status) => ({
  ...BASE, delivery_id: 9, delivery_status: status, customer_id: 7, outstanding_balance: '1795.00',
  delivery_charged: '150', delivery_quoted: '120', notes: 'Call 0400 000 000', free_delivery: false, cash_to_removalist: false,
});

function installFetch(deliveries) {
  const mock = jest.fn(async (url) => {
    const u = String(url);
    let body = [];
    if (u.startsWith('/api/delivery?include_removalists')) body = { deliveries, removalists: [{ id: 3, name: 'Jets' }] };
    else if (u.includes('resource=run-order')) body = { available: false };
    else if (u.includes('resource=board-notes')) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  });
  global.fetch = mock;
  return mock;
}
const calls = (mock, re) => mock.mock.calls.filter(([u]) => re.test(String(u)));

function renderAt(path, element) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={path} element={element} />
        <Route path="*" element={<div>ELSEWHERE</div>} />
      </Routes>
    </MemoryRouter>
  );
}

// No way to change anything: no inputs, selects, textareas or checkboxes in the table, and no
// money anywhere on the page.
function expectReadOnlyTable(table) {
  const t = within(table);
  expect(t.queryAllByRole('textbox')).toHaveLength(0);
  expect(t.queryAllByRole('combobox')).toHaveLength(0);
  expect(t.queryAllByRole('spinbutton')).toHaveLength(0);
  expect(t.queryAllByRole('checkbox')).toHaveLength(0);
  expect(table.querySelectorAll('input, select, textarea')).toHaveLength(0);
  for (const h of ['Delivery Charged', 'Delivery Quoted', 'Margin', 'Notes']) {
    expect(t.queryByRole('columnheader', { name: h })).not.toBeInTheDocument();
  }
  expect(table.textContent).not.toMatch(/\$/);
}

beforeEach(() => localStorage.clear());

describe('delivery tabs', () => {
  test('a technician gets the three delivery tabs, not the collections tabs', () => {
    login(TECH);
    renderAt('/delivery_operations', <DeliveryTabs />);
    for (const tab of ['Current Operations', 'To Be Booked', 'Delivery Schedule', 'Operations Completed', 'Deliveries Completed']) {
      expect(screen.getByRole('link', { name: tab })).toBeInTheDocument();
    }
    expect(screen.queryByRole('link', { name: 'Current Collections' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Collections Completed' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /temporary delivery run/i })).not.toBeInTheDocument();
  });

  test('an admin keeps the collections tabs', () => {
    login(ADMIN);
    renderAt('/delivery_operations', <DeliveryTabs />);
    expect(screen.getByRole('link', { name: 'Current Collections' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Collections Completed' })).toBeInTheDocument();
  });
});

describe('To Be Booked — technician (view only)', () => {
  test('identifies itself so the server hides the money; no per-workorder look-ups', async () => {
    login(TECH);
    const f = installFetch([AS_TECH('To Be Booked', 'Outstanding')]);
    renderAt('/delivery_operations/to-be-booked', <ToBeBookedPage />);
    await screen.findByText('Dana Customer');
    const [, opts] = calls(f, /include_removalists/)[0];
    expect(opts.headers['X-User-Id']).toBe('ED');
    expect(opts.headers.Authorization).toMatch(/^Bearer /);
    expect(calls(f, /\/api\/workorder\?id=/)).toHaveLength(0);
  });

  test('shows the job, carrier, date, status and Outstanding — and nothing to change', async () => {
    login(TECH);
    installFetch([AS_TECH('To Be Booked', 'Outstanding')]);
    renderAt('/delivery_operations/to-be-booked', <ToBeBookedPage />);
    await screen.findByText('Dana Customer');
    const table = screen.getByRole('table');
    expect(within(table).getByText('1 × Life Fitness 95X (Reco)')).toBeInTheDocument();
    expect(within(table).getByText('Jets')).toBeInTheDocument();
    expect(within(table).getByText('Outstanding')).toBeInTheDocument();
    expect(within(table).getByText('To Be Booked')).toBeInTheDocument();
    expect(within(table).getByText(/5 Nov 2026/)).toBeInTheDocument();
    expect(within(table).queryByRole('button', { name: /evidence/i })).not.toBeInTheDocument();
    expectReadOnlyTable(table);
    expect(screen.getByText(/view only/i)).toBeInTheDocument();
  });

  test('the WK kiosk gets the same view-only page', async () => {
    login(WK);
    installFetch([AS_TECH('To Be Booked', 'Paid')]);
    renderAt('/delivery_operations/to-be-booked', <ToBeBookedPage />);
    await screen.findByText('Dana Customer');
    expect(within(screen.getByRole('table')).getByText('Paid')).toBeInTheDocument();
    expectReadOnlyTable(screen.getByRole('table'));
  });

  test('a delivery with no workorder balance shows no payment status', async () => {
    login(TECH);
    installFetch([{ ...AS_TECH('To Be Booked', null), workorder_id: null }]);
    renderAt('/delivery_operations/to-be-booked', <ToBeBookedPage />);
    await screen.findByText('Dana Customer');
    const t = within(screen.getByRole('table'));
    expect(t.queryByText('Paid')).not.toBeInTheDocument();
    expect(t.queryByText('Outstanding')).not.toBeInTheDocument();
  });
});

describe('Delivery Schedule — technician (view only)', () => {
  test('booked jobs are listed with Paid / Outstanding and nothing to change or reorder', async () => {
    login(TECH);
    const f = installFetch([AS_TECH('Booked for Delivery', 'Paid')]);
    renderAt('/delivery_operations/schedule', <SchedulePage />);
    await screen.findAllByText('Dana Customer'); // the screen table + the (hidden) print sheet
    expect(calls(f, /include_removalists/)[0][1].headers['X-User-Id']).toBe('ED');
    expect(calls(f, /\/api\/workorder\?id=/)).toHaveLength(0);
    const table = screen.getAllByRole('table')[0];
    expect(within(table).getByText('Paid')).toBeInTheDocument();
    expect(within(table).getByText('Booked for Delivery')).toBeInTheDocument();
    expect(within(table).queryByRole('button', { name: /move/i })).not.toBeInTheDocument();
    expectReadOnlyTable(table);
  });
});

describe('Deliveries Completed — technician (view only)', () => {
  test('completed jobs are listed with Paid and nothing to change', async () => {
    login(TECH);
    installFetch([AS_TECH('Delivery Completed', 'Paid')]);
    renderAt('/delivery_operations/completed-deliveries', <CompletedDeliveriesPage />);
    await screen.findByText('Dana Customer');
    const table = screen.getByRole('table');
    expect(within(table).getByText('Paid')).toBeInTheDocument();
    expect(within(table).getByText('Delivery Completed')).toBeInTheDocument();
    expectReadOnlyTable(table);
  });
});

describe('view-only holds even when more arrives than expected (review)', () => {
  test('the WK kiosk (an admin login) gets no board-notes editor', async () => {
    login(WK);
    const f = installFetch([AS_TECH('To Be Booked', 'Paid')]);
    const base = f.getMockImplementation();
    f.mockImplementation(async (url, opts) => (String(url).includes('resource=board-notes')
      ? { ok: true, status: 200, json: async () => ({ available: true, body: 'Driver in Thursday 9am', version: 3 }) }
      : base(url, opts)));
    renderAt('/delivery_operations/to-be-booked', <ToBeBookedPage />);
    expect(await screen.findByText('Driver in Thursday 9am')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit notes/i })).not.toBeInTheDocument();
  });

  test('Deliveries Completed draws no money even if the server sent full rows', async () => {
    login(TECH);
    installFetch([{ ...AS_ADMIN('Delivery Completed'), balance_status: 'Outstanding', free_delivery: true, cash_to_removalist: true, installation_cost: '80' }]);
    renderAt('/delivery_operations/completed-deliveries', <CompletedDeliveriesPage />);
    await screen.findByText('Dana Customer');
    const table = screen.getByRole('table');
    expectReadOnlyTable(table);
    expect(within(table).queryByText('FREE')).not.toBeInTheDocument();
    expect(within(table).queryByText('CASH')).not.toBeInTheDocument();
    expect(table.textContent).not.toMatch(/1795|0400/);
  });

  test('To Be Booked and the Schedule draw no money even if the server sent full rows', async () => {
    login(TECH);
    installFetch([{ ...AS_ADMIN('To Be Booked'), balance_status: 'Outstanding' }]);
    const { unmount } = renderAt('/delivery_operations/to-be-booked', <ToBeBookedPage />);
    await screen.findByText('Dana Customer');
    expectReadOnlyTable(screen.getByRole('table'));
    expect(screen.getByRole('table').textContent).not.toMatch(/1795|0400/);
    unmount();
    installFetch([{ ...AS_ADMIN('Booked for Delivery'), balance_status: 'Outstanding' }]);
    renderAt('/delivery_operations/schedule', <SchedulePage />);
    await screen.findAllByText('Dana Customer');
    for (const table of screen.getAllByRole('table')) {
      expect(table.textContent).not.toMatch(/\$|1795|0400/);
    }
  });
});

describe('admins are unchanged', () => {
  test('To Be Booked keeps the money columns and the editors', async () => {
    login(ADMIN);
    installFetch([AS_ADMIN('To Be Booked')]);
    renderAt('/delivery_operations/to-be-booked', <ToBeBookedPage />);
    await screen.findByText('Dana Customer');
    const t = within(screen.getByRole('table'));
    expect(t.getByRole('columnheader', { name: 'Delivery Charged' })).toBeInTheDocument();
    expect(t.getByRole('columnheader', { name: 'Notes' })).toBeInTheDocument();
    expect(t.getAllByRole('combobox').length).toBeGreaterThan(0);
    expect(screen.queryByText(/view only/i)).not.toBeInTheDocument();
  });

  test('Deliveries Completed keeps the money columns', async () => {
    login(ADMIN);
    installFetch([AS_ADMIN('Delivery Completed')]);
    renderAt('/delivery_operations/completed-deliveries', <CompletedDeliveriesPage />);
    await screen.findByText('Dana Customer');
    expect(screen.getByRole('columnheader', { name: 'Delivery Quoted' })).toBeInTheDocument();
  });
});

describe('collections — not for technicians', () => {
  test.each([
    ['/delivery_operations/current-collections', <CurrentCollectionsPage />],
    ['/delivery_operations/completed-collections', <CompletedCollectionsPage />],
  ])('%s: not available, and nothing is fetched', (path, page) => {
    login(TECH);
    const f = installFetch([]);
    renderAt(path, page);
    expect(screen.getByText(/not available to workshop logins/i)).toBeInTheDocument();
    expect(calls(f, /collections/)).toHaveLength(0);
  });

  test('a collection typed in by address: not available either (review)', () => {
    login(TECH);
    const f = installFetch([]);
    render(
      <MemoryRouter initialEntries={['/delivery_operations/collections/5']}>
        <Routes><Route path="/delivery_operations/collections/:id" element={<CollectionDetailPage />} /></Routes>
      </MemoryRouter>
    );
    expect(screen.getByText(/not available to workshop logins/i)).toBeInTheDocument();
    expect(calls(f, /collections/)).toHaveLength(0);
  });
});
