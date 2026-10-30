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
  range: { from: '2026-07-01', to: '2026-10-30' },
  salespeople: [S('KM', 'Kelly Munthe'), S('JG', 'John Gray', { sales: 5000, gross_profit: null, margin: null, costed_lines: 0 })],
  totals: S(null, null, { sales: 25000, workorders: 20 }),
  coverage: { lines: 20, priced_lines: 8, estimated_lines: 12, unpriced_lines: 0, costed_lines: 5, workorders: 20, completed: 16, completed_timed: 15, delivery_jobs: 16, jobs_no_cost: 2, ecommerce: 14 },
  monthly: { KM: { '2026-07': 5000, '2026-08': 15000 }, JG: { '2026-08': 5000 } },
  previous: { mode: 'year', range: { from: '2025-07-01', to: '2025-10-30' }, salespeople: [S('KM', 'Kelly Munthe', { sales: 10000 })], totals: S(null, null, { sales: 10000 }), coverage: {} },
};
const DRILL = { range: SALES.range, salesperson: 'KM', workorders: [{ workorder_id: 901, invoice_id: 'INV-901', date_created: '2026-08-01T00:00:00Z', status: 'Completed', outstanding_balance: 0, sales: 1795 }] };

function login(roles, id = 'GS') {
  const b64 = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  localStorage.setItem('token', `${b64({ alg: 'none' })}.${b64({ id, roles })}.sig`);
  localStorage.setItem('user', JSON.stringify({ id, name: 'Nick', access: roles[0], roles }));
}
const OVERVIEW = {
  range: { from: '2026-07-01', to: '2026-10-30' },
  sales: { value: 25000, previous: 10000, workorders: 20, lines: 20, priced_lines: 8, estimated_lines: 12, unpriced_lines: 0 },
  profit: { gross_profit: 7500, margin: 0.75, costed_lines: 5, lines: 20, previous: 5000 },
  on_time: { pct: 0.75, on_time: 6, eligible: 8, previous: 0.5 },
  pipeline: { value: 532244, workorders: 43, lines: 60, estimated_lines: 20, unpriced_lines: 1 },
  owed: { total: 255748, workorders: 26, open_total: 208325, open_workorders: 20, credit_workorders: 0 },
  deliveries: { net: -8650, jobs_both: 300, jobs: 420, previous: -10000 },
  workshop: { items_completed: 799, items_timed: 250, avg_days: 10.3, in_workshop_now: 10, previous: 400 },
  stock: { value_cost: 106324, units: 4228, units_costed: 217, free_weights: { available: true, value_cost: 1795, units: 40, units_costed: 30 } },
  customers: { total: 524, individual: 347, business: 170, not_set: 7, new: 521, returning: 3, history_from: '2025-05-09' },
  states: [{ state: 'VIC', workorders: 278, sales: 900000 }, { state: 'NSW', workorders: 145, sales: 450000 }],
  previous: { mode: 'year', range: { from: '2025-07-01', to: '2025-10-30' } },
};
function installFetch({ sales = [200, SALES], drill = [200, DRILL], overview = [200, OVERVIEW] } = {}) {
  const mock = jest.fn(async (url) => {
    const u = String(url);
    const [status, json] = u.includes('resource=sales-workorders') ? drill : u.includes('resource=overview') ? overview : sales;
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
    const [url, opts] = f.mock.calls.find(([u]) => String(u).includes('resource=sales&'));
    expect(url).toBe('/api/director?resource=sales&from=2026-07-01&to=2026-10-30&compare=year');
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
    expect(f.mock.calls.some(([u]) => String(u) === '/api/director?resource=sales-workorders&salesperson=KM&from=2026-07-01&to=2026-10-30')).toBe(true);
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

describe("Director's View — review fixes", () => {
  test('the default comparison is the same dates a year earlier, and says so', async () => {
    login(['superadmin']);
    installFetch();
    renderPage();
    await screen.findByRole('table', { name: /sales team/i });
    expect(screen.getByText(/same dates a year earlier/i)).toBeInTheDocument();
  });

  test('a custom range compares with the period just before', async () => {
    login(['superadmin']);
    const f = installFetch();
    renderPage();
    await screen.findByRole('table', { name: /sales team/i });
    fireEvent.change(screen.getByLabelText('Period'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-01-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-03-31' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    await waitFor(() => expect(f.mock.calls.at(-1)[0]).toMatch(/from=2026-01-01&to=2026-03-31&compare=1$/));
  });

  test('workorders with no salesperson show as Unassigned, without a drill-down', async () => {
    login(['superadmin']);
    installFetch({ sales: [200, { ...SALES, salespeople: [...SALES.salespeople, S(null, 'Unassigned', { sales: 100 })] }] });
    renderPage();
    const table = await screen.findByRole('table', { name: /sales team/i });
    const row = within(table).getByRole('row', { name: 'Unassigned' });
    expect(within(row).queryByRole('button')).not.toBeInTheDocument();
  });

  test('unknown delivery charges are disclosed', async () => {
    login(['superadmin']);
    installFetch({ sales: [200, { ...SALES, coverage: { ...SALES.coverage, jobs_no_charge: 7 } }] });
    renderPage();
    await screen.findByRole('table', { name: /sales team/i });
    expect(screen.getByText(/7 have no charge entered/i)).toBeInTheDocument();
  });

  test('while a new period loads, the old figures are marked as updating', async () => {
    login(['superadmin']);
    let release;
    const f = installFetch();
    renderPage();
    await screen.findByRole('table', { name: /sales team/i });
    f.mockImplementationOnce(() => new Promise((r) => { release = () => r({ ok: true, status: 200, json: async () => SALES }); }));
    fireEvent.change(screen.getByLabelText('Period'), { target: { value: 'last12' } });
    expect(await screen.findByText(/updating/i)).toBeInTheDocument();
    release();
    await waitFor(() => expect(screen.queryByText(/updating/i)).not.toBeInTheDocument());
  });
});

// G22b — products sold, earnings and profit.
const PR = (sku, name, over = {}) => ({ sku, name, brand: 'TEC', units: 2, revenue: 10000, lines: 2, costed_lines: 2, priced_lines: 1, estimated_lines: 1, costed_revenue: 10000, cogs: 2000, gross_profit: 8000, margin: 0.8, ...over });
const PRODUCTS = {
  range: { from: '2026-07-01', to: '2026-10-30' },
  totals: { units: 8, revenue: 75300, costed_revenue: 70000, cogs: 47000, lines: 7, costed_lines: 4, priced_lines: 3, estimated_lines: 4, gross_profit: 23000, margin: 0.3286 },
  product_count: 4,
  top_revenue: [PR('A', 'Alpha', { revenue: 50000 }), PR('C', 'Charlie', { gross_profit: null, margin: null, costed_lines: 0 })],
  bottom_revenue: [PR('C', 'Charlie', { gross_profit: null, margin: null, costed_lines: 0 })],
  top_profit: [PR('B', 'Bravo', { gross_profit: 18000 })],
  bottom_profit: [PR('A', 'Alpha', { gross_profit: 5000 })],
  brands: [{ brand: 'TEC', units: 4, revenue: 70000, lines: 4, costed_lines: 4, gross_profit: 23000 }],
  conditions: [{ condition: 'CS', units: 10, revenue: 30000, lines: 8 }],
  by_fy: [{ fy: 2026, units: 1977, revenue: 2813375.5, lines: 919, priced_lines: 330, is_current: false }, { fy: 2027, units: 11, revenue: 17950, lines: 11, priced_lines: 5, is_current: true }],
  profit_ranked: 1,
  stock: { products: 258, units: 4228, units_costed: 217, value_cost: 106323.54, units_priced: 4228, value_sell: 1602880, negative: 4 },
  aged: { in_stock: 73, over90: 35, over180: 0, oldest: [{ lot_number: 'L00001', sku: 'A', name: 'Alpha', age_days: 112 }] },
  cost_missing: { total: 287, items: [{ sku: 'CR-1', name: 'Chamber', brand: 'CR', price: 55900, stock: 3 }] },
  previous: { mode: 'year', range: { from: '2025-07-01', to: '2025-10-30' }, totals: { revenue: 50200 } },
};
function installBoth() {
  const mock = jest.fn(async (url) => {
    const u = String(url);
    const json = u.includes('resource=products') ? PRODUCTS : u.includes('sales-workorders') ? DRILL : SALES;
    return { ok: true, status: 200, json: async () => json };
  });
  global.fetch = mock;
  return mock;
}
const openProducts = async () => {
  await screen.findByRole('table', { name: /sales team/i });
  fireEvent.click(screen.getByRole('tab', { name: 'Products & profit' }));
  const region = await screen.findByRole('region', { name: 'Products & profit' });
  await within(region).findByRole('table', { name: 'Top 10 products by revenue' }); // figures loaded
  return region;
};

describe("Director's View — products & profit (G22b)", () => {
  test('a second tab loads the products figures with the same period + comparison', async () => {
    login(['superadmin']);
    const f = installBoth();
    renderPage();
    await openProducts();
    expect(f.mock.calls.some(([u]) => String(u) === '/api/director?resource=products&from=2026-07-01&to=2026-10-30&compare=year')).toBe(true);
  });

  test('headline figures with change and coverage', async () => {
    login(['superadmin']);
    installBoth();
    renderPage();
    const region = await openProducts();
    expect(within(region).getByText('$75,300')).toBeInTheDocument();
    expect(within(region).getByText('▲ 50%')).toBeInTheDocument();
    expect(within(region).getByText(/4 of 7 lines have a cost set/i)).toBeInTheDocument();
    expect(within(region).getByText(/217 of 4,228 units in stock have a cost/i)).toBeInTheDocument();
    expect(within(region).getByText(/4 products with negative stock are left out/i)).toBeInTheDocument();
  });

  test('a product with no cost shows profit as —, never $0', async () => {
    login(['superadmin']);
    installBoth();
    renderPage();
    const region = await openProducts();
    const table = within(region).getByRole('table', { name: 'Top 10 products by revenue' });
    const row = within(table).getByRole('row', { name: /Charlie/ });
    expect(row).toHaveTextContent('—');
    expect(row).not.toHaveTextContent('$0');
  });

  test('clean-up worklist + aged lots + per financial year', async () => {
    login(['superadmin']);
    installBoth();
    renderPage();
    const region = await openProducts();
    expect(within(region).getByText(/showing 1 of 287/i)).toBeInTheDocument();
    expect(within(region).getByRole('table', { name: /price set but cost missing/i })).toHaveTextContent('$55,900');
    expect(within(region).getByRole('table', { name: /lots in stock over 90 days/i })).toHaveTextContent('112');
    expect(within(region).getByRole('table', { name: /sold per financial year/i })).toHaveTextContent('FY2026');
  });
});

describe("Director's View — products & profit review fixes", () => {
  test('the running year is marked "to date"; per-year price coverage shown', async () => {
    login(['superadmin']);
    installBoth();
    renderPage();
    const region = await openProducts();
    const fy = within(region).getByRole('table', { name: /sold per financial year/i });
    expect(fy).toHaveTextContent('FY2027 to date');
    expect(fy).toHaveTextContent('330 of 919');
  });

  test('stock at sell price says how many units have a price; profit rankings say who is in them', async () => {
    login(['superadmin']);
    installBoth();
    renderPage();
    const region = await openProducts();
    expect(within(region).getByText(/4,228 of 4,228 units have a price/i)).toBeInTheDocument();
    expect(within(region).getByText(/profit rankings include only the 1 product with every line costed/i)).toBeInTheDocument();
  });
});

// G22c — deliveries & removalists.
const DEL_ROW = (id, name, over = {}) => ({ removalist_id: id, removalist: name, jobs: 10, jobs_with_cost: 8, jobs_both: 8, carrier_cost: 4000, charged: 3500, both_cost: 4000, both_charged: 3200, avg_cost: 500, median_cost: 450, loss_jobs: 5, loss_amount: 900, free_jobs: 2, free_jobs_with_cost: 2, free_cost: 700, under_target_jobs: 7, target: 4800, cash_jobs: 0, install_jobs: 0, install_cost: 0, price_difference: -800, recovery: 0.8, vs_target: -1600, ...over });
const DELIVERIES = {
  range: { from: '2026-07-01', to: '2026-10-30' },
  totals: DEL_ROW(null, 'All', { jobs: 443, jobs_both: 332, both_cost: 257213.16, both_charged: 182492.94, price_difference: -74720.22, recovery: 0.7095, loss_jobs: 264, loss_amount: 86411.23, free_jobs: 92, vs_target: -126163 }),
  removalists: [DEL_ROW(1, 'Moving Soon'), DEL_ROW(null, 'No carrier set', { jobs_both: 0, recovery: null, price_difference: 0 })],
  states: [
    { state: 'ACT', jobs: 13, single_jobs: 9, single_avg_cost: 524.1, card_zone: 'ACT', card_base: 474, drift: 0.1057, flag: 'drift', both_cost: 100, both_charged: 90, price_difference: -10 },
    { state: 'VIC', jobs: 262, single_jobs: 91, single_avg_cost: 279.78, card_zone: null, card_base: null, drift: null, flag: 'several-zones', both_cost: 100, both_charged: 90, price_difference: -10 },
  ],
  like_for_like: [{ state: 'NSW', carriers: [{ removalist_id: 14, removalist: 'DTL Logistics', jobs: 30, avg_cost: 750, median_cost: 700 }, { removalist_id: 1, removalist: 'Moving Soon', jobs: 5, avg_cost: 600, median_cost: 590 }] }],
  monthly: [{ month: '2026-07', jobs: 10, cost: 5000, charged: 4000, margin: -1000 }],
  target_markup: 1.2,
  coverage: { jobs: 443, jobs_with_cost: 340, jobs_both: 332, excluded_collects: 84 },
  previous: { mode: 'year', range: { from: '2025-07-01', to: '2025-10-30' }, totals: DEL_ROW(null, 'All', { price_difference: -50000 }) },
};
function installAll() {
  const mock = jest.fn(async (url) => {
    const u = String(url);
    const json = u.includes('resource=deliveries') ? DELIVERIES : u.includes('resource=products') ? PRODUCTS : u.includes('sales-workorders') ? DRILL : SALES;
    return { ok: true, status: 200, json: async () => json };
  });
  global.fetch = mock;
  return mock;
}
const openDeliveries = async () => {
  await screen.findByRole('table', { name: /sales team/i });
  fireEvent.click(screen.getByRole('tab', { name: 'Deliveries & removalists' }));
  const region = await screen.findByRole('region', { name: 'Deliveries & removalists' });
  await within(region).findByRole('table', { name: /by removalist/i });
  return region;
};

describe("Director's View — deliveries & removalists (G22c)", () => {
  test('loads the deliveries figures for the period', async () => {
    login(['superadmin']);
    const f = installAll();
    renderPage();
    await openDeliveries();
    expect(f.mock.calls.some(([u]) => String(u) === '/api/director?resource=deliveries&from=2026-07-01&to=2026-10-30&compare=year')).toBe(true);
  });

  test('company net, loss jobs, recovery and coverage', async () => {
    login(['superadmin']);
    installAll();
    renderPage();
    const region = await openDeliveries();
    expect(within(region).getByText('−$74,720')).toBeInTheDocument();
    expect(within(region).getByText(/332 of 443 jobs have both a carrier cost and a charge/i)).toBeInTheDocument();
    expect(within(region).getByText(/84 Customer Collect pickups are left out/i)).toBeInTheDocument();
    expect(within(region).getByText(/GST/)).toBeInTheDocument();
  });

  test('per removalist: price difference + recovery; no comparable jobs shows —', async () => {
    login(['superadmin']);
    installAll();
    renderPage();
    const region = await openDeliveries();
    const table = within(region).getByRole('table', { name: /by removalist/i });
    const ms = within(table).getByRole('row', { name: /Moving Soon/ });
    expect(ms).toHaveTextContent('−$800');
    expect(ms).toHaveTextContent('80%');
    expect(within(table).getByRole('row', { name: /No carrier set/ })).toHaveTextContent('—');
  });

  test('zone drift flagged against the rate card; multi-zone states say why', async () => {
    login(['superadmin']);
    installAll();
    renderPage();
    const region = await openDeliveries();
    const zones = within(region).getByRole('table', { name: /rate card/i });
    expect(within(zones).getByRole('row', { name: /ACT/ })).toHaveTextContent(/\+11%.*refresh/i);
    expect(within(zones).getByRole('row', { name: /VIC/ })).toHaveTextContent(/several card zones/i);
  });

  test('like-for-like carriers within one state', async () => {
    login(['superadmin']);
    installAll();
    renderPage();
    const region = await openDeliveries();
    const like = within(region).getByRole('table', { name: /like-for-like/i });
    expect(like).toHaveTextContent('NSW');
    expect(like).toHaveTextContent('DTL Logistics');
    expect(like).toHaveTextContent('$750');
  });
});

describe("Director's View — deliveries review fixes", () => {
  const D2 = {
    ...DELIVERIES,
    removalists: [DEL_ROW(1, 'Moving Soon'), DEL_ROW(7, 'Quiet Co', { jobs_both: 0, recovery: null, loss_jobs: 0, loss_amount: 0, price_difference: 0, vs_target: 0 })],
    states: [...DELIVERIES.states, { state: 'SA', jobs: 22, jobs_both: 0, single_jobs: 12, single_avg_cost: 546.02, card_zone: 'Adelaide (metro)', card_base: 583, drift: -0.0634, flag: 'ok', regional_caveat: true, both_cost: 0, both_charged: 0, price_difference: null }],
    monthly: [{ month: '2026-07', jobs: 10, jobs_both: 6, cost: 5000, charged: 4000, margin: -1000 }, { month: '2026-08', jobs: 2, jobs_both: 0, cost: 0, charged: 0, margin: null }],
  };
  const open = async () => {
    login(['superadmin']);
    global.fetch = jest.fn(async (url) => ({ ok: true, status: 200, json: async () => (String(url).includes('resource=deliveries') ? D2 : SALES) }));
    renderPage();
    return openDeliveries();
  };

  test('cost/charge columns say they are comparable jobs only', async () => {
    const region = await open();
    expect(within(region).getByRole('columnheader', { name: /carrier cost \(comparable\)/i })).toBeInTheDocument();
    expect(within(region).getByRole('columnheader', { name: /charged \(comparable\)/i })).toBeInTheDocument();
  });

  test('nothing comparable → —, never $0', async () => {
    const region = await open();
    const quiet = within(within(region).getByRole('table', { name: /by removalist/i })).getByRole('row', { name: /Quiet Co/ });
    expect(quiet).not.toHaveTextContent('$0');
    const sa = within(within(region).getByRole('table', { name: /rate card/i })).getByRole('row', { name: /SA/ });
    expect(sa).toHaveTextContent(/metro/i);
    expect(sa).toHaveTextContent(/regional jobs/i);
    expect(sa).not.toHaveTextContent('$0');
    const aug = within(within(region).getByRole('table', { name: /monthly/i })).getByRole('row', { name: /Aug 2026/ });
    expect(aug).toHaveTextContent('—');
    expect(aug).not.toHaveTextContent('$0');
  });

  test('free deliveries say how many had a known cost', async () => {
    const region = await open();
    expect(within(region).getByText(/absorbed on 2 of 92 free jobs/i)).toBeInTheDocument();
  });
});

describe("Director's View — owner answers (30 Oct 2026)", () => {
  test('condition codes show their website names', async () => {
    login(['superadmin']);
    installBoth();
    renderPage();
    const region = await openProducts();
    const table = within(region).getByRole('table', { name: 'Sales by item condition' });
    expect(within(table).getByRole('rowheader', { name: 'Clean and Serviced (CS)' })).toBeInTheDocument();
  });

  test('margin is labelled gross margin, with labour not included', async () => {
    login(['superadmin']);
    installBoth();
    renderPage();
    const team = await screen.findByRole('table', { name: /sales team/i });
    expect(within(team).getByRole('columnheader', { name: 'Gross margin' })).toBeInTheDocument();
    expect(screen.getByText(/lot's cost where recorded, otherwise the product average cost — refurbishment labour is not included/i)).toBeInTheDocument(); // Sales team coverage
    const region = await openProducts();
    expect(within(region).getByRole('table', { name: 'Top 10 products by revenue' })).toHaveTextContent('Gross margin');
    expect(within(region).getByText('Gross margin 33%')).toBeInTheDocument();
    expect(within(region).getByText(/lot's cost where recorded, otherwise the product average cost — refurbishment labour is not included/i)).toBeInTheDocument(); // Products coverage
    expect(within(region).getByText(/Cancelled items are excluded/)).toBeInTheDocument();
  });
});

describe("Director's View — business overview (G22d)", () => {
  const overview = async () => { await screen.findByRole('button', { name: /^sales this period/i }); return screen.getByRole('region', { name: /business overview/i }); };

  test('loads the overview for the same period and comparison', async () => {
    login(['superadmin']);
    const f = installFetch();
    renderPage();
    await overview();
    expect(f.mock.calls.some(([u]) => String(u) === '/api/director?resource=overview&from=2026-07-01&to=2026-10-30&compare=year')).toBe(true);
  });

  test('headline tiles with whole-dollar money and change vs the previous period', async () => {
    login(['superadmin']);
    installFetch();
    renderPage();
    const region = await overview();
    const sales = within(region).getByRole('button', { name: /^sales this period/i });
    expect(sales).toHaveTextContent('$25,000');
    expect(sales).toHaveTextContent('▲ 150%');
    expect(within(region).getByRole('button', { name: /^gross profit/i })).toHaveTextContent('$7,500');
    expect(within(region).getByText('$532,244')).toBeInTheDocument(); // open orders (today)
    expect(within(region).getByText('$255,748')).toBeInTheDocument(); // money still owed (today)
    expect(within(region).getByRole('button', { name: /^delivery net margin/i })).toHaveTextContent('−$8,650');
    expect(within(region).getByText('799')).toBeInTheDocument();
    expect(within(region).getByText('$106,324')).toBeInTheDocument();
  });

  test('every tile says what share of the data it rests on', async () => {
    login(['superadmin']);
    installFetch();
    renderPage();
    const region = await overview();
    expect(within(region).getByText(/8 of 20 lines priced on the order/i)).toBeInTheDocument();
    expect(within(region).getByText(/75% gross margin on 5 of 20 lines with a cost/i)).toBeInTheDocument();
    expect(within(region).getByText(/300 of 420 jobs have both a cost and a charge/i)).toBeInTheDocument();
    expect(within(region).getByText(/217 of 4,228 units have a cost/i)).toBeInTheDocument();
    expect(within(region).getByText(/250 of 799 items have a workshop start/i)).toBeInTheDocument();
    expect(within(region).getByText(/history starts 9 May 2025/i)).toBeInTheDocument();
    expect(within(region).getByText(/Brand New Free Weights: \$1,795 at cost/i)).toBeInTheDocument();
  });

  test('customer mix, new vs returning, sales by state', async () => {
    login(['superadmin']);
    installFetch();
    renderPage();
    const region = await overview();
    expect(within(region).getByText(/347 individual · 170 business · 7 not set/i)).toBeInTheDocument();
    expect(within(region).getByText(/521 new · 3 returning/i)).toBeInTheDocument();
    const states = within(region).getByRole('list', { name: /sales by delivery state/i });
    expect(states).toHaveTextContent('VIC');
    expect(states).toHaveTextContent('$900,000');
  });

  test('a tile opens its section', async () => {
    login(['superadmin']);
    const f = installFetch();
    renderPage();
    const region = await overview();
    fireEvent.click(within(region).getByRole('button', { name: /^delivery net margin/i }));
    expect(screen.getByRole('tab', { name: /deliveries/i })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(f.mock.calls.some(([u]) => String(u).includes('resource=deliveries'))).toBe(true));
  });

  test('unknown profit shows —, never $0; free weights not set up says so', async () => {
    login(['superadmin']);
    installFetch({ overview: [200, { ...OVERVIEW, profit: { ...OVERVIEW.profit, gross_profit: null, margin: null, costed_lines: 0 }, stock: { ...OVERVIEW.stock, free_weights: { available: false } } }] });
    renderPage();
    const region = await overview();
    const gp = within(region).getByRole('button', { name: /^gross profit/i });
    expect(gp).toHaveTextContent('—');
    expect(gp).not.toHaveTextContent('$0');
    expect(within(region).queryByText(/Brand New Free Weights/i)).not.toBeInTheDocument();
  });

  test('an overview failure is shown and the sections still work', async () => {
    login(['superadmin']);
    installFetch({ overview: [500, { error: 'Server error' }] });
    renderPage();
    expect(await screen.findByText(/could not load the overview/i)).toBeInTheDocument();
    expect(await screen.findByRole('table', { name: /sales team/i })).toBeInTheDocument();
  });
});

describe("Director's View — overview review fixes (G22d)", () => {
  const overview = async () => { await screen.findByRole('button', { name: /^sales this period/i }); return screen.getByRole('region', { name: /business overview/i }); };

  test('lines with no price are named, not hidden as "estimated"', async () => {
    login(['superadmin']);
    installFetch({ overview: [200, { ...OVERVIEW, sales: { ...OVERVIEW.sales, estimated_lines: 9, unpriced_lines: 3 } }] });
    renderPage();
    const region = await overview();
    expect(within(region).getByText(/9 estimated from the list price, 3 with no price \(counted as \$0\)/i)).toBeInTheDocument();
  });

  test('"today" tiles do not open a period section', async () => {
    login(['superadmin']);
    installFetch();
    renderPage();
    const region = await overview();
    expect(within(region).queryByRole('button', { name: /^open orders/i })).not.toBeInTheDocument();
    expect(within(region).queryByRole('button', { name: /^money still owed/i })).not.toBeInTheDocument();
    expect(within(region).getByText('$255,748')).toBeInTheDocument();
  });

  test('tile buttons are named by their label, the note describes them', async () => {
    login(['superadmin']);
    installFetch();
    renderPage();
    const region = await overview();
    const b = within(region).getByRole('button', { name: 'Sales this period' });
    expect(b).toHaveAccessibleDescription(/lines priced on the order/i);
    expect(b.querySelector('div')).toBeNull();
  });

  test('no workshop start yet → "no average yet"; deliveries go by delivery date', async () => {
    login(['superadmin']);
    installFetch({ overview: [200, { ...OVERVIEW, workshop: { ...OVERVIEW.workshop, avg_days: null, items_timed: 0 } }] });
    renderPage();
    const region = await overview();
    expect(within(region).getByText(/no average yet/i)).toBeInTheDocument();
    expect(within(region).getByText(/deliveries by the delivery date/i)).toBeInTheDocument();
  });

  test('a partial overview response does not crash the page', async () => {
    login(['superadmin']);
    installFetch({ overview: [200, { range: OVERVIEW.range, sales: OVERVIEW.sales, previous: null }] });
    renderPage();
    const region = await overview();
    expect(within(region).getByRole('button', { name: 'Sales this period' })).toHaveTextContent('$25,000');
    expect(await screen.findByRole('table', { name: /sales team/i })).toBeInTheDocument();
  });
});
