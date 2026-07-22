// F31 — changing the bucket/status filter must not destroy a draft in progress.
//
// THE BUG (live on Production): `switchBucket` and `switchStatus` both call `clearSelection()`,
// which calls `resetComposerState()` UNCONDITIONALLY. So a rep with a half-typed reply who taps
// "Closed", or moves from "Assigned to You" to "All", loses it — no warning, no undo.
//
// Same family as F27, pointed the other way: F27 was about a draft reaching the WRONG customer,
// this one is about a draft simply being destroyed. F27 deliberately did not bundle it.
//
// THE FIX, and why it is conditional: a filter is about the LIST, not about the open thread.
// Wiping the reading pane was only ever justified because it was cheap — and it is not cheap
// when it throws away work. So when the composer has unsaved content, switching a filter now
// re-filters the list and leaves the thread and the draft exactly as they were. When the
// composer is empty, behaviour is unchanged (the second test pins that, so the fix cannot
// quietly become "the thread never closes").

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Inbox from '../inbox';

const CONVERSATIONS = [
  {
    uid: 'conv-alice',
    status: 'open',
    channel: { type: 'sms', identifier: '0400000001' },
    identity: { displayName: 'Alice Adams' },
    lastMessageAt: '2026-07-21T10:00:00.000Z',
  },
];

const json = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
  headers: { get: () => 'application/json' },
});

function mockFetch() {
  return jest.fn(async (url) => {
    const u = String(url);
    if (u.includes('resource=conversations')) {
      // FILTER-AWARE on purpose. A mock that returns the same row for every bucket/status makes
      // filtering a no-op, and then the exact state this feature creates — a thread open in the
      // reading pane that is NOT in the visible list — never occurs in any test, so every
      // "the thread stays open" assertion passes for the wrong reason. Alice is open and
      // assigned, so she is absent from status=closed and from bucket=unassigned.
      const inScope = !u.includes('status=closed') && !u.includes('bucket=unassigned');
      return json({ data: inScope ? CONVERSATIONS : [], serverTime: '2026-07-21T10:00:00.000Z' });
    }
    if (u.includes('resource=messages')) {
      return json({
        data: [{ uid: 'm1', direction: 'inbound', body: 'Is the rack still available?', createdAt: '2026-07-21T09:00:00.000Z' }],
        serverTime: '2026-07-21T10:00:00.000Z',
      });
    }
    if (u.includes('resource=templates')) return json({ data: [] });
    if (u.includes('resource=reps')) return json({ reps: [] });
    if (u.includes('/api/podium/status')) return json({ podiumUserId: 'pod-me' });
    if (u.includes('/api/podium/assign')) return json({ assignees: [] });
    if (u.includes('/api/podium/contact')) return json({ customer: null, workorders: [] });
    if (u.includes('/api/products')) return json([]);
    return json({});
  });
}

const composer = () => screen.getByPlaceholderText(/type a reply…|write an internal note…/i);

/**
 * Let the list reload the switch kicked off finish before the test ends. These assertions are
 * synchronous (the draft is either still there or it isn't), so without this the fetch settles
 * after RTL has unmounted and React reports the update as un-acted — noise that would be blamed
 * on whichever test runs next.
 */
const settle = async () => {
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
};
const conversationButton = (name) => {
  const row = screen.getByText(name).closest('button');
  if (!row) throw new Error(`Conversation row for "${name}" is not a <button>`);
  return row;
};

async function openAliceAnd(type) {
  render(
    <MemoryRouter>
      <Inbox />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText('Alice Adams')).toBeInTheDocument());
  await userEvent.click(conversationButton('Alice Adams'));
  await waitFor(() => expect(composer()).toBeInTheDocument());
  // Wait for the thread itself, not just the composer: the message list arrives on its own
  // request, and a test that types immediately can outrun it (the typing was the only reason
  // the other tests happened to be safe).
  await waitFor(() => expect(screen.getByText('Is the rack still available?')).toBeInTheDocument());
  if (type) await userEvent.type(composer(), type);
}

