import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import TechChecklistPage from '../tech-checklist';
import { CHECK_ITEMS, canUseTechChecklist, unansweredItems, emptyChecks } from '../../utils/techChecklist';

// G16 — technician screen & electronics checklist for a scanned lot.

jest.mock('../../components/CameraBarcodeScanner', () => function FakeCamera({ onResult, onClose }) {
  return (
    <div>
      <button type="button" onClick={() => onResult('L00042')}>fake-scan</button>
      <button type="button" onClick={onClose}>fake-close</button>
    </div>
  );
});

const VIEW = {
  available: true,
  lot: { lot_id: 42, lot_number: 'L00042', status: 'Assigned', serial_number: null, product_sku: 'LF-95X', product_name: 'Life Fitness 95X Elliptical', product_brand: 'Life Fitness' },
  order: {
    workorder_id: 19422, workorder_items_id: 2001, invoice_id: 'INV-19422', workorder_status: 'Work Ordered',
    estimated_completion: '2026-10-24', item_status: 'In Workshop', delivery_suburb: 'Altona North', delivery_state: 'VIC',
    technician_id: 'ED', technician_name: 'Eden', item_sn: 'DEC83B18000051 & CONSOLE AZB06195052',
  },
  checklist: null,
  prefill: { base_serial: 'DEC83B18000051', console_serial: 'AZB06195052' },
};
const allYes = () => Object.fromEntries(CHECK_ITEMS.map((i) => [i.key, { v: 'yes', note: '' }]));

function login({ id = 'ED', roles = ['technician'] } = {}) {
  const b64 = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  localStorage.setItem('token', `${b64({ alg: 'none' })}.${b64({ id, roles })}.sig`);
  localStorage.setItem('user', JSON.stringify({ id, name: 'Tech', access: roles[0], roles }));
}

// get: [status, json] for GET; put: [status, json] (or a function of the body) for PUT.
function installFetch({ get = [200, VIEW], put = [200, VIEW] } = {}) {
  const mock = jest.fn(async (url, opts = {}) => {
    const isPut = opts.method === 'PUT';
    let pair = isPut ? put : get;
    if (typeof pair === 'function') pair = pair(JSON.parse(opts.body));
    const [status, json] = pair;
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  });
  global.fetch = mock;
  return mock;
}
const putBodies = (mock) => mock.mock.calls.filter(([, o]) => o?.method === 'PUT').map(([, o]) => JSON.parse(o.body));

function renderPage(entry = '/tech-checklist') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/tech-checklist" element={<TechChecklistPage />} />
        <Route path="/" element={<div>LOGIN PAGE</div>} />
        <Route path="*" element={<div>ELSEWHERE</div>} />
      </Routes>
    </MemoryRouter>
  );
}
const scan = (text) => {
  fireEvent.change(screen.getByLabelText('Lot number'), { target: { value: text } });
  fireEvent.submit(screen.getByLabelText('Lot number').closest('form'));
};
const answerAll = () => {
  for (const item of CHECK_ITEMS) {
    fireEvent.click(within(screen.getByRole('group', { name: item.label })).getByLabelText('Yes'));
  }
};

beforeEach(() => localStorage.clear());

describe('techChecklist utils', () => {
  test('who may use it: technician / workshop / superadmin, or the WK account', () => {
    expect(canUseTechChecklist({ id: 'ED' }, ['technician'])).toBe(true);
    expect(canUseTechChecklist({ id: 'XX' }, ['workshop'])).toBe(true);
    expect(canUseTechChecklist({ id: 'GS' }, ['superadmin'])).toBe(true);
    expect(canUseTechChecklist({ id: 'WK' }, ['admin'])).toBe(true);
    expect(canUseTechChecklist({ id: 'GA' }, ['admin'])).toBe(false);
    expect(canUseTechChecklist(null, [])).toBe(false);
  });
  test('a blank checklist has every line unanswered', () => {
    expect(unansweredItems(emptyChecks())).toHaveLength(CHECK_ITEMS.length);
    expect(unansweredItems(allYes())).toEqual([]);
  });
});

