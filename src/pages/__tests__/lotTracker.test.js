import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import LotTrackerPage from '../lot-tracker';
import { looksLikeLotNumber, formatWhen } from '../../utils/lotTracker';

// G11 — Lot Tracker: scan/search a lot number and see the item's whole journey.

// The camera scanner needs a real camera + ZXing; stand in a button that "scans" a sticker.
jest.mock('../../components/CameraBarcodeScanner', () => function FakeCamera({ onResult, onClose }) {
  return (
    <div>
      <button type="button" onClick={() => onResult('L00001')}>fake-scan</button>
      <button type="button" onClick={onClose}>fake-close</button>
    </div>
  );
});

const JOURNEY = {
  lot: { lot_number: 'L00001', status: 'Assigned', serial_number: 'SN-12345', created_at: '2026-07-10T02:00:00.000Z', created_by: 'GS', created_by_name: 'Nick Enrique Wijaya' },
  product: { sku: '2609', name: 'Life Fitness 95T Treadmill', brand: 'Life Fitness' },
  origin: { collection_id: 12, name: 'Anytime Fitness Geelong', suburb: 'Geelong', state: 'VIC', description: 'Full gym strip-out', notes: null, collection_date: '2026-07-10', status: 'Completed', carrier: 'Nelson Removals' },
  assignment: { workorder_id: 883, workorder_items_id: 2001, invoice_id: 'INV-883', workorder_status: 'Completed', workorder_created: '2026-08-18T03:00:00.000Z', customer_id: 26, customer_name: 'Dana Customer', delivery_suburb: 'Altona North', delivery_state: 'VIC', salesperson: 'GS' },
  workshop: { item_status: 'Completed', condition: 'Refurbished', in_workshop: '2026-08-18T04:54:01.000Z', technician_id: 'ED', technician_name: 'Eden', serial_number: 'SN-12345' },
  deliveries: [{ delivery_id: 700, delivery_date: '2026-08-21', delivery_status: 'Delivery Completed', delivery_type: 'Delivery', suburb: 'Altona North', state: 'VIC', carrier: 'Cobbs Transport' }],
  timeline: [
    { kind: 'origin', at: '2026-07-10', date_only: true, title: 'Collected (extraction)', detail: 'Anytime Fitness Geelong, Geelong, VIC', by_name: 'Nelson Removals' },
    { kind: 'lot', at: '2026-07-10T02:00:00.000Z', title: 'Lot number issued', detail: 'L00001 · Life Fitness 95T Treadmill', by: 'GS', by_name: 'Nick Enrique Wijaya' },
    { kind: 'workshop', at: '2026-08-18T04:54:00.000Z', title: 'Went into the workshop', detail: null, by: 'ED', by_name: 'Eden' },
    { kind: 'delivery', at: '2026-08-21', date_only: true, title: 'Delivered', detail: 'Altona North, VIC', by_name: 'Cobbs Transport' },
  ],
};

function login(roles) {
  const b64 = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  localStorage.setItem('token', `${b64({ alg: 'none' })}.${b64({ id: 'GL', roles })}.sig`);
  localStorage.setItem('user', JSON.stringify({ id: 'GL', name: 'Shaun', access: roles[0], roles }));
}

// Route responses by URL: { journey: [status, json], search: [status, json] }.
function installFetch({ journey = [200, JOURNEY], search = [200, { results: [], limit: 25 }] } = {}) {
  const mock = jest.fn(async (url) => {
    const [status, json] = String(url).includes('journey-search') ? search : journey;
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  });
  global.fetch = mock;
  return mock;
}
const urls = (mock) => mock.mock.calls.map(([url]) => String(url));

function renderPage(entry = '/lot-tracker') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/lot-tracker" element={<LotTrackerPage />} />
        <Route path="/" element={<div>LOGIN PAGE</div>} />
        <Route path="*" element={<div>ELSEWHERE</div>} />
      </Routes>
    </MemoryRouter>
  );
}
const type = (text) => {
  fireEvent.change(screen.getByLabelText('Lot number or search'), { target: { value: text } });
  fireEvent.submit(screen.getByLabelText('Lot number or search').closest('form'));
};

beforeEach(() => localStorage.clear());

