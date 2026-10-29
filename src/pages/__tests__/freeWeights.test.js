import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import ProductsPage from '../products';

// G21 (owner, 29 Oct 2026) — Products page split into "Current stock" and "Brand New Free
// Weights"; the free-weights stock is kept per individual weight.

jest.mock('react-hot-toast', () => ({
  __esModule: true,
  default: { loading: jest.fn(), success: jest.fn(), error: jest.fn() },
}));

const PRODUCTS = [{ sku: 'LF-95T', name: 'Life Fitness 95T Treadmill', brand: 'Life Fitness', stock: 3, price: '1795' }];
const LIST = {
  available: true, can_see_cost: false,
  totals: { units: 11 },
  products: [
    {
      id: 1, brand: 'Trigrip', name: 'Olympic Rubber Weight', category: 'plate', notes: '', active: true,
      variants: [
        { id: 11, weight_kg: 1.25, sku: null, stock: 0, price: 19, reorder_level: 4, active: true },
        { id: 12, weight_kg: 2.5, sku: null, stock: 3, price: 32, reorder_level: 4, active: true },
        { id: 13, weight_kg: 20, sku: null, stock: 8, price: 1795, reorder_level: 2, active: true },
      ],
    },
    {
      id: 2, brand: 'Grays', name: 'Hex Dumbbell', category: 'dumbbell', notes: '', active: true,
      variants: [{ id: 21, weight_kg: 10, sku: null, stock: 0, price: 45.5, reorder_level: null, active: true }],
    },
  ],
};
const SUPER_LIST = {
  ...LIST, can_see_cost: true, totals: { units: 11, value_at_cost: 7234.5, units_without_cost: 3 },
  products: LIST.products.map((p) => ({ ...p, variants: p.variants.map((v) => ({ ...v, unit_cost: v.id === 12 ? null : 9.5 })) })),
};

function login(roles, id = 'GL') {
  const b64 = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  localStorage.setItem('token', `${b64({ alg: 'none' })}.${b64({ id, roles })}.sig`);
  localStorage.setItem('user', JSON.stringify({ id, name: 'Shaun', access: roles[0], roles }));
}

// Route by URL + method. `fw` = { list, move, moves, product } → [status, json] or fn(body).
function installFetch(fw = {}) {
  const routes = { list: [200, LIST], moves: [200, { moves: [] }], move: [200, { variant: { id: 12, stock: 1 } }], product: [201, { id: 3, ...LIST }], ...fw };
  const mock = jest.fn(async (url, opts = {}) => {
    const u = String(url);
    let pair;
    if (!u.includes('/api/free-weights')) pair = [200, PRODUCTS];
    else if (u.includes('resource=list')) pair = routes.list;
    else if (u.includes('resource=moves')) pair = routes.moves;
    else if (u.includes('resource=move')) pair = routes.move;
    else if (u.includes('resource=product')) pair = routes.product;
    if (typeof pair === 'function') pair = pair(JSON.parse(opts.body || 'null'));
    const [status, json] = pair;
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  });
  global.fetch = mock;
  return mock;
}
const calls = (mock, part) => mock.mock.calls.filter(([url]) => String(url).includes(part));
const bodyOf = (call) => JSON.parse(call[1].body);

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname}{loc.search}</div>;
}
function renderPage(entry = '/products?tab=free-weights') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/products" element={<><ProductsPage /><Where /></>} />
        <Route path="/" element={<div>LOGIN PAGE</div>} />
        <Route path="*" element={<div>ELSEWHERE</div>} />
      </Routes>
    </MemoryRouter>
  );
}
const card = async (name) => (await screen.findByRole('article', { name: new RegExp(name) }));

beforeEach(() => localStorage.clear());

