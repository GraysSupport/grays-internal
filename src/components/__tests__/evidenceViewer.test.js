import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import EvidenceViewer from '../EvidenceViewer';

// G28 — photos/videos open in a pop-up inside the portal (owner, 10 Nov 2026), never a
// SharePoint page (most users can't log in to SharePoint).

const FILES = [
  { id: 1, file_name: 'front.jpg', mime_type: 'image/jpeg', uploaded_by_name: 'Liam', uploaded_at: '2026-11-10T01:00:00Z', web_url: 'https://sp/1' },
  { id: 2, file_name: 'walk.MOV', mime_type: 'video/quicktime', uploaded_by_name: 'Eden', uploaded_at: '2026-11-10T02:00:00Z', web_url: 'https://sp/2' },
  { id: 3, file_name: 'back.HEIC', mime_type: 'image/heic', uploaded_by_name: 'Ana', uploaded_at: '2026-11-10T03:00:00Z', web_url: 'https://sp/3' },
];
const LINKS = {
  1: { kind: 'image', url: 'https://dl/1', file_name: 'front.jpg' },
  2: { kind: 'video', url: 'https://dl/2', file_name: 'walk.MOV' },
  3: { kind: 'image', url: 'https://thumb/3', file_name: 'back.HEIC' },
};
const setup = (props = {}) => {
  const fetchLink = jest.fn(async (f) => LINKS[f.id]);
  const onClose = jest.fn();
  render(<EvidenceViewer files={FILES} index={0} fetchLink={fetchLink} onClose={onClose} {...props} />);
  return { fetchLink, onClose };
};

test('opens the photo in a dialog from a portal link — no SharePoint page', async () => {
  const { fetchLink } = setup();
  const dialog = screen.getByRole('dialog', { name: 'front.jpg' });
  const img = await within(dialog).findByRole('img', { name: 'front.jpg' });
  expect(img).toHaveAttribute('src', 'https://dl/1');
  expect(fetchLink).toHaveBeenCalledWith(FILES[0]);
  expect(within(dialog).getByText(/1 of 3/)).toBeInTheDocument();
  expect(within(dialog).getByText(/Liam/)).toBeInTheDocument();
});

test('next / previous step through the files; a video plays in place', async () => {
  setup();
  await screen.findByRole('img', { name: 'front.jpg' });
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  const dialog = await screen.findByRole('dialog', { name: 'walk.MOV' });
  await waitFor(() => expect(dialog.querySelector('video')).not.toBeNull());
  expect(dialog.querySelector('video')).toHaveAttribute('src', 'https://dl/2');
  fireEvent.keyDown(dialog, { key: 'ArrowRight' });
  expect(await screen.findByRole('img', { name: 'back.HEIC' })).toHaveAttribute('src', 'https://thumb/3');
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowLeft' });
  expect(await screen.findByRole('dialog', { name: 'walk.MOV' })).toBeInTheDocument();
});

test('Escape and the close button close it, without reaching the evidence pop-up behind', async () => {
  const outer = jest.fn();
  document.addEventListener('keydown', outer);
  const { onClose } = setup();
  await screen.findByRole('img', { name: 'front.jpg' });
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(outer).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Close photo' }));
  expect(onClose).toHaveBeenCalledTimes(2);
  document.removeEventListener('keydown', outer);
});

test('the link is fetched again once if it has expired (image error)', async () => {
  const { fetchLink } = setup();
  const img = await screen.findByRole('img', { name: 'front.jpg' });
  fireEvent.error(img);
  await waitFor(() => expect(fetchLink).toHaveBeenCalledTimes(2));
});

test('a failed link says so, in plain words', async () => {
  const fetchLink = jest.fn(async () => { throw new Error('That file is no longer in SharePoint'); });
  render(<EvidenceViewer files={FILES} index={0} fetchLink={fetchLink} onClose={() => {}} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('That file is no longer in SharePoint');
});
