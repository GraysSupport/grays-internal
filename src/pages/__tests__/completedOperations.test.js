import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CompletedOperationsPage from '../delivery_operations/completed-operations';

// G23 (owner, 30 Oct 2026): cancelled workorders are listed on the same page, behind a switch.
jest.mock('react-hot-toast', () => ({
  __esModule: true,
  default: { success: jest.fn(), error: jest.fn(), loading: jest.fn(), dismiss: jest.fn() },
}));

const ROW = (id, invoice) => ({ workorder_id: id, invoice_id: invoice, customer_name: 'Pat', date_created: '2026-10-01', items: [] });

test('Completed by default; switching to Cancelled loads the cancelled list', async () => {
  localStorage.setItem('user', JSON.stringify({ id: 'BR', access: 'sales', roles: ['sales'] }));
  const f = jest.fn(async (url) => ({
    ok: true, status: 200,
    json: async () => (String(url).includes('status=Cancelled') ? [ROW(2, 'INV-CANX')] : [ROW(1, 'INV-DONE')]),
  }));
  global.fetch = f;
  render(<MemoryRouter><CompletedOperationsPage /></MemoryRouter>);
  expect(await screen.findByText('INV-DONE')).toBeInTheDocument();
  expect(f.mock.calls[0][0]).toBe('/api/workorder?status=Completed');
  fireEvent.change(screen.getByLabelText('Show completed or cancelled'), { target: { value: 'Cancelled' } });
  expect(await screen.findByText('INV-CANX')).toBeInTheDocument();
  expect(screen.queryByText('INV-DONE')).not.toBeInTheDocument();
  await waitFor(() => expect(f.mock.calls.at(-1)[0]).toBe('/api/workorder?status=Cancelled'));
  expect(screen.getAllByText('Operations Cancelled').length).toBeGreaterThan(0);
});