describe('lotTracker utils', () => {
  test('a lot sticker is L + digits; anything else is a search', () => {
    expect(looksLikeLotNumber('L00042')).toBe(true);
    expect(looksLikeLotNumber(' l00042 ')).toBe(true);
    expect(looksLikeLotNumber('treadmill')).toBe(false);
    expect(looksLikeLotNumber('2609')).toBe(false);
    expect(looksLikeLotNumber('L12')).toBe(false);
    expect(looksLikeLotNumber('')).toBe(false);
  });
  test('dates: date-only stays a date; timestamps show Melbourne time', () => {
    expect(formatWhen('2026-07-10', true)).toMatch(/^10 July? 2026$/); // en-AU short month is "July" in current ICU
    expect(formatWhen('2026-07-10')).toMatch(/^10 July? 2026$/); // never shifted by a timezone
    expect(formatWhen('2026-08-18T04:54:01.000Z')).toMatch(/18 Aug 2026, 2:54\s?pm/i);
    expect(formatWhen(null)).toBe('—');
  });
});

describe('access — admin + superadmin only', () => {
  test.each([['logistics'], ['technician'], ['staff'], ['sales'], ['workshop']])('%s gets no tracker and no request is made', (role) => {
    login([role]);
    const fetchMock = installFetch();
    renderPage('/lot-tracker?lot=L00001');
    expect(screen.getByText(/available to admin and superadmin users/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Lot number or search')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  test.each([['admin'], ['superadmin']])('%s gets the scanner box, focused and ready for a USB scanner', (role) => {
    login([role]);
    installFetch();
    renderPage();
    expect(screen.getByLabelText('Lot number or search')).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Scan with the camera' })).toBeInTheDocument();
  });
  test('not logged in → back to the login page', async () => {
    installFetch();
    renderPage();
    expect(await screen.findByText('LOGIN PAGE')).toBeInTheDocument();
  });
});

describe('the journey', () => {
  test('a USB/Bluetooth scan (types the number + Enter) opens the journey with the login token', async () => {
    login(['admin']);
    const fetchMock = installFetch();
    renderPage();
    type('l00001');
    expect(await screen.findByRole('heading', { name: 'L00001' })).toBeInTheDocument();
    expect(urls(fetchMock)).toEqual(['/api/lots?resource=journey&lot_number=L00001']);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toMatch(/^Bearer /);
    expect(urls(fetchMock).some((u) => /\/api\/lots\?lot_number=/.test(u))).toBe(false); // never the public lookup
  });

  test('shows everything Nick asked for', async () => {
    login(['admin']);
    installFetch();
    renderPage('/lot-tracker?lot=L00001');
    await screen.findByRole('heading', { name: 'L00001' });

    // where it came from (extraction)
    const origin = screen.getByRole('heading', { name: /Where it came from/ }).closest('section');
    expect(within(origin).getByText('Anytime Fitness Geelong')).toBeInTheDocument();
    expect(within(origin).getByText('Geelong, VIC')).toBeInTheDocument();
    expect(within(origin).getByText(/^10 July? 2026$/)).toBeInTheDocument();
    expect(within(origin).getByText('Nelson Removals')).toBeInTheDocument();
    // where it is assigned
    const assigned = screen.getByRole('heading', { name: 'Where it is assigned' }).closest('section');
    expect(within(assigned).getByRole('link', { name: '#883' })).toHaveAttribute('href', '/delivery_operations/workorder/883');
    expect(within(assigned).getByText('Dana Customer')).toBeInTheDocument();
    expect(within(assigned).getByText('INV-883')).toBeInTheDocument();
    // when it went to the workshop + who did it + serial number
    const workshop = screen.getByRole('heading', { name: 'Workshop' }).closest('section');
    expect(within(workshop).getByText(/18 Aug 2026, 2:54\s?pm/i)).toBeInTheDocument();
    expect(within(workshop).getByText('Eden')).toBeInTheDocument();
    expect(within(workshop).getByText('SN-12345')).toBeInTheDocument();
    // when it was delivered + by who
    const delivery = screen.getByRole('heading', { name: 'Delivery' }).closest('section');
    expect(within(delivery).getByText('Delivered on')).toBeInTheDocument();
    expect(within(delivery).getByText('21 Aug 2026')).toBeInTheDocument();
    expect(within(delivery).getByText('Cobbs Transport')).toBeInTheDocument();
    // the journey, in order, each step with who
    const steps = within(screen.getByRole('list', { name: 'Item journey' })).getAllByRole('listitem').map((li) => li.textContent);
    expect(steps).toHaveLength(4);
    expect(steps[0]).toMatch(/Collected \(extraction\).*10 July? 2026 · Nelson Removals/);
    expect(steps[2]).toMatch(/Went into the workshop.*Eden/);
    expect(steps[3]).toMatch(/Delivered.*21 Aug 2026 · Cobbs Transport/);
  });

  test('the phone camera scan opens the same journey', async () => {
    login(['superadmin']);
    const fetchMock = installFetch();
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Scan with the camera' }));
    fireEvent.click(screen.getByRole('button', { name: 'fake-scan' }));
    expect(await screen.findByRole('heading', { name: 'L00001' })).toBeInTheDocument();
    expect(urls(fetchMock)).toEqual(['/api/lots?resource=journey&lot_number=L00001']);
    expect(screen.queryByRole('button', { name: 'fake-scan' })).toBeNull(); // camera closed
  });

  test('unit cost is shown only when the server sends it (superadmin)', async () => {
    login(['admin']);
    installFetch();
    const first = renderPage('/lot-tracker?lot=L00001');
    await screen.findByRole('heading', { name: 'L00001' });
    expect(screen.queryByText(/Unit cost/)).toBeNull();
    first.unmount();

    login(['superadmin']);
    installFetch({ journey: [200, { ...JOURNEY, lot: { ...JOURNEY.lot, unit_cost: 450 } }] });
    renderPage('/lot-tracker?lot=L00001');
    expect(await screen.findByText(/Unit cost/)).toBeInTheDocument();
    expect(screen.getByText('$450')).toBeInTheDocument();
  });

  test('a lot still in stock says what has not happened yet instead of showing blanks', async () => {
    login(['admin']);
    installFetch({ journey: [200, { ...JOURNEY, lot: { ...JOURNEY.lot, status: 'In Stock', serial_number: null }, assignment: null, workshop: null, deliveries: [], timeline: JOURNEY.timeline.slice(0, 2) }] });
    renderPage('/lot-tracker?lot=L00001');
    await screen.findByRole('heading', { name: 'L00001' });
    expect(screen.getByText('Not assigned to a workorder yet.')).toBeInTheDocument();
    expect(screen.getByText(/No workshop record yet/)).toBeInTheDocument();
    expect(screen.getByText(/No delivery has been raised/)).toBeInTheDocument();
    expect(screen.getByText('Not recorded')).toBeInTheDocument(); // serial
  });

  test('unknown lot → a clear message', async () => {
    login(['admin']);
    installFetch({ journey: [404, { error: 'No lot found for L99999' }] });
    renderPage();
    type('L99999');
    expect(await screen.findByRole('alert')).toHaveTextContent('No lot found for L99999');
  });

  test('an expired sign-in ends the session instead of showing an empty page', async () => {
    login(['admin']);
    installFetch({ journey: [401, { error: 'Authentication required' }] });
    renderPage();
    type('L00001');
    expect(await screen.findByText('LOGIN PAGE')).toBeInTheDocument();
    expect(localStorage.getItem('token')).toBeNull();
  });
});

describe('search', () => {
  const RESULTS = { limit: 25, results: [
    { lot_number: 'L00007', status: 'In Stock', product_sku: '2609', serial_number: null, product_name: 'Life Fitness 95T Treadmill', invoice_id: null },
    { lot_number: 'L00001', status: 'Assigned', product_sku: '2609', serial_number: 'SN-12345', product_name: 'Life Fitness 95T Treadmill', invoice_id: 'INV-883' },
  ] };

  test('text that is not a lot number searches; picking a result opens its journey', async () => {
    login(['admin']);
    const fetchMock = installFetch({ search: [200, RESULTS] });
    renderPage();
    type('treadmill');
    const list = await screen.findByRole('list', { name: 'Search results' });
    expect(urls(fetchMock)).toEqual(['/api/lots?resource=journey-search&q=treadmill']);
    expect(within(list).getAllByRole('button')).toHaveLength(2);
    fireEvent.click(within(list).getByRole('button', { name: /L00001/ }));
    expect(await screen.findByRole('heading', { name: 'L00001' })).toBeInTheDocument();
    expect(urls(fetchMock).at(-1)).toBe('/api/lots?resource=journey&lot_number=L00001');
  });

  test('no matches → says so', async () => {
    login(['admin']);
    installFetch();
    renderPage();
    type('zzzz');
    expect(await screen.findByText('No lots match “zzzz”.')).toBeInTheDocument();
  });

  test('a server validation message (e.g. too short) is shown', async () => {
    login(['admin']);
    installFetch({ search: [400, { error: 'Type at least 2 characters to search' }] });
    renderPage();
    type('a');
    expect(await screen.findByRole('alert')).toHaveTextContent('Type at least 2 characters to search');
  });

  test('the box is cleared and re-focused after a scan, ready for the next sticker', async () => {
    login(['admin']);
    installFetch();
    renderPage();
    type('L00001');
    await screen.findByRole('heading', { name: 'L00001' });
    await waitFor(() => expect(screen.getByLabelText('Lot number or search')).toHaveValue(''));
    expect(screen.getByLabelText('Lot number or search')).toHaveFocus();
  });
});