beforeEach(() => {
  localStorage.setItem('token', 'test-token');
  localStorage.setItem('user', JSON.stringify({ id: 'GS', name: 'Tester', roles: ['sales'] }));
  global.fetch = mockFetch();
  URL.createObjectURL = jest.fn(() => 'blob:mock-url');
  URL.revokeObjectURL = jest.fn();
});

afterEach(() => {
  localStorage.clear();
  jest.resetAllMocks();
});

describe('F31 — a filter switch must not throw away work', () => {
  test('switching the status filter keeps a half-typed reply', async () => {
    await openAliceAnd('Yes — it is, I can hold it for you');

    await userEvent.click(screen.getByRole('button', { name: 'Closed' }));

    expect(composer()).toHaveValue('Yes — it is, I can hold it for you');

    await settle();
  });

  test('switching the bucket filter keeps a half-typed reply', async () => {
    await openAliceAnd('Yes — it is, I can hold it for you');

    await userEvent.click(screen.getByRole('button', { name: 'All' }));

    expect(composer()).toHaveValue('Yes — it is, I can hold it for you');

    await settle();
  });

  test('the thread stays open too — a draft with nowhere to send it is no better', async () => {
    await openAliceAnd('Half a sentence');

    await userEvent.click(screen.getByRole('button', { name: 'All' }));

    // The reading pane still shows Alice's thread, so Send still goes where the rep expects.
    expect(screen.getByText('Is the rack still available?')).toBeInTheDocument();
    expect(composer()).toHaveValue('Half a sentence');
    await settle();
  });

  test('the list itself still re-filters', async () => {
    // The point of the switch has to keep working: this is a fix for the composer, not a veto
    // on the filter.
    await openAliceAnd('Half a sentence');

    await userEvent.click(screen.getByRole('button', { name: 'All' }));

    await waitFor(() =>
      expect(global.fetch.mock.calls.some(([u]) => String(u).includes('resource=conversations&bucket=all'))).toBe(true),
    );
  });

  test('with an EMPTY composer the switch still clears the thread (unchanged behaviour)', async () => {
    // Characterization. Without this, the fix could drift into "the thread never closes", which
    // is a different product decision that nobody asked for.
    await openAliceAnd(null);
    expect(screen.getByText('Is the rack still available?')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'All' }));

    await waitFor(() => expect(screen.queryByText('Is the rack still available?')).not.toBeInTheDocument());
  });

  test('whitespace is not work — a composer holding only spaces still clears', async () => {
    await openAliceAnd('   ');

    await userEvent.click(screen.getByRole('button', { name: 'All' }));

    await waitFor(() => expect(screen.queryByText('Is the rack still available?')).not.toBeInTheDocument());
  });

  test('an attached file counts as work even with no text typed', async () => {
    // A quote PDF or a photo of the machine is the expensive half of a message: the rep found
    // the file, not just typed a line. Losing it silently is worse than losing the text.
    await openAliceAnd(null);
    const file = new File(['pdf-bytes'], 'quote-20431.pdf', { type: 'application/pdf' });
    const input = document.querySelector('input[type="file"]');
    expect(input).toBeTruthy();
    await userEvent.upload(input, file);
    await waitFor(() => expect(screen.getByText(/quote-20431\.pdf/i)).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'All' }));

    expect(screen.getByText(/quote-20431\.pdf/i)).toBeInTheDocument();
    expect(screen.getByText('Is the rack still available?')).toBeInTheDocument();
    await settle();
  });

  test('re-clicking the filter you are already on changes nothing', async () => {
    await openAliceAnd('Still typing');

    await userEvent.click(screen.getByRole('button', { name: 'Assigned to You' }));

    expect(composer()).toHaveValue('Still typing');
    expect(screen.getByText('Is the rack still available?')).toBeInTheDocument();
    await settle();
  });

  test('re-clicking the current filter with an EMPTY composer keeps the thread too', async () => {
    // The no-op guards (`if (next === bucket) return`) are what this pins. With a draft typed
    // they are unfalsifiable — `keepThread` would be true anyway — so only the empty-composer
    // case can tell whether they exist. Mutation testing proved deleting both guards left the
    // whole suite green before this test.
    await openAliceAnd(null);

    await userEvent.click(screen.getByRole('button', { name: 'Assigned to You' }));
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));

    expect(screen.getByText('Is the rack still available?')).toBeInTheDocument();
    await settle();
  });

  test('with an EMPTY composer the STATUS filter clears the thread as well', async () => {
    // The bucket half of `switchScope`'s contract was pinned; the status half was not, so
    // `switchStatus` could bypass switchScope entirely and never clear anything.
    await openAliceAnd(null);

    await userEvent.click(screen.getByRole('button', { name: 'Closed' }));

    await waitFor(() => expect(screen.queryByText('Is the rack still available?')).not.toBeInTheDocument());
  });

  test('a kept thread says so when it falls outside the filter, and can still be sent to', async () => {
    // The filter-aware mock puts Alice genuinely out of scope here (she is open, the filter is
    // Closed), which is the state the whole feature creates. Two things have to hold: the rep is
    // TOLD — on a phone the list is hidden behind the thread, so without this the tap has no
    // visible effect at all — and Send still targets the thread they are looking at.
    await openAliceAnd('Yes, I can hold it until Friday');

    await userEvent.click(screen.getByRole('button', { name: 'Closed' }));

    await waitFor(() => expect(screen.getByText(/isn’t in the current view/i)).toBeInTheDocument());
    expect(composer()).toHaveValue('Yes, I can hold it until Friday');

    await userEvent.click(screen.getByRole('button', { name: /^send$/i }));
    await waitFor(() => {
      const post = global.fetch.mock.calls.find(
        ([u, init]) => String(u).includes('resource=messages') && init?.method === 'POST',
      );
      expect(post).toBeTruthy();
      expect(JSON.parse(post[1].body).conversationId).toBe('conv-alice');
    });
    await settle();
  });

  test('a kept thread keeps receiving new messages', async () => {
    // The failure this prevents is silent and nasty: the 8s poll is scoped by bucket/status, so
    // a thread kept open OUTSIDE that scope can never appear in the poll's payload — the rep
    // composes a reply while inbound messages quietly stop arriving. No error, no spinner.
    // Found by the code review; the top-up in pollNow is what this pins.
    // Fake timers from BEFORE the render, and fireEvent throughout: the 8s interval is created
    // during mount, so switching to fake timers afterwards leaves a real timer that
    // advanceTimersByTime can never fire — the first version of this test passed on that
    // technicality and proved nothing. userEvent v13 needs real timers, hence fireEvent.
    jest.useFakeTimers();
    try {
      render(
        <MemoryRouter>
          <Inbox />
        </MemoryRouter>,
      );
      await waitFor(() => expect(screen.getByText('Alice Adams')).toBeInTheDocument());
      fireEvent.click(conversationButton('Alice Adams'));
      await waitFor(() => expect(screen.getByText('Is the rack still available?')).toBeInTheDocument());
      fireEvent.change(composer(), { target: { value: 'Typing while she replies' } });

      fireEvent.click(screen.getByRole('button', { name: 'Closed' }));
      await waitFor(() => expect(screen.getByText(/isn’t in the current view/i)).toBeInTheDocument());

      const threadGets = () => global.fetch.mock.calls.filter(
        ([u, init]) => String(u).includes('resource=messages') && String(u).includes('conv-alice') && (init?.method || 'GET') === 'GET',
      ).length;
      const before = threadGets();

      await act(async () => { jest.advanceTimersByTime(8000); });
      await act(async () => { await Promise.resolve(); });

      expect(threadGets()).toBeGreaterThan(before);
    } finally {
      jest.useRealTimers();
    }
  });

  test('the notice is not shown while the thread IS in the list', async () => {
    // Otherwise the banner could be permanently on and the test above would prove nothing.
    await openAliceAnd('Half a sentence');

    await userEvent.click(screen.getByRole('button', { name: 'All' }));

    expect(screen.queryByText(/isn’t in the current view/i)).not.toBeInTheDocument();
    await settle();
  });
});
