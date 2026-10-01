import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import DeliverySchedulePage from '../delivery_operations/schedule';
import { compareStops, moveStop, neighbourInRun, runKey, sameRun, stopsInRun, runOrderPayload } from '../../utils/runOrder';

// G9 — drag-to-reorder booked deliveries, only within the same carrier AND the same day.

const BOOKED = 'Booked for Delivery';
const d = (id, name, carrierId, carrier, day) => ({
  delivery_id: id, invoice_id: `INV${id}`, customer_name: name, delivery_suburb: 'Altona North', delivery_state: 'VIC',
  removalist_id: carrierId, removalist_name: carrier, delivery_date: day, delivery_status: BOOKED,
  workorder_id: 100 + id, items_text: '1 × Treadmill', outstanding_balance: 0, notes: '',
  delivery_charged: 100, delivery_quoted: 80,
});
const DELIVERIES = [
  d(1, 'Alice', 7, 'Nelson', '2026-10-02'),
  d(2, 'Bob', 7, 'Nelson', '2026-10-02'),
  d(3, 'Cara', 7, 'Nelson', '2026-10-02'),
  d(4, 'Dan', 9, 'Cobbs', '2026-10-02'),   // same day, other carrier
  d(5, 'Eve', 7, 'Nelson', '2026-10-03'),  // same carrier, other day
];
const REMOVALISTS = [{ id: 7, name: 'Nelson' }, { id: 9, name: 'Cobbs' }];

function login(roles) {
  const b64 = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  localStorage.setItem('token', `${b64({ alg: 'none' })}.${b64({ id: 'GL', roles })}.sig`);
  localStorage.setItem('user', JSON.stringify({ id: 'GL', name: 'Shaun', access: roles[0], roles }));
}

function installFetch({ order = {}, available = true, putStatus = 200, putError } = {}) {
  const mock = jest.fn(async (url, init = {}) => {
    const ok = (json, status = 200) => ({ ok: status < 300, status, json: async () => json });
    if (String(url).includes('resource=run-order')) {
      if (init.method === 'PUT') {
        return putStatus === 200 ? ok({ available: true, order: {} }) : ok({ error: putError || 'nope' }, putStatus);
      }
      return ok({ available, order });
    }
    if (String(url).startsWith('/api/delivery')) return ok({ deliveries: DELIVERIES, removalists: REMOVALISTS });
    return ok({});
  });
  global.fetch = mock;
  return mock;
}
const puts = (mock) => mock.mock.calls.filter(([, init]) => init?.method === 'PUT').map(([url, init]) => ({ url, body: JSON.parse(init.body) }));

async function renderSchedule() {
  const view = render(<MemoryRouter initialEntries={['/delivery_operations/schedule']}><DeliverySchedulePage /></MemoryRouter>);
  await waitFor(() => expect(view.container.querySelector('tr[tabindex="0"]')).not.toBeNull());
  return view;
}
// Customer names of the on-screen schedule rows, top to bottom.
const NAMES = ['Alice', 'Bob', 'Cara', 'Dan', 'Eve'];
const rowsOf = (container) => Array.from(container.querySelectorAll('tr[tabindex="0"]'));
const orderOf = (container) => rowsOf(container).map((tr) => NAMES.find((n) => tr.textContent.includes(n))).join(',');
const rowFor = (container, name) => rowsOf(container).find((tr) => tr.textContent.includes(name));

beforeEach(() => localStorage.clear());

