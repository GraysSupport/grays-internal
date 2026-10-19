import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import WorkorderDetailPage from '../delivery_operations/workorder/[id]';
import ActiveWorkordersPage from '../delivery_operations/index';
import CustomersPage from '../customers/index';
import WaitlistPage from '../waitlist/index';
import DeliveryTabs from '../../components/DeliveryTabs';
import { isWorkshopRestricted } from '../../utils/workshopAccess';

// G17 (Nick, 19 Oct 2026) — technicians, the workshop role and the WK kiosk see the job, not the
// money, and may only change item status (never Canceled) and serials.

jest.mock('react-hot-toast', () => {
  const t = Object.assign(jest.fn(), { success: jest.fn(), error: jest.fn(), loading: jest.fn(() => 'id') });
  return { __esModule: true, default: t, toast: t, Toaster: () => null };
});

// What the SERVER sends a workshop login (already redacted) vs an admin.
const WO_ADMIN = {
  workorder_id: 41, invoice_id: '19422', customer_id: 7, customer_name: 'Dana Customer', salesperson: 'GA',
  status: 'Work Ordered', delivery_suburb: 'Altona North', delivery_state: 'VIC', estimated_completion: '2026-10-24',
  date_created: '2026-10-01T00:00:00.000Z', notes: 'Paint frame', important_flag: false,
  outstanding_balance: '1795', delivery_charged: '150', delivery_type: 'Standard',
  items: [{ workorder_items_id: 2001, product_id: 'LF-95X', product_name: 'Life Fitness 95X', quantity: 1, condition: 'Reco', technician_id: 'ED', status: 'In Workshop', item_sn: 'SN1', is_custom: false }],
  activity: [],
};
const { outstanding_balance, delivery_charged, customer_id, ...WO_WORKSHOP } = WO_ADMIN;

function login({ id, access, roles, email }) {
  const b64 = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  localStorage.setItem('token', `${b64({ alg: 'none' })}.${b64({ id, roles })}.sig`);
  localStorage.setItem('user', JSON.stringify({ id, name: id, access, roles, email: email || `${id}@graysfitness.com.au` }));
}
const TECH = { id: 'ED', access: 'technician', roles: ['technician'] };
// No kiosk email here on purpose: the id alone must restrict WK (review finding — the old page
// rule matched the email, so a test with the email would pass without the new id rule).
const WK = { id: 'WK', access: 'admin', roles: ['admin'], email: 'wk-other@graysfitness.com.au' };
const ADMIN = { id: 'GA', access: 'admin', roles: ['admin'] };

function installFetch(wo) {
  const mock = jest.fn(async (url, opts = {}) => {
    const u = String(url);
    let body = [];
    if (u.startsWith('/api/workorder?id=')) body = wo;
    else if (u.startsWith('/api/workorder?status=')) body = [{ ...wo, items: wo.items }];
    else if (u.startsWith('/api/workorder?technicians')) body = [{ id: 'ED', name: 'Eden' }, { id: 'TB', name: 'Toby' }];
    else if (u.startsWith('/api/users')) body = [{ id: 'GA', name: 'Vincent' }, { id: 'ED', name: 'Eden' }];
    if (opts.method === 'PUT') body = wo;
    return { ok: true, status: 200, json: async () => body };
  });
  global.fetch = mock;
  return mock;
}
const calls = (mock, re) => mock.mock.calls.filter(([u]) => re.test(String(u)));

function renderAt(path, element, route) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={route} element={element} />
        <Route path="*" element={<div>ELSEWHERE</div>} />
      </Routes>
    </MemoryRouter>
  );
}
const openWorkorder = () => renderAt('/delivery_operations/workorder/41', <WorkorderDetailPage />, '/delivery_operations/workorder/:id');

beforeEach(() => localStorage.clear());

test('who counts as a workshop login', () => {
  expect(isWorkshopRestricted(TECH, TECH.roles)).toBe(true);
  expect(isWorkshopRestricted(WK, WK.roles)).toBe(true);
  expect(isWorkshopRestricted({ id: 'WS', access: 'staff' }, ['workshop'])).toBe(true);
  expect(isWorkshopRestricted(ADMIN, ADMIN.roles)).toBe(false);
  expect(isWorkshopRestricted({ id: 'MX', access: 'technician' }, ['technician', 'logistics'])).toBe(false);
  expect(isWorkshopRestricted({ id: 'OL', access: 'technician' }, [])).toBe(true); // pre-roles session
});

