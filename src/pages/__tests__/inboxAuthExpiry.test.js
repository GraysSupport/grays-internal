// F32 (a) — `loadConversations`' own 401 redirect.
//
// Every fetch in src/pages/inbox.js carries the same three-line guard:
//
//     if (res.status === 401) { navigate('/'); return; }
//
// twelve times over, and NOTHING covered any of them. This one matters most: it is the redirect
// a rep actually hits. The JWT lives 1 hour, the SPA session is a 30-minute *sliding* window,
// and the inbox polls every ~8 seconds all day — so the overwhelmingly common way a rep leaves
// this page is that their token expires while it is open and the next poll comes back 401. It
// is the most-travelled error path in the product and it was load-bearing on nobody's test.
//
// It was found by accident during the F28 build: a mutation harness aimed at the COMPOSE 401
// hit this guard instead, and the whole suite stayed green.
//
// WHAT EACH TEST PINS, and why it isn't obvious:
//   - a 401 on first load lands the rep on the login route, rather than leaving them on an
//     inbox that is simply, permanently empty;
//   - a 401 arriving on the BACKGROUND POLL redirects too. This is the real-world case — nobody
//     is watching at the moment the token expires — and it is the one a naive implementation
//     misses, because the poll passes `{ silent: true }` and silent paths are exactly where
//     error handling gets skipped;
//   - the redirect happens WITHOUT an error toast. A toast here would be noise the rep cannot
//     act on, and worse, the same code path also handles 403, which SHOULD explain itself;
//   - 403 is not 401: a non-sales user is told why and sent to the dashboard, not to login.
//     These two live in adjacent lines and are easy to conflate.

import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import toast from 'react-hot-toast';
import Inbox from '../inbox';

jest.mock('react-hot-toast', () => {
  const fn = jest.fn();
  fn.success = jest.fn();
  fn.error = jest.fn();
  fn.promise = jest.fn((p) => p);
  fn.dismiss = jest.fn();
  return { __esModule: true, default: fn, Toaster: () => null };
});

const CONVERSATIONS = [
  {
    uid: 'conv-alice',
    status: 'open',
    channel: { type: 'sms', identifier: '0400000001' },
    identity: { displayName: 'Alice Adams' },
    lastMessageAt: '2026-07-21T10:00:00.000Z',
  },
];

const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
  headers: { get: () => 'application/json' },
});

/**
 * The inbox's mount traffic, with the conversations endpoint under the test's control.
 * `conversationsHandler` is called with the request count so a test can let the first load
 * succeed and fail a later poll — which is the scenario that matters.
 */
function mockFetch(conversationsHandler) {
  let conversationCalls = 0;
  return jest.fn(async (url) => {
    const u = String(url);
    if (u.includes('resource=conversations')) {
      conversationCalls += 1;
      return conversationsHandler(conversationCalls);
    }
    if (u.includes('resource=poll')) return json({ data: [], serverTime: '2026-07-21T10:00:00.000Z' });
    if (u.includes('resource=messages')) return json({ data: [], serverTime: '2026-07-21T10:00:00.000Z' });
    if (u.includes('resource=templates')) return json({ data: [] });
    if (u.includes('resource=reps')) return json({ reps: [] });
    if (u.includes('/api/podium/status')) return json({ podiumUserId: 'pod-me' });
    if (u.includes('/api/podium/assign')) return json({ assignees: [] });
    if (u.includes('/api/podium/contact')) return json({ customer: null, workorders: [] });
    if (u.includes('/api/products')) return json([]);
    return json({});
  });
}

/** As above, but with the ~8s background poll under the test's control too. */
function mockFetchWithPoll(conversationsHandler, pollHandler) {
  const base = mockFetch(conversationsHandler);
  return jest.fn(async (url, init) => {
    if (String(url).includes('resource=poll')) return pollHandler();
    return base(url, init);
  });
}

