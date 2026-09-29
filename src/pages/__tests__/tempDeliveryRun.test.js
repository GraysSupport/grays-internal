// G8 (Nick, 28 Sep 2026) — "Create temporary delivery run".
//
// THE HARD RULE this file exists to pin: planning a run must not create, update or delete any
// workorder, workorder item, delivery or log row. The planner is browser-only; its one server
// call is a gated GET. The "zero write requests" test drives a whole planning session — load,
// add, reorder, name the carrier, pick a day, print, export, clear — and then asserts every
// request the page made was a GET to the read-only candidates endpoint. The server half (that
// endpoint issues exactly three SELECTs) is pinned in scripts/ops-temp-run-smoke.mjs.

import React from 'react';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TempDeliveryRunPage from '../delivery_operations/temp-run';
import DeliveryTabs from '../../components/DeliveryTabs';
import { PLAN_STORAGE_KEY } from '../../utils/tempRun';

const CANDIDATES = {
  deliveries: [
    { delivery_id: 101, workorder_id: 9, invoice_id: '20431', customer_name: 'Dana Delivery', customer_phone: '0400 000 000', customer_address: '1 Test St', delivery_suburb: 'Altona North', delivery_state: 'VIC', items_text: '1.00 × Treadmill (Grade A)', notes: 'Rear access' },
  ],
  workorders: [
    { workorder_id: 12, invoice_id: '20500', customer_name: 'Wes Workorder', customer_phone: '0411 111 111', customer_address: '2 Test Rd', delivery_suburb: 'Geelong', delivery_state: 'VIC', items_text: '2.00 × Dumbbell rack', notes: 'Owes $200 — chase' },
    { workorder_id: 13, invoice_id: '20501', customer_name: 'Ola Other', customer_phone: '0422 222 222', customer_address: '3 Test Ave', delivery_suburb: 'Werribee', delivery_state: 'VIC', items_text: '1.00 × Bench', notes: null },
  ],
  removalists: [
    { id: 1, name: 'Cobbs' },
    { id: 2, name: 'Customer Collect' },
    { id: 3, name: 'Nelson' },
  ],
};

// The left panel shows ONE source at a time; these flip it (Nick's feedback, 29 Sep 2026).
const showCurrentOps = () => fireEvent.click(screen.getByRole('button', { name: /^Current operations/ }));
const showToBeBooked = () => fireEvent.click(screen.getByRole('button', { name: /^To be booked/ }));