describe('workorder page — technician', () => {
  test('identifies itself to the server (token + user id)', async () => {
    login(TECH);
    const f = installFetch(WO_WORKSHOP);
    openWorkorder();
    await screen.findByText(/Invoice #19422/);
    const [, opts] = calls(f, /^\/api\/workorder\?id=/)[0];
    expect(opts.headers.Authorization).toMatch(/^Bearer /);
    expect(opts.headers['X-User-Id']).toBe('ED');
  });

  test('no money, no customer contact, nothing to add, remove or reopen', async () => {
    login(TECH);
    installFetch(WO_WORKSHOP);
    openWorkorder();
    await screen.findByText(/Invoice #19422/);
    expect(screen.getByText('Dana Customer')).toBeInTheDocument();
    expect(screen.queryByText(/View \/ Edit/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Payment Status/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Outstanding Balance/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Delivery Charged/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Add Product' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /mark important/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Workorder Status/)).not.toBeInTheDocument();
  });

  test('salesperson, target date, technician and notes are read-only', async () => {
    login(TECH);
    installFetch(WO_WORKSHOP);
    openWorkorder();
    await screen.findByText(/Invoice #19422/);
    fireEvent.click(screen.getByText('GA'));
    expect(screen.queryByText('Select Salesperson')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(/Expected Completion Date/));
    expect(document.querySelector('input[type="date"]')).toBeNull();
    expect(screen.queryByText('Select tech')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Notes')).toHaveAttribute('readonly');
  });

  test('item status offers the three workshop statuses, never Canceled', async () => {
    login(TECH);
    installFetch(WO_WORKSHOP);
    openWorkorder();
    await screen.findByText(/Invoice #19422/);
    const status = screen.getByDisplayValue('In Workshop');
    const options = within(status).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Not in Workshop', 'In Workshop', 'Completed']);
  });

  test('Save sends only item status + serial', async () => {
    login(TECH);
    const f = installFetch(WO_WORKSHOP);
    openWorkorder();
    await screen.findByText(/Invoice #19422/);
    fireEvent.change(screen.getByDisplayValue('In Workshop'), { target: { value: 'Completed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls(f, /^\/api\/workorder\?id=/).some(([, o]) => o?.method === 'PUT')).toBe(true));
    const [, put] = calls(f, /^\/api\/workorder\?id=/).find(([, o]) => o?.method === 'PUT');
    const body = JSON.parse(put.body);
    expect(Object.keys(body)).toEqual(['items']);
    expect(body.items).toEqual([{ workorder_items_id: 2001, status: 'Completed', item_sn: 'SN1' }]);
    expect(put.headers['X-User-Id']).toBe('ED');
  });

  test('the WK kiosk gets the same view', async () => {
    login(WK);
    installFetch(WO_WORKSHOP);
    openWorkorder();
    await screen.findByText(/Invoice #19422/);
    expect(screen.queryByRole('button', { name: '+ Add Product' })).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Notes')).toHaveAttribute('readonly');
  });
});

describe('workorder page — admin (unchanged)', () => {
  test('admin keeps every control', async () => {
    login(ADMIN);
    installFetch(WO_ADMIN);
    openWorkorder();
    await screen.findByText(/Invoice #19422/);
    expect(screen.getByRole('button', { name: '+ Add Product' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    expect(screen.getByText(/Payment Status/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Notes')).not.toHaveAttribute('readonly');
    const options = within(screen.getByDisplayValue('In Workshop')).getAllByRole('option').map((o) => o.textContent);
    expect(options).toContain('Canceled');
  });
});

describe('lists, tabs and customers', () => {
  test('active workorders: no Payment column/filter or Create link for a technician', async () => {
    login(TECH);
    const f = installFetch(WO_WORKSHOP);
    renderAt('/delivery_operations', <ActiveWorkordersPage />, '/delivery_operations');
    await screen.findByText('Dana Customer');
    expect(screen.queryByRole('columnheader', { name: 'Payment' })).not.toBeInTheDocument();
    expect(screen.queryByText('All Payments')).not.toBeInTheDocument();
    expect(screen.queryByText(/Create New Work Order/)).not.toBeInTheDocument();
    const [, opts] = calls(f, /^\/api\/workorder\?status=/)[0];
    expect(opts.headers['X-User-Id']).toBe('ED');
  });

  test('active workorders: admin still has the Payment column', async () => {
    login(ADMIN);
    installFetch(WO_ADMIN);
    renderAt('/delivery_operations', <ActiveWorkordersPage />, '/delivery_operations');
    await screen.findByText('Dana Customer');
    expect(screen.getByRole('columnheader', { name: 'Payment' })).toBeInTheDocument();
  });

  test('delivery tabs: booking + money tabs hidden for workshop logins', () => {
    login(TECH);
    renderAt('/delivery_operations', <DeliveryTabs />, '/delivery_operations');
    expect(screen.getByText('Current Operations')).toBeInTheDocument();
    expect(screen.queryByText('To Be Booked')).not.toBeInTheDocument();
    expect(screen.queryByText('Delivery Schedule')).not.toBeInTheDocument();
    expect(screen.queryByText('Deliveries Completed')).not.toBeInTheDocument();
    expect(screen.getByText('Operations Completed')).toBeInTheDocument();
  });

  test('waitlist page (customer email + phone): not available, and nothing is fetched', () => {
    login(WK);
    const f = installFetch(WO_WORKSHOP);
    renderAt('/waitlist', <WaitlistPage />, '/waitlist');
    expect(screen.getByText(/not available to workshop logins/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to the workshop view/i })).toHaveAttribute('href', '/workshop');
    expect(calls(f, /\/api\/waitlist/)).toHaveLength(0);
  });

  test('a completed workorder: workshop logins cannot change item status', async () => {
    login(TECH);
    installFetch({ ...WO_WORKSHOP, status: 'Completed', items: [{ ...WO_WORKSHOP.items[0], status: 'Completed' }] });
    openWorkorder();
    await screen.findByText(/Invoice #19422/);
    expect(screen.getByDisplayValue('Completed')).toBeDisabled();
  });

  test('customers page: not available, and nothing is fetched', () => {
    login(TECH);
    const f = installFetch(WO_WORKSHOP);
    renderAt('/customers', <CustomersPage />, '/customers');
    expect(screen.getByText(/not available to workshop logins/i)).toBeInTheDocument();
    expect(calls(f, /\/api\/customers/)).toHaveLength(0);
  });
});
