// F28 — the four compose behaviours that live in Inbox, not in ComposeModal.
//
// F25 built the RTL harness and covered `ComposeModal`. But the behaviours its backlog row
// named are all in `Inbox.submitCompose`, which the modal cannot reach:
//
//   1. the `composeSendingRef` double-submit guard — the one thing standing between a rep's
//      double-tap and a customer receiving the SAME TEXT TWICE. `ComposeModal` provably cannot
//      prevent it: its `sending` is a PROP captured at render, so two submits dispatched before
//      React re-renders both read `false`. Only the ref, read synchronously, stops the second.
//   2. `openConversationById` being called after a successful compose — landing the rep in the
//      thread is an acceptance criterion, and its failure path has its own toast.
//   3. the 401 and timeout branches.
//   4. `composeResultMessage` actually being what the toast renders — the dedupe signal. If the
//      server REUSED an existing thread and the toast says "started", the rep reads it as an
//      accidental duplicate and may go looking for a thread that doesn't exist. (The helper's
//      own logic is covered by scripts/podium-compose-smoke.mjs, not by jest — what was missing
//      is proof that the PAGE renders its output.)
//
// WHY THE ASSERTIONS LOOK LIKE THIS: every one is about a REQUEST that was or wasn't made, or a
// message that was or wasn't shown — never about internal state. The failure this suite exists
// to catch is "the customer got two texts", and the only honest evidence for that is how many
// POSTs left the page.
//
// Toast is mocked (a first for this repo) because it is the page's entire user-facing output on
// three of these four paths: there is no DOM change to assert on a timeout, only what the rep
// is told. See the mock factory below.

import React from 'react';
import { act, render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import toast from 'react-hot-toast';
import Inbox from '../inbox';
import { composeResultMessage } from '../../utils/compose';

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

const NEW_CONV = {
  uid: 'conv-new',
  status: 'open',
  channel: { type: 'sms', identifier: '0400999888' },
  identity: { displayName: 'New Customer' },
  lastMessageAt: '2026-07-21T11:00:00.000Z',
};

const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
  headers: { get: () => 'application/json' },
});

/**
 * The inbox's read-only surface. `composeHandler` owns every POST to resource=compose, so each
 * test decides how the server behaves (success / 401 / 500 / never resolves) without rebuilding
 * the rest of the page's mount traffic.
 */
