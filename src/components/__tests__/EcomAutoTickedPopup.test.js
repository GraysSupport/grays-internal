import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import EcomAutoTickedPopup from '../EcomAutoTickedPopup';
import { shouldMarkEcomAutoSeen, markEcomAutoSeen } from '../../utils/ecomAutoTicked';

// Owner, 26 Nov 2026: once the dry run is off, a successful website update ticks the E-Commerce
// flag by itself — GS still needs a popup to open each of those workorders ONCE and enter the
// sold items' values. Once a workorder is opened it never pops up again.

const rows = [
  { workorder_id: 11, invoice_id: 'INV-11', customer_name: 'Alex Smith', ecommerce_auto_ticked_at: '2026-11-27T01:00:00Z', items: [{ product_name: 'Life Fitness Treadmill', quantity: 1 }, { product_name: 'Bench', quantity: 2 }] },
  { workorder_id: 12, invoice_id: 'INV-12', customer_name: 'Jo Lee', ecommerce_auto_ticked_at: '2026-11-27T02:00:00Z', items: [] },
];

function mockList(list, { ok = true } = {}) {
  global.fetch = jest.fn(async () => ({ ok, status: ok ? 200 : 403, json: async () => ({ available: true, rows: list }) }));
}

beforeEach(() => { localStorage.clear(); });

test('pops up with each automatically ticked workorder and its sold items', async () => {
  mockList(rows);
  render(<EcomAutoTickedPopup onOpen={() => {}} />);
  expect(await screen.findByRole('dialog', { name: /website stock updated automatically/i })).toBeInTheDocument();
  expect(screen.getByText('INV-11')).toBeInTheDocument();
  expect(screen.getByText(/1 × Life Fitness Treadmill, 2 × Bench/)).toBeInTheDocument();
  expect(screen.getByText('INV-12')).toBeInTheDocument();
  expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('resource=ecommerce-auto-ticked'), expect.anything());
});

test('nothing to show → no popup', async () => {
  mockList([]);
  render(<EcomAutoTickedPopup onOpen={() => {}} />);
  await waitFor(() => expect(global.fetch).toHaveBeenCalled());
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('server refuses (not GS) → no popup, no error', async () => {
  mockList(rows, { ok: false });
  render(<EcomAutoTickedPopup onOpen={() => {}} />);
  await waitFor(() => expect(global.fetch).toHaveBeenCalled());
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('Open goes to that workorder', async () => {
  mockList(rows);
  const onOpen = jest.fn();
  render(<EcomAutoTickedPopup onOpen={onOpen} />);
  await screen.findByText('INV-11');
  fireEvent.click(screen.getByRole('button', { name: /open INV-11/i }));
  expect(onOpen).toHaveBeenCalledWith(11);
});

test('Close hides it for now', async () => {
  mockList(rows);
  render(<EcomAutoTickedPopup onOpen={() => {}} />);
  await screen.findByText('INV-11');
  fireEvent.click(screen.getByRole('button', { name: /close/i }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('the workorder page marks it seen only for GS, only while it is waiting', () => {
  const waiting = { workorder_id: 11, ecommerce_auto_ticked_at: '2026-11-27T01:00:00Z', ecommerce_auto_seen_at: null };
  expect(shouldMarkEcomAutoSeen(waiting, true)).toBe(true);
  expect(shouldMarkEcomAutoSeen(waiting, false)).toBe(false);
  expect(shouldMarkEcomAutoSeen({ ...waiting, ecommerce_auto_seen_at: '2026-11-27T03:00:00Z' }, true)).toBe(false);
  expect(shouldMarkEcomAutoSeen({ ...waiting, ecommerce_auto_ticked_at: null }, true)).toBe(false);
  expect(shouldMarkEcomAutoSeen(null, true)).toBe(false);
});

test('marking seen posts to the one-segment workorder API', async () => {
  global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, marked: true }) }));
  await expect(markEcomAutoSeen(11)).resolves.toBe(true);
  const [url, opts] = global.fetch.mock.calls[0];
  expect(url).toBe('/api/workorder?id=11&resource=ecommerce-auto-seen');
  expect(opts.method).toBe('POST');
});

test('marking seen never throws when the network fails', async () => {
  global.fetch = jest.fn(async () => { throw new Error('offline'); });
  await expect(markEcomAutoSeen(11)).resolves.toBe(false);
});