describe('runOrder utils', () => {
  test('a run is carrier + day; rows with no day belong to no run', () => {
    expect(runKey(DELIVERIES[0])).toBe('7|2026-10-02');
    expect(runKey({ removalist_id: null, delivery_date: '2026-10-02' })).toBe('none|2026-10-02');
    expect(runKey({ removalist_id: 7, delivery_date: null })).toBe('');
    expect(sameRun(DELIVERIES[0], DELIVERIES[1])).toBe(true);
    expect(sameRun(DELIVERIES[0], DELIVERIES[3])).toBe(false); // other carrier
    expect(sameRun(DELIVERIES[0], DELIVERIES[4])).toBe(false); // other day
    expect(sameRun({ removalist_id: 7, delivery_date: null }, { removalist_id: 7, delivery_date: null })).toBe(false);
  });

  test('unordered rows sort exactly as before (carrier, then customer); ordered rows come first', () => {
    const names = (order) => [...DELIVERIES.slice(0, 4)].sort(compareStops(order)).map((r) => r.customer_name).join(',');
    expect(names({})).toBe('Dan,Alice,Bob,Cara');
    expect(names({ 3: 1, 1: 2, 2: 3 })).toBe('Dan,Cara,Alice,Bob');
    expect(names({ 3: 1 })).toBe('Dan,Cara,Alice,Bob'); // partially ordered: ordered first
  });

  test('moveStop returns the run’s complete new order, and refuses cross-run moves', () => {
    expect(moveStop(DELIVERIES, {}, 3, 1)).toEqual([3, 1, 2]);
    expect(moveStop(DELIVERIES, {}, 1, 3)).toEqual([2, 3, 1]);
    expect(moveStop(DELIVERIES, { 3: 1, 1: 2, 2: 3 }, 2, 3)).toEqual([2, 3, 1]);
    expect(moveStop(DELIVERIES, {}, 1, 4)).toBeNull(); // other carrier
    expect(moveStop(DELIVERIES, {}, 1, 5)).toBeNull(); // other day
    expect(moveStop(DELIVERIES, {}, 1, 1)).toBeNull();
    expect(moveStop(DELIVERIES, {}, 1, 999)).toBeNull();
  });

  test('neighbours stop at the ends of the run; the payload names the carrier + day', () => {
    expect(neighbourInRun(DELIVERIES, {}, DELIVERIES[0], 'up')).toBeNull();
    expect(neighbourInRun(DELIVERIES, {}, DELIVERIES[0], 'down').delivery_id).toBe(2);
    expect(neighbourInRun(DELIVERIES, {}, DELIVERIES[2], 'down')).toBeNull(); // Dan is next on screen but another run
    expect(stopsInRun(DELIVERIES, DELIVERIES[3], {})).toHaveLength(1);
    expect(runOrderPayload(DELIVERIES[0], [2, 1, 3])).toEqual({ removalist_id: 7, delivery_date: '2026-10-02', delivery_ids: [2, 1, 3] });
  });
});

