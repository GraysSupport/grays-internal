import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import DirectorPage from '../director';

// G22a (owner, 29 Oct 2026) — Director's View, sales team performance. Superadmin only.

const S = (sp, name, over = {}) => ({
  salesperson: sp, salesperson_name: name, workorders: 10, open: 2, completed: 8, invoices: 9, units: 12, sales: 20000,
  priced_lines: 4, estimated_lines: 6, unpriced_lines: 0, costed_lines: 5, costed_sales: 10000, cogs: 2500,
  delivery_jobs: 8, delivery_charged: 1600, carrier_cost: 2000, free_jobs: 2, free_cost: 450, jobs_no_cost: 1,
  outstanding: 3000, completed_timed: 8, avg_days: 20, on_time_eligible: 8, on_time: 6, ecommerce: 7,
  aov: 2000, gross_profit: 7500, margin: 0.75, delivery_net: -400, on_time_pct: 0.75, ecommerce_share: 0.7, ...over,
});
const SALES = {
  range: { from: '2026-07-01', to: '2027-06-30' },
  salespeople: [S('KM', 'Kelly Munthe'), S('JG', 'John Gray', { sales: 5000, gross_profit: null, margin: null, costed_lines: 0 })],
  totals: S(null, null, { sales: 25000, workorders: 20 }),
  coverage: { lines: 20, priced_lines: 8, estimated_lines: 12, unpriced_lines: 0, costed_lines: 5, workorders: 20, completed: 16, completed_timed: 15, delivery_jobs: 16, jobs_no_cost: 2, ecommerce: 14 },
  monthly: { KM: { '2026-07': 5000, '2026-08': 15000 }, JG: { '2026-08': 5000 } },
  previous: { range: { from: '2025-07-01', to: '2026-06-30' }, salespeople: [S('KM', 'Kelly Munthe', { sales: 10000 })], totals: S(null, null, { sales: 10000 }), coverage: {} },
};
const DRILL = { range: SALES.range, salesperson: 'KM', workorders: [{ workorder_id: 901, invoice_id: 'INV-901', date_created: '2026-08-01T00:00:00Z', status: 'Completed', outstanding_balance: 0, sales: 1795 }] };

function login(roles, id = 'GS') {
  const b64 = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  localStorage.setItem('token', `${b64({ alg: 'none' })}.${b64({ id, roles })}.sig`);
  localStorage.setItem('user', JSON.stringify({ id, name: 'Nick', access: roles[0], roles }));
}
function installFetch({ sales = [200, SALES], drill = [200, DRILL] } = {}) {
  const mock = jest.fn(async (url) => {
    const [status, json] = String(url).includes('resource=sales-workorders') ? drill : sales;
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  });
  global.fetch = mock;
  return mock;
}
const NOW = new Date('2026-10-30T03:00:00Z'); // 30 Oct 2026, 2 pm Melbourne
function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/director']}>
      <Routes>
        <Route path="/director" element={<DirectorPage now={NOW} />} />
        <Route path="/" element={<div>LOGIN PAGE</div>} />
        <Route path="*" element={<div>ELSEWHERE</div>} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => localStorage.clear());

