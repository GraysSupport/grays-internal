import { StrictMode } from 'react';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import DispatchEvidencePanel, { DispatchEvidenceButton, EvidenceFolderLink, WorkorderEvidence } from '../DispatchEvidencePanel';
import {
  MAX_FILE_BYTES, isAllowedFileName, needsEvidence, canUploadEvidence, uploadInChunks,
  readPending, addPending, removePending, formatBytes,
} from '../../utils/dispatchEvidence';

// G18 — dispatch evidence: photos + videos per workorder item → SharePoint.

function login({ id = 'LG', roles = ['logistics'] } = {}) {
  const b64 = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  localStorage.setItem('token', `${b64({ alg: 'none' })}.${b64({ id, roles })}.sig`);
  localStorage.setItem('user', JSON.stringify({ id, name: 'Liam', access: roles[0], roles }));
}

const FILE_11 = { id: 11, file_name: '2026-10-28 14-32-10 front.jpg', mime_type: 'image/jpeg', size_bytes: 4000000, web_url: 'https://sp/f11', uploaded_by: 'LG', uploaded_by_name: 'Liam', uploaded_at: '2026-10-28T03:32:10Z', thumbnail_url: 'https://thumb/11' };
const LIST = {
  configured: true, available: true, dispatched: false, can_upload: true, can_delete: false,
  max_file_bytes: MAX_FILE_BYTES, folder_url: 'https://sp/wo',
  items: [
    { workorder_items_id: 2001, label: 'TM-95T Life Fitness 95T Treadmill', folder_url: 'https://sp/item', files: [FILE_11] },
    { workorder_items_id: 2003, label: 'LF-95X Life Fitness 95X Elliptical', folder_url: null, files: [] },
  ],
};
const SESSION = { upload_url: 'https://upload/s1', chunk_bytes: 10485760, expires_at: '2999-01-01T00:00:00Z', file_name: '2026-10-28 14-40-00 back.jpg' };

const res = (status, json = {}, headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (k) => headers[String(k).toLowerCase()] ?? (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
  json: async () => json,
});

// routes: { list, 'upload-session', complete, file } → [status, json] | fn(body, url) | Error.
// upload: fn(url, opts) for every call to https://upload/… (PUT chunks, GET status, DELETE cancel).
function installFetch(routes = {}, upload = () => res(201, { id: 'drive-1', name: SESSION.file_name })) {
  const mock = jest.fn(async (url, opts = {}) => {
    if (String(url).startsWith('https://upload/')) return upload(url, opts);
    const resource = new URL(url, 'http://x').searchParams.get('resource');
    let pair = routes[resource] ?? (resource === 'list' ? [200, LIST] : resource === 'upload-session' ? [200, SESSION] : [200, {}]);
    if (typeof pair === 'function') pair = pair(opts.body ? JSON.parse(opts.body) : null, url);
    if (pair instanceof Error) throw pair;
    return res(pair[0], pair[1]);
  });
  global.fetch = mock;
  return mock;
}
const callsTo = (mock, resource) => mock.mock.calls.filter(([u]) => !String(u).startsWith('https://') && new URL(u, 'http://x').searchParams.get('resource') === resource);
const uploadCalls = (mock, method) => mock.mock.calls.filter(([u, o]) => String(u).startsWith('https://upload/') && (o?.method || 'GET') === method);

function renderPanel(props = {}) {
  return render(
    <MemoryRouter initialEntries={['/wo']}>
      <Routes>
        <Route path="/wo" element={<DispatchEvidencePanel workorderId={731} {...props} />} />
        <Route path="/" element={<div>LOGIN PAGE</div>} />
      </Routes>
    </MemoryRouter>
  );
}
const pick = (itemLabel, files) => {
  fireEvent.change(screen.getByLabelText(`Add photos or videos for ${itemLabel}`), { target: { files } });
};
const jpg = (name = 'back.jpg', size = 1000) => {
  const f = new File(['x'.repeat(Math.min(size, 2000))], name, { type: 'image/jpeg' });
  if (size > 2000) Object.defineProperty(f, 'size', { value: size });
  return f;
};
const ELLIPTICAL = 'LF-95X Life Fitness 95X Elliptical';
const noSleep = async () => {};

