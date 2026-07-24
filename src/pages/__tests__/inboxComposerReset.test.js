// F27 — switching conversations must not carry the composer across.
//
// THE BUG (live on Production): clicking a different conversation in the list set the new
// selection but left `draft`, `attachments`, `composerMode` and `showTemplates` untouched. So
// a half-typed reply to customer A survived into customer B's thread — and if the composer
// was in internal-note mode, the next Send posted B's thread as an internal note instead of a
// reply, or vice versa. Sending A's text to B is a genuine mis-send: the wrong customer
// receives a real SMS.
//
// F20 increment 2 extracted `resetComposerState()` and wired it into `openConversationById`
// (the new compose / deep-link path). This is the same fix on the older list-click path,
// which F20 left alone as an out-of-scope pre-existing bug.
//
// THE HARNESS: this is the first test that renders the whole Inbox page rather than one
// modal, because `openConversation` is a closure inside `Inbox` and cannot be reached any
// other way. It needs a router, a logged-in token and a fetch surface. Kept deliberately
// small — it mocks only the endpoints the page actually calls on mount — and it is the seam
// the rest of F28's Inbox-level coverage will build on.

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Inbox from '../inbox';

// Shaped as the list actually consumes it: the row label is
// `c.identity?.displayName || convTitle(c)`, so `identity.displayName` is what a rep reads.
const CONVERSATIONS = [
  {
    uid: 'conv-alice',
    status: 'open',
    channel: { type: 'sms', identifier: '0400000001' },
    identity: { displayName: 'Alice Adams' },
    lastMessageAt: '2026-07-20T10:00:00.000Z',
  },
  {
    uid: 'conv-bob',
    status: 'open',
    channel: { type: 'sms', identifier: '0400000002' },
    identity: { displayName: 'Bob Brown' },
    lastMessageAt: '2026-07-20T09:00:00.000Z',
  },
];

const threadFor = (uid) => ({
  data: [
    {
      uid: `${uid}-m1`,
      direction: 'inbound',
      body: `Message in ${uid}`,
      createdAt: '2026-07-20T09:00:00.000Z',
    },
  ],
  serverTime: '2026-07-20T10:00:00.000Z',
});