describe('TechChecklistPage', () => {
  test('admin (not WK) gets a not-available screen and no lookup', () => {
    login({ id: 'GA', roles: ['admin'] });
    const f = installFetch();
    renderPage();
    expect(screen.getByText(/for technicians and the workshop/i)).toBeInTheDocument();
    expect(f).not.toHaveBeenCalled();
  });

  test('scanning with the camera opens the lot: order details, no customer', async () => {
    login();
    const f = installFetch();
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Scan with the camera' }));
    fireEvent.click(screen.getByText('fake-scan'));
    expect(await screen.findByText('Life Fitness 95X Elliptical')).toBeInTheDocument();
    expect(String(f.mock.calls[0][0])).toBe('/api/lots?resource=tech-checklist&lot_number=L00042');
    expect(f.mock.calls[0][1].headers.Authorization).toMatch(/^Bearer /);
    const order = screen.getByRole('region', { name: 'Order' });
    expect(within(order).getByText('19422')).toBeInTheDocument();
    expect(within(order).getByText('INV-19422')).toBeInTheDocument();
    expect(within(order).getByText('24 Oct 2026')).toBeInTheDocument();
    expect(within(order).getByText('Altona North, VIC')).toBeInTheDocument();
    expect(within(order).getByText('Eden')).toBeInTheDocument();
    expect(screen.queryByText(/assigned to eden, not you/i)).not.toBeInTheDocument();
  });

  test('serials are pre-filled from the workorder', async () => {
    login();
    installFetch();
    renderPage('/tech-checklist?lot=L00042');
    expect(await screen.findByLabelText('Base S/N')).toHaveValue('DEC83B18000051');
    expect(screen.getByLabelText('Console S/N')).toHaveValue('AZB06195052');
  });

  test('warns when the item is assigned to another technician', async () => {
    login({ id: 'BR' });
    installFetch();
    renderPage('/tech-checklist?lot=L00042');
    expect(await screen.findByText(/assigned to eden, not you/i)).toBeInTheDocument();
  });

  test('an unassigned lot says so', async () => {
    login();
    installFetch({ get: [200, { ...VIEW, order: null, prefill: { base_serial: '', console_serial: '' } }] });
    renderPage('/tech-checklist?lot=L00042');
    expect(await screen.findByText(/not assigned to an order yet/i)).toBeInTheDocument();
  });

  test('sign-off is disabled until every line is answered', async () => {
    login();
    installFetch();
    renderPage('/tech-checklist?lot=L00042');
    const box = await screen.findByLabelText(/screen ok to ship/i);
    expect(box).toBeDisabled();
    answerAll();
    expect(box).not.toBeDisabled();
  });

  test('Save sends the checklist, serials, sign-off and the version shown', async () => {
    login();
    const saved = { ...VIEW, checklist: { checks: allYes(), test_tag_no: '555', base_serial: 'B2', console_serial: 'C2', comments: '', ok_to_ship: true, approved_by: 'ED', approved_by_name: 'Eden', approved_at: '2026-10-19T03:00:00.000Z', updated_by: 'ED', updated_by_name: 'Eden', updated_at: '2026-10-19T03:00:00.000Z', version: 1 } };
    const f = installFetch({ put: [200, saved] });
    renderPage('/tech-checklist?lot=L00042');
    await screen.findByLabelText('Base S/N');
    answerAll();
    const audio = screen.getByRole('group', { name: 'Audio' });
    fireEvent.click(within(audio).getByLabelText('SPK N/A'));
    fireEvent.change(screen.getByLabelText('Base S/N'), { target: { value: 'B2' } });
    fireEvent.change(screen.getByLabelText('Console S/N'), { target: { value: 'C2' } });
    fireEvent.change(screen.getByLabelText('Test & Tag No.'), { target: { value: '555' } });
    fireEvent.change(screen.getByLabelText('Rem Ads / De-Reg comment'), { target: { value: 'MyTrainer' } });
    fireEvent.click(screen.getByLabelText(/screen ok to ship/i));
    fireEvent.click(screen.getByRole('button', { name: 'Save checklist' }));
    await screen.findByText(/signed off by eden/i);
    const [body] = putBodies(f);
    expect(body.lot_number).toBe('L00042');
    expect(body.base_version).toBe(0);
    expect(body.ok_to_ship).toBe(true);
    expect(body.base_serial).toBe('B2');
    expect(body.console_serial).toBe('C2');
    expect(body.test_tag_no).toBe('555');
    expect(body.checks.boots_ok.v).toBe('yes');
    expect(body.checks.audio.spk).toBe('na');
    expect(body.checks.rem_ads_dereg.note).toBe('MyTrainer');
    expect(screen.getByRole('status')).toHaveTextContent(/saved/i);
  });

  test('a stale save warns with the other person, and overwrite uses the version shown', async () => {
    login();
    const current = { ...VIEW, checklist: { checks: allYes(), test_tag_no: '', base_serial: 'X', console_serial: '', comments: '', ok_to_ship: false, approved_by: null, approved_by_name: null, approved_at: null, updated_by: 'BR', updated_by_name: 'Brodie', updated_at: '2026-10-19T02:00:00.000Z', version: 4 } };
    let n = 0;
    const f = installFetch({ put: () => (++n === 1 ? [409, { error: 'Brodie saved this checklist after you opened it', current }] : [200, current]) });
    renderPage('/tech-checklist?lot=L00042');
    await screen.findByLabelText('Base S/N');
    fireEvent.click(screen.getByRole('button', { name: 'Save checklist' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/brodie saved this checklist/i);
    fireEvent.click(screen.getByRole('button', { name: 'Overwrite with mine' }));
    await waitFor(() => expect(putBodies(f)).toHaveLength(2));
    expect(putBodies(f)[1].base_version).toBe(4);
  });

  test('before the migration: the order still shows, the checklist says not available', async () => {
    login();
    installFetch({ get: [200, { ...VIEW, available: false }] });
    renderPage('/tech-checklist?lot=L00042');
    expect(await screen.findByText(/checklist is not available yet/i)).toBeInTheDocument();
    expect(screen.getByText('INV-19422')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save checklist' })).not.toBeInTheDocument();
  });

  test('unknown lot → not found', async () => {
    login();
    installFetch({ get: [404, { error: 'No lot found for L09999' }] });
    renderPage();
    scan('l09999');
    expect(await screen.findByRole('alert')).toHaveTextContent(/no lot found/i);
  });
});