beforeEach(() => { localStorage.clear(); jest.restoreAllMocks(); });

describe('dispatchEvidence utils', () => {
  test('photos and videos only; OTHER items need none', () => {
    expect(['a.jpg', 'b.HEIC', 'c.mov', 'd.mp4'].every(isAllowedFileName)).toBe(true);
    expect(['a.pdf', 'b', 'c.jpg.exe'].some(isAllowedFileName)).toBe(false);
    expect(needsEvidence({ product_id: 'other' })).toBe(false);
    expect(needsEvidence({ product_id: 'TM-95T' })).toBe(true);
  });
  test('who may upload: logistics/admin/superadmin/technician/workshop, or WK', () => {
    expect(canUploadEvidence({ id: 'WK' }, ['admin'])).toBe(true);
    expect(canUploadEvidence({ id: 'ED' }, ['technician'])).toBe(true);
    expect(canUploadEvidence({ id: 'ST' }, ['staff'])).toBe(false);
  });
  test('formatBytes', () => {
    expect(formatBytes(4_000_000)).toBe('3.8 MB');
    expect(formatBytes(512)).toBe('1 KB');
  });
  test('pending: one entry per file, per user', () => {
    addPending({ workorder_id: 731, workorder_items_id: 2001, drive_item_id: 'd1', user_id: 'LG' });
    addPending({ workorder_id: 731, workorder_items_id: 2001, drive_item_id: 'd1', user_id: 'LG' });
    addPending({ workorder_id: 731, workorder_items_id: 2001, file_name: 'n.mp4', user_id: 'LG' });
    expect(readPending()).toHaveLength(2);
    removePending('d1');
    removePending('name:n.mp4');
    expect(readPending()).toHaveLength(0);
  });
});

