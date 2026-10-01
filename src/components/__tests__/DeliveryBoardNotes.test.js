import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DeliveryBoardNotes from '../DeliveryBoardNotes';

// G7 — the shared "when are drivers coming in next" notes panel on the To-Be-Booked tab.

const NOTE = {
  board: 'to-be-booked',
  body: 'Nelson — Thu 2 Oct AM\nCobbs — next Tues',
  updated_by: 'GA',
  updated_by_name: 'Vincent Ly',
  updated_at: '2026-10-01T04:15:00.000Z', // 2:15 pm AEST
  version: 3,
  available: true,
};

// base64url JWT payload so utils/auth.getRoles() reads the roles the way it does in the app.
function login(roles) {
  const b64 = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  localStorage.setItem('token', `${b64({ alg: 'none' })}.${b64({ id: 'GL', roles })}.sig`);
  localStorage.setItem('user', JSON.stringify({ id: 'GL', name: 'Shaun', access: roles[0], roles }));
}

// Queue of responses, one per fetch call: [status, json].
function installFetch(...responses) {
  const queue = [...responses];
  const mock = jest.fn(async () => {
    const [status, json] = queue.length > 1 ? queue.shift() : queue[0];
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  });
  global.fetch = mock;
  return mock;
}
const putCalls = (mock) => mock.mock.calls.filter(([, init]) => init?.method === 'PUT');
const lastPutBody = (mock) => JSON.parse(putCalls(mock).at(-1)[1].body);

beforeEach(() => localStorage.clear());

test('everyone on the tab can read the note, with who edited it last and when (Melbourne time)', async () => {
  login(['technician']);
  const fetchMock = installFetch([200, NOTE]);
  render(<DeliveryBoardNotes />);
  expect(await screen.findByText(/Nelson — Thu 2 Oct AM/)).toBeInTheDocument();
  expect(screen.getByText(/Cobbs — next Tues/)).toBeInTheDocument();
  expect(screen.getByText(/Last edited by Vincent Ly/)).toBeInTheDocument();
  expect(screen.getByText(/1 Oct 2026/)).toBeInTheDocument();
  expect(screen.getByText(/2:15\s?pm/i)).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith('/api/delivery?resource=board-notes');
});

test('the note is readable with no login token at all (the 1h token expires mid-shift)', async () => {
  localStorage.setItem('user', JSON.stringify({ id: 'BR', name: 'Brett', access: 'technician' }));
  installFetch([200, NOTE]);
  render(<DeliveryBoardNotes />);
  expect(await screen.findByText(/Nelson — Thu 2 Oct AM/)).toBeInTheDocument();
});

test.each([['technician'], ['staff'], ['sales'], ['workshop']])('%s cannot edit', async (role) => {
  login([role]);
  installFetch([200, NOTE]);
  render(<DeliveryBoardNotes />);
  await screen.findByText(/Nelson/);
  expect(screen.queryByRole('button', { name: /edit/i })).toBeNull();
});

