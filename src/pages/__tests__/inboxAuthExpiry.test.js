// F32 (a) — what happens in the inbox when the session expires.
//
// The row asked for a test of `loadConversations`' own 401 redirect. Writing it found a bug one
// level down instead, so this file is mostly about `pollNow`, which had no 401 branch at all.
//
// Every OTHER fetch in src/pages/inbox.js carries the same three-line guard:
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
//   - a 401 arriving on the BACKGROUND POLL redirects at all. This is the real-world case —
//     nobody is watching at the moment the token expires — and it was the broken one: `pollNow`
//     swallowed it into `if (!res.ok) return`, the silent path where error handling gets skipped;
//   - the click-driven redirects stay silent (the rep knows what they just did), while the
//     TIMER-driven one explains itself and ends the session. Two different behaviours on
//     purpose, and each is pinned, because code review showed a toast could be added to the
//     poll path with every test still green;
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

/**
 * Let everything the page kicked off finish before asserting.
 *
 * Deliberately drains MICROTASKS only. An earlier version awaited a real `setTimeout(0)`, which
 * simply never fires while jest's fake timers are installed — the fake-timer tests hung for the
 * full 5s jest timeout and took the following test down with them. Nothing here needs the macro
 * queue: the page's fan-out is promise-chained, and where a timer is genuinely wanted the test
 * advances it explicitly.
 */
const settle = async () => {
  for (let i = 0; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { await Promise.resolve(); });
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

  test('it does not render a list out of a 401 body', async () => {
    // The failure mode without the guard: the response still parses, so whatever the error body
    // happens to contain gets treated as data. This 401 carries a plausible-looking payload for
    // exactly that reason — code review caught the first version asserting the ABSENCE of a
    // conversation the mock never returned under any implementation, which could not fail.
    global.fetch = mockFetch(() => json({ error: 'Unauthorized', data: CONVERSATIONS }, 401));

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

  test('the timer-driven redirect TELLS the rep why, unlike the click-driven ones', async () => {
    // Code review found this uncovered: adding a toast to the poll guard passed all six tests,
    // because the "no toast" test only ever exercised the foreground path. A silent redirect is
    // right after a click — the rep knows what they did — and wrong on a timer, where the page
    // just vanishes mid-sentence.
    jest.useFakeTimers();
    global.fetch = mockFetchWithPoll(
      () => json({ data: CONVERSATIONS, serverTime: '2026-07-21T10:00:00.000Z' }),
      () => json({ error: 'Unauthorized' }, 401),
    );

    renderInbox();
    await act(async () => { await Promise.resolve(); });
    await waitFor(() => expect(screen.getByText('Alice Adams')).toBeInTheDocument());

    await act(async () => { jest.advanceTimersByTime(9000); });
    await act(async () => { await Promise.resolve(); });

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Your session expired — please sign in again'));
  });

  test('… and ends the session, so Back cannot bounce off a dead token', async () => {
    // Navigating without clearing the token leaves a loop: Back lands on /inbox, the client
    // gate sees a token and mounts, it 401s, and pushes to login again.
    jest.useFakeTimers();
    global.fetch = mockFetchWithPoll(
      () => json({ data: CONVERSATIONS, serverTime: '2026-07-21T10:00:00.000Z' }),
      () => json({ error: 'Unauthorized' }, 401),
    );

    renderInbox();
    await act(async () => { await Promise.resolve(); });
    await waitFor(() => expect(screen.getByText('Alice Adams')).toBeInTheDocument());
    expect(localStorage.getItem('token')).toBe('jwt-token');

    await act(async () => { jest.advanceTimersByTime(9000); });
    await act(async () => { await Promise.resolve(); });

    await waitFor(() => expect(screen.getByText('LOGIN PAGE')).toBeInTheDocument());
    expect(localStorage.getItem('token')).toBeNull();
    expect(localStorage.getItem('user')).toBeNull();
    expect(localStorage.getItem('sessionExpiry')).toBeNull();

    // NOT pinned here: that the navigation uses `replace` rather than push. Mutating it to a
    // push survives this suite. Observing it needs a `createMemoryRouter` harness and a
    // `navigate(-1)`, and the observation is muddied anyway because the cleared token means the
    // client gate bounces a Back-navigation regardless. The clearing above is the real defence
    // against the loop; `replace` is belt-and-braces. Named rather than left silently uncovered.
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
    await settle();

    // Prove the poll actually ran before concluding anything from its silence — otherwise this
    // test would pass simply because nothing happened, and would keep passing if an added
    // `await` inside pollNow pushed the guard past the assertions.
    const pollCalls = global.fetch.mock.calls.filter(([u]) => String(u).includes('resource=poll'));
    expect(pollCalls.length).toBeGreaterThanOrEqual(1);

    expect(screen.queryByText('LOGIN PAGE')).not.toBeInTheDocument();
    expect(screen.getByText('Alice Adams')).toBeInTheDocument();
    expect(localStorage.getItem('token')).toBe('jwt-token');
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
