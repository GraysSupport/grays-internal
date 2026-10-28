import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import DispatchEvidencePanel, { DispatchEvidenceButton } from '../DispatchEvidencePanel';
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

const LIST = {
  configured: true, available: true, can_upload: true, can_delete: false,
  max_file_bytes: MAX_FILE_BYTES, folder_url: 'https://sp/wo',
  items: [
    {
      workorder_items_id: 2001, label: 'TM-95T Life Fitness 95T Treadmill', folder_url: 'https://sp/item',
      files: [{ id: 11, file_name: '2026-10-28 14-32-10 front.jpg', mime_type: 'image/jpeg', size_bytes: 4000000, web_url: 'https://sp/f11', uploaded_by: 'LG', uploaded_by_name: 'Liam', uploaded_at: '2026-10-28T03:32:10Z', thumbnail_url: 'https://thumb/11' }],
    },
    { workorder_items_id: 2003, label: 'LF-95X Life Fitness 95X Elliptical', folder_url: null, files: [] },
  ],
};

// routes: { 'list': [status, json] | fn, 'upload-session': ..., complete: ..., file: ... }; PUTs to the
// SharePoint upload URL answer with `put` (array of [status, json] consumed in order, last repeats).
function installFetch(routes = {}, put = [[201, { id: 'drive-1', name: 'x.jpg' }]]) {
  const puts = [...put];
  const mock = jest.fn(async (url, opts = {}) => {
    let pair;
    if (String(url).startsWith('https://upload/')) pair = puts.length > 1 ? puts.shift() : puts[0];
    else {
      const resource = new URL(url, 'http://x').searchParams.get('resource');
      pair = routes[resource] ?? (resource === 'list' ? [200, LIST] : [200, {}]);
      if (typeof pair === 'function') pair = pair(opts.body ? JSON.parse(opts.body) : null, url);
    }
    if (pair instanceof Error) throw pair;
    const [status, json] = pair;
    return { ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, json: async () => json };
  });
  global.fetch = mock;
  return mock;
}
const callsTo = (mock, resource) => mock.mock.calls.filter(([u]) => new URL(u, 'http://x').searchParams.get('resource') === resource);
const putsTo = (mock) => mock.mock.calls.filter(([u]) => String(u).startsWith('https://upload/'));

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
  const input = screen.getByLabelText(`Add photos or videos for ${itemLabel}`);
  fireEvent.change(input, { target: { files } });
};
const jpg = (name = 'front.jpg', size = 1000) => {
  const f = new File(['x'.repeat(Math.min(size, 2000))], name, { type: 'image/jpeg' });
  if (size > 2000) Object.defineProperty(f, 'size', { value: size });
  return f;
};

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
    expect(canUploadEvidence({ id: 'SA' }, ['sales'])).toBe(false);
  });
  test('formatBytes', () => {
    expect(formatBytes(4_000_000)).toBe('3.8 MB');
    expect(formatBytes(512)).toBe('1 KB');
  });

  test('uploadInChunks: Content-Range per chunk, no Authorization header, returns the item', async () => {
    const blob = new Blob(['abcdefghij']); // 10 bytes, chunks of 4
    const f = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({ nextExpectedRanges: ['4-'] }) })
      .mockResolvedValueOnce({ ok: true, status: 202, json: async () => ({ nextExpectedRanges: ['8-'] }) })
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ id: 'drive-9', name: 'a.jpg' }) });
    const progress = [];
    const item = await uploadInChunks({ file: blob, uploadUrl: 'https://upload/s', chunkBytes: 4, fetch: f, onProgress: (p) => progress.push(p), sleep: async () => {} });
    expect(item.id).toBe('drive-9');
    expect(f.mock.calls.map(([, o]) => o.headers['Content-Range'])).toEqual(['bytes 0-3/10', 'bytes 4-7/10', 'bytes 8-9/10']);
    expect(f.mock.calls.every(([, o]) => !('Authorization' in o.headers))).toBe(true);
    expect(progress.at(-1)).toBe(1);
  });

  test('uploadInChunks retries a dropped chunk, then gives up with a clear error', async () => {
    const blob = new Blob(['abcd']);
    const flaky = jest.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ id: 'ok' }) });
    expect((await uploadInChunks({ file: blob, uploadUrl: 'https://upload/s', chunkBytes: 4, fetch: flaky, sleep: async () => {} })).id).toBe('ok');

    const dead = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(uploadInChunks({ file: blob, uploadUrl: 'https://upload/s', chunkBytes: 4, fetch: dead, sleep: async () => {} }))
      .rejects.toThrow(/connection/i);
    expect(dead).toHaveBeenCalledTimes(4);
  });

  test('pending completes survive in this browser', () => {
    addPending({ workorder_id: 731, workorder_items_id: 2001, drive_item_id: 'd1', file_name: 'a.jpg' });
    addPending({ workorder_id: 731, workorder_items_id: 2001, drive_item_id: 'd1', file_name: 'a.jpg' });
    expect(readPending()).toHaveLength(1);
    removePending('d1');
    expect(readPending()).toHaveLength(0);
  });
});