describe('uploadInChunks (Microsoft Graph upload-session protocol)', () => {
  const blob10 = () => new Blob(['abcdefghij']);

  test('Content-Range per chunk, no Authorization header, returns the item', async () => {
    const f = jest.fn()
      .mockResolvedValueOnce(res(202, { nextExpectedRanges: ['4-'] }))
      .mockResolvedValueOnce(res(202, { nextExpectedRanges: ['8-'] }))
      .mockResolvedValueOnce(res(201, { id: 'drive-9' }));
    const progress = [];
    const item = await uploadInChunks({ file: blob10(), uploadUrl: 'https://upload/s', chunkBytes: 4, fetch: f, onProgress: (p) => progress.push(p), sleep: noSleep });
    expect(item.id).toBe('drive-9');
    expect(f.mock.calls.map(([, o]) => o.headers['Content-Range'])).toEqual(['bytes 0-3/10', 'bytes 4-7/10', 'bytes 8-9/10']);
    expect(f.mock.calls.every(([, o]) => !('Authorization' in o.headers))).toBe(true);
    expect(progress.at(-1)).toBe(1);
  });

  test('a dropped reply: asks SharePoint where it got to and carries on from there (no blind resend)', async () => {
    const f = jest.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))      // PUT 0-3: bytes landed, reply lost
      .mockResolvedValueOnce(res(200, { nextExpectedRanges: ['4-'] })) // GET status
      .mockResolvedValueOnce(res(202, { nextExpectedRanges: ['8-'] })) // PUT 4-7
      .mockResolvedValueOnce(res(201, { id: 'ok' }));                 // PUT 8-9
    expect((await uploadInChunks({ file: blob10(), uploadUrl: 'https://upload/s', chunkBytes: 4, fetch: f, sleep: noSleep })).id).toBe('ok');
    expect(f.mock.calls[1][1].method).toBe('GET');
    expect(f.mock.calls.filter(([, o]) => o.method === 'PUT').map(([, o]) => o.headers['Content-Range'])).toEqual(['bytes 0-3/10', 'bytes 4-7/10', 'bytes 8-9/10']);
  });

  test('follows nextExpectedRanges even when SharePoint asks for earlier bytes again', async () => {
    const f = jest.fn()
      .mockResolvedValueOnce(res(202, { nextExpectedRanges: ['0-'] }))
      .mockResolvedValueOnce(res(201, { id: 'ok' }));
    await uploadInChunks({ file: new Blob(['abcd']), uploadUrl: 'https://upload/s', chunkBytes: 4, fetch: f, sleep: noSleep });
    expect(f.mock.calls.map(([, o]) => o.headers['Content-Range'])).toEqual(['bytes 0-3/4', 'bytes 0-3/4']);
  });

  test('final chunk sent, reply lost, session gone → "maybe committed" (record it by name)', async () => {
    const f = jest.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch')) // the only chunk
      .mockResolvedValueOnce(res(404, {}));                    // GET status: the session finished
    const err = await uploadInChunks({ file: new Blob(['abcd']), uploadUrl: 'https://upload/s', chunkBytes: 4, fetch: f, sleep: noSleep }).catch((e) => e);
    expect(err.code).toBe('maybe-committed');
  });

  test('backs off (growing to 30 s), then gives up with plain words', async () => {
    const sleeps = [];
    const dead = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const err = await uploadInChunks({ file: new Blob(['abcd']), uploadUrl: 'https://upload/s', chunkBytes: 4, fetch: dead, sleep: async (ms) => sleeps.push(ms) }).catch((e) => e);
    expect(err.code).toBe('network');
    expect(err.message).toMatch(/signal/i);
    expect(sleeps).toEqual([2000, 4000, 8000, 16000, 30000, 30000]);
  });

  test('429 waits for Retry-After', async () => {
    const sleeps = [];
    const f = jest.fn()
      .mockResolvedValueOnce(res(429, {}, { 'retry-after': '7' }))
      .mockResolvedValueOnce(res(200, { nextExpectedRanges: ['0-'] }))
      .mockResolvedValueOnce(res(201, { id: 'ok' }));
    await uploadInChunks({ file: new Blob(['abcd']), uploadUrl: 'https://upload/s', chunkBytes: 4, fetch: f, sleep: async (ms) => sleeps.push(ms) });
    expect(sleeps[0]).toBe(7000);
  });

  test('a refusal is not retried', async () => {
    const f = jest.fn().mockResolvedValue(res(403, {}));
    const err = await uploadInChunks({ file: new Blob(['abcd']), uploadUrl: 'https://upload/s', chunkBytes: 4, fetch: f, sleep: noSleep }).catch((e) => e);
    expect(err.code).toBe('refused');
    expect(f).toHaveBeenCalledTimes(1);
  });

  test('resume after the final chunk was already sent: a finished session means "maybe committed"', async () => {
    const fetch = jest.fn(async () => res(404, {}));
    const file = new Blob(['x'.repeat(10)]);
    await expect(uploadInChunks({ file, uploadUrl: 'https://upload/s', chunkBytes: 1024, fetch, sleep: noSleep, resume: true, finalSent: true }))
      .rejects.toMatchObject({ code: 'maybe-committed' });
  });

  test('resume: starts from where an earlier attempt left off; an expired session says so', async () => {
    const f = jest.fn()
      .mockResolvedValueOnce(res(200, { nextExpectedRanges: ['8-'] }))
      .mockResolvedValueOnce(res(201, { id: 'ok' }));
    await uploadInChunks({ file: blob10(), uploadUrl: 'https://upload/s', chunkBytes: 4, fetch: f, sleep: noSleep, resume: true });
    expect(f.mock.calls[1][1].headers['Content-Range']).toBe('bytes 8-9/10');
    const gone = jest.fn().mockResolvedValue(res(404, {}));
    expect((await uploadInChunks({ file: blob10(), uploadUrl: 'https://upload/s', chunkBytes: 4, fetch: gone, sleep: noSleep, resume: true }).catch((e) => e)).code).toBe('expired');
  });
});