// Routes a request to a canned response by URL. Anything unmatched returns an empty 200 so a
// stray best-effort fetch can't fail the test for the wrong reason.
function mockFetch() {
  return jest.fn(async (url) => {
    const u = String(url);
    const json = (body, ok = true) => ({
      ok,
      status: ok ? 200 : 500,
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: { get: () => 'application/json' },
    });

    if (u.includes('resource=conversations')) {
      return json({ data: CONVERSATIONS, serverTime: '2026-07-20T10:00:00.000Z' });
    }
    if (u.includes('resource=messages')) {
      const uid = u.includes('conv-bob') ? 'conv-bob' : 'conv-alice';
      return json(threadFor(uid));
    }
    if (u.includes('resource=templates')) return json({ data: [] });
    // Shapes matter even when empty. The page reads `d.reps` here and a BARE ARRAY from
    // /api/products — returning `{data: []}` for either would leave those features
    // permanently empty in every future test while looking correct.
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
    <MemoryRouter>
      <Inbox />
    </MemoryRouter>,
  );
}

// No `|| getByText(name)` fallback on purpose: if a list row ever stops being a <button>,
// this should fail with "no button found", not silently click a <div> and fail later with a
// confusing assertion about draft text.
const conversationButton = (name) => {
  const row = screen.getByText(name).closest('button');
  if (!row) throw new Error(`Conversation row for "${name}" is not a <button>`);
  return row;
};
const composer = () => screen.getByPlaceholderText(/type a reply…|write an internal note…/i);

let user;
beforeEach(() => {
  user = userEvent.setup(); // v14: real timers here, no advanceTimers needed
  localStorage.setItem('token', 'test-token');
  localStorage.setItem('user', JSON.stringify({ id: 'GS', name: 'Tester', roles: ['sales'] }));
  global.fetch = mockFetch();

  // jsdom 16 (pinned by CRA 5) implements NEITHER of these. The composer revokes attachment
  // object URLs on unmount, so without the stubs any test that attaches a file dies in
  // cleanup rather than in the assertion.
  URL.createObjectURL = jest.fn(() => 'blob:mock-url');
  URL.revokeObjectURL = jest.fn();
});

afterEach(() => {
  localStorage.clear();
  jest.resetAllMocks();
});

describe('F27 — switching conversations resets the composer', () => {
  test('a half-typed reply to one customer does not follow into another thread', async () => {
    renderInbox();

    // Open Alice and start typing a reply we never send.
    await waitFor(() => expect(screen.getByText('Alice Adams')).toBeInTheDocument());
    await user.click(conversationButton('Alice Adams'));
    await waitFor(() => expect(composer()).toBeInTheDocument());
    await user.type(composer(), 'Alice, your rack is ready');
    expect(composer()).toHaveValue('Alice, your rack is ready');

    // Switch to Bob by clicking the list — the path this feature fixes.
    await user.click(conversationButton('Bob Brown'));
    await waitFor(() => expect(screen.getByText(/Message in conv-bob/i)).toBeInTheDocument());

    // The draft addressed to Alice must NOT be sitting in Bob's composer.
    expect(composer()).toHaveValue('');
  });

  test('internal-note mode does not follow into another thread', async () => {
    renderInbox();

    await waitFor(() => expect(screen.getByText('Alice Adams')).toBeInTheDocument());
    await user.click(conversationButton('Alice Adams'));
    await waitFor(() => expect(composer()).toBeInTheDocument());

    // Put the composer into internal-note mode on Alice's thread.
    await user.click(screen.getByRole('button', { name: /internal note/i }));
    expect(screen.getByPlaceholderText(/write an internal note…/i)).toBeInTheDocument();

    await user.click(conversationButton('Bob Brown'));
    await waitFor(() => expect(screen.getByText(/Message in conv-bob/i)).toBeInTheDocument());

    // If note mode survived, the next Send posts a team-only note instead of replying to the
    // customer (or the reverse) — silent, and wrong in both directions.
    expect(screen.getByPlaceholderText(/type a reply…/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/write an internal note…/i)).not.toBeInTheDocument();
  });

  // The backlog row names four states; draft and composerMode are covered above. This is the
  // one that matters most and was the biggest hole in my first mutation set: an image or
  // quote PDF attached for Alice, following into Bob's composer and being SENT. Worse than
  // stray text, because a rep skims the textarea before sending but not the attachment chips.
  test('an attachment picked for one customer does not follow into another thread', async () => {
    renderInbox();

    await waitFor(() => expect(screen.getByText('Alice Adams')).toBeInTheDocument());
    await user.click(conversationButton('Alice Adams'));
    await waitFor(() => expect(composer()).toBeInTheDocument());

    const file = new File(['fake-image-bytes'], 'alice-quote.png', { type: 'image/png' });
    const input = document.querySelector('input[type="file"]');
    expect(input).toBeTruthy();
    await user.upload(input, file);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /remove attachment/i })).toBeInTheDocument(),
    );

    await user.click(conversationButton('Bob Brown'));
    await waitFor(() => expect(screen.getByText(/Message in conv-bob/i)).toBeInTheDocument());

    expect(screen.queryByRole('button', { name: /remove attachment/i })).not.toBeInTheDocument();
    // The blob must be released too, not just dropped from state.
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });

  test('re-clicking the SAME conversation does not wipe a draft in progress', async () => {
    renderInbox();

    await waitFor(() => expect(screen.getByText('Alice Adams')).toBeInTheDocument());
    await user.click(conversationButton('Alice Adams'));
    await waitFor(() => expect(composer()).toBeInTheDocument());
    await user.type(composer(), 'Half a sentence');

    // A rep re-clicking the thread they are already in (or a list re-render) must not be
    // treated as a switch — that would discard their work with no undo, which is the same
    // class of harm this feature exists to prevent, just pointed the other way.
    await user.click(conversationButton('Alice Adams'));
    await waitFor(() => expect(screen.getByText(/Message in conv-alice/i)).toBeInTheDocument());

    expect(composer()).toHaveValue('Half a sentence');
  });
});

// Keeps every assertion above honest: if the list stopped rendering both customers, the
// switch-thread tests would pass vacuously. Asserts the EXACT row count too, so a duplicate
// -row regression (the 8s poll appending rather than replacing) fails here rather than
// somewhere confusing.
test('harness sanity: the list renders exactly the two seeded conversations', async () => {
  renderInbox();
  await waitFor(() => expect(screen.getByText('Alice Adams')).toBeInTheDocument());
  expect(screen.getByText('Bob Brown')).toBeInTheDocument();
  expect(screen.getAllByText(/Alice Adams|Bob Brown/)).toHaveLength(2);
});