describe('Products page tabs', () => {
  test('Current stock is the default tab and unchanged', async () => {
    login(['admin']);
    const f = installFetch();
    renderPage('/products');
    expect(screen.getByRole('tab', { name: 'Current stock' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('LF-95T')).toBeInTheDocument();
    expect(calls(f, '/api/free-weights')).toHaveLength(0);
  });

  test('the Brand New Free Weights tab is in the URL and loads its own list with the login token', async () => {
    login(['admin']);
    const f = installFetch();
    renderPage('/products');
    fireEvent.click(screen.getByRole('tab', { name: 'Brand New Free Weights' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/products?tab=free-weights');
    await card('Olympic Rubber Weight');
    const [url, opts] = calls(f, 'resource=list')[0];
    expect(url).toBe('/api/free-weights?resource=list');
    expect(opts.headers.Authorization).toMatch(/^Bearer /);
    expect(screen.queryByText('LF-95T')).not.toBeInTheDocument();
  });
});

describe('Brand New Free Weights tab', () => {
  test('one card per line, one chip per weight with stock and price', async () => {
    login(['admin']);
    installFetch();
    renderPage();
    const c = await card('Trigrip Olympic Rubber Weight');
    const chip = within(c).getByRole('listitem', { name: /20 kg/ });
    expect(chip).toHaveTextContent('8 on hand');
    expect(chip).toHaveTextContent('$1,795');
    expect(within(await card('Hex Dumbbell')).getByRole('listitem', { name: /10 kg/ })).toHaveTextContent('$45.50');
  });

  test('low and out-of-stock weights are labelled in words, not colour only', async () => {
    login(['admin']);
    installFetch();
    renderPage();
    const c = await card('Olympic Rubber Weight');
    expect(within(c).getByRole('listitem', { name: /1\.25 kg/ })).toHaveTextContent('Out of stock');
    expect(within(c).getByRole('listitem', { name: /2\.5 kg/ })).toHaveTextContent('Low stock');
    expect(within(c).getByRole('listitem', { name: /20 kg/ })).not.toHaveTextContent(/low stock|out of stock/i);
    expect(within(c).getByText(/pairs/i)).toBeInTheDocument(); // plates are counted each
  });

  test('totals: units on hand; no cost for non-superadmin', async () => {
    login(['admin']);
    installFetch();
    renderPage();
    await card('Olympic Rubber Weight');
    expect(screen.getByText(/11 units on hand/)).toBeInTheDocument();
    expect(screen.queryByText(/value at cost/i)).not.toBeInTheDocument();
  });

  test('superadmin sees stock value at cost and how many units have no cost', async () => {
    login(['superadmin']);
    installFetch({ list: [200, SUPER_LIST] });
    renderPage();
    await card('Olympic Rubber Weight');
    expect(screen.getByText(/value at cost: \$7,234\.50/i)).toBeInTheDocument();
    expect(screen.getByText(/3 units have no cost set/i)).toBeInTheDocument();
  });

  test('search by weight, category filter and low-stock only', async () => {
    login(['admin']);
    installFetch();
    renderPage();
    await card('Olympic Rubber Weight');
    fireEvent.change(screen.getByLabelText('Search free weights'), { target: { value: '10kg' } });
    expect(screen.queryByRole('article', { name: /Olympic/ })).not.toBeInTheDocument();
    expect(screen.getByRole('article', { name: /Hex Dumbbell/ })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search free weights'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'plate' } });
    expect(screen.queryByRole('article', { name: /Hex/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: '' } });
    fireEvent.click(screen.getByLabelText('Low stock only'));
    expect(screen.getAllByRole('article')).toHaveLength(2); // both lines have a low/out weight
  });

  test('before the migration: a plain "not set up yet" message', async () => {
    login(['admin']);
    installFetch({ list: [200, { available: false, can_see_cost: false, products: [], totals: { units: 0 } }] });
    renderPage();
    expect(await screen.findByText(/not set up on this database yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add product line/i })).not.toBeInTheDocument();
  });

  test('an expired login goes back to the login page', async () => {
    login(['admin']);
    installFetch({ list: [401, { error: 'Authentication required' }] });
    renderPage();
    expect(await screen.findByText('LOGIN PAGE')).toBeInTheDocument();
    expect(localStorage.getItem('token')).toBeNull();
  });

  test('a refused login (workshop) sees the server message, not a crash', async () => {
    login(['technician'], 'TE');
    installFetch({ list: [403, { error: 'Free weights stock is not available to workshop logins' }] });
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent(/not available to workshop logins/);
  });

  test('copy calls it brand new — never used or second-hand', async () => {
    login(['admin']);
    installFetch();
    renderPage();
    await card('Olympic Rubber Weight');
    expect(document.body.textContent).not.toMatch(/second-hand|\bused\b|refurbished/i);
  });
});

describe('Update stock on one weight', () => {
  test('Sold 2 with an invoice number posts one move and shows the new count', async () => {
    login(['admin']);
    const f = installFetch({ move: [200, { variant: { id: 12, stock: 1 } }] });
    renderPage();
    const c = await card('Olympic Rubber Weight');
    fireEvent.click(within(c).getByRole('button', { name: 'Update stock — Trigrip Olympic Rubber Weight 2.5 kg' }));
    const dialog = await screen.findByRole('dialog', { name: /2\.5 kg/ });
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'sold' } });
    fireEvent.change(within(dialog).getByLabelText('Quantity'), { target: { value: '2' } });
    fireEvent.change(within(dialog).getByLabelText(/Invoice or PO number/), { target: { value: 'INV-20411' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save stock change' }));
    await waitFor(() => expect(calls(f, 'resource=move&').length + calls(f, 'resource=move').filter(([u]) => !u.includes('moves')).length).toBeGreaterThan(0));
    const post = f.mock.calls.find(([u, o]) => String(u) === '/api/free-weights?resource=move' && o?.method === 'POST');
    expect(bodyOf(post)).toEqual({ variant_id: 12, qty: 2, reason: 'sold', reference: 'INV-20411', note: '' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(within(c).getByRole('listitem', { name: /2\.5 kg/ })).toHaveTextContent('1 on hand');
  });

  test('an adjustment can take stock out (signed quantity)', async () => {
    login(['admin']);
    const f = installFetch();
    renderPage();
    const c = await card('Olympic Rubber Weight');
    fireEvent.click(within(c).getByRole('button', { name: /Update stock — .* 20 kg/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'adjustment' } });
    fireEvent.click(within(dialog).getByLabelText('Take out'));
    fireEvent.change(within(dialog).getByLabelText('Quantity'), { target: { value: '3' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save stock change' }));
    await waitFor(() => expect(f.mock.calls.some(([u, o]) => String(u) === '/api/free-weights?resource=move' && o?.method === 'POST')).toBe(true));
    const post = f.mock.calls.find(([u, o]) => String(u) === '/api/free-weights?resource=move' && o?.method === 'POST');
    expect(bodyOf(post)).toMatchObject({ variant_id: 13, qty: -3, reason: 'adjustment' });
  });

  test('a refused move (not enough stock) keeps the dialog open with the reason', async () => {
    login(['admin']);
    installFetch({ move: [409, { error: 'Only 0 on hand — cannot take out 1' }] });
    renderPage();
    const c = await card('Olympic Rubber Weight');
    fireEvent.click(within(c).getByRole('button', { name: /Update stock — .* 1\.25 kg/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'sold' } });
    fireEvent.change(within(dialog).getByLabelText('Quantity'), { target: { value: '1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save stock change' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Only 0 on hand');
  });

  test('the dialog shows that weight\'s history', async () => {
    login(['admin']);
    const f = installFetch({ moves: [200, { moves: [{ id: 5, delta: 12, reason: 'received', reference: 'PO-77', note: null, user_id: 'GA', user_name: 'Vincent', at: '2026-10-28T04:00:00.000Z' }] }] });
    renderPage();
    const c = await card('Olympic Rubber Weight');
    fireEvent.click(within(c).getByRole('button', { name: /Update stock — .* 2\.5 kg/ }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/\+12/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Vincent/)).toBeInTheDocument();
    expect(within(dialog).getByText(/PO-77/)).toBeInTheDocument();
    expect(calls(f, 'resource=moves&variant_id=12')).toHaveLength(1);
  });
});

describe('Add a product line', () => {
  test('plate ladder prefill, prices, opening stock → one POST', async () => {
    login(['admin']);
    const f = installFetch();
    renderPage();
    await card('Olympic Rubber Weight');
    fireEvent.click(screen.getByRole('button', { name: '+ Add product line' }));
    const dialog = await screen.findByRole('dialog', { name: /add product line/i });
    fireEvent.change(within(dialog).getByLabelText('Brand'), { target: { value: 'Trigrip' } });
    fireEvent.change(within(dialog).getByLabelText('Product name'), { target: { value: 'Bumper Plate' } });
    fireEvent.change(within(dialog).getByLabelText('Category'), { target: { value: 'plate' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /use the plates ladder/i }));
    expect(within(dialog).getAllByLabelText(/^Weight \(kg\)/)).toHaveLength(7);
    expect(within(dialog).queryByLabelText(/unit cost/i)).not.toBeInTheDocument(); // admin: no cost
    for (const input of within(dialog).getAllByLabelText(/^Price for /)) fireEvent.change(input, { target: { value: '25' } });
    fireEvent.change(within(dialog).getByLabelText('Price for 20 kg'), { target: { value: '1795' } });
    fireEvent.change(within(dialog).getByLabelText('Opening stock for 20 kg'), { target: { value: '4' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save product line' }));
    await waitFor(() => expect(f.mock.calls.some(([u, o]) => String(u) === '/api/free-weights?resource=product' && o?.method === 'POST')).toBe(true));
    const post = f.mock.calls.find(([u, o]) => String(u) === '/api/free-weights?resource=product' && o?.method === 'POST');
    const body = bodyOf(post);
    expect(body).toMatchObject({ brand: 'Trigrip', name: 'Bumper Plate', category: 'plate' });
    expect(body.variants).toHaveLength(7);
    expect(body.variants.find((v) => v.weight_kg === 20)).toMatchObject({ price: 1795, stock: 4 });
    expect(body.variants[0]).not.toHaveProperty('unit_cost');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  test('a weight with no price is caught before saving', async () => {
    login(['admin']);
    const f = installFetch();
    renderPage();
    await card('Olympic Rubber Weight');
    fireEvent.click(screen.getByRole('button', { name: '+ Add product line' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Brand'), { target: { value: 'X' } });
    fireEvent.change(within(dialog).getByLabelText('Product name'), { target: { value: 'Y' } });
    fireEvent.change(within(dialog).getByLabelText(/^Weight \(kg\)/), { target: { value: '5' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save product line' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/price/i);
    expect(f.mock.calls.some(([, o]) => o?.method === 'POST')).toBe(false);
  });

  test('superadmin can enter unit cost; edit never sends stock', async () => {
    login(['superadmin']);
    const f = installFetch({ list: [200, SUPER_LIST], product: [200, { id: 1, ...SUPER_LIST }] });
    renderPage();
    const c = await card('Olympic Rubber Weight');
    fireEvent.click(within(c).getByRole('button', { name: 'Edit Trigrip Olympic Rubber Weight' }));
    const dialog = await screen.findByRole('dialog', { name: /edit/i });
    expect(within(dialog).getByLabelText('Unit cost for 20 kg')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/opening stock/i)).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Price for 20 kg'), { target: { value: '1695' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save product line' }));
    await waitFor(() => expect(f.mock.calls.some(([u, o]) => String(u) === '/api/free-weights?resource=product&id=1' && o?.method === 'PUT')).toBe(true));
    const put = f.mock.calls.find(([u, o]) => String(u) === '/api/free-weights?resource=product&id=1' && o?.method === 'PUT');
    const body = bodyOf(put);
    expect(body.variants.find((v) => v.weight_kg === 20)).toMatchObject({ price: 1695, unit_cost: 9.5 });
    expect(body.variants.every((v) => !('stock' in v))).toBe(true);
  });
});

describe('CSV export', () => {
  test('exports the filtered list', async () => {
    login(['admin']);
    installFetch();
    const created = [];
    global.URL.createObjectURL = jest.fn((blob) => { created.push(blob); return 'blob:x'; });
    global.URL.revokeObjectURL = jest.fn();
    const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {}); // jsdom cannot navigate
    renderPage();
    await card('Olympic Rubber Weight');
    fireEvent.click(screen.getByRole('button', { name: 'Export free weights CSV' }));
    expect(created).toHaveLength(1);
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });
});

describe('G21 review fixes', () => {
  test('a typo in an optional number is caught, never sent as blank', async () => {
    login(['admin']);
    const f = installFetch();
    renderPage();
    await card('Olympic Rubber Weight');
    fireEvent.click(screen.getByRole('button', { name: '+ Add product line' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Brand'), { target: { value: 'X' } });
    fireEvent.change(within(dialog).getByLabelText('Product name'), { target: { value: 'Y' } });
    fireEvent.change(within(dialog).getByLabelText(/^Weight \(kg\)/), { target: { value: '5' } });
    fireEvent.change(within(dialog).getByLabelText('Price for 5 kg'), { target: { value: '49' } });
    fireEvent.change(within(dialog).getByLabelText('Opening stock for 5 kg'), { target: { value: '4o' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save product line' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/opening stock for 5 kg/i);
    expect(f.mock.calls.some(([, o]) => o?.method === 'POST')).toBe(false);
  });

  test('superadmin: value at cost follows a stock change', async () => {
    login(['superadmin']);
    const list = { ...SUPER_LIST, totals: { units: 11, value_at_cost: 100, units_without_cost: 3 } };
    installFetch({ list: [200, list], move: [200, { variant: { id: 13, stock: 10 } }] }); // 20 kg: 8 → 10 at $9.50
    renderPage();
    const c = await card('Olympic Rubber Weight');
    fireEvent.click(within(c).getByRole('button', { name: /Update stock — .* 20 kg/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Quantity'), { target: { value: '2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save stock change' }));
    expect(await screen.findByText(/13 units on hand/)).toBeInTheDocument();
    expect(screen.getByText(/value at cost: \$119/i)).toBeInTheDocument();
  });

  test('clicking outside the line form does not throw the edits away', async () => {
    login(['admin']);
    installFetch();
    renderPage();
    await card('Olympic Rubber Weight');
    fireEvent.click(screen.getByRole('button', { name: '+ Add product line' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(dialog); // the backdrop
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  test('switching tabs keeps other URL settings; the panel is labelled by its tab', async () => {
    login(['admin']);
    installFetch();
    renderPage('/products?inStock=true');
    fireEvent.click(screen.getByRole('tab', { name: 'Brand New Free Weights' }));
    expect(screen.getByTestId('where')).toHaveTextContent('inStock=true');
    expect(screen.getByTestId('where')).toHaveTextContent('tab=free-weights');
    expect(screen.getByRole('tabpanel', { name: 'Brand New Free Weights' })).toBeInTheDocument();
    await card('Olympic Rubber Weight'); // let the list load settle
  });
});