// base64url JWT payload so utils/auth.getRoles() reads the roles the way it does in the app.
function tokenFor(roles) {
  const b64 = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'none' })}.${b64({ id: 'LG', roles })}.sig`;
}

function login(roles) {
  localStorage.setItem('token', tokenFor(roles));
  localStorage.setItem('user', JSON.stringify({ id: 'LG', name: 'Logan', access: roles[0], roles }));
}

function installFetch(body = CANDIDATES, status = 200) {
  const fn = jest.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }));
  global.fetch = fn;
  return fn;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/delivery_operations/temp-run']}>
      <TempDeliveryRunPage />
    </MemoryRouter>
  );
}

let openedHtml;
let csvBlobs;
let downloads;
beforeEach(() => {
  downloads = [];
  // jsdom can't follow a blob: link; record the download instead of letting it navigate.
  jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click() { downloads.push(this.download); });
  localStorage.clear();
  openedHtml = '';
  csvBlobs = [];
  window.open = jest.fn(() => ({ document: { open() {}, write(h) { openedHtml += h; }, close() {} } }));
  window.confirm = jest.fn(() => true);
  global.URL.createObjectURL = jest.fn((blob) => { csvBlobs.push(blob); return 'blob:csv'; });
  global.URL.revokeObjectURL = jest.fn();
});

afterEach(() => jest.restoreAllMocks());

async function blobText(blob) {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.readAsText(blob);
  });
}

test('loads candidates from the gated read with the login token', async () => {
  login(['logistics']);
  const fetchMock = installFetch();
  renderPage();

  expect(await screen.findByText('Dana Delivery')).toBeInTheDocument();
  expect(screen.getByText(/Temporary run — not booked/)).toBeInTheDocument();

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe('/api/logistics?resource=run-candidates');
  expect(init.headers.Authorization).toMatch(/^Bearer /);
});

test('the left panel toggles between To be booked and Current operations, one list at a time', async () => {
  login(['logistics']);
  installFetch();
  renderPage();
  await screen.findByText('Dana Delivery');

  const tbb = screen.getByRole('button', { name: /^To be booked/ });
  const ops = screen.getByRole('button', { name: /^Current operations/ });
  expect(tbb).toHaveAttribute('aria-pressed', 'true');
  expect(ops).toHaveAttribute('aria-pressed', 'false');
  expect(tbb).toHaveTextContent('(1)');
  expect(ops).toHaveTextContent('(2)');
  expect(screen.queryByText('Wes Workorder')).toBeNull();

  showCurrentOps();
  expect(ops).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByText('Wes Workorder')).toBeInTheDocument();
  expect(screen.getByText('Ola Other')).toBeInTheDocument();
  expect(screen.queryByText('Dana Delivery')).toBeNull();

  showToBeBooked();
  expect(screen.getByText('Dana Delivery')).toBeInTheDocument();
  expect(screen.queryByText('Wes Workorder')).toBeNull();
});

test('the carrier is picked from our carriers list (Customer Collect is not a run carrier)', async () => {
  login(['logistics']);
  installFetch();
  renderPage();
  await screen.findByText('Dana Delivery');

  const select = screen.getByLabelText('Run 1 carrier');
  expect(select.tagName).toBe('SELECT');
  const options = [...select.options].map((o) => o.textContent);
  expect(options).toEqual(['Select carrier…', 'Cobbs', 'Nelson']);
  fireEvent.change(select, { target: { value: 'Nelson' } });
  expect(select).toHaveValue('Nelson');
});

test('a carrier saved before the list existed is kept, not silently blanked', async () => {
  login(['logistics']);
  localStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify({ runs: [{ id: 'run-x', carrier: 'Old Mate Transport', day: '', stops: [] }], stops: {} }));
  installFetch();
  renderPage();
  await screen.findByText('Dana Delivery');
  const select = screen.getByLabelText('Run 1 carrier');
  expect(select).toHaveValue('Old Mate Transport');
  expect([...select.options].map((o) => o.textContent)).toContain('Old Mate Transport (not in list)');
});

test('ZERO WRITE REQUESTS across a full planning session', async () => {
  login(['logistics']);
  const fetchMock = installFetch();
  // Not just fetch: any other way out of the browser counts as a request too.
  const xhrOpen = jest.spyOn(XMLHttpRequest.prototype, 'open');
  navigator.sendBeacon = jest.fn(() => true);
  renderPage();
  await screen.findByText('Dana Delivery');

  fireEvent.click(screen.getByRole('button', { name: /^Add Dana Delivery \(WO 9\) to run$/ }));
  showCurrentOps();
  fireEvent.click(screen.getByRole('button', { name: /^Add Wes Workorder \(WO 12\) to run$/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Move Wes Workorder up' }));
  fireEvent.change(screen.getByLabelText('Run 1 carrier'), { target: { value: 'Nelson' } });
  fireEvent.change(screen.getByLabelText('Run 1 day'), { target: { value: '2026-10-02' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add another run' }));
  fireEvent.change(screen.getByLabelText('Add stops to'), { target: { value: screen.getByLabelText('Add stops to').options[1].value } });
  fireEvent.click(screen.getByRole('button', { name: /^Add Ola Other \(WO 13\) to run$/ }));
  expect(within(screen.getByRole('list', { name: 'Run 2 stops' })).getByText('Ola Other')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Print run sheet' }));
  fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
  fireEvent.click(screen.getByRole('button', { name: 'Remove run 2' }));
  fireEvent.click(screen.getByRole('button', { name: 'Remove Dana Delivery' }));
  fireEvent.click(screen.getByRole('button', { name: 'Clear run' }));

  // The only request ever made: the one GET on mount.
  expect(fetchMock).toHaveBeenCalledTimes(1);
  for (const [url, init = {}] of fetchMock.mock.calls) {
    expect((init.method || 'GET').toUpperCase()).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(String(url)).toBe('/api/logistics?resource=run-candidates');
  }
  expect(xhrOpen).not.toHaveBeenCalled();
  expect(navigator.sendBeacon).not.toHaveBeenCalled();
});

test('stops are ordered, then printed and exported in that order', async () => {
  login(['superadmin']);
  installFetch();
  renderPage();
  await screen.findByText('Dana Delivery');

  fireEvent.click(screen.getByRole('button', { name: /^Add Dana Delivery \(WO 9\) to run$/ }));
  showCurrentOps();
  fireEvent.click(screen.getByRole('button', { name: /^Add Wes Workorder \(WO 12\) to run$/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Move Dana Delivery down' }));
  fireEvent.change(screen.getByLabelText('Run 1 carrier'), { target: { value: 'Nelson' } });

  const run = screen.getByRole('list', { name: 'Run 1 stops' });
  const names = within(run).getAllByTestId('stop-name').map((n) => n.textContent);
  expect(names).toEqual(['Wes Workorder', 'Dana Delivery']);

  // Added stops leave the "available" list — one customer can't go on two runs.
  showToBeBooked();
  expect(screen.queryByRole('button', { name: /^Add Dana Delivery \(WO 9\) to run$/ })).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Print run sheet' }));
  expect(openedHtml.indexOf('Wes Workorder')).toBeGreaterThan(-1);
  expect(openedHtml.indexOf('Wes Workorder')).toBeLessThan(openedHtml.indexOf('Dana Delivery'));
  expect(openedHtml).toContain('1300 769 556');

  fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
  expect(csvBlobs).toHaveLength(1);
  expect(downloads).toEqual([expect.stringMatching(/^temporary-delivery-run-\d{4}-\d{2}-\d{2}\.csv$/)]);
  const csv = await blobText(csvBlobs[0]);
  const rows = csv.trim().split('\r\n');
  expect(rows[1]).toMatch(/^1,Nelson,,1,Wes Workorder,0411 111 111,/);
  expect(rows[2]).toMatch(/^1,Nelson,,2,Dana Delivery,0400 000 000,/);
});

test('the draft survives a refresh (localStorage) and "Clear run" empties it', async () => {
  login(['logistics']);
  installFetch();
  const first = renderPage();
  await screen.findByText('Dana Delivery');
  fireEvent.click(screen.getByRole('button', { name: /^Add Dana Delivery \(WO 9\) to run$/ }));
  fireEvent.change(screen.getByLabelText('Run 1 carrier'), { target: { value: 'Cobbs' } });
  first.unmount();

  installFetch();
  renderPage();
  const run = await screen.findByRole('list', { name: 'Run 1 stops' });
  expect(within(run).getByText('Dana Delivery')).toBeInTheDocument();
  expect(screen.getByLabelText('Run 1 carrier')).toHaveValue('Cobbs');

  fireEvent.click(screen.getByRole('button', { name: 'Clear run' }));
  expect(window.confirm).toHaveBeenCalled();
  expect(within(screen.getByRole('list', { name: 'Run 1 stops' })).queryByText('Dana Delivery')).toBeNull();
  expect(screen.getByLabelText('Run 1 carrier')).toHaveValue('');
  expect(localStorage.getItem(PLAN_STORAGE_KEY)).toBeNull();
});

test('a stop planned earlier but since booked/completed is kept, and flagged', async () => {
  login(['logistics']);
  installFetch();
  const first = renderPage();
  await screen.findByText('Dana Delivery');
  fireEvent.click(screen.getByRole('button', { name: /^Add Dana Delivery \(WO 9\) to run$/ }));
  first.unmount();

  installFetch({ deliveries: [], workorders: CANDIDATES.workorders });
  renderPage();
  const run = await screen.findByRole('list', { name: 'Run 1 stops' });
  await waitFor(() => expect(within(run).getByText(/no longer waiting to be booked/i)).toBeInTheDocument());
  expect(within(run).getByText('Dana Delivery')).toBeInTheDocument();
});

test('a planned workorder that has since become a To-Be-Booked delivery is not offered twice', async () => {
  login(['logistics']);
  installFetch();
  const first = renderPage();
  await screen.findByText('Dana Delivery');
  showCurrentOps();
  fireEvent.click(screen.getByRole('button', { name: /^Add Wes Workorder \(WO 12\) to run$/ }));
  first.unmount();

  // WO 12 completed → a delivery row now exists for it; the workorder list no longer has it.
  installFetch({
    deliveries: [...CANDIDATES.deliveries, { delivery_id: 200, workorder_id: 12, invoice_id: '20500', customer_name: 'Wes Workorder', customer_phone: '0411 111 111', customer_address: '2 Test Rd', delivery_suburb: 'Geelong', delivery_state: 'VIC', items_text: '2.00 × Dumbbell rack', notes: null }],
    workorders: [CANDIDATES.workorders[1]],
  });
  renderPage();
  const run = await screen.findByRole('list', { name: 'Run 1 stops' });
  await screen.findByText('Dana Delivery');
  // Default tab is To be booked — exactly where the duplicate (delivery 200) would appear.
  expect(screen.queryByRole('button', { name: /^Add Wes Workorder/ })).toBeNull();
  showCurrentOps();
  expect(screen.queryByRole('button', { name: /^Add Wes Workorder/ })).toBeNull();
  expect(within(run).getByText(/now a to-be-booked delivery/i)).toBeInTheDocument();
  expect(within(run).queryByText(/no longer waiting/i)).toBeNull();
});

test('a stop on the run shows name + suburb/state, not the address (Nick, 29 Sep 2026)', async () => {
  login(['logistics']);
  installFetch();
  renderPage();
  await screen.findByText('Dana Delivery');
  fireEvent.click(screen.getByRole('button', { name: /^Add Dana Delivery \(WO 9\) to run$/ }));
  const run = screen.getByRole('list', { name: 'Run 1 stops' });
  expect(within(run).getByText('Altona North VIC')).toBeInTheDocument();
  expect(within(run).queryByText(/1 Test St/)).toBeNull();
  expect(within(run).queryByText(/address/i)).toBeNull();
});

test('workorder notes are shown on screen as internal and never printed', async () => {
  login(['logistics']);
  installFetch();
  renderPage();
  await screen.findByText('Dana Delivery');
  showCurrentOps();
  fireEvent.click(screen.getByRole('button', { name: /^Add Wes Workorder \(WO 12\) to run$/ }));
  const run = screen.getByRole('list', { name: 'Run 1 stops' });
  expect(within(run).getByText(/Workorder notes \(internal — not printed\)/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Print run sheet' }));
  expect(openedHtml).not.toContain('Owes $200');
});

test('roles without logistics/superadmin get no planner and make no request', async () => {
  login(['staff']);
  const fetchMock = installFetch();
  renderPage();
  expect(await screen.findByText(/logistics or superadmin/i)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Print run sheet' })).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});

test('a 403 from the server is shown, not swallowed', async () => {
  login(['logistics']);
  installFetch({ error: 'Requires the logistics role' }, 403);
  renderPage();
  expect(await screen.findByText(/don’t have access/i)).toBeInTheDocument();
});

describe('DeliveryTabs entry point', () => {
  function renderTabs() {
    return render(
      <MemoryRouter initialEntries={['/delivery_operations/to-be-booked']}>
        <DeliveryTabs />
      </MemoryRouter>
    );
  }

  test.each([['logistics'], ['superadmin']])('shows "Create temporary delivery run" for %s', (role) => {
    login([role]);
    renderTabs();
    const link = screen.getByRole('link', { name: 'Create temporary delivery run' });
    expect(link).toHaveAttribute('href', '/delivery_operations/temp-run');
  });

  test.each([['staff'], ['technician'], ['sales']])('hides it for %s', (role) => {
    login([role]);
    renderTabs();
    expect(screen.queryByRole('link', { name: 'Create temporary delivery run' })).toBeNull();
  });
});

