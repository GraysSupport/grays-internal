import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import WorkorderCancel from '../../components/WorkorderCancel';

// G23 (owner, 30 Oct 2026) — cancel / reopen a workorder from its page.

jest.mock('react-hot-toast', () => ({
  __esModule: true,
  default: { success: jest.fn(), error: jest.fn(), loading: jest.fn(), dismiss: jest.fn() },
}));

function login(roles, id = 'BR') {
  const b64 = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  localStorage.setItem('token', `${b64({ alg: 'none' })}.${b64({ id, roles })}.sig`);
  localStorage.setItem('user', JSON.stringify({ id, name: 'Shaun', access: roles[0], roles }));
}
function installFetch(status = 200, json = { workorder_id: 41, status: 'Cancelled', items: [], activity: [] }) {
  const mock = jest.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => json }));
  global.fetch = mock;
  return mock;
}
const renderIt = (props) => render(<MemoryRouter><WorkorderCancel workorderId={41} status="Work Ordered" onChanged={jest.fn()} {...props} /></MemoryRouter>);

beforeEach(() => localStorage.clear());

describe('Cancel a workorder', () => {
  test('a sales login confirms first, then one PUT with only the status', async () => {
    login(['sales']);
    const f = installFetch();
    const onChanged = jest.fn();
    renderIt({ onChanged });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel workorder' }));
    const dialog = screen.getByRole('dialog', { name: /cancel this workorder/i });
    expect(dialog).toHaveTextContent(/stock is returned/i);
    expect(dialog).toHaveTextContent(/Lots assigned to its items go back to In Stock/);
    expect(f).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, cancel workorder' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ status: 'Cancelled' })));
    expect(f).toHaveBeenCalledTimes(1);
    const [url, opts] = f.mock.calls[0];
    expect(url).toBe('/api/workorder?id=41');
    expect(opts.method).toBe('PUT');
    expect(JSON.parse(opts.body)).toEqual({ status: 'Cancelled' });
    expect(opts.headers.Authorization).toMatch(/^Bearer /);
  });

  test('"Keep workorder" closes without saving', () => {
    login(['admin']);
    const f = installFetch();
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel workorder' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep workorder' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(f).not.toHaveBeenCalled();
  });

  test('a refusal (e.g. a delivery exists) is shown in the dialog', async () => {
    login(['logistics']);
    installFetch(409, { error: 'This workorder already has a delivery — remove the delivery first, then cancel the workorder' });
    const onChanged = jest.fn();
    renderIt({ onChanged });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel workorder' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, cancel workorder' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/remove the delivery first/);
    expect(onChanged).not.toHaveBeenCalled();
  });

  test('a Completed workorder shows no cancel button (set it back to Work Ordered first)', () => {
    login(['admin']);
    renderIt({ status: 'Completed' });
    expect(screen.queryByRole('button', { name: 'Cancel workorder' })).not.toBeInTheDocument();
  });

  test.each([['staff'], ['technician']])('a %s login sees no cancel button', (role) => {
    login([role]);
    renderIt();
    expect(screen.queryByRole('button', { name: 'Cancel workorder' })).not.toBeInTheDocument();
  });
});

describe('A cancelled workorder', () => {
  test('everyone sees the cancelled banner', () => {
    login(['staff']);
    renderIt({ status: 'Cancelled' });
    expect(screen.getByRole('status')).toHaveTextContent(/This workorder is cancelled/);
    expect(screen.queryByRole('button', { name: 'Reopen workorder' })).not.toBeInTheDocument();
  });

  test('superadmin reopens it after confirming', async () => {
    login(['superadmin'], 'GS');
    const f = installFetch(200, { workorder_id: 41, status: 'Work Ordered', items: [], activity: [] });
    const onChanged = jest.fn();
    renderIt({ status: 'Cancelled', onChanged });
    fireEvent.click(screen.getByRole('button', { name: 'Reopen workorder' }));
    expect(screen.getByRole('dialog', { name: /reopen this workorder/i })).toHaveTextContent(/lots are not re-assigned/i);
    fireEvent.click(screen.getByRole('button', { name: 'Yes, reopen workorder' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ status: 'Work Ordered', reopen: true });
  });
});
