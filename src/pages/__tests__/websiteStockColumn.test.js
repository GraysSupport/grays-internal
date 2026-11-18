import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ProductsPage from '../products';
import { websiteStockCell } from '../../utils/websiteStockColumn';

// G25c (owner chose "G25 follow-ups", 18 Nov 2026): Products page "Website stock" column and the
// superadmin weekly drift report. Read-only toward the website.

jest.mock('react-hot-toast', () => ({
  __esModule: true,
  default: { loading: jest.fn(), success: jest.fn(), error: jest.fn() },
}));

const PRODUCTS = [
  { sku: 'TEC-TR600', name: 'Technogym Treadmill', brand: 'Technogym', stock: 5, price: '1795' },
  { sku: 'LFT-TRSE3HD', name: 'Life Fitness', brand: 'LF', stock: 6, price: '2495' },
  { sku: 'G25-NOWEB', name: 'Not on site', brand: 'GEN', stock: 2, price: '100' },
];
const COLUMN = {
  available: true, source: 'live', checkedAt: '2026-11-19T00:00:00Z', errors: [],
  items: {
    'TEC-TR600': { website: 4, state: 'mismatch' },
    'LFT-TRSE3HD': { website: 6, state: 'match' },
    'G25-NOWEB': { website: null, state: 'not_on_website' },
  },
};
const DRIFT = {
  available: true, source: 'live', checkedAt: '2026-11-19T00:00:00Z', errors: [],
  counts: { checked: 3, mismatches: 1, notOnWebsite: 1, unknown: 0 },
  rows: [
    { sku: 'TEC-TR600', name: 'Technogym Treadmill', portal: 5, website: 4, state: 'mismatch' },
    { sku: 'G25-NOWEB', name: 'Not on site', portal: 2, website: null, state: 'not_on_website' },
  ],
};

function login(id, roles) {
  const b64 = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  localStorage.setItem('token', `${b64({ alg: 'none' })}.${b64({ id, roles })}.sig`);
  localStorage.setItem('user', JSON.stringify({ id, name: id, access: roles[0], roles }));
}

function installFetch({ column = [200, COLUMN], drift = [200, DRIFT], report = [200, { report: null }] } = {}) {
  const reply = ([status, json]) => ({ ok: status >= 200 && status < 300, status, json: async () => json });
  const mock = jest.fn(async (url) => {
    const u = String(url);
    if (u.includes('/api/website-stock?resource=column')) return reply(column);
    if (u.includes('/api/website-stock?resource=drift')) return reply(drift);
    if (u.includes('/api/website-stock?resource=report')) return reply(report);
    return reply([200, PRODUCTS]);
  });
  global.fetch = mock;
  return mock;
}
const siteCalls = (mock) => mock.mock.calls.filter(([url]) => String(url).includes('/api/website-stock'));

function renderPage(path = '/products') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/products" element={<ProductsPage />} />
        <Route path="*" element={<div>ELSEWHERE</div>} />
      </Routes>
    </MemoryRouter>
  );
}
const rowFor = async (sku) => (await screen.findByText(sku)).closest('tr');

beforeEach(() => localStorage.clear());

describe('websiteStockCell', () => {
  test('labels every state in plain English', () => {
    expect(websiteStockCell({ website: 4, state: 'mismatch' })).toEqual({ text: '4', tone: 'warn' });
    expect(websiteStockCell({ website: 6, state: 'match' })).toEqual({ text: '6', tone: 'ok' });
    expect(websiteStockCell({ website: null, state: 'not_on_website' }).text).toBe('not on website');
    expect(websiteStockCell({ website: 3, state: 'skipped' }).text).toMatch(/not synced/i);
    expect(websiteStockCell({ website: null, state: 'unknown' }).text).toMatch(/couldn.t read/i);
    expect(websiteStockCell(undefined).text).toBe('—');
  });
});

describe('Products page — Website stock column', () => {
  test('superadmin sees the column, read once per page load (never per row)', async () => {
    login('GS', ['superadmin']);
    const mock = installFetch();
    renderPage();
    expect(await screen.findByRole('columnheader', { name: /website stock/i })).toBeInTheDocument();
    expect(within(await rowFor('TEC-TR600')).getByText('4')).toBeInTheDocument();
    expect(within(await rowFor('G25-NOWEB')).getByText('not on website')).toBeInTheDocument();
    await waitFor(() => expect(siteCalls(mock)).toHaveLength(1));
  });

  test('the website is only ever read (no method other than GET)', async () => {
    login('GS', ['superadmin']);
    const mock = installFetch();
    renderPage();
    await screen.findByRole('columnheader', { name: /website stock/i });
    for (const [, init] of siteCalls(mock)) expect(String(init?.method || 'GET').toUpperCase()).toBe('GET');
  });

  test('a login the server refuses (403) gets no column', async () => {
    login('JS', ['staff']);
    installFetch({ column: [403, { error: 'no' }] });
    renderPage();
    await screen.findByText('TEC-TR600');
    await waitFor(() => expect(screen.queryByRole('columnheader', { name: /website stock/i })).not.toBeInTheDocument());
  });

  test('workshop logins never ask for website stock (G17)', async () => {
    login('TT', ['technician']);
    const mock = installFetch();
    renderPage();
    await screen.findByText('TEC-TR600');
    expect(siteCalls(mock)).toHaveLength(0);
    expect(screen.queryByRole('columnheader', { name: /website stock/i })).not.toBeInTheDocument();
  });

  test('mock data on a Preview is labelled as sample data', async () => {
    login('GS', ['superadmin']);
    installFetch({ column: [200, { ...COLUMN, source: 'mock' }] });
    renderPage();
    expect(await screen.findByText(/sample website data/i)).toBeInTheDocument();
  });

  test('website not set up → no column, a short note', async () => {
    login('GS', ['superadmin']);
    installFetch({ column: [200, { available: false, reason: 'The website connection is not set up here' }] });
    renderPage();
    expect(await screen.findByText(/website connection is not set up/i)).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /website stock/i })).not.toBeInTheDocument();
  });
});

describe('Products page — Website drift tab (superadmin)', () => {
  test('superadmin sees the tab; "Check now" lists mismatches only', async () => {
    login('GS', ['superadmin']);
    const mock = installFetch();
    renderPage('/products?tab=website-drift');
    expect(await screen.findByText(/no weekly report yet/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /check now/i }));
    const table = await screen.findByRole('table', { name: /website drift/i });
    expect(within(table).getByText('TEC-TR600')).toBeInTheDocument();
    expect(within(table).getByText('G25-NOWEB')).toBeInTheDocument();
    expect(within(table).queryByText('LFT-TRSE3HD')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /set website/i })).not.toBeInTheDocument();
    for (const [, init] of siteCalls(mock)) expect(String(init?.method || 'GET').toUpperCase()).toBe('GET');
  });

  test('shows the latest stored weekly report', async () => {
    login('GS', ['superadmin']);
    installFetch({ report: [200, { report: { ...DRIFT, createdAt: '2026-11-16T20:00:00Z', status: 'ok' } }] });
    renderPage('/products?tab=website-drift');
    const table = await screen.findByRole('table', { name: /website drift/i });
    expect(within(table).getByText('TEC-TR600')).toBeInTheDocument();
  });

  test('the marketing lead (GM, admin) has the column but not the drift tab', async () => {
    login('GM', ['admin']);
    installFetch();
    renderPage();
    await screen.findByRole('columnheader', { name: /website stock/i });
    expect(screen.queryByRole('tab', { name: /website drift/i })).not.toBeInTheDocument();
  });
});