describe('DispatchEvidencePanel', () => {
  test('lists each item with its files, thumbnail and uploader', async () => {
    login();
    installFetch();
    renderPanel();
    expect(await screen.findByText('TM-95T Life Fitness 95T Treadmill')).toBeInTheDocument();
    expect(screen.getByText(ELLIPTICAL)).toBeInTheDocument();
    expect(screen.getByRole('img', { name: FILE_11.file_name })).toHaveAttribute('src', 'https://thumb/11');
    expect(screen.getByText(/Liam/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });

  test('on the page it renders nothing while Microsoft is not set up', async () => {
    login();
    installFetch({ list: [200, { ...LIST, configured: false }] });
    const { container } = renderPanel();
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  test('no upload control for someone who cannot upload', async () => {
    login({ id: 'ST', roles: ['staff'] });
    installFetch({ list: [200, { ...LIST, can_upload: false }] });
    renderPanel();
    await screen.findByText('TM-95T Life Fitness 95T Treadmill');
    expect(screen.queryByLabelText(/Add photos or videos/)).not.toBeInTheDocument();
  });

  test('upload: session → straight to SharePoint → complete → list refreshed', async () => {
    login();
    const fetchMock = installFetch({ complete: [200, { recorded: true, id: 12 }] });
    const onChanged = jest.fn();
    renderPanel({ onChanged });
    await screen.findByText(ELLIPTICAL);
    pick(ELLIPTICAL, [jpg('back.jpg')]);

    await waitFor(() => expect(callsTo(fetchMock, 'complete')).toHaveLength(1));
    expect(JSON.parse(callsTo(fetchMock, 'upload-session')[0][1].body)).toEqual({ workorder_id: 731, workorder_items_id: 2003, file_name: 'back.jpg', size: 1000 });
    expect(callsTo(fetchMock, 'upload-session')[0][1].headers.Authorization).toMatch(/^Bearer /);
    expect(uploadCalls(fetchMock, 'PUT')).toHaveLength(1);
    expect(uploadCalls(fetchMock, 'PUT')[0][1].headers.Authorization).toBeUndefined();
    expect(JSON.parse(callsTo(fetchMock, 'complete')[0][1].body)).toEqual({ workorder_id: 731, workorder_items_id: 2003, drive_item_id: 'drive-1' });
    await waitFor(() => expect(callsTo(fetchMock, 'list').length).toBeGreaterThanOrEqual(2));
    expect(onChanged).toHaveBeenCalled();
    expect(readPending()).toHaveLength(0);
  });

  test('a long upload keeps the 30-minute inactivity logout away', async () => {
    login();
    localStorage.setItem('sessionExpiry', '1');
    installFetch({ complete: [200, { recorded: true }] });
    renderPanel();
    await screen.findByText(ELLIPTICAL);
    pick(ELLIPTICAL, [jpg('back.jpg')]);
    await waitFor(() => expect(Number(localStorage.getItem('sessionExpiry'))).toBeGreaterThan(Date.now()));
  });

  test('refuses a file over 300 MB, or a non-photo, before uploading anything', async () => {
    login();
    const fetchMock = installFetch();
    renderPanel();
    await screen.findByText(ELLIPTICAL);
    pick(ELLIPTICAL, [jpg('huge.jpg', MAX_FILE_BYTES + 1), new File(['x'], 'quote.pdf', { type: 'application/pdf' })]);
    expect(await screen.findByText(/over 300 MB/i)).toBeInTheDocument();
    expect(screen.getByText(/only photos and videos/i)).toBeInTheDocument();
    expect(callsTo(fetchMock, 'upload-session')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument();
  });

  test('a failed session request can be retried; no connection is said plainly', async () => {
    login();
    let sessions = 0;
    const fetchMock = installFetch({
      'upload-session': () => { sessions += 1; return sessions === 1 ? new TypeError('Failed to fetch') : [200, SESSION]; },
      complete: [200, { recorded: true }],
    });
    renderPanel();
    await screen.findByText(ELLIPTICAL);
    pick(ELLIPTICAL, [jpg('back.jpg')]);
    expect(await screen.findByText(/No connection/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry back.jpg' }));
    await waitFor(() => expect(callsTo(fetchMock, 'complete')).toHaveLength(1));
  });

  test('Retry after a failed "record" only records — the file is not sent again (no duplicate)', async () => {
    login();
    let completes = 0;
    const fetchMock = installFetch({ complete: () => { completes += 1; return completes === 1 ? [502, { error: 'The Microsoft shared drive refused the request' }] : [200, { recorded: true }]; } });
    renderPanel();
    await screen.findByText(ELLIPTICAL);
    pick(ELLIPTICAL, [jpg('back.jpg')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry back.jpg' }));
    await waitFor(() => expect(callsTo(fetchMock, 'complete')).toHaveLength(2));
    expect(callsTo(fetchMock, 'upload-session')).toHaveLength(1);
    expect(uploadCalls(fetchMock, 'PUT')).toHaveLength(1);
    expect(JSON.parse(callsTo(fetchMock, 'complete')[1][1].body).drive_item_id).toBe('drive-1');
  });

  test('final reply lost: the file is recorded by the name the session gave it', async () => {
    login();
    const fetchMock = installFetch({ complete: [200, { recorded: true }] }, (url, opts) => {
      if (opts.method === 'PUT') return Promise.reject(new TypeError('Failed to fetch'));
      return res(404, {}); // status check: the session has finished
    });
    renderPanel();
    await screen.findByText(ELLIPTICAL);
    pick(ELLIPTICAL, [jpg('back.jpg')]);
    await waitFor(() => expect(callsTo(fetchMock, 'complete')).toHaveLength(1), { timeout: 3000 });
    expect(JSON.parse(callsTo(fetchMock, 'complete')[0][1].body)).toEqual({ workorder_id: 731, workorder_items_id: 2003, file_name: SESSION.file_name, size: 1000 });
  });
  test('works under React StrictMode (and a remount) — uploads are not left waiting', async () => {
    login();
    const fetchMock = installFetch({ complete: [200, { recorded: true }] });
    render(
      <StrictMode>
        <MemoryRouter initialEntries={['/wo']}>
          <Routes><Route path="/wo" element={<DispatchEvidencePanel workorderId={731} />} /></Routes>
        </MemoryRouter>
      </StrictMode>
    );
    await screen.findByText(ELLIPTICAL);
    pick(ELLIPTICAL, [jpg('back.jpg')]);
    await waitFor(() => expect(callsTo(fetchMock, 'complete')).toHaveLength(1));
    expect(uploadCalls(fetchMock, 'PUT')).toHaveLength(1);
  });

  test('Retry after the final chunk was sent records by name — never a second upload', async () => {
    login();
    let puts = 0;
    const fetchMock = installFetch({ complete: [200, { recorded: true }] }, (url, opts) => {
      if (opts.method === 'PUT') { puts += 1; return res(403, {}); } // final chunk sent, reply refused
      return res(404, {}); // later: the session has finished
    });
    renderPanel();
    await screen.findByText(ELLIPTICAL);
    pick(ELLIPTICAL, [jpg('back.jpg')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry back.jpg' }));
    await waitFor(() => expect(callsTo(fetchMock, 'complete')).toHaveLength(1));
    expect(JSON.parse(callsTo(fetchMock, 'complete')[0][1].body)).toEqual({ workorder_id: 731, workorder_items_id: 2003, file_name: SESSION.file_name, size: 1000 });
    expect(callsTo(fetchMock, 'upload-session')).toHaveLength(1);
    expect(puts).toBe(1);
  });

  test('recorded by name but SharePoint never got it: Retry uploads it afresh', async () => {
    login();
    let completes = 0;
    let puts = 0;
    const fetchMock = installFetch({
      complete: () => { completes += 1; return completes === 1 ? [400, { error: 'That file was not found in SharePoint' }] : [200, { recorded: true }]; },
    }, (url, opts) => {
      if (opts.method === 'PUT') { puts += 1; return puts === 1 ? Promise.reject(new TypeError('Failed to fetch')) : res(201, { id: 'drive-2', name: SESSION.file_name }); }
      return res(404, {});
    });
    renderPanel();
    await screen.findByText(ELLIPTICAL);
    pick(ELLIPTICAL, [jpg('back.jpg')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry back.jpg' }, { timeout: 3000 }));
    await waitFor(() => expect(callsTo(fetchMock, 'complete')).toHaveLength(2));
    expect(callsTo(fetchMock, 'upload-session')).toHaveLength(2);
    expect(JSON.parse(callsTo(fetchMock, 'complete')[1][1].body)).toEqual({ workorder_id: 731, workorder_items_id: 2003, drive_item_id: 'drive-2' });
  });

  test('login expired after the upload: the file is kept (for this user), recorded later', async () => {
    login();
    installFetch({ complete: [401, { error: 'Authentication required' }] });
    renderPanel();
    await screen.findByText(ELLIPTICAL);
    pick(ELLIPTICAL, [jpg('back.jpg')]);
    expect(await screen.findByText('LOGIN PAGE')).toBeInTheDocument();
    expect(localStorage.getItem('token')).toBeNull();
    expect(readPending()).toEqual([expect.objectContaining({ workorder_id: 731, workorder_items_id: 2003, drive_item_id: 'drive-1', user_id: 'LG' })]);
  });

  test('on open, this user\'s unrecorded uploads (any workorder) are recorded, and it says so', async () => {
    login();
    addPending({ workorder_id: 731, workorder_items_id: 2003, drive_item_id: 'drive-7', user_id: 'LG', saved_at: Date.now() });
    addPending({ workorder_id: 999, workorder_items_id: 1, drive_item_id: 'other-wo', user_id: 'LG', saved_at: Date.now() });
    addPending({ workorder_id: 731, workorder_items_id: 2003, drive_item_id: 'someone-else', user_id: 'ED', saved_at: Date.now() });
    const fetchMock = installFetch({ complete: [200, { recorded: true }] });
    renderPanel();
    expect(await screen.findByText(/2 uploads saved before your login expired/)).toBeInTheDocument();
    expect(callsTo(fetchMock, 'complete').map(([, o]) => JSON.parse(o.body).drive_item_id).sort()).toEqual(['drive-7', 'other-wo']);
    expect(readPending().map((p) => p.drive_item_id)).toEqual(['someone-else']);
  });

  test('pending: kept on a server/connection error, dropped on a 400, never touched by a viewer', async () => {
    login();
    addPending({ workorder_id: 731, workorder_items_id: 2003, drive_item_id: 'flaky', user_id: 'LG', saved_at: Date.now() });
    addPending({ workorder_id: 731, workorder_items_id: 2003, drive_item_id: 'gone', user_id: 'LG', saved_at: Date.now() });
    installFetch({ complete: (body) => (body.drive_item_id === 'flaky' ? [502, {}] : [400, { error: 'That file was not found in SharePoint' }]) });
    renderPanel();
    await waitFor(() => expect(readPending().map((p) => p.drive_item_id)).toEqual(['flaky']));

    localStorage.clear();
    login({ id: 'LG', roles: ['staff'] });
    addPending({ workorder_id: 731, workorder_items_id: 2003, drive_item_id: 'mine', user_id: 'LG', saved_at: Date.now() });
    const fetchMock = installFetch({ list: [200, { ...LIST, can_upload: false }] });
    renderPanel();
    await screen.findAllByText('TM-95T Life Fitness 95T Treadmill');
    expect(callsTo(fetchMock, 'complete')).toHaveLength(0);
    expect(readPending()).toHaveLength(1);
  });

  test('superadmin can delete (after confirming)', async () => {
    login({ id: 'NE', roles: ['superadmin'] });
    const fetchMock = installFetch({ list: [200, { ...LIST, can_delete: true }], file: [200, { deleted: true }] });
    jest.spyOn(window, 'confirm').mockReturnValue(true);
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: `Delete ${FILE_11.file_name}` }));
    await waitFor(() => expect(callsTo(fetchMock, 'file')).toHaveLength(1));
    expect(callsTo(fetchMock, 'file')[0][1].method).toBe('DELETE');
    expect(callsTo(fetchMock, 'file')[0][0]).toMatch(/id=11/);
  });

  test('lot tracker mode: one item, read-only; hidden when that item has nothing', async () => {
    login({ id: 'NE', roles: ['superadmin'] });
    installFetch({ list: [200, { ...LIST, can_delete: true }] });
    renderPanel({ itemId: 2001, readOnly: true });
    expect(await screen.findByRole('img', { name: FILE_11.file_name })).toBeInTheDocument();
    expect(screen.queryByText(ELLIPTICAL)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Add photos or videos/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });

  test('lot tracker mode never records other people\'s pending uploads', async () => {
    login();
    addPending({ workorder_id: 731, workorder_items_id: 2003, drive_item_id: 'mine', user_id: 'LG', saved_at: Date.now() });
    const fetchMock = installFetch();
    const { container } = renderPanel({ itemId: 2003, readOnly: true });
    await waitFor(() => expect(callsTo(fetchMock, 'list')).toHaveLength(1));
    expect(callsTo(fetchMock, 'complete')).toHaveLength(0);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('EvidenceFolderLink (workorder header, once dispatched)', () => {
  test('shows only once dispatched and a folder exists', () => {
    const { rerender } = render(<EvidenceFolderLink info={{ ...LIST, dispatched: false }} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    rerender(<EvidenceFolderLink info={{ ...LIST, dispatched: true, folder_url: null }} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    rerender(<EvidenceFolderLink info={{ ...LIST, dispatched: true }} />);
    expect(screen.getByRole('link', { name: /Open dispatch evidence folder/ })).toHaveAttribute('href', 'https://sp/wo');
  });
});

describe('WorkorderEvidence (workorder header: a button + pop-up, owner 29 Oct 2026)', () => {
  const renderHeader = (props = {}) => render(
    <MemoryRouter initialEntries={['/wo']}>
      <Routes><Route path="/wo" element={<WorkorderEvidence workorderId={731} invoiceId="19623" {...props} />} /></Routes>
    </MemoryRouter>
  );

  test('a button with the file count — the evidence itself only in the pop-up', async () => {
    login();
    installFetch();
    renderHeader();
    const btn = await screen.findByRole('button', { name: 'Dispatch evidence for invoice 19623' });
    expect(btn).toHaveTextContent('Dispatch evidence (1)');
    expect(screen.queryByText(ELLIPTICAL)).not.toBeInTheDocument();
    expect(screen.queryByText('Open dispatch evidence folder')).not.toBeInTheDocument();
    fireEvent.click(btn);
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(ELLIPTICAL)).toBeInTheDocument();
  });

  test('once dispatched, the folder button shows beside it', async () => {
    login();
    installFetch({ list: [200, { ...LIST, dispatched: true }] });
    renderHeader();
    expect(await screen.findByText('Open dispatch evidence folder')).toHaveAttribute('href', 'https://sp/wo');
  });

  test('nothing while Microsoft is not set up, or when no item needs evidence', async () => {
    login();
    const fetchMock = installFetch({ list: [200, { configured: false, available: false, items: [] }] });
    const { unmount } = renderHeader();
    await waitFor(() => expect(callsTo(fetchMock, 'list')).toHaveLength(1));
    await act(async () => {});
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    unmount();
    installFetch({ list: [200, { ...LIST, items: [] }] });
    renderHeader();
    await act(async () => {});
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  test('an upload in the pop-up refreshes the count and the activity log', async () => {
    login();
    let lists = 0;
    const withNew = { ...LIST, items: [LIST.items[0], { ...LIST.items[1], files: [{ ...FILE_11, id: 12 }] }] };
    installFetch({ list: () => { lists += 1; return [200, lists === 1 ? LIST : withNew]; }, complete: [200, { recorded: true }] });
    const onChanged = jest.fn();
    renderHeader({ onChanged });
    fireEvent.click(await screen.findByRole('button', { name: 'Dispatch evidence for invoice 19623' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText(ELLIPTICAL);
    pick(ELLIPTICAL, [jpg('back.jpg')]);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Dispatch evidence for invoice 19623' })).toHaveTextContent('Dispatch evidence (2)'));
  });
});

describe('DispatchEvidenceButton (delivery rows)', () => {
  function renderRow(rowClick = jest.fn(), rowKey = jest.fn()) {
    render(
      <MemoryRouter>
        <table><tbody><tr onClick={rowClick} onKeyDown={rowKey}><td>
          <DispatchEvidenceButton workorderId={731} invoiceId="19623" />
        </td></tr></tbody></table>
      </MemoryRouter>
    );
    return { rowClick, rowKey };
  }

  test('opens the panel in a dialog; clicks and keys inside never reach the row', async () => {
    login();
    installFetch();
    const { rowClick, rowKey } = renderRow();
    fireEvent.click(screen.getByRole('button', { name: 'Dispatch evidence for invoice 19623' }));
    const dialog = await screen.findByRole('dialog', { name: /Dispatch evidence/ });
    await within(dialog).findByText('TM-95T Life Fitness 95T Treadmill');
    expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus();
    fireEvent.click(dialog);
    fireEvent.keyDown(dialog, { key: 'Enter' });
    expect(rowClick).not.toHaveBeenCalled();
    expect(rowKey).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dispatch evidence for invoice 19623' })).toHaveFocus();
  });

  test('Escape anywhere closes it', async () => {
    login();
    installFetch();
    renderRow();
    fireEvent.click(screen.getByRole('button', { name: 'Dispatch evidence for invoice 19623' }));
    await screen.findByRole('dialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('says why when there is nothing to show (not set up / only OTHER items)', async () => {
    login();
    installFetch({ list: [200, { ...LIST, configured: false }] });
    renderRow();
    fireEvent.click(screen.getByRole('button', { name: 'Dispatch evidence for invoice 19623' }));
    expect(await screen.findByText(/isn't set up yet/)).toBeInTheDocument();
  });

  test('closing while uploading really cancels the upload', async () => {
    login();
    const fetchMock = installFetch({}, (url, opts) => {
      if (opts.method === 'DELETE') return res(204);
      // A chunk that never finishes until it is aborted.
      return new Promise((_, reject) => opts.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    });
    jest.spyOn(window, 'confirm').mockReturnValue(true);
    renderRow();
    fireEvent.click(screen.getByRole('button', { name: 'Dispatch evidence for invoice 19623' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText(ELLIPTICAL);
    pick(ELLIPTICAL, [jpg('back.jpg')]);
    await waitFor(() => expect(uploadCalls(fetchMock, 'PUT')).toHaveLength(1));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/cancelled/));
    await waitFor(() => expect(uploadCalls(fetchMock, 'DELETE')).toHaveLength(1));
    expect(uploadCalls(fetchMock, 'PUT')[0][1].signal.aborted).toBe(true); // the chunk itself is stopped
    await act(async () => {});
    expect(callsTo(fetchMock, 'complete')).toHaveLength(0);
  });
});
