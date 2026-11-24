import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CompletedOperationsPage from '../delivery_operations/completed-operations';

// G23 (owner, 30 Oct 2026): cancelled workorders are listed on the same page, behind a switch.
// 25 Nov 2026 (owner): the default view shows completed AND cancelled together, so one search
// finds both; each row says which it is. The switch can still narrow to one.
jest.mock('react-hot-toast', () => ({
  __esModule: true,
  default: { success: jest.fn(), error: jest.fn(), loading: jest.fn(), dismiss: jest.fn() },
}));

const ROW = (id, invoice, status, date, customer = 'Pat') => ({
  workorder_id: id, invoice_id: invoice, customer_name: customer, status, date_created: date, items: [],
});

function mockFetch() {
  const f = jest.fn(async (url) => ({
    ok: true, status: 200,
    json: async () => (String(url).includes('status=Cancelled')
      ? [ROW(2, 'INV-CANX', 'Cancelled', '2026-10-05', 'Robin')]
      : [ROW(1, 'INV-DONE', 'Completed', '2026-10-01')]),
  }));
  global.fetch = f;
  return f;
}

beforeEach(() => {
  localStorage.setItem('user', JSON.stringify({ id: 'BR', access: 'sales', roles: ['sales'] }));
});

test('default view lists completed and cancelled together, newest first, with a status badge', async () => {
  const f = mockFetch();
  render(<MemoryRouter><CompletedOperationsPage /></MemoryRouter>);
  expect(await screen.findByText('INV-DONE')).toBeInTheDocument();
  expect(screen.getByText('INV-CANX')).toBeInTheDocument();
  const urls = f.mock.calls.map((c) => c[0]).sort();
  expect(urls).toEqual(['/api/workorder?status=Cancelled', '/api/workorder?status=Completed']);
  // Newest first across both lists: the cancelled one (5 Oct) above the completed one (1 Oct).
  const rows = screen.getAllByRole('row').slice(1);
  expect(within(rows[0]).getByText('INV-CANX')).toBeInTheDocument();
  expect(within(rows[0]).getByText('Cancelled')).toBeInTheDocument();
  expect(within(rows[1]).getByText('Completed')).toBeInTheDocument();
});

test('search finds a cancelled workorder in the default view', async () => {
  mockFetch();
  render(<MemoryRouter><CompletedOperationsPage /></MemoryRouter>);
  await screen.findByText('INV-DONE');
  fireEvent.change(screen.getByPlaceholderText('Search'), { target: { value: 'robin' } });
  expect(screen.getByText('INV-CANX')).toBeInTheDocument();
  expect(screen.queryByText('INV-DONE')).not.toBeInTheDocument();
});

test('the switch still narrows to Completed only or Cancelled only', async () => {
  const f = mockFetch();
  render(<MemoryRouter><CompletedOperationsPage /></MemoryRouter>);
  await screen.findByText('INV-DONE');
  fireEvent.change(screen.getByLabelText('Show completed or cancelled'), { target: { value: 'Cancelled' } });
  expect(await screen.findByText('INV-CANX')).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByText('INV-DONE')).not.toBeInTheDocument());
  await waitFor(() => expect(f.mock.calls.at(-1)[0]).toBe('/api/workorder?status=Cancelled'));
  expect(screen.getAllByText('Operations Cancelled').length).toBeGreaterThan(0);
  fireEvent.change(screen.getByLabelText('Show completed or cancelled'), { target: { value: 'Completed' } });
  expect(await screen.findByText('INV-DONE')).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByText('INV-CANX')).not.toBeInTheDocument());
});