test.each([['logistics'], ['admin'], ['superadmin']])('%s can edit and save; the save carries the version they opened', async (role) => {
  login([role]);
  const saved = { ...NOTE, body: 'Nelson — Fri 3 Oct PM', updated_by: 'GL', updated_by_name: 'Shaun Cronin', version: 4 };
  const fetchMock = installFetch([200, NOTE], [200, saved]);
  render(<DeliveryBoardNotes />);
  await screen.findByText(/Nelson — Thu/);
  fireEvent.click(screen.getByRole('button', { name: 'Edit notes' }));
  expect(screen.getByLabelText('Notes text')).toHaveFocus();
  fireEvent.change(screen.getByLabelText('Notes text'), { target: { value: 'Nelson — Fri 3 Oct PM' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save notes' }));
  expect(await screen.findByText('Saved')).toBeInTheDocument();
  expect(lastPutBody(fetchMock)).toEqual({ body: 'Nelson — Fri 3 Oct PM', base_version: 3 });
  expect(screen.getByText(/Nelson — Fri 3 Oct PM/)).toBeInTheDocument();
  expect(screen.getByText(/Last edited by Shaun Cronin/)).toBeInTheDocument();
  expect(screen.queryByLabelText('Notes text')).toBeNull(); // back to read view
});

test('an empty board invites the first note (editors) and starts from version 0', async () => {
  login(['admin']);
  const empty = { ...NOTE, body: '', updated_by: null, updated_by_name: null, updated_at: null, version: 0 };
  const fetchMock = installFetch([200, empty], [200, { ...NOTE, body: 'First', version: 1 }]);
  render(<DeliveryBoardNotes />);
  expect(await screen.findByText(/No notes yet/)).toBeInTheDocument();
  expect(screen.queryByText(/Last edited by/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Edit notes' }));
  fireEvent.change(screen.getByLabelText('Notes text'), { target: { value: 'First' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save notes' }));
  await screen.findByText('Saved');
  expect(lastPutBody(fetchMock)).toEqual({ body: 'First', base_version: 0 });
});

test('warns when someone else saved since you opened it — nothing is overwritten until you choose', async () => {
  login(['admin']);
  const theirs = { ...NOTE, body: 'Cobbs — Wed instead', updated_by: 'GS', updated_by_name: 'Nick Enrique Wijaya', version: 4 };
  const fetchMock = installFetch(
    [200, NOTE],
    [409, { error: 'Nick Enrique Wijaya saved these notes after you opened them', current: theirs }],
    [200, { ...theirs, body: 'Mine', updated_by: 'GL', updated_by_name: 'Shaun Cronin', version: 5 }],
  );
  // (the third response is the "Overwrite with mine" save)
  render(<DeliveryBoardNotes />);
  await screen.findByText(/Nelson — Thu/);
  fireEvent.click(screen.getByRole('button', { name: 'Edit notes' }));
  fireEvent.change(screen.getByLabelText('Notes text'), { target: { value: 'Mine' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save notes' }));

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/Nick Enrique Wijaya saved these notes after you opened them/);
  expect(alert).toHaveTextContent('Cobbs — Wed instead'); // their text is shown so you can compare
  expect(screen.getByLabelText('Notes text')).toHaveValue('Mine'); // my draft is kept
  expect(putCalls(fetchMock)).toHaveLength(1);

  fireEvent.click(screen.getByRole('button', { name: 'Overwrite with mine' }));
  await screen.findByText('Saved');
  // Overwriting saves on the version I was SHOWN (4) — no blind force — so if a third person
  // saved in the meantime the server refuses again instead of silently losing their note.
  expect(lastPutBody(fetchMock)).toEqual({ body: 'Mine', base_version: 4 });
  expect(putCalls(fetchMock)).toHaveLength(2);
});

test('…or take their version instead (no second save)', async () => {
  login(['admin']);
  const theirs = { ...NOTE, body: 'Cobbs — Wed instead', updated_by_name: 'Nick Enrique Wijaya', version: 4 };
  const fetchMock = installFetch([200, NOTE], [409, { error: 'Nick Enrique Wijaya saved these notes after you opened them', current: theirs }]);
  render(<DeliveryBoardNotes />);
  await screen.findByText(/Nelson — Thu/);
  fireEvent.click(screen.getByRole('button', { name: 'Edit notes' }));
  fireEvent.change(screen.getByLabelText('Notes text'), { target: { value: 'Mine' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save notes' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Use their version' }));
  expect(screen.getByText('Cobbs — Wed instead')).toBeInTheDocument();
  expect(screen.queryByLabelText('Notes text')).toBeNull();
  expect(putCalls(fetchMock)).toHaveLength(1);
});

test('a failed save says so and keeps the draft', async () => {
  login(['admin']);
  installFetch([200, NOTE], [500, { error: 'Server error' }]);
  render(<DeliveryBoardNotes />);
  await screen.findByText(/Nelson — Thu/);
  fireEvent.click(screen.getByRole('button', { name: 'Edit notes' }));
  fireEvent.change(screen.getByLabelText('Notes text'), { target: { value: 'Draft I must not lose' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save notes' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn’t save/);
  expect(screen.getByLabelText('Notes text')).toHaveValue('Draft I must not lose');
});

test('shows a character count and blocks an over-long note before it is sent', async () => {
  login(['admin']);
  const fetchMock = installFetch([200, NOTE]);
  render(<DeliveryBoardNotes />);
  await screen.findByText(/Nelson — Thu/);
  fireEvent.click(screen.getByRole('button', { name: 'Edit notes' }));
  expect(screen.getByLabelText('Notes text')).toHaveAttribute('maxLength', '2000');
  fireEvent.change(screen.getByLabelText('Notes text'), { target: { value: 'abc' } });
  expect(screen.getByText('3 / 2000')).toBeInTheDocument();
  // A paste can beat maxLength in some browsers — Save must still refuse it client-side.
  fireEvent.change(screen.getByLabelText('Notes text'), { target: { value: 'x'.repeat(2001) } });
  fireEvent.click(screen.getByRole('button', { name: 'Save notes' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/limited to 2000 characters/);
  expect(putCalls(fetchMock)).toHaveLength(0);
});

test.each([
  [401, { error: 'Authentication required' }, /sign-in has expired/],
  [403, { error: 'Requires one of: logistics, admin, superadmin' }, /don’t have permission/],
])('a %i on save gets a plain-English message and keeps the draft', async (status, payload, message) => {
  login(['admin']);
  installFetch([200, NOTE], [status, payload]);
  render(<DeliveryBoardNotes />);
  await screen.findByText(/Nelson — Thu/);
  fireEvent.click(screen.getByRole('button', { name: 'Edit notes' }));
  fireEvent.change(screen.getByLabelText('Notes text'), { target: { value: 'Keep me' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save notes' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(message);
  expect(screen.getByLabelText('Notes text')).toHaveValue('Keep me');
});

test('coming back to the tab refreshes the note — but never under someone who is typing', async () => {
  login(['admin']);
  const newer = { ...NOTE, body: 'Updated while you were away', version: 4 };
  const fetchMock = installFetch([200, NOTE], [200, newer], [200, { ...newer, body: 'Even newer', version: 5 }]);
  render(<DeliveryBoardNotes />);
  await screen.findByText(/Nelson — Thu/);
  fireEvent.focus(window);
  expect(await screen.findByText('Updated while you were away')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Edit notes' }));
  fireEvent.change(screen.getByLabelText('Notes text'), { target: { value: 'typing…' } });
  fireEvent.focus(window);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  expect(screen.getByLabelText('Notes text')).toHaveValue('typing…');
  expect(screen.queryByText('Even newer')).toBeNull();
});

test('Cancel discards the draft', async () => {
  login(['admin']);
  const fetchMock = installFetch([200, NOTE]);
  render(<DeliveryBoardNotes />);
  await screen.findByText(/Nelson — Thu/);
  fireEvent.click(screen.getByRole('button', { name: 'Edit notes' }));
  fireEvent.change(screen.getByLabelText('Notes text'), { target: { value: 'scrap this' } });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.getByText(/Nelson — Thu/)).toBeInTheDocument();
  expect(putCalls(fetchMock)).toHaveLength(0);
  // …and reopening starts from the saved note, not the scrapped draft.
  fireEvent.click(screen.getByRole('button', { name: 'Edit notes' }));
  expect(screen.getByLabelText('Notes text')).toHaveValue(NOTE.body);
});

test('renders nothing while the table is not migrated (prod before merge) or the read fails', async () => {
  login(['superadmin']);
  const fetchMock = installFetch([200, { board: 'to-be-booked', body: '', version: 0, available: false }]);
  const { container, unmount } = render(<DeliveryBoardNotes />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  await waitFor(() => expect(container).toBeEmptyDOMElement());
  unmount();

  const failing = installFetch([500, { error: 'Server error' }]);
  const second = render(<DeliveryBoardNotes />);
  await waitFor(() => expect(failing).toHaveBeenCalled());
  await waitFor(() => expect(second.container).toBeEmptyDOMElement());
});