describe('schedule page', () => {
  test('default order is unchanged when nothing has been ordered', async () => {
    login(['admin']);
    installFetch();
    const { container } = await renderSchedule();
    expect(orderOf(container)).toBe('Dan,Alice,Bob,Cara,Eve');
  });

  test('a saved order is shown', async () => {
    login(['technician']);
    installFetch({ order: { 3: 1, 1: 2, 2: 3 } });
    const { container } = await renderSchedule();
    await waitFor(() => expect(orderOf(container)).toBe('Dan,Cara,Alice,Bob,Eve'));
  });

  test.each([['logistics'], ['admin'], ['superadmin']])('%s: Move down saves the run’s new order', async (role) => {
    login([role]);
    const fetchMock = installFetch();
    const { container } = await renderSchedule();
    fireEvent.click(await screen.findByRole('button', { name: 'Move Alice down' }));
    await waitFor(() => expect(puts(fetchMock)).toHaveLength(1));
    expect(puts(fetchMock)[0]).toEqual({
      url: '/api/delivery?resource=run-order',
      body: { removalist_id: 7, delivery_date: '2026-10-02', delivery_ids: [2, 1, 3] },
    });
    expect(orderOf(container)).toBe('Dan,Bob,Alice,Cara,Eve');
  });

  test('keyboard/touch buttons cannot leave the run', async () => {
    login(['admin']);
    installFetch();
    await renderSchedule();
    expect(await screen.findByRole('button', { name: 'Move Alice up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Cara down' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Dan up' })).toBeDisabled();   // alone on Cobbs that day
    expect(screen.getByRole('button', { name: 'Move Dan down' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Eve up' })).toBeDisabled();   // alone on the 3rd
    expect(screen.getByRole('button', { name: 'Move Bob up' })).toBeEnabled();
  });

  test('drag a row onto another stop of the same carrier and day → reordered', async () => {
    login(['admin']);
    const fetchMock = installFetch();
    const { container } = await renderSchedule();
    await screen.findByRole('button', { name: 'Move Cara up' });
    fireEvent.dragStart(rowFor(container, 'Cara'));
    const accepted = !fireEvent.dragOver(rowFor(container, 'Alice')); // preventDefault() = a valid drop target
    expect(accepted).toBe(true);
    fireEvent.drop(rowFor(container, 'Alice'));
    await waitFor(() => expect(puts(fetchMock)).toHaveLength(1));
    expect(puts(fetchMock)[0].body).toEqual({ removalist_id: 7, delivery_date: '2026-10-02', delivery_ids: [3, 1, 2] });
    expect(orderOf(container)).toBe('Dan,Cara,Alice,Bob,Eve');
  });

  test.each([['another carrier', 'Dan'], ['another day', 'Eve']])('a drop on %s is refused with a visible cue and saves nothing', async (_why, target) => {
    login(['admin']);
    const fetchMock = installFetch();
    const { container } = await renderSchedule();
    await screen.findByRole('button', { name: 'Move Cara up' });
    fireEvent.dragStart(rowFor(container, 'Cara'));
    const accepted = !fireEvent.dragOver(rowFor(container, target));
    expect(accepted).toBe(false); // not a drop target
    expect(rowFor(container, target).className).toMatch(/outline-red-400/);
    expect(rowFor(container, target)).toHaveAttribute('title', expect.stringMatching(/same carrier and day/));
    fireEvent.drop(rowFor(container, target));
    fireEvent.dragEnd(rowFor(container, 'Cara'));
    expect(puts(fetchMock)).toHaveLength(0);
    expect(orderOf(container)).toBe('Dan,Alice,Bob,Cara,Eve');
    expect(rowFor(container, target).className).not.toMatch(/outline-red-400/); // cue cleared
  });

  test.each([['technician'], ['staff'], ['sales']])('%s gets no reorder controls and rows are not draggable', async (role) => {
    login([role]);
    installFetch();
    const { container } = await renderSchedule();
    expect(screen.queryByRole('button', { name: /^Move /i })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Stop' })).toBeNull();
    expect(rowFor(container, 'Alice')).toHaveAttribute('draggable', 'false');
  });

  test('before the database is migrated (available:false) the schedule is exactly as it was', async () => {
    login(['superadmin']);
    installFetch({ available: false });
    const { container } = await renderSchedule();
    expect(screen.queryByRole('button', { name: /^Move /i })).toBeNull();
    expect(orderOf(container)).toBe('Dan,Alice,Bob,Cara,Eve');
  });

  test('a refused save snaps the row back', async () => {
    login(['admin']);
    const fetchMock = installFetch({ putStatus: 409, putError: 'Those deliveries are no longer all on the same carrier and day' });
    const { container } = await renderSchedule();
    fireEvent.click(await screen.findByRole('button', { name: 'Move Alice down' }));
    await waitFor(() => expect(puts(fetchMock)).toHaveLength(1));
    await waitFor(() => expect(orderOf(container)).toBe('Dan,Alice,Bob,Cara,Eve'));
  });

  test('reordering is switched off while a search hides part of a run', async () => {
    login(['admin']);
    installFetch();
    await renderSchedule();
    await screen.findByRole('button', { name: 'Move Alice down' });
    fireEvent.change(screen.getByPlaceholderText('Search deliveries, items, carriers…'), { target: { value: 'Alice' } });
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Move /i })).toBeNull());
  });

  test('moving a stop never opens the workorder (the row itself is clickable)', async () => {
    login(['admin']);
    const fetchMock = installFetch();
    await renderSchedule();
    const btn = await screen.findByRole('button', { name: 'Move Bob up' });
    fireEvent.click(btn);
    fireEvent.keyDown(btn, { key: 'Enter' });
    await waitFor(() => expect(puts(fetchMock)).toHaveLength(1));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/workorder'))).toBe(false);
    expect(screen.getByRole('button', { name: 'Move Bob down' })).toBeInTheDocument(); // still on the schedule
  });
});
