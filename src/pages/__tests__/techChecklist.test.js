import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import TechChecklistPage from '../tech-checklist';
import { CHECK_ITEMS, canUseTechChecklist, unansweredItems, emptyChecks, signOffLine, lastSavedLine } from '../../utils/techChecklist';
import { formatWhen } from '../../utils/lotTracker';

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

  test('Save sends the serials that were shown, so unchanged serials are never rewritten', async () => {
    login();
    const f = installFetch();
    renderPage('/tech-checklist?lot=L00042');
    await screen.findByLabelText('Base S/N');
    fireEvent.change(screen.getByLabelText('Base S/N'), { target: { value: 'NEW1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save checklist' }));
    await waitFor(() => expect(putBodies(f)).toHaveLength(1));
    expect(putBodies(f)[0].serials_shown).toEqual({ base_serial: 'DEC83B18000051', console_serial: 'AZB06195052' });
  });

  test('a multi-machine item says the serial is saved to this lot only', async () => {
    login();
    installFetch({ get: [200, { ...VIEW, order: { ...VIEW.order, lots_on_item: 2 } }] });
    renderPage('/tech-checklist?lot=L00042');
    expect(await screen.findByText(/2 machines on this workorder item/i)).toBeInTheDocument();
  });

  test('unsaved work survives an expired sign-in (the WK kiosk) and is restored after logging back in', async () => {
    login({ id: 'WK', roles: ['admin'] });
    installFetch({ put: [401, { error: 'Authentication required' }] });
    const first = renderPage('/tech-checklist?lot=L00042');
    await screen.findByLabelText('Base S/N');
    fireEvent.click(within(screen.getByRole('group', { name: 'Boots OK' })).getByLabelText('Yes'));
    fireEvent.change(screen.getByLabelText('Base S/N'), { target: { value: 'KEEPME' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save checklist' }));
    expect(await screen.findByText('LOGIN PAGE')).toBeInTheDocument();
    expect(localStorage.getItem('token')).toBeNull();
    first.unmount();

    login({ id: 'WK', roles: ['admin'] });
    installFetch();
    renderPage('/tech-checklist?lot=L00042');
    expect(await screen.findByLabelText('Base S/N')).toHaveValue('KEEPME');
    expect(within(screen.getByRole('group', { name: 'Boots OK' })).getByLabelText('Yes')).toBeChecked();
    expect(screen.getByText(/restored your unsaved changes/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard unsaved changes' }));
    expect(screen.getByLabelText('Base S/N')).toHaveValue('DEC83B18000051');
  });

  test('a successful save clears the draft', async () => {
    login();
    installFetch({ put: [200, { ...VIEW, checklist: { ...VIEW.checklist, checks: allYes(), version: 1, updated_at: '2026-10-19T03:00:00.000Z', updated_by: 'ED', updated_by_name: 'Eden' } }] });
    const r = renderPage('/tech-checklist?lot=L00042');
    await screen.findByLabelText('Base S/N');
    fireEvent.change(screen.getByLabelText('Base S/N'), { target: { value: 'X1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save checklist' }));
    await screen.findByRole('status');
    r.unmount();
    installFetch();
    renderPage('/tech-checklist?lot=L00042');
    await screen.findByLabelText('Base S/N');
    expect(screen.queryByText(/restored your unsaved changes/i)).not.toBeInTheDocument();
  });

  test('a late save answer for a lot no longer on screen does not bring it back', async () => {
    login();
    let releaseSave;
    const VIEW_B = { ...VIEW, lot: { ...VIEW.lot, lot_id: 43, lot_number: 'L00043', product_name: 'Second Machine' } };
    global.fetch = jest.fn((url, opts = {}) => {
      if (opts.method === 'PUT') return new Promise((resolve) => { releaseSave = () => resolve({ ok: true, status: 200, json: async () => VIEW }); });
      const body = String(url).includes('L00043') ? VIEW_B : VIEW;
      return Promise.resolve({ ok: true, status: 200, json: async () => body });
    });
    renderPage('/tech-checklist?lot=L00042');
    await screen.findByText('Life Fitness 95X Elliptical');
    fireEvent.click(screen.getByRole('button', { name: 'Save checklist' }));
    scan('L00043');
    expect(await screen.findByText('Second Machine')).toBeInTheDocument();
    await act(async () => { releaseSave(); await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.getByText('Second Machine')).toBeInTheDocument();
    expect(screen.queryByText('Life Fitness 95X Elliptical')).not.toBeInTheDocument();
  });

  test('Enter in a comment box (e.g. a scanner) does not save the checklist', async () => {
    login();
    const f = installFetch();
    renderPage('/tech-checklist?lot=L00042');
    const note = await screen.findByLabelText('Boots OK comment');
    // A browser turns Enter in a text box into a form submit (implicit submission); jsdom does
    // not, so the submit is fired directly. Only the Save button may save.
    fireEvent.submit(note.closest('form'));
    await new Promise((r) => setTimeout(r, 0));
    expect(putBodies(f)).toHaveLength(0);
  });

  test('unknown lot → not found', async () => {
    login();
    installFetch({ get: [404, { error: 'No lot found for L09999' }] });
    renderPage();
    scan('l09999');
    expect(await screen.findByRole('alert')).toHaveTextContent(/no lot found/i);
  });
});

// G20 (owner, 29 Oct 2026) — show when a signed-off checklist was updated, and by whom.
describe('G20 sign-off line', () => {
  // 27 Oct 2026, 2:21 pm and 28 Oct 2026, 3:00 pm Melbourne (AEDT, UTC+11).
  const SIGNED = '2026-10-27T03:21:00.000Z';
  const EDITED = '2026-10-28T04:00:00.000Z';
  const base = {
    ok_to_ship: true, approved_by: 'GR', approved_by_name: 'Graeme', approved_at: SIGNED,
    updated_by: 'GR', updated_by_name: 'Graeme', updated_at: SIGNED,
  };

  test('signed off and never edited since: no "Updated"', () => {
    expect(signOffLine(base)).toBe(`OK to ship · signed off by Graeme · ${formatWhen(SIGNED)}`);
    expect(signOffLine(base)).not.toMatch(/updated/i);
  });

  test('Graeme signs off, Nick re-saves the next day: the owner\'s example string', () => {
    const line = signOffLine({ ...base, updated_by: 'NG', updated_by_name: 'Nick', updated_at: EDITED });
    expect(line).toMatch(/^OK to ship · signed off by Graeme · 27 Oct 2026, 2:21\s?pm · Updated 28 Oct 2026, 3:00\s?pm by Nick$/);
  });

  test('a save within 60 s of the sign-off is the same save, not an update', () => {
    const line = signOffLine({ ...base, updated_at: '2026-10-27T03:21:59.000Z' });
    expect(line).not.toMatch(/updated/i);
    const later = signOffLine({ ...base, updated_at: '2026-10-27T03:22:01.000Z' });
    expect(later).toMatch(/Updated .* by Graeme$/); // same-person edits still show
  });

  test('saved but not signed off: "Last saved … by …"', () => {
    const c = { ok_to_ship: false, approved_by: null, approved_at: null, updated_by: 'NG', updated_by_name: 'Nick', updated_at: EDITED };
    expect(signOffLine(c)).toMatch(/^Last saved 28 Oct 2026, 3:00\s?pm by Nick$/);
    expect(lastSavedLine(c)).toBe(signOffLine(c));
  });

  test('sign-off removed and re-ticked: shows the new signer, not stale text', () => {
    const resigned = { ...base, approved_by: 'NG', approved_by_name: 'Nick', approved_at: EDITED, updated_by: 'NG', updated_by_name: 'Nick', updated_at: EDITED };
    expect(signOffLine(resigned)).toBe(`OK to ship · signed off by Nick · ${formatWhen(EDITED)}`);
  });

  test('falls back to the user id when no name came back; nothing saved → null', () => {
    expect(signOffLine({ ...base, approved_by_name: null, updated_by: 'NG', updated_by_name: null, updated_at: EDITED }))
      .toMatch(/signed off by GR · .* · Updated .* by NG$/);
    expect(signOffLine(null)).toBeNull();
    expect(lastSavedLine(null)).toBeNull();
  });

  test('the checklist screen shows "Updated … by Nick" after a signed-off checklist is re-saved', async () => {
    login();
    const checklist = { checks: allYes(), test_tag_no: '', base_serial: '', console_serial: '', comments: '', ...base, updated_by: 'NG', updated_by_name: 'Nick', updated_at: EDITED, version: 3 };
    installFetch({ get: [200, { ...VIEW, checklist }] });
    renderPage('/tech-checklist?lot=L00042');
    expect(await screen.findByText(/^OK to ship · signed off by Graeme · 27 Oct 2026, 2:21\s?pm · Updated 28 Oct 2026, 3:00\s?pm by Nick$/)).toBeInTheDocument();
  });
});