function mockFetch(composeHandler) {
  return jest.fn(async (url, init) => {
    const u = String(url);
    if (u.includes('resource=compose')) return composeHandler(url, init);
    if (u.includes('resource=conversation&')) return json({ conversation: NEW_CONV });
    if (u.includes('resource=conversations')) {
      return json({ data: CONVERSATIONS, serverTime: '2026-07-21T10:00:00.000Z' });
    }
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

function renderInbox() {
  return render(
    <MemoryRouter initialEntries={['/inbox']}>
      <Routes>
        <Route path="/inbox" element={<Inbox />} />
        {/* A 401 sends the rep to the login route — this is how we observe it. */}
        <Route path="/" element={<div>LOGIN PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const composeCalls = () =>
  global.fetch.mock.calls.filter(([u]) => String(u).includes('resource=compose'));

/**
 * Let everything the page kicked off finish before the test ends.
 *
 * A successful compose fans out into loadConversations + openConversationById + loadThread /
 * loadPanel / loadAssignees. If the test returns while those are still in flight, RTL unmounts
 * underneath them and React reports the resulting update as an un-awaited `act` — attributed to
 * whichever test happens to be running NEXT, which is a genuinely misleading failure to debug.
 */
// Several passes on purpose: the fan-out is a CHAIN (compose → conversation → thread → panel →
// assignees), so one macrotask only advances it one link.
const settle = async () => {
  for (let i = 0; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
};

/**
 * Open the modal and fill it in, leaving it one submit away from sending.
 *
 * ⚠️ `fireEvent.change`, NOT `userEvent.type`, and that is load-bearing rather than lazy.
 * user-event **v13** (what this repo pins) leaves an armed `capture: true, once: true` window
 * blur listener behind after typing. The next test's modal autofocuses its input on commit,
 * jsdom synchronously blurs the old one, that listener fires `fireEvent.change` — i.e. a second
 * RTL `act()` re-entered from inside the first one's flush — and React 19 (which pops the act
 * scope BEFORE flushing) reports "A component suspended inside an `act` scope".
 *
 * The warning itself is cosmetic. What is not cosmetic: React latches
 * `didWarnNoAwaitAct` on the first such warning, and that latch is SHARED with the genuine
 * "you called act(async) without await" warning — so from that point on, the rest of the file
 * loses React's un-awaited-act detection entirely. Verified by planting an un-awaited async act
 * and watching it go silent.
 *
 * Per-keystroke behaviour (the Start button enabling as you type) is covered by
 * composeModal.test.js, which is the right place for it; nothing here needs keystroke fidelity.
 * Delete this note when user-event moves to v14 — `userEvent.setup()` does not do this.
 */
async function openComposeAndFill({ to = '0400 999 888', body = 'Hi, this is Grays Fitness' } = {}) {
  await waitFor(() => expect(screen.getByRole('button', { name: /new conversation/i })).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: /new conversation/i }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText(/^to$/i), { target: { value: to } });
  fireEvent.change(within(dialog).getByPlaceholderText(/message/i), { target: { value: body } });
  return dialog;
}

/** The modal's submit control. Anchored — `/send/i` would also match the reply composer. */
const startButton = (dialog) => within(dialog).getByRole('button', { name: /start conversation/i });

beforeEach(() => {
  localStorage.setItem('token', 'test-token');
  localStorage.setItem('user', JSON.stringify({ id: 'GS', name: 'Tester', roles: ['sales'] }));
  URL.createObjectURL = jest.fn(() => 'blob:mock-url');
  URL.revokeObjectURL = jest.fn();
});

afterEach(() => {
  localStorage.clear();
  // clearAllMocks, NOT resetAllMocks (which inboxComposerReset.test.js uses) — and the
  // difference is load-bearing, not an oversight to tidy up: the module factory above runs ONCE
  // per file, so resetAllMocks would strip `toast.promise`'s implementation and never restore
  // it, breaking every test after the first.
  jest.clearAllMocks();
});

describe('F28 — Inbox.submitCompose', () => {
  test('a successful compose posts once, opens the thread, and refreshes the list', async () => {
    global.fetch = mockFetch(() => json({ conversationId: 'conv-new', reused: false }));
    renderInbox();
    const dialog = await openComposeAndFill();

    await userEvent.click(startButton(dialog));

    await waitFor(() => expect(composeCalls()).toHaveLength(1));
    const [, init] = composeCalls()[0];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ to: '0400 999 888', channel: 'phone', body: 'Hi, this is Grays Fitness' });

    // Acceptance criterion: the rep lands IN the new thread.
    await waitFor(() =>
      expect(global.fetch.mock.calls.some(([u]) => String(u).includes('resource=conversation&conversationId=conv-new'))).toBe(true),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

  });

  test('the list is refreshed even when the bucket does not change', async () => {
    // Deliberately started on the All tab. On any other bucket the success path ALSO widens to
    // All, which re-runs the list effect — so a refresh assertion there passes whether or not
    // the explicit `loadConversations({silent:true})` exists, and proves nothing. On All, that
    // call is the only thing that can put the new thread in the list. (Mutation testing found
    // the weaker version of this test; it survived.)
    global.fetch = mockFetch(() => json({ conversationId: 'conv-new', reused: false }));
    renderInbox();
    await waitFor(() => expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() =>
      expect(global.fetch.mock.calls.some(([u]) => String(u).includes('resource=conversations&bucket=all'))).toBe(true),
    );
    const before = global.fetch.mock.calls.filter(([u]) => String(u).includes('resource=conversations')).length;

    const dialog = await openComposeAndFill();
    await userEvent.click(startButton(dialog));

    await waitFor(() =>
      expect(global.fetch.mock.calls.filter(([u]) => String(u).includes('resource=conversations')).length)
        .toBeGreaterThan(before),
    );
    await settle();
  });

  test('the list widens to All so the thread the rep is reading is actually in it', async () => {
    // The inbox opens on bucket=mine. Podium may not have assigned a brand-new conversation to
    // the rep yet, so without widening they end up reading a thread that is absent from the list
    // beside it — and clicking away loses it. Asserted through the REQUEST (bucket=all), because
    // that is the observable consequence rather than the state variable.
    global.fetch = mockFetch(() => json({ conversationId: 'conv-new', reused: false }));
    renderInbox();
    await waitFor(() =>
      expect(global.fetch.mock.calls.some(([u]) => String(u).includes('bucket=mine'))).toBe(true),
    );

    const dialog = await openComposeAndFill();
    await userEvent.click(startButton(dialog));

    await waitFor(() =>
      expect(global.fetch.mock.calls.some(([u]) => String(u).includes('resource=conversations&bucket=all'))).toBe(true),
    );
    await settle();
  });

  test('the toast is exactly composeResultMessage — a REUSED thread never reads as "started"', async () => {
    // The dedupe signal. Silently reusing a thread while saying "Conversation started" is the
    // precise mis-signal the message exists to prevent, and only this wiring test pins it: the
    // pure helper is well covered, but nothing asserted the page renders its output.
    const result = { conversationId: 'conv-new', reused: true, reopened: true };
    global.fetch = mockFetch(() => json(result));
    renderInbox();
    const dialog = await openComposeAndFill();

    await userEvent.click(startButton(dialog));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(composeResultMessage(result)));
    expect(toast.success).toHaveBeenCalledWith('Reopened and continued the existing conversation');
  });

  test('a double submit sends ONE message — the customer is never texted twice', async () => {
    // The guard this suite exists for. Both submits are dispatched in the SAME tick, before
    // React can re-render with sending=true, which is exactly what a key-repeat on Enter or a
    // double-tap on a slow phone produces. Dedupe on the server would keep them to one THREAD,
    // but the second POST would still send a second message.
    let resolveCompose;
    const pending = new Promise((r) => { resolveCompose = r; });
    global.fetch = mockFetch(() => pending);
    renderInbox();
    const dialog = await openComposeAndFill();

    // One synchronous act scope for BOTH submits: that is the whole point — the second must be
    // refused before React has had any chance to re-render with sending=true.
    act(() => {
      fireEvent.submit(dialog);
      fireEvent.submit(dialog);
    });

    expect(composeCalls()).toHaveLength(1);

    // Let the in-flight send settle before unmount, or the state update lands on a torn-down
    // tree and the failure surfaces in the NEXT test instead of this one.
    await act(async () => {
      resolveCompose(json({ conversationId: 'conv-new', reused: false }));
      await pending;
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // Wait for the FAN-OUT to land, not just the modal to close: the success path goes on to
    // open the composed thread, and ending the test mid-chain leaves React updating a tree RTL
    // has already unmounted.
    await waitFor(() =>
      expect(global.fetch.mock.calls.some(([u]) => String(u).includes('conversationId=conv-new'))).toBe(true),
    );
    await settle();
  });

  test('once the first send finishes, a later compose is allowed again (the guard resets)', async () => {
    // The other half: a guard that never released would silently break compose for the rest of
    // the session, and the double-submit test alone cannot tell the two apart.
    global.fetch = mockFetch(() => json({ conversationId: 'conv-new', reused: false }));
    renderInbox();
    const first = await openComposeAndFill();
    await userEvent.click(startButton(first));
    await waitFor(() => expect(composeCalls()).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const second = await openComposeAndFill({ to: '0400 111 222', body: 'Second message' });
    await userEvent.click(startButton(second));
    await waitFor(() => expect(composeCalls()).toHaveLength(2));
  });

  test('a 401 sends the rep to the login page and says nothing at all on the way out', async () => {
    global.fetch = mockFetch(() => json({ error: 'Unauthorized' }, 401));
    renderInbox();
    const dialog = await openComposeAndFill();

    // act-wrapped: the 401 branch navigates after an await, so the router's state update lands
    // outside userEvent's own act scope.
    await act(async () => {
      await userEvent.click(startButton(dialog));
    });

    await waitFor(() => expect(screen.getByText('LOGIN PAGE')).toBeInTheDocument());
    expect(toast.success).not.toHaveBeenCalled();
    // The 401 branch returns BEFORE the error path. Losing that `return` would log the rep out
    // and throw a bogus "Unauthorized" toast at them on the way to the login screen.
    expect(toast.error).not.toHaveBeenCalled();
  });

  test('an error response with no readable body still says something useful', async () => {
    // The one path that deliberately keeps the modal open is also the one where the server is
    // least likely to have sent a tidy JSON body. Without the fallback the rep gets a blank (or
    // literally "undefined") toast and no idea whether their message went anywhere.
    global.fetch = mockFetch(() => ({
      ok: false,
      status: 500,
      json: async () => { throw new Error('not json'); },
      text: async () => '',
      headers: { get: () => 'text/html' },
    }));
    renderInbox();
    const dialog = await openComposeAndFill();

    await userEvent.click(startButton(dialog));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not start the conversation'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  test('a server error leaves the modal open with the draft intact', async () => {
    global.fetch = mockFetch(() => json({ error: 'Podium rejected the recipient' }, 400));
    renderInbox();
    const dialog = await openComposeAndFill();

    await userEvent.click(startButton(dialog));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Podium rejected the recipient'));
    // The rep must be able to fix the recipient rather than retype the message.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(dialog).getByPlaceholderText(/message/i)).toHaveValue('Hi, this is Grays Fitness');
  });

  test('a lost response NEVER reads as "nothing was sent"', async () => {
    // The server hands the message to Podium BEFORE it responds, so a dropped response does not
    // mean a dropped message. Copy that invites a blind retry is how a customer gets two texts —
    // dedupe protects the THREAD, not the MESSAGE.
    global.fetch = mockFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    renderInbox();
    const dialog = await openComposeAndFill();

    await userEvent.click(startButton(dialog));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    const message = toast.error.mock.calls.at(-1)[0];
    expect(message).toMatch(/may already have been sent/i);
    expect(message).toMatch(/check the inbox before retrying/i);
    // Discriminating, not just permissive: without this the two catch branches could collapse
    // into one and a dropped connection would be reported to the rep as a timeout.
    expect(message).not.toMatch(/timed out/i);

    // The list must refresh on this path above all others — it is the rep's only way to see
    // whether the message they were not told about actually landed.
    await waitFor(() =>
      expect(global.fetch.mock.calls.filter(([u]) => String(u).includes('resource=conversations')).length).toBeGreaterThan(1),
    );
    await settle();
  });

  test('a stalled request times out and says the message may already have gone', async () => {
    // Drives the REAL AbortController + timer, not a hand-thrown AbortError: the assertion is
    // that a stalled send releases the rep at all. Without the timer the modal stays locked with
    // no way out but a reload, which loses the draft.
    global.fetch = mockFetch((url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }));
    renderInbox();
    // Mount and fill on REAL timers — findBy*/userEvent need them — then switch, so the fake
    // clock only covers the wait this test is actually about.
    const dialog = await openComposeAndFill({ to: '0400999888', body: 'Stalled send' });

    jest.useFakeTimers();
    try {
      fireEvent.submit(dialog);
      expect(composeCalls()).toHaveLength(1);

      await act(async () => { jest.advanceTimersByTime(30000); });

      expect(toast.error).toHaveBeenCalled();
      expect(toast.error.mock.calls.at(-1)[0]).toMatch(/timed out/i);
      expect(toast.error.mock.calls.at(-1)[0]).toMatch(/may already have been sent/i);
    } finally {
      jest.useRealTimers();
    }
    await settle();
  });

  test('if the thread cannot be opened, the rep is told where to find it', async () => {
    // The modal and the draft are already gone at this point, and on bucket=mine the new thread
    // may not be in the list either — saying nothing would leave the rep with no way back to a
    // conversation that really was created.
    global.fetch = jest.fn(async (url, init) => {
      const u = String(url);
      if (u.includes('resource=compose')) return json({ conversationId: 'conv-new', reused: false });
      if (u.includes('resource=conversation&')) return json({ error: 'not found' }, 404);
      return mockFetch(() => json({}))(url, init);
    });
    renderInbox();
    const dialog = await openComposeAndFill();

    await userEvent.click(startButton(dialog));

    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls.at(-1)[0]).toMatch(/find it under all conversations/i);
    await settle();
  });
});
