import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ProductsPage from '../products';

// G11 follow-up (Nick, 13 Oct 2026) — "View Lots" next to Edit on the Products page: the
// in-stock lot numbers for that one product.

jest.mock('react-hot-toast', () => ({
  __esModule: true,
  default: { loading: jest.fn(), success: jest.fn(), error: jest.fn() },
}));

const PRODUCTS = [
  { sku: 'LF-95T', name: 'Life Fitness 95T Treadmill', brand: 'Life Fitness', stock: 3, price: '1795' },
  { sku: 'PRE-EFX', name: 'Precor EFX 885', brand: 'Precor', stock: 0, price: '2495' },
];
const LOTS = {
  sku: 'LF-95T', count: 3, in_stock_count: 2, limit: 500,
  lots: [
    { lot_number: 'L00007', status: 'In Stock', assigned_to: null, serial_number: null, created_at: '2026-07-10T02:00:00.000Z', collection_name: 'Anytime Fitness Geelong', collection_date: '2026-07-10' },
    { lot_number: 'L00009', status: 'In Stock', assigned_to: null, serial_number: 'SN-9', created_at: '2026-08-01T02:00:00.000Z', collection_name: null, collection_date: null },
    { lot_number: 'L00003', status: 'Assigned', assigned_to: { workorder_id: 883, invoice_id: 'INV-883', customer_name: 'Dana Customer' }, serial_number: null, created_at: '2026-07-01T02:00:00.000Z', collection_name: null, collection_date: null },
  ],
};

function login(roles) {
  const b64 = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  localStorage.setItem('token', `${b64({ alg: 'none' })}.${b64({ id: 'GL', roles })}.sig`);
  localStorage.setItem('user', JSON.stringify({ id: 'GL', name: 'Shaun', access: roles[0], roles }));
}

function installFetch(lots = [200, LOTS]) {
  const mock = jest.fn(async (url) => {
    if (String(url).includes('resource=product-lots')) {
      const [status, json] = lots;
      return { ok: status >= 200 && status < 300, status, json: async () => json };
    }
    return { ok: true, status: 200, json: async () => PRODUCTS };
  });
  global.fetch = mock;
  return mock;
}
const lotCalls = (mock) => mock.mock.calls.filter(([url]) => String(url).includes('resource=product-lots'));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/products']}>
      <Routes>
        <Route path="/products" element={<ProductsPage />} />
        <Route path="*" element={<div>ELSEWHERE</div>} />
      </Routes>
    </MemoryRouter>
  );
}
const rowFor = async (sku) => (await screen.findByText(sku)).closest('tr');

beforeEach(() => localStorage.clear());

