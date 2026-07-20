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
import { render, screen, waitFor, within } from '@testing-library/react';
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
    if (u.includes('resource=reps')) return json({ data: [] });
    if (u.includes('/api/podium/status')) return json({ podiumUserId: 'pod-me' });
    if (u.includes('/api/podium/assign')) return json({ assignees: [] });
    if (u.includes('/api/podium/contact')) return json({ customer: null, workorders: [] });
    if (u.includes('/api/products')) return json({ data: [] });
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

const conversationButton = (name) => screen.getByText(name).closest('button') || screen.getByText(name);
const composer = () => screen.getByPlaceholderText(/type a reply…|write an internal note…/i);

beforeEach(() => {
  localStorage.setItem('token', 'test-token');
  localStorage.setItem('user', JSON.stringify({ id: 'GS', name: 'Tester', roles: ['sales'] }));
  global.fetch = mockFetch();
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
    await userEvent.click(conversationButton('Alice Adams'));
    await waitFor(() => expect(composer()).toBeInTheDocument());
    await userEvent.type(composer(), 'Alice, your rack is ready');
    expect(composer()).toHaveValue('Alice, your rack is ready');

    // Switch to Bob by clicking the list — the path this feature fixes.
    await userEvent.click(conversationButton('Bob Brown'));
    await waitFor(() => expect(screen.getByText(/Message in conv-bob/i)).toBeInTheDocument());

    // The draft addressed to Alice must NOT be sitting in Bob's composer.
    expect(composer()).toHaveValue('');
  });

  test('internal-note mode does not follow into another thread', async () => {
    renderInbox();

    await waitFor(() => expect(screen.getByText('Alice Adams')).toBeInTheDocument());
    await userEvent.click(conversationButton('Alice Adams'));
    await waitFor(() => expect(composer()).toBeInTheDocument());

    // Put the composer into internal-note mode on Alice's thread.
    await userEvent.click(screen.getByRole('button', { name: /internal note/i }));
    expect(screen.getByPlaceholderText(/write an internal note…/i)).toBeInTheDocument();

    await userEvent.click(conversationButton('Bob Brown'));
    await waitFor(() => expect(screen.getByText(/Message in conv-bob/i)).toBeInTheDocument());

    // If note mode survived, the next Send posts a team-only note instead of replying to the
    // customer (or the reverse) — silent, and wrong in both directions.
    expect(screen.getByPlaceholderText(/type a reply…/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/write an internal note…/i)).not.toBeInTheDocument();
  });

  test('re-clicking the SAME conversation does not wipe a draft in progress', async () => {
    renderInbox();

    await waitFor(() => expect(screen.getByText('Alice Adams')).toBeInTheDocument());
    await userEvent.click(conversationButton('Alice Adams'));
    await waitFor(() => expect(composer()).toBeInTheDocument());
    await userEvent.type(composer(), 'Half a sentence');

    // A rep re-clicking the thread they are already in (or a list re-render) must not be
    // treated as a switch — that would discard their work with no undo, which is the same
    // class of harm this feature exists to prevent, just pointed the other way.
    await userEvent.click(conversationButton('Alice Adams'));
    await waitFor(() => expect(screen.getByText(/Message in conv-alice/i)).toBeInTheDocument());

    expect(composer()).toHaveValue('Half a sentence');
  });
});

// Keeps the panel/thread queries above honest: if the list stops rendering both customers,
// every assertion in this file becomes vacuous.
test('harness sanity: both conversations render in the list', async () => {
  renderInbox();
  await waitFor(() => expect(screen.getByText('Alice Adams')).toBeInTheDocument());
  expect(screen.getByText('Bob Brown')).toBeInTheDocument();
  const list = screen.getByText('Alice Adams').closest('button');
  expect(within(list).getByText('Alice Adams')).toBeInTheDocument();
});
