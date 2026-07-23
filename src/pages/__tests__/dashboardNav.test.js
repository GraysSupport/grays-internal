// F19 increment 2a — the portal has to be navigable on a phone.
//
// THE BUG: the dashboard sidebar is `hidden md:block` and it is the portal's ONLY navigation.
// Below 768px a logged-in user therefore sees a dashboard with no links to anywhere. F19
// increment 1 shipped the installable PWA, which sharpens it: an installed app runs standalone
// with no browser URL bar, so there is no address bar to fall back on either.
//
// WHAT THESE TESTS PIN, and why each one is here rather than being "obvious":
//  - the two renderings of the nav (sidebar + drawer) show the SAME items for the same user —
//    the whole reason the item list was extracted into src/utils/nav.js;
//  - the drawer CLOSES when a link is followed. This is the one that bites: React Router
//    swaps the page underneath without unmounting the drawer, so a drawer that stays open
//    leaves the rep staring at the menu they just used, on top of the page they asked for;
//  - Logout still works from the drawer — it is the only way out of an installed PWA;
//  - the technician restriction survives the refactor (characterization, not new behaviour).

import React from 'react';
import { act, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Dashboard from '../dashboard';
import { buildNavItems } from '../../utils/nav';

// jsdom 16 (pinned by CRA 5) has no matchMedia at all. The drawer closes itself when the
// viewport crosses the md breakpoint, so the tests need one that can be driven.
function installMatchMedia(initialMatches = false) {
  const listeners = new Set();
  const mql = {
    matches: initialMatches,
    media: '(min-width: 768px)',
    addEventListener: (_e, cb) => listeners.add(cb),
    removeEventListener: (_e, cb) => listeners.delete(cb),
  };
  window.matchMedia = jest.fn(() => mql);
  return {
    /** Simulate the phone being rotated to landscape / the window being widened past md. */
    growPastBreakpoint: () => {
      mql.matches = true;
      listeners.forEach((cb) => cb({ matches: true }));
    },
  };
}

function mockFetch() {
  return jest.fn(async (url) => {
    const u = String(url);
    const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    // Every dashboard dataset is consumed as a bare array (ensureArray tolerates more, but
    // returning the real shape keeps the test honest about what the endpoints send).
    if (u.includes('/api/products')) return json([]);
    if (u.includes('/api/waitlist')) return json([]);
    if (u.includes('/api/workorder')) return json([]);
    if (u.includes('/api/delivery')) return json([]);
    if (u.includes('/api/collections')) return json([]);
    return json({});
  });
}

function renderDashboard(user = { id: 'NK', name: 'Nick', access: 'superadmin', roles: ['superadmin'] }) {
  localStorage.setItem('token', 'test-token');
  localStorage.setItem('user', JSON.stringify(user));
  return render(
    <MemoryRouter>
      <Dashboard />
    </MemoryRouter>,
  );
}

const menuButton = () => screen.getByRole('button', { name: /menu/i });
// DOM order, not two role queries concatenated: the parity assertion below compares the two
// renderings item-for-item, and a link/button split would compare a re-ordered list against a
// re-ordered list and pass even if the real order had diverged.
const labelsIn = (el) =>
  Array.from(el.querySelectorAll('a[href], button'))
    .map((n) => n.textContent.trim())
    .filter(Boolean);

let user;
beforeEach(() => {
  user = userEvent.setup(); // v14: no fake timers in this file
  global.fetch = mockFetch();
  installMatchMedia(false);
});

afterEach(() => {
  localStorage.clear();
  jest.resetAllMocks();
});

describe('F19 — mobile navigation drawer', () => {
  test('the dashboard offers a menu button (the only nav below md)', async () => {
    renderDashboard();
    await waitFor(() => expect(menuButton()).toBeInTheDocument());
  });

  test('the drawer shows exactly the same items as the desktop sidebar', async () => {
    renderDashboard();
    await waitFor(() => expect(menuButton()).toBeInTheDocument());

    const sidebarLabels = labelsIn(screen.getByTestId('sidebar-nav'));
    expect(sidebarLabels).toContain('Dashboard');
    expect(sidebarLabels).toContain('Logout');

    await user.click(menuButton());
    const drawerLabels = labelsIn(screen.getByTestId('mobile-nav'));

    // Order included: the two renderings read the same list, so drift shows up here first.
    expect(drawerLabels).toEqual(sidebarLabels);
  });

  test('the drawer is a dialog and takes focus (F26 convention)', async () => {
    renderDashboard();
    await waitFor(() => expect(menuButton()).toBeInTheDocument());
    await user.click(menuButton());

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  });

  test('Escape closes the drawer and focus returns to the menu button', async () => {
    renderDashboard();
    await waitFor(() => expect(menuButton()).toBeInTheDocument());
    await user.click(menuButton());
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(menuButton());
  });

  test('following a link closes the drawer', async () => {
    // Without this the router swaps the page underneath and the menu stays open on top of it.
    renderDashboard();
    await waitFor(() => expect(menuButton()).toBeInTheDocument());
    await user.click(menuButton());

    const drawer = screen.getByTestId('mobile-nav');
    await user.click(within(drawer).getByRole('link', { name: 'Products' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  test('the backdrop closes the drawer', async () => {
    renderDashboard();
    await waitFor(() => expect(menuButton()).toBeInTheDocument());
    await user.click(menuButton());

    await user.click(screen.getByTestId('mobile-nav-backdrop'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  test('Logout works from the drawer — in an installed PWA it is the only way out', async () => {
    renderDashboard();
    await waitFor(() => expect(menuButton()).toBeInTheDocument());
    await user.click(menuButton());

    const drawer = screen.getByTestId('mobile-nav');
    // act-wrapped explicitly: the handler awaits the access-log POST and only then navigates,
    // so the router's state update lands after userEvent's own act scope has closed.
    await act(async () => {
      await user.click(within(drawer).getByRole('button', { name: 'Logout' }));
    });

    await waitFor(() => expect(localStorage.getItem('token')).toBeNull());
    expect(localStorage.getItem('user')).toBeNull();
    // The access-log row is what tells ops a session ended deliberately rather than expiring.
    expect(global.fetch).toHaveBeenCalledWith('/api/access-log', expect.objectContaining({ method: 'POST' }));
  });

  test('every link actually points where the nav data says — in BOTH renderings', async () => {
    // Without this the labels can be right and every href wrong: the code review proved
    // `to={item.to}` could be hard-coded to "/dashboard" with all tests still green.
    const nickUser = { id: 'NK', name: 'Nick', access: 'superadmin', roles: ['superadmin'] };
    renderDashboard(nickUser);
    await waitFor(() => expect(menuButton()).toBeInTheDocument());
    await user.click(menuButton());

    const expected = buildNavItems({ user: nickUser, roles: nickUser.roles }).filter((i) => i.to);
    for (const testId of ['sidebar-nav', 'mobile-nav']) {
      const nav = screen.getByTestId(testId);
      for (const item of expected) {
        expect(within(nav).getByRole('link', { name: item.label })).toHaveAttribute('href', item.to);
      }
    }
  });

  test('the role set comes from the JWT, not just the legacy `access` value', async () => {
    // A sales rep is `access: 'staff'` with `sales` only in the signed role set (F0b). If the
    // roles wiring broke, they would silently lose Inbox and Lead Funnel on both renderings —
    // and every other fixture here is entitled via `access`, so nothing else would notice.
    renderDashboard({ id: 'AM', name: 'Amelia', access: 'staff', roles: ['staff', 'sales'] });
    await waitFor(() => expect(menuButton()).toBeInTheDocument());
    await user.click(menuButton());

    const drawer = screen.getByTestId('mobile-nav');
    expect(within(drawer).getByRole('link', { name: 'Inbox' })).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: 'Lead Funnel' })).toBeInTheDocument();
    expect(within(drawer).queryByRole('link', { name: 'Awaiting Workorder' })).not.toBeInTheDocument();
  });

  test('the × button closes the drawer', async () => {
    // On a 375px phone the drawer is 288px wide, so the backdrop is an 87px strip — the × is
    // the affordance a rep will actually aim for.
    renderDashboard();
    await waitFor(() => expect(menuButton()).toBeInTheDocument());
    await user.click(menuButton());

    await user.click(screen.getByRole('button', { name: /close menu/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  test('growing past the md breakpoint closes the drawer (rotate to landscape)', async () => {
    // Left open it would stay mounted but display:none, with useDialog's document-level Tab
    // trap still cycling focus through invisible links — keyboard navigation dead page-wide.
    const media = installMatchMedia(false);
    renderDashboard();
    await waitFor(() => expect(menuButton()).toBeInTheDocument());
    await user.click(menuButton());
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    act(() => media.growPastBreakpoint());
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  test('the two renderings stay on their own side of the md breakpoint', async () => {
    // jsdom has no CSS, so these classes are the only evidence that desktop is unchanged —
    // acceptance criterion 6. Without them, dropping `md:hidden` is invisible to every test.
    renderDashboard();
    await waitFor(() => expect(menuButton()).toBeInTheDocument());
    expect(menuButton()).toHaveClass('md:hidden');
    expect(screen.getByTestId('sidebar-nav').closest('aside')).toHaveClass('hidden', 'md:block');

    await user.click(menuButton());
    expect(screen.getByTestId('mobile-nav-backdrop').parentElement).toHaveClass('md:hidden');
  });

  test('a technician sees no Products / Customers / Waitlist in the drawer either', async () => {
    renderDashboard({ id: 'TE', name: 'Tech', access: 'technician', roles: ['technician'] });
    await waitFor(() => expect(menuButton()).toBeInTheDocument());
    await user.click(menuButton());

    const drawer = screen.getByTestId('mobile-nav');
    for (const label of ['Products', 'Customers', 'Waitlist']) {
      expect(within(drawer).queryByRole('link', { name: label })).not.toBeInTheDocument();
    }
    expect(within(drawer).getByRole('link', { name: 'Delivery Operations' })).toBeInTheDocument();
  });
});