describe('DispatchEvidencePanel', () => {
  test('lists each item with its files, thumbnail and uploader', async () => {
    login();
    installFetch();
    renderPanel();
    expect(await screen.findByText('TM-95T Life Fitness 95T Treadmill')).toBeInTheDocument();
    expect(screen.getByText('LF-95X Life Fitness 95X Elliptical')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '2026-10-28 14-32-10 front.jpg' })).toHaveAttribute('src', 'https://thumb/11');
    expect(screen.getByText(/Liam/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });

  test('renders nothing while Microsoft is not set up, or before migration 0010', async () => {
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
    const fetchMock = installFetch({
      'upload-session': [200, { upload_url: 'https://upload/s1', chunk_bytes: 10485760, file_name: '2026-10-28 14-40-00 back.jpg' }],
      complete: [200, { recorded: true, id: 12 }],
    }, [[201, { id: 'drive-1', name: '2026-10-28 14-40-00 back.jpg' }]]);
    const onChanged = jest.fn();
    renderPanel({ onChanged });
    await screen.findByText('LF-95X Life Fitness 95X Elliptical');
    pick('LF-95X Life Fitness 95X Elliptical', [jpg('back.jpg')]);

    await waitFor(() => expect(callsTo(fetchMock, 'complete')).toHaveLength(1));
    const session = JSON.parse(callsTo(fetchMock, 'upload-session')[0][1].body);
    expect(session).toEqual({ workorder_id: 731, workorder_items_id: 2003, file_name: 'back.jpg', size: 1000 });
    expect(callsTo(fetchMock, 'upload-session')[0][1].headers.Authorization).toMatch(/^Bearer /);
    expect(putsTo(fetchMock)).toHaveLength(1);
    expect(putsTo(fetchMock)[0][1].headers.Authorization).toBeUndefined();
    expect(JSON.parse(callsTo(fetchMock, 'complete')[0][1].body)).toEqual({ workorder_id: 731, workorder_items_id: 2003, drive_item_id: 'drive-1' });
    await waitFor(() => expect(callsTo(fetchMock, 'list').length).toBeGreaterThanOrEqual(2));
    expect(onChanged).toHaveBeenCalled();
    expect(readPending()).toHaveLength(0);
  });

  test('refuses a file over 300 MB, or a non-photo, before uploading anything', async () => {
    login();
    const fetchMock = installFetch();
    renderPanel();
    await screen.findByText('LF-95X Life Fitness 95X Elliptical');
    pick('LF-95X Life Fitness 95X Elliptical', [jpg('huge.jpg', MAX_FILE_BYTES + 1), new File(['x'], 'quote.pdf', { type: 'application/pdf' })]);
    expect(await screen.findByText(/over 300 MB/i)).toBeInTheDocument();
    expect(screen.getByText(/only photos and videos/i)).toBeInTheDocument();
    expect(callsTo(fetchMock, 'upload-session')).toHaveLength(0);
  });

  test('a failed upload can be retried', async () => {
    login();
    let sessions = 0;
    const fetchMock = installFetch({
      'upload-session': () => { sessions += 1; return sessions === 1 ? [502, { error: 'The Microsoft shared drive refused the request' }] : [200, { upload_url: 'https://upload/s2', chunk_bytes: 10485760 }]; },
      complete: [200, { recorded: true }],
    });
    renderPanel();
    await screen.findByText('LF-95X Life Fitness 95X Elliptical');
    pick('LF-95X Life Fitness 95X Elliptical', [jpg('back.jpg')]);
    expect(await screen.findByText(/Microsoft shared drive refused/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry back.jpg' }));
    await waitFor(() => expect(callsTo(fetchMock, 'complete')).toHaveLength(1));
  });

  test('login expired after the upload: the file is kept, recorded after the next login', async () => {
    login();
    const fetchMock = installFetch({
      'upload-session': [200, { upload_url: 'https://upload/s1', chunk_bytes: 10485760 }],
      complete: [401, { error: 'Authentication required' }],
    });
    renderPanel();
    await screen.findByText('LF-95X Life Fitness 95X Elliptical');
    pick('LF-95X Life Fitness 95X Elliptical', [jpg('back.jpg')]);
    expect(await screen.findByText('LOGIN PAGE')).toBeInTheDocument();
    expect(localStorage.getItem('token')).toBeNull();
    expect(readPending()).toEqual([expect.objectContaining({ workorder_id: 731, workorder_items_id: 2003, drive_item_id: 'drive-1' })]);
    expect(callsTo(fetchMock, 'complete')).toHaveLength(1);
  });

  test('on open, unrecorded uploads for this workorder are recorded first', async () => {
    login();
    addPending({ workorder_id: 731, workorder_items_id: 2003, drive_item_id: 'drive-7', file_name: 'late.jpg' });
    addPending({ workorder_id: 999, workorder_items_id: 1, drive_item_id: 'other-wo', file_name: 'x.jpg' });
    const fetchMock = installFetch({ complete: [200, { recorded: true }] });
    renderPanel();
    await waitFor(() => expect(callsTo(fetchMock, 'complete')).toHaveLength(1));
    expect(JSON.parse(callsTo(fetchMock, 'complete')[0][1].body).drive_item_id).toBe('drive-7');
    await waitFor(() => expect(readPending().map((p) => p.drive_item_id)).toEqual(['other-wo']));
  });

  test('superadmin can delete (after confirming)', async () => {
    login({ id: 'NE', roles: ['superadmin'] });
    const fetchMock = installFetch({ list: [200, { ...LIST, can_delete: true }], file: [200, { deleted: true }] });
    jest.spyOn(window, 'confirm').mockReturnValue(true);
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete 2026-10-28 14-32-10 front.jpg' }));
    await waitFor(() => expect(callsTo(fetchMock, 'file')).toHaveLength(1));
    expect(callsTo(fetchMock, 'file')[0][1].method).toBe('DELETE');
    expect(callsTo(fetchMock, 'file')[0][0]).toMatch(/id=11/);
  });
});

describe('DispatchEvidenceButton (delivery rows)', () => {
  test('opens the panel in a dialog; clicks and keys inside never reach the row', async () => {
    login();
    installFetch();
    const rowClick = jest.fn();
    const rowKey = jest.fn();
    render(
      <MemoryRouter>
        <table><tbody><tr onClick={rowClick} onKeyDown={rowKey}><td>
          <DispatchEvidenceButton workorderId={731} invoiceId="19623" />
        </td></tr></tbody></table>
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dispatch evidence for invoice 19623' }));
    const dialog = await screen.findByRole('dialog', { name: /Dispatch evidence/ });
    await within(dialog).findByText('TM-95T Life Fitness 95T Treadmill');
    fireEvent.click(dialog);
    fireEvent.keyDown(dialog, { key: 'Enter' });
    expect(rowClick).not.toHaveBeenCalled();
    expect(rowKey).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(rowClick).not.toHaveBeenCalled();
  });
});
