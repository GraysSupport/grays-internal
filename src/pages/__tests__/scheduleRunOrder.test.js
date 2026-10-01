import { render, screen, fireEvent, waitFor, createEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
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

// `putStatus` may be a list — one status per save, in order (the last one repeats).
// `serverOrder` is what a later GET returns (the page reloads it after a refused save).
function installFetch({ order = {}, serverOrder, available = true, putStatus = 200, putError } = {}) {
  const statuses = Array.isArray(putStatus) ? [...putStatus] : [putStatus];
  let gets = 0;
  const mock = jest.fn(async (url, init = {}) => {
    const ok = (json, status = 200) => ({ ok: status < 300, status, json: async () => json });
    if (String(url).includes('resource=run-order')) {
      if (init.method === 'PUT') {
        const status = statuses.length > 1 ? statuses.shift() : statuses[0];
        return status === 200 ? ok({ available: true, order: {} }) : ok({ error: putError || 'nope' }, status);
      }
      gets += 1;
      return ok({ available, order: gets > 1 && serverOrder ? serverOrder : order });
    }
    if (String(url).startsWith('/api/delivery')) return ok({ deliveries: DELIVERIES, removalists: REMOVALISTS });
    return ok({});
  });
  global.fetch = mock;
  return mock;
}
const puts = (mock) => mock.mock.calls.filter(([, init]) => init?.method === 'PUT').map(([url, init]) => ({ url, body: JSON.parse(init.body) }));

async function renderSchedule() {
  const view = render(
    <MemoryRouter initialEntries={['/delivery_operations/schedule']}>
      <Routes>
        <Route path="/delivery_operations/schedule" element={<DeliverySchedulePage />} />
        <Route path="*" element={<div>LEFT THE SCHEDULE</div>} />
      </Routes>
    </MemoryRouter>
  );
  await waitFor(() => expect(view.container.querySelector('tr[tabindex="0"]')).not.toBeNull());
  return view;
}
// Customer names of the on-screen schedule rows, top to bottom.
const NAMES = ['Alice', 'Bob', 'Cara', 'Dan', 'Eve'];
const rowsOf = (container) => Array.from(container.querySelectorAll('tr[tabindex="0"]'));
const orderOf = (container) => rowsOf(container).map((tr) => NAMES.find((n) => tr.textContent.includes(n))).join(',');
const rowFor = (container, name) => rowsOf(container).find((tr) => tr.textContent.includes(name));
const handleFor = (container, id) => container.querySelector(`[data-run-handle="${id}"]`);

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
    fireEvent.dragStart(handleFor(container, 3));
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
    fireEvent.dragStart(handleFor(container, 3));
    const accepted = !fireEvent.dragOver(rowFor(container, target));
    expect(accepted).toBe(false); // not a drop target
    expect(rowFor(container, target).className).toMatch(/outline-red-400/);
    expect(rowFor(container, target).className).toMatch(/!bg-red-100/); // Safari draws no outline on <tr>
    expect(rowFor(container, target)).toHaveAttribute('title', expect.stringMatching(/same carrier and day/));
    // A real browser sends NO drop to a refused target — the cue is cleared when the drag leaves.
    fireEvent.dragLeave(rowFor(container, target));
    expect(rowFor(container, target).className).not.toMatch(/outline-red-400|bg-red-100/);
    expect(rowFor(container, target)).not.toHaveAttribute('title');
    fireEvent.dragEnd(handleFor(container, 3));
    // …and even a forced drop there saves nothing.
    fireEvent.dragStart(handleFor(container, 3));
    fireEvent.drop(rowFor(container, target));
    expect(puts(fetchMock)).toHaveLength(0);
    expect(orderOf(container)).toBe('Dan,Alice,Bob,Cara,Eve');
  });

  test('moving between cells of the same row does not drop the cue', async () => {
    login(['admin']);
    installFetch();
    const { container } = await renderSchedule();
    await screen.findByRole('button', { name: 'Move Cara up' });
    fireEvent.dragStart(handleFor(container, 3));
    const alice = rowFor(container, 'Alice');
    fireEvent.dragOver(alice);
    // jsdom has no DragEvent, so relatedTarget has to be set on the event by hand.
    const leave = createEvent.dragLeave(alice);
    Object.defineProperty(leave, 'relatedTarget', { value: alice.querySelector('td') });
    fireEvent(alice, leave);
    expect(alice.className).toMatch(/outline-gray-400/);
  });

  test('only the handle is draggable — the row is not, so text in it can still be selected', async () => {
    login(['admin']);
    const fetchMock = installFetch();
    const { container } = await renderSchedule();
    await screen.findByRole('button', { name: 'Move Cara up' });
    expect(rowFor(container, 'Cara')).not.toHaveAttribute('draggable');
    expect(handleFor(container, 3)).toHaveAttribute('draggable', 'true');
    // A drag that did NOT start on a handle (e.g. selected text) is ignored by the rows.
    fireEvent.dragStart(rowFor(container, 'Cara').querySelector('td:nth-child(3)'));
    expect(fireEvent.dragOver(rowFor(container, 'Alice'))).toBe(true); // not prevented → not a drop target
    fireEvent.drop(rowFor(container, 'Alice'));
    expect(puts(fetchMock)).toHaveLength(0);
  });

  test('two quick moves are saved one after the other, each with the run’s complete order', async () => {
    login(['admin']);
    const fetchMock = installFetch();
    const { container } = await renderSchedule();
    fireEvent.click(await screen.findByRole('button', { name: 'Move Cara up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move Cara up' }));
    await waitFor(() => expect(puts(fetchMock)).toHaveLength(2));
    expect(puts(fetchMock).map((p) => p.body.delivery_ids)).toEqual([[1, 3, 2], [3, 1, 2]]);
    expect(orderOf(container)).toBe('Dan,Cara,Alice,Bob,Eve');
  });

  test('re-booking a stop to another carrier retires its stop number on screen', async () => {
    login(['admin']);
    installFetch({ order: { 3: 1, 1: 2, 2: 3 } });
    const { container } = await renderSchedule();
    await waitFor(() => expect(orderOf(container)).toBe('Dan,Cara,Alice,Bob,Eve'));
    const dateInput = rowFor(container, 'Cara').querySelector('input[type="date"]');
    fireEvent.change(dateInput, { target: { value: '2026-10-03' } });
    fireEvent.blur(dateInput);
    // Cara joins Eve's run on the 3rd with NO number, so she sorts by name there (Cara, Eve).
    await waitFor(() => expect(orderOf(container)).toBe('Dan,Alice,Bob,Cara,Eve'));
  });

  test.each([['technician'], ['staff'], ['sales']])('%s gets no reorder controls and rows are not draggable', async (role) => {
    login([role]);
    installFetch();
    const { container } = await renderSchedule();
    expect(screen.queryByRole('button', { name: /^Move /i })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Stop' })).toBeNull();
    expect(container.querySelector('[data-run-handle]')).toBeNull();
    expect(container.querySelector('[draggable="true"]')).toBeNull();
  });

  test('before the database is migrated (available:false) the schedule is exactly as it was', async () => {
    login(['superadmin']);
    installFetch({ available: false });
    const { container } = await renderSchedule();
    expect(screen.queryByRole('button', { name: /^Move /i })).toBeNull();
    expect(orderOf(container)).toBe('Dan,Alice,Bob,Cara,Eve');
  });

  test('a refused save reloads the real order from the server', async () => {
    login(['admin']);
    const fetchMock = installFetch({ putStatus: 409, putError: 'Those deliveries are no longer all on the same carrier and day' });
    const { container } = await renderSchedule();
    fireEvent.click(await screen.findByRole('button', { name: 'Move Alice down' }));
    expect(orderOf(container)).toBe('Dan,Bob,Alice,Cara,Eve'); // optimistic
    await waitFor(() => expect(puts(fetchMock)).toHaveLength(1));
    await waitFor(() => expect(orderOf(container)).toBe('Dan,Alice,Bob,Cara,Eve'));
  });

  test('a failed first save does not throw away a later move that DID save', async () => {
    login(['admin']);
    // 1st save refused, 2nd accepted; afterwards the server holds the 2nd order.
    const fetchMock = installFetch({ putStatus: [500, 200], serverOrder: { 3: 1, 1: 2, 2: 3 } });
    const { container } = await renderSchedule();
    fireEvent.click(await screen.findByRole('button', { name: 'Move Cara up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move Cara up' }));
    await waitFor(() => expect(puts(fetchMock)).toHaveLength(2));
    await waitFor(() => expect(orderOf(container)).toBe('Dan,Cara,Alice,Bob,Eve'));
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
    expect(screen.queryByText('LEFT THE SCHEDULE')).toBeNull();
    expect(screen.getByRole('button', { name: 'Move Bob down' })).toBeInTheDocument();
  });

  test('(control) clicking the row itself still opens the workorder', async () => {
    login(['admin']);
    installFetch();
    const { container } = await renderSchedule();
    await screen.findByRole('button', { name: 'Move Bob up' });
    fireEvent.click(rowFor(container, 'Bob').querySelector('td:nth-child(3)'));
    expect(await screen.findByText('LEFT THE SCHEDULE')).toBeInTheDocument();
  });
});
