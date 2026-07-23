// F25 — the repo's first React component test.
//
// WHY THIS FILE EXISTS: @testing-library/react, jest-dom and user-event have been in
// `dependencies` since the project started, and until now there was not one `*.test.js` in
// `src/`. Every finding in the F20 increment-2 code review lived in this component, and none
// of them could have been caught by a test: the pure helpers (src/utils/compose.js) are well
// covered by scripts/podium-compose-smoke.mjs, the UI that USES them was not covered at all.
//
// SCOPE: ComposeModal only — the modal a rep types a new conversation into. The behaviour
// that matters here is the Start button's gating, because the modal is one click away from
// texting a real customer, and the channel it derives decides which way that text goes.
//
// NOT COVERED HERE (named, not silently skipped — see MEMORY.md backlog):
//   - Inbox.submitCompose's `composeSendingRef` double-submit guard, `openConversationById`
//     being called after a compose, and its 401/timeout branches. Those live in the Inbox
//     page component, which needs a router + an authenticated fetch surface to render; that
//     is a bigger harness than this increment, and it gets its own backlog row rather than a
//     shallow mock that would assert nothing real.

import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ComposeModal } from '../inbox';

// Rendering helper: the three props ComposeModal takes, with jest spies for the callbacks.
function renderModal(props = {}) {
  const onSubmit = jest.fn();
  const onClose = jest.fn();
  const utils = render(
    <ComposeModal sending={false} onSubmit={onSubmit} onClose={onClose} {...props} />,
  );
  return { onSubmit, onClose, ...utils };
}

// Labels are matched ANCHORED. An unanchored /to/ would also match a future "Total",
// "History" or "Store" label and throw on multiple matches — a failure that reads as though
// the new field broke these tests, when really the query was always too loose.
const startButton = () => screen.getByRole('button', { name: /start conversation|starting/i });
const recipientBox = () => screen.getByLabelText(/^to$/i);
const messageBox = () => screen.getByLabelText(/^message$/i);
const backdrop = () => screen.getByTestId('compose-backdrop');

// user-event v14: one fresh `setup()` per test (real timers throughout this file).
let user;
beforeEach(() => {
  user = userEvent.setup();
});

describe('ComposeModal — Start button gating', () => {
  test('Start is disabled before anything is typed', () => {
    renderModal();
    expect(startButton()).toBeDisabled();
  });

  test('Start stays disabled when the recipient is not a phone or an email', async () => {
    renderModal();
    await user.type(recipientBox(), 'not-a-contact');
    await user.type(messageBox(), 'Your rack is ready for pickup.');
    // "not-a-contact" has no @-domain and fewer than MIN_PHONE_DIGITS digits, so there is
    // nowhere for this message to go. Sending it would 400 at best.
    expect(startButton()).toBeDisabled();
  });

  test('Start stays disabled when the message is only whitespace', async () => {
    renderModal();
    await user.type(recipientBox(), '0412345678');
    await user.type(messageBox(), '   ');
    expect(startButton()).toBeDisabled();
  });

  test('Start enables once the recipient and the message are both valid', async () => {
    renderModal();
    await user.type(recipientBox(), '0412345678');
    await user.type(messageBox(), 'Your rack is ready for pickup.');
    expect(startButton()).toBeEnabled();
  });
});

describe('ComposeModal — what it submits', () => {
  test('a phone recipient submits channel "phone", trimmed', async () => {
    const { onSubmit } = renderModal();
    await user.type(recipientBox(), '  0412 345 678  ');
    await user.type(messageBox(), '  Your rack is ready.  ');
    await user.click(startButton());

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      to: '0412 345 678',
      channel: 'phone',
      body: 'Your rack is ready.',
    });
  });

  test('an email recipient submits channel "email"', async () => {
    const { onSubmit } = renderModal();
    await user.type(recipientBox(), 'nick@graysfitness.com.au');
    await user.type(messageBox(), 'Quote attached.');
    await user.click(startButton());

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'email', to: 'nick@graysfitness.com.au' }),
    );
  });
});

describe('ComposeModal — while a send is in flight', () => {
  test('Start is disabled and reads "Starting…" once the parent reports sending', () => {
    renderModal({ sending: true });
    expect(startButton()).toBeDisabled();
    expect(startButton()).toHaveTextContent(/starting/i);
  });

  // The customer-visible risk: a second dispatch is a second text. Once the parent has
  // flipped `sending`, further clicks must not reach onSubmit.
  //
  // The narrower race — two clicks landing BEFORE React re-renders with sending=true — is
  // deliberately not this component's job and cannot be fixed here, because `sending` is a
  // prop captured at render. Inbox.submitCompose guards it synchronously with
  // `composeSendingRef`. If that ref is ever removed, this test will still pass; that is why
  // the Inbox-level test is called out as a backlog row above rather than assumed covered.
  test('the disabled Start button cannot be re-clicked once sending', async () => {
    const { onSubmit, rerender } = renderModal();
    await user.type(recipientBox(), '0412345678');
    await user.type(messageBox(), 'Your rack is ready.');
    await user.click(startButton());
    expect(onSubmit).toHaveBeenCalledTimes(1);

    rerender(<ComposeModal sending onSubmit={onSubmit} onClose={jest.fn()} />);
    await user.click(startButton());
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe('ComposeModal — closing without losing a draft', () => {
  test('Escape closes an untouched modal', async () => {
    const { onClose } = renderModal();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('Escape does not close mid-send, which would drop the draft', async () => {
    const { onClose } = renderModal({ sending: true });
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });

  // This positive case is what stops the negative one below from rotting into a no-op: if
  // backdrop-close stops working altogether (or the testid moves), THIS test goes red loudly.
  // Without it, deleting the whole closeOnBackdrop body left all 11 earlier tests green.
  test('a backdrop click closes an untouched modal', async () => {
    const { onClose } = renderModal();
    await user.click(backdrop());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('a backdrop click discards nothing once the rep has typed', async () => {
    const { onClose } = renderModal();
    await user.type(messageBox(), 'Half a quote');
    await user.click(backdrop());
    expect(onClose).not.toHaveBeenCalled();
  });

  // The backdrop guard above is only safe BECAUSE these two exits always remain — block the
  // backdrop without them and a typed draft is trapped in a modal with no way out but a
  // reload. Untested, that guarantee is a comment; tested, it's a constraint.
  test('Cancel closes even when the rep has typed', async () => {
    const { onClose } = renderModal();
    await user.type(messageBox(), 'Half a quote');
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('the × closes even when the rep has typed', async () => {
    const { onClose } = renderModal();
    await user.type(messageBox(), 'Half a quote');
    await user.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
