// G8 (Nick, 28 Sep 2026) — "Create temporary delivery run".
//
// THE HARD RULE this file exists to pin: planning a run must not create, update or delete any
// workorder, workorder item, delivery or log row. The planner is browser-only; its one server
// call is a gated GET. The "zero write requests" test drives a whole planning session — load,
// add, reorder, name the carrier, pick a day, print, export, clear — and then asserts every
// request the page made was a GET to the read-only candidates endpoint. The server half (that
// endpoint issues exactly two SELECTs) is pinned in scripts/ops-temp-run-smoke.mjs.

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
    { workorder_id: 12, invoice_id: '20500', customer_name: 'Wes Workorder', customer_phone: '0411 111 111', customer_address: '2 Test Rd', delivery_suburb: 'Geelong', delivery_state: 'VIC', items_text: '2.00 × Dumbbell rack', notes: null },
  ],
};

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

test('loads candidates from the gated read with the login token, both sources listed', async () => {
  login(['logistics']);
  const fetchMock = installFetch();
  renderPage();

  expect(await screen.findByText('Dana Delivery')).toBeInTheDocument();
  expect(screen.getByText('Wes Workorder')).toBeInTheDocument();
  expect(screen.getByText(/Temporary run — not booked/)).toBeInTheDocument();

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe('/api/logistics?resource=run-candidates');
  expect(init.headers.Authorization).toMatch(/^Bearer /);
});

test('ZERO WRITE REQUESTS across a full planning session', async () => {
  login(['logistics']);
  const fetchMock = installFetch();
  renderPage();
  await screen.findByText('Dana Delivery');

  fireEvent.click(screen.getByRole('button', { name: 'Add Dana Delivery to run' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add Wes Workorder to run' }));
  fireEvent.click(screen.getByRole('button', { name: 'Move Wes Workorder up' }));
  fireEvent.change(screen.getByLabelText('Run 1 carrier'), { target: { value: 'Nelson' } });
  fireEvent.change(screen.getByLabelText('Run 1 day'), { target: { value: '2026-10-02' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add another run' }));
  fireEvent.click(screen.getByRole('button', { name: 'Print run sheet' }));
  fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
  fireEvent.click(screen.getByRole('button', { name: 'Remove Dana Delivery' }));
  fireEvent.click(screen.getByRole('button', { name: 'Clear run' }));

  // The only request ever made: the one GET on mount.
  expect(fetchMock).toHaveBeenCalledTimes(1);
  for (const [url, init = {}] of fetchMock.mock.calls) {
    expect((init.method || 'GET').toUpperCase()).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(String(url)).toBe('/api/logistics?resource=run-candidates');
  }
});

test('stops are ordered, then printed and exported in that order', async () => {
  login(['superadmin']);
  installFetch();
  renderPage();
  await screen.findByText('Dana Delivery');

  fireEvent.click(screen.getByRole('button', { name: 'Add Dana Delivery to run' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add Wes Workorder to run' }));
  fireEvent.click(screen.getByRole('button', { name: 'Move Dana Delivery down' }));
  fireEvent.change(screen.getByLabelText('Run 1 carrier'), { target: { value: 'Nelson' } });

  const run = screen.getByRole('list', { name: 'Run 1 stops' });
  const names = within(run).getAllByTestId('stop-name').map((n) => n.textContent);
  expect(names).toEqual(['Wes Workorder', 'Dana Delivery']);

  // Added stops leave the "available" list — one customer can't go on two runs.
  expect(screen.queryByRole('button', { name: 'Add Dana Delivery to run' })).toBeNull();

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
  fireEvent.click(screen.getByRole('button', { name: 'Add Dana Delivery to run' }));
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
  fireEvent.click(screen.getByRole('button', { name: 'Add Dana Delivery to run' }));
  first.unmount();

  installFetch({ deliveries: [], workorders: CANDIDATES.workorders });
  renderPage();
  const run = await screen.findByRole('list', { name: 'Run 1 stops' });
  await waitFor(() => expect(within(run).getByText(/no longer waiting to be booked/i)).toBeInTheDocument());
  expect(within(run).getByText('Dana Delivery')).toBeInTheDocument();
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