describe("Director's View", () => {
  test('non-superadmin: "Superadmin only", nothing fetched', () => {
    login(['admin'], 'GA');
    const f = installFetch();
    renderPage();
    expect(screen.getByText(/superadmin only/i)).toBeInTheDocument();
    expect(f).not.toHaveBeenCalled();
  });

  test('loads the current financial year with comparison, using the login token', async () => {
    login(['superadmin']);
    const f = installFetch();
    renderPage();
    await screen.findByRole('table', { name: /sales team/i });
    const [url, opts] = f.mock.calls[0];
    expect(url).toBe('/api/director?resource=sales&from=2026-07-01&to=2027-06-30&compare=1');
    expect(opts.headers.Authorization).toMatch(/^Bearer /);
  });

  test('one row per salesperson + totals, money as whole dollars, change vs previous period', async () => {
    login(['superadmin']);
    installFetch();
    renderPage();
    const table = await screen.findByRole('table', { name: /sales team/i });
    const km = within(table).getByRole('row', { name: /Kelly Munthe/ });
    expect(km).toHaveTextContent('$20,000');
    expect(km).toHaveTextContent('▲ 100%');
    expect(km).toHaveTextContent('$2,000'); // average order value
    expect(km).toHaveTextContent('75%'); // margin + on time
    expect(km).toHaveTextContent('−$400'); // delivery net
    const jg = within(table).getByRole('row', { name: /John Gray/ });
    expect(jg).toHaveTextContent('new'); // no sales last period
    expect(within(table).getByRole('row', { name: /Total/ })).toHaveTextContent('$25,000');
  });

  test('unknown cost shows as —, never $0', async () => {
    login(['superadmin']);
    installFetch();
    renderPage();
    const table = await screen.findByRole('table', { name: /sales team/i });
    const jg = within(table).getByRole('row', { name: /John Gray/ });
    expect(within(jg).getAllByText('—').length).toBeGreaterThan(0);
  });

  test('every section carries a data-coverage line + the GST footnote', async () => {
    login(['superadmin']);
    installFetch();
    renderPage();
    await screen.findByRole('table', { name: /sales team/i });
    expect(screen.getByText(/8 of 20 lines use the price on the order; 12 are estimated/i)).toBeInTheDocument();
    expect(screen.getByText(/5 of 20 lines have a cost set/i)).toBeInTheDocument();
    expect(screen.getByText(/15 of 16 completed workorders/i)).toBeInTheDocument();
    expect(screen.getByText(/GST-inclusive as stored/i)).toBeInTheDocument();
  });

  test('changing the period re-loads; custom range uses the typed dates', async () => {
    login(['superadmin']);
    const f = installFetch();
    renderPage();
    await screen.findByRole('table', { name: /sales team/i });
    fireEvent.change(screen.getByLabelText('Period'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-01-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-03-31' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    await waitFor(() => expect(f.mock.calls.some(([u]) => String(u).includes('from=2026-01-01&to=2026-03-31'))).toBe(true));
    fireEvent.click(screen.getByLabelText('Compare with the previous period'));
    await waitFor(() => expect(f.mock.calls.at(-1)[0]).not.toMatch(/compare=1/));
  });

  test('drill-down: a salesperson\'s workorders link to the workorder page', async () => {
    login(['superadmin']);
    const f = installFetch();
    renderPage();
    const table = await screen.findByRole('table', { name: /sales team/i });
    fireEvent.click(within(table).getByRole('button', { name: 'Show workorders for Kelly Munthe' }));
    const list = await screen.findByRole('region', { name: /Kelly Munthe — workorders/ });
    expect(await within(list).findByRole('link', { name: /INV-901/ })).toHaveAttribute('href', '/delivery_operations/workorder/901');
    expect(within(list).getByText('$1,795')).toBeInTheDocument();
    expect(f.mock.calls.some(([u]) => String(u) === '/api/director?resource=sales-workorders&salesperson=KM&from=2026-07-01&to=2027-06-30')).toBe(true);
  });

  test('an expired login goes back to the login page', async () => {
    login(['superadmin']);
    installFetch({ sales: [401, { error: 'Authentication required' }] });
    renderPage();
    expect(await screen.findByText('LOGIN PAGE')).toBeInTheDocument();
  });

  test('a server refusal is shown, not a crash', async () => {
    login(['superadmin']);
    installFetch({ sales: [403, { error: 'Requires one of: superadmin' }] });
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent(/superadmin/);
  });
});

describe("Dashboard — Director's View button", () => {
  // eslint-disable-next-line global-require
  const Dashboard = require('../dashboard').default;
  const renderDash = () => render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <Routes>
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/director" element={<div>DIRECTOR PAGE</div>} />
        <Route path="*" element={<div>ELSEWHERE</div>} />
      </Routes>
    </MemoryRouter>
  );
  const quietFetch = () => { global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => [] })); };

  test('superadmin sees it and it opens /director', async () => {
    login(['superadmin']);
    quietFetch();
    renderDash();
    fireEvent.click(await screen.findByRole('button', { name: "Director's View" }));
    expect(await screen.findByText('DIRECTOR PAGE')).toBeInTheDocument();
  });

  test.each([['admin'], ['sales'], ['logistics'], ['technician']])('%s does not see it', async (role) => {
    login([role], 'GA');
    quietFetch();
    renderDash();
    await screen.findByText(/Dashboard Analytics/);
    expect(screen.queryByRole('button', { name: "Director's View" })).not.toBeInTheDocument();
  });
});
