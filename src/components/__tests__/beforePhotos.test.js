import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BeforePhotosPanel, BeforePhotosButton } from '../BeforePhotos';
import { addPending, readPending } from '../../utils/dispatchEvidence';
import { isPlaced, beforePhotosLabel } from '../../utils/beforePhotos';

// G27 — before-refurbishment photos per lot (owner, 10 Nov 2026).

function login({ id = 'ED', roles = ['technician'] } = {}) {
  const b64 = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  localStorage.setItem('token', `${b64({ alg: 'none' })}.${b64({ id, roles })}.sig`);
  localStorage.setItem('user', JSON.stringify({ id, name: 'Eden', access: roles[0], roles }));
}

const PHOTO = { id: 7, file_name: '2026-11-10 12-00-00 console.jpg', mime_type: 'image/jpeg', size_bytes: 4000000, web_url: 'https://sp/p7', uploaded_by: 'ED', uploaded_by_name: 'Eden', uploaded_at: '2026-11-10T01:00:00Z', thumbnail_url: 'https://thumb/7' };
const LIST = {
  configured: true, available: true, can_upload: true, can_delete: false, max_file_bytes: 300 * 1024 * 1024,
  lot: { lot_id: 55, lot_number: 'L00055', product_sku: 'TM-95T', status: 'Assigned', workorder_items_id: 2001, workorder_id: 731 },
  folder_url: 'https://sp/lot55', files: [PHOTO],
};
const SESSION = { upload_url: 'https://upload/s1', chunk_bytes: 10485760, expires_at: '2999-01-01T00:00:00Z', file_name: '2026-11-10 12-05-00 back.jpg' };
const res = (status, json = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => json });

function installFetch(routes = {}) {
  const mock = jest.fn(async (url, opts = {}) => {
    if (String(url).startsWith('https://upload/')) return res(201, { id: 'drive-9', name: SESSION.file_name });
    const resource = new URL(url, 'http://x').searchParams.get('resource');
    const fallback = { 'before-list': [200, LIST], 'before-upload-session': [200, SESSION] }[resource] || [200, {}];
    const pair = routes[resource] ?? fallback;
    return res(pair[0], pair[1]);
  });
  global.fetch = mock;
  return mock;
}
const callsTo = (mock, resource) => mock.mock.calls.filter(([u]) => !String(u).startsWith('https://') && new URL(u, 'http://x').searchParams.get('resource') === resource);
const ui = (el) => render(<MemoryRouter>{el}</MemoryRouter>);
const jpg = (name = 'back.jpg') => new File(['x'.repeat(1000)], name, { type: 'image/jpeg' });

beforeEach(() => { localStorage.clear(); jest.restoreAllMocks(); });

describe('beforePhotos utils', () => {
  test('placed = Assigned on a workorder item', () => {
    expect(isPlaced({ status: 'Assigned', workorder_items_id: 1, workorder_id: 2 })).toBe(true);
    expect(isPlaced({ status: 'In Stock', workorder_items_id: null, workorder_id: null })).toBe(false);
  });
  test('button label shows the count', () => {
    expect(beforePhotosLabel(0)).toBe('Before photos');
    expect(beforePhotosLabel(3)).toBe('Before photos (3)');
  });
});