function renderInbox() {
  return render(
    <MemoryRouter initialEntries={['/inbox']}>
      <Routes>
        <Route path="/inbox" element={<Inbox />} />
        {/* The redirect targets are how we observe navigate() without stubbing it — a stub
            would pass even if the router were wired up wrongly. */}
        <Route path="/" element={<div>LOGIN PAGE</div>} />
        <Route path="/dashboard" element={<div>DASHBOARD</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const settle = async () => {
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
};

beforeEach(() => {
  localStorage.setItem('token', 'jwt-token');
  localStorage.setItem('user', JSON.stringify({ id: 'AM', name: 'Amelia', access: 'staff', roles: ['staff', 'sales'] }));
});

afterEach(() => {
  localStorage.clear();
  jest.clearAllMocks();
  jest.useRealTimers();
});

describe('F32(a) — the inbox sends an expired session back to login', () => {
  test('a 401 on first load lands the rep on the login page', async () => {
    global.fetch = mockFetch(() => json({ error: 'Unauthorized' }, 401));

    renderInbox();

    expect(await screen.findByText('LOGIN PAGE')).toBeInTheDocument();
  });

  test('it does not leave the rep on an inbox that merely looks empty', async () => {
    // The failure mode without the guard: the fetch returns, `data` is not an array, the list
    // renders as empty, and the rep sits there refreshing a page that will never load.
    global.fetch = mockFetch(() => json({ error: 'Unauthorized' }, 401));

    renderInbox();
    await settle();

    expect(screen.queryByText('Alice Adams')).not.toBeInTheDocument();
    expect(screen.getByText('LOGIN PAGE')).toBeInTheDocument();
  });

  test('the redirect is silent — no error toast the rep cannot act on', async () => {
    global.fetch = mockFetch(() => json({ error: 'Unauthorized' }, 401));

    renderInbox();
    await screen.findByText('LOGIN PAGE');
    await settle();

    expect(toast.error).not.toHaveBeenCalled();
  });

  test('a token that expires DURING the session redirects on the next poll', async () => {
    // THE REAL-WORLD CASE, and the one that was actually broken. Writing this test is how the
    // bug surfaced: `pollNow` had no 401 branch at all — just `if (!res.ok) return` — so an
    // expired token was swallowed silently, every 8 seconds, forever. The rep sat in an inbox
    // that had quietly stopped updating: no redirect, no toast, no spinner, nothing. And
    // because loadConversations only re-runs when the poll reports updates, and a 401 poll
    // never reports any, the guard this row was written about could never fire either.
    //
    // The rep's own conclusion is the worst part: the inbox looks fine. It just never shows
    // another message.
    jest.useFakeTimers();
    global.fetch = mockFetchWithPoll(
      () => json({ data: CONVERSATIONS, serverTime: '2026-07-21T10:00:00.000Z' }),
      () => json({ error: 'Unauthorized' }, 401),
    );

    renderInbox();
    await act(async () => { await Promise.resolve(); });

    // The first load succeeded, so the rep is still on the inbox.
    await waitFor(() => expect(screen.getByText('Alice Adams')).toBeInTheDocument());
    expect(screen.queryByText('LOGIN PAGE')).not.toBeInTheDocument();

    // Now the token expires and the polling interval comes round.
    await act(async () => { jest.advanceTimersByTime(9000); });
    await act(async () => { await Promise.resolve(); });

    await waitFor(() => expect(screen.getByText('LOGIN PAGE')).toBeInTheDocument());
  });

  test('a poll that fails for any OTHER reason does not throw the rep out', async () => {
    // The counterweight: a flaky network or a 500 must stay silent and keep the page alive.
    // Redirecting on every failed background request would log people out of a working session.
    jest.useFakeTimers();
    global.fetch = mockFetchWithPoll(
      () => json({ data: CONVERSATIONS, serverTime: '2026-07-21T10:00:00.000Z' }),
      () => json({ error: 'Server error' }, 500),
    );

    renderInbox();
    await act(async () => { await Promise.resolve(); });
    await waitFor(() => expect(screen.getByText('Alice Adams')).toBeInTheDocument());

    await act(async () => { jest.advanceTimersByTime(9000); });
    await act(async () => { await Promise.resolve(); });

    expect(screen.queryByText('LOGIN PAGE')).not.toBeInTheDocument();
    expect(screen.getByText('Alice Adams')).toBeInTheDocument();
  });

  test('403 is not 401 — a non-sales user is told why and sent to the dashboard', async () => {
    // Adjacent line, different meaning: the session is valid, the ROLE is wrong. Conflating the
    // two would bounce a logged-in staff member to the login screen with no explanation.
    global.fetch = mockFetch(() => json({ error: 'Forbidden' }, 403));

    renderInbox();

    expect(await screen.findByText('DASHBOARD')).toBeInTheDocument();
    expect(screen.queryByText('LOGIN PAGE')).not.toBeInTheDocument();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The Inbox is for sales users'));
  });
});