describe('Products page — View Lots', () => {
  test('admin sees a View Lots button next to Edit on every product', async () => {
    login(['admin']);
    installFetch();
    renderPage();
    const row = await rowFor('LF-95T');
    expect(within(row).getByRole('link', { name: 'Edit' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'View Lots for LF-95T' })).toHaveTextContent('View Lots');
    expect(within(await rowFor('PRE-EFX')).getByRole('button', { name: 'View Lots for PRE-EFX' })).toBeInTheDocument();
  });

  test('clicking it lists that product’s lots, each linking to the Lot Tracker', async () => {
    login(['superadmin']);
    const mock = installFetch();
    renderPage();
    fireEvent.click(within(await rowFor('LF-95T')).getByRole('button', { name: 'View Lots for LF-95T' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByRole('heading', { name: 'Lots' })).toBeInTheDocument();
    expect(within(dialog).getByText(/Life Fitness 95T Treadmill/)).toBeInTheDocument();
    expect(await within(dialog).findByRole('link', { name: 'L00007' })).toHaveAttribute('href', '/lot-tracker?lot=L00007');
    expect(within(dialog).getByRole('link', { name: 'L00009' })).toHaveAttribute('href', '/lot-tracker?lot=L00009');
    expect(within(dialog).getByText('2 in stock · 1 assigned to an order')).toBeInTheDocument();
    expect(within(dialog).getByText('SN-9')).toBeInTheDocument();
    expect(within(dialog).getByText('Anytime Fitness Geelong')).toBeInTheDocument();

    const calls = lotCalls(mock);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('/api/lots?resource=product-lots&sku=LF-95T');
    expect(calls[0][1].headers.Authorization).toMatch(/^Bearer /);
    // Read-only: nothing on this page writes when lots are viewed.
    expect(mock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  });

  test('an assigned lot shows where it went and that it is no longer in stock', async () => {
    login(['admin']);
    installFetch();
    renderPage();
    fireEvent.click(within(await rowFor('LF-95T')).getByRole('button', { name: 'View Lots for LF-95T' }));
    const dialog = await screen.findByRole('dialog');
    const assigned = (await within(dialog).findByRole('link', { name: 'L00003' })).closest('tr');
    expect(within(assigned).getByText('Assigned — no longer in stock')).toBeInTheDocument();
    expect(within(assigned).getByRole('link', { name: 'Workorder #883' })).toHaveAttribute('href', '/delivery_operations/workorder/883');
    expect(assigned).toHaveTextContent('INV-883');
    expect(assigned).toHaveTextContent('Dana Customer');
    const inStock = within(dialog).getByRole('link', { name: 'L00007' }).closest('tr');
    expect(within(inStock).getByText('In stock')).toBeInTheDocument();
    expect(within(inStock).getByText('Not assigned')).toBeInTheDocument();
  });

  test('says when the in-stock lot count and the stock figure disagree', async () => {
    login(['admin']);
    installFetch();
    renderPage();
    fireEvent.click(within(await rowFor('LF-95T')).getByRole('button', { name: 'View Lots for LF-95T' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/Stock on hand is 3/)).toBeInTheDocument();
  });

  test('a product with no in-stock lots says so', async () => {
    login(['admin']);
    installFetch([200, { sku: 'PRE-EFX', count: 0, in_stock_count: 0, limit: 500, lots: [] }]);
    renderPage();
    fireEvent.click(within(await rowFor('PRE-EFX')).getByRole('button', { name: 'View Lots for PRE-EFX' }));
    expect(await screen.findByText('No lots recorded for this product.')).toBeInTheDocument();
  });

  test('a failed load shows the error in the dialog', async () => {
    login(['admin']);
    installFetch([403, { error: 'Insufficient role' }]);
    renderPage();
    fireEvent.click(within(await rowFor('LF-95T')).getByRole('button', { name: 'View Lots for LF-95T' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Insufficient role');
  });

  test('no mismatch note when the in-stock lots equal the stock figure, even with assigned lots listed', async () => {
    login(['admin']);
    installFetch([200, { ...LOTS, count: 4, in_stock_count: 3, lots: [...LOTS.lots, { ...LOTS.lots[0], lot_number: 'L00011' }] }]);
    renderPage();
    fireEvent.click(within(await rowFor('LF-95T')).getByRole('button', { name: 'View Lots for LF-95T' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('link', { name: 'L00011' });
    expect(within(dialog).queryByText(/Stock on hand is/)).not.toBeInTheDocument();
  });

  test('Escape and the Close button both close it', async () => {
    login(['admin']);
    installFetch();
    renderPage();
    const button = within(await rowFor('LF-95T')).getByRole('button', { name: 'View Lots for LF-95T' });
    fireEvent.click(button);
    await screen.findByRole('dialog');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(button);
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  test('Tab stays inside the dialog, and focus returns to the button that opened it', async () => {
    login(['admin']);
    installFetch();
    renderPage();
    const button = within(await rowFor('LF-95T')).getByRole('button', { name: 'View Lots for LF-95T' });
    button.focus();
    fireEvent.click(button);
    const dialog = await screen.findByRole('dialog');
    const close = within(dialog).getByRole('button', { name: 'Close' });
    expect(close).toHaveFocus();
    const firstLot = await within(dialog).findByRole('link', { name: 'L00007' });
    fireEvent.keyDown(window, { key: 'Tab' }); // from the last control → wraps to the first
    expect(firstLot).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true }); // and back
    expect(close).toHaveFocus();
    fireEvent.click(close);
    await waitFor(() => expect(button).toHaveFocus());
  });

  test('unit cost is shown only when the server sends it (superadmin)', async () => {
    login(['superadmin']);
    installFetch([200, { ...LOTS, lots: [{ ...LOTS.lots[0], unit_cost: 450 }, { ...LOTS.lots[1], unit_cost: null }] }]);
    renderPage();
    fireEvent.click(within(await rowFor('LF-95T')).getByRole('button', { name: 'View Lots for LF-95T' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('columnheader', { name: 'Unit cost' })).toBeInTheDocument();
    expect(within(dialog).getByText('$450.00')).toBeInTheDocument();
  });

  test('no unit cost column when the server sends none (admin)', async () => {
    login(['admin']);
    installFetch();
    renderPage();
    fireEvent.click(within(await rowFor('LF-95T')).getByRole('button', { name: 'View Lots for LF-95T' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('link', { name: 'L00007' });
    expect(within(dialog).queryByRole('columnheader', { name: 'Unit cost' })).not.toBeInTheDocument();
  });

  test('staff and technicians get Edit only — no View Lots, and no lots request', async () => {
    login(['staff']);
    const mock = installFetch();
    renderPage();
    const row = await rowFor('LF-95T');
    expect(within(row).getByRole('link', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /View Lots/ })).not.toBeInTheDocument();
    expect(lotCalls(mock)).toHaveLength(0);
  });
});