describe('BeforePhotosPanel', () => {
  test('lists the lot\'s photos from before-list by lot id', async () => {
    login();
    const f = installFetch();
    ui(<BeforePhotosPanel lotId={55} />);
    expect(await screen.findByRole('heading', { name: 'Before refurbishment' })).toBeInTheDocument();
    expect(screen.getByAltText(PHOTO.file_name)).toHaveAttribute('src', 'https://thumb/7');
    expect(new URL(callsTo(f, 'before-list')[0][0], 'http://x').searchParams.get('lot_id')).toBe('55');
  });

  test('uploads go to before-upload-session / before-complete with the lot id only', async () => {
    login();
    const f = installFetch();
    ui(<BeforePhotosPanel lotId={55} />);
    fireEvent.change(await screen.findByLabelText('Add photos or videos for Lot L00055'), { target: { files: [jpg()] } });
    await waitFor(() => expect(callsTo(f, 'before-complete')).toHaveLength(1));
    const sessionBody = JSON.parse(callsTo(f, 'before-upload-session')[0][1].body);
    expect(sessionBody).toEqual({ lot_id: 55, file_name: 'back.jpg', size: 1000 });
    expect(JSON.parse(callsTo(f, 'before-complete')[0][1].body)).toEqual({ lot_id: 55, drive_item_id: 'drive-9' });
    expect(callsTo(f, 'complete')).toHaveLength(0);
    expect(callsTo(f, 'upload-session')).toHaveLength(0);
    expect(readPending()).toHaveLength(0); // recorded → no longer pending
  });

  test('a saved before-photo upload is kept apart from dispatch entries (a pre-G27 tab never sees it)', () => {
    addPending({ kind: 'before', lot_id: 55, user_id: 'ED', drive_item_id: 'drive-b' });
    addPending({ workorder_id: 731, workorder_items_id: 2001, user_id: 'ED', drive_item_id: 'drive-d' });
    expect(JSON.parse(localStorage.getItem('grays.dispatchEvidence.pending')).map((p) => p.drive_item_id)).toEqual(['drive-d']);
    expect(JSON.parse(localStorage.getItem('grays.beforePhotos.pending')).map((p) => p.drive_item_id)).toEqual(['drive-b']);
    expect(readPending()).toHaveLength(2);
  });

  test('the lot-row count asks for count_only (no move, no thumbnails)', async () => {
    login();
    const f = installFetch();
    ui(<BeforePhotosButton lotId={55} name="lot L00055" />);
    await screen.findByRole('button', { name: 'Before photos (1) — lot L00055' });
    expect(new URL(callsTo(f, 'before-list')[0][0], 'http://x').searchParams.get('count_only')).toBe('1');
  });

  test('read-only (Tech Checklist) shows photos without an upload button', async () => {
    login();
    installFetch();
    ui(<BeforePhotosPanel lotId={55} readOnly />);
    expect(await screen.findByAltText(PHOTO.file_name)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Add photos or videos/)).not.toBeInTheDocument();
  });

  test('read-only with no photos renders nothing', async () => {
    login();
    const f = installFetch({ 'before-list': [200, { ...LIST, files: [] }] });
    const { container } = ui(<BeforePhotosPanel lotId={55} readOnly />);
    await waitFor(() => expect(callsTo(f, 'before-list')).toHaveLength(1));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  test('a saved before-photo upload is recorded through before-complete', async () => {
    login();
    addPending({ kind: 'before', lot_id: 55, user_id: 'ED', drive_item_id: 'drive-old' });
    addPending({ workorder_id: 731, workorder_items_id: 2001, user_id: 'ED', drive_item_id: 'drive-wo' });
    const f = installFetch();
    ui(<BeforePhotosPanel lotId={55} />);
    await waitFor(() => expect(callsTo(f, 'before-complete')).toHaveLength(1));
    await waitFor(() => expect(callsTo(f, 'complete')).toHaveLength(1));
    expect(JSON.parse(callsTo(f, 'before-complete')[0][1].body)).toEqual({ lot_id: 55, drive_item_id: 'drive-old' });
    expect(JSON.parse(callsTo(f, 'complete')[0][1].body)).toEqual({ workorder_id: 731, workorder_items_id: 2001, drive_item_id: 'drive-wo' });
  });

  test('hidden-ish when not migrated: says it is not set up', async () => {
    login();
    installFetch({ 'before-list': [200, { ...LIST, available: false, files: [] }] });
    const { container } = ui(<BeforePhotosPanel lotId={55} />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});

describe('before photos for an item without a lot (old stock, owner 10 Nov 2026)', () => {
  const ITEM_LIST = {
    ...LIST, lot: null, item: { workorder_items_id: 2005, workorder_id: 731, label: 'LF-95X Life Fitness 95X Elliptical' }, files: [],
  };

  test('uploads name the workorder item, never a lot', async () => {
    login();
    const f = installFetch({ 'before-list': [200, ITEM_LIST] });
    ui(<BeforePhotosPanel workorderItemId={2005} />);
    fireEvent.change(await screen.findByLabelText('Add photos or videos for LF-95X Life Fitness 95X Elliptical'), { target: { files: [jpg()] } });
    await waitFor(() => expect(callsTo(f, 'before-complete')).toHaveLength(1));
    expect(new URL(callsTo(f, 'before-list')[0][0], 'http://x').searchParams.get('workorder_items_id')).toBe('2005');
    expect(JSON.parse(callsTo(f, 'before-upload-session')[0][1].body)).toEqual({ workorder_items_id: 2005, file_name: 'back.jpg', size: 1000 });
    expect(JSON.parse(callsTo(f, 'before-complete')[0][1].body)).toEqual({ workorder_items_id: 2005, drive_item_id: 'drive-9' });
  });

  test('a saved item upload is recorded by item', async () => {
    login();
    addPending({ kind: 'before', workorder_items_id: 2005, user_id: 'ED', drive_item_id: 'drive-item' });
    const f = installFetch({ 'before-list': [200, ITEM_LIST] });
    ui(<BeforePhotosPanel workorderItemId={2005} />);
    await waitFor(() => expect(callsTo(f, 'before-complete')).toHaveLength(1));
    expect(JSON.parse(callsTo(f, 'before-complete')[0][1].body)).toEqual({ workorder_items_id: 2005, drive_item_id: 'drive-item' });
  });

  test('onlyIfAny hides the item button when there are no item photos', async () => {
    login();
    const f = installFetch({ 'before-list': [200, ITEM_LIST] });
    const { container } = ui(<BeforePhotosButton workorderItemId={2005} name="Elliptical" onlyIfAny />);
    await waitFor(() => expect(callsTo(f, 'before-list')).toHaveLength(1));
    expect(container).toBeEmptyDOMElement();
  });

  test('the item button shows otherwise', async () => {
    login();
    installFetch({ 'before-list': [200, ITEM_LIST] });
    ui(<BeforePhotosButton workorderItemId={2005} name="Elliptical" />);
    expect(await screen.findByRole('button', { name: 'Before photos — Elliptical' })).toBeInTheDocument();
  });
});

describe('BeforePhotosButton', () => {
  test('shows the count and opens the photos in a dialog', async () => {
    login();
    installFetch();
    ui(<BeforePhotosButton lotId={55} name="lot L00055" />);
    const btn = await screen.findByRole('button', { name: 'Before photos (1) — lot L00055' });
    expect(btn).toHaveTextContent('Before photos (1)');
    fireEvent.click(btn);
    expect(await screen.findByRole('dialog', { name: 'Before refurbishment — lot L00055' })).toBeInTheDocument();
    expect(await screen.findByAltText(PHOTO.file_name)).toBeInTheDocument();
  });

  test('hidden while Microsoft is not connected or the tables are missing', async () => {
    login();
    const f = installFetch({ 'before-list': [200, { ...LIST, configured: false }] });
    const { container } = ui(<BeforePhotosButton lotId={55} name="lot L00055" />);
    await waitFor(() => expect(callsTo(f, 'before-list')).toHaveLength(1));
    expect(container).toBeEmptyDOMElement();
  });
});
