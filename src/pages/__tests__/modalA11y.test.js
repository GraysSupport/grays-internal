// F26 — dialog semantics and focus management for the inbox overlays.
//
// THE BUG: none of the inbox modals set role="dialog"/aria-modal, none trapped focus, and
// none returned focus to the control that opened them. A keyboard or screen-reader user can
// Tab straight out of an open modal into the inbox behind it — reading and operating
// controls that are visually covered, with no way to tell where they are.
//
// A DELIBERATE SPLIT, worth reading before changing anything here:
//
//   WorkorderModal, ProductLookupModal and ComposeModal are TRUE MODALS — full-screen
//   backdrop, nothing behind them is meant to be reachable. They get role="dialog",
//   aria-modal="true", a labelling heading, a focus trap, and focus restore.
//
//   The assign picker (AssigneeBar) is NOT a modal. It is a small popover anchored to its
//   button, with no backdrop, and the page behind it stays live by design. Giving it
//   aria-modal or a focus trap would be WRONG — it would lie to a screen reader about the
//   rest of the page being inert, and trap a keyboard user in a dropdown. It gets popover
//   semantics instead: aria-haspopup/aria-expanded, Escape to close, and focus restore.
//
// The backlog row asked for "all four modals" in one pass. Three are modals; the fourth is a
// popover, and is treated as one.

import React, { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ComposeModal, WorkorderModal, ProductLookupModal, AssigneeBar } from '../inbox';

// Renders a modal behind a real opener button, so focus restore can be asserted against the
// element that actually had focus — not a synthetic stand-in.
function renderWithOpener(renderModal) {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>Open it</button>
        <button type="button">Somewhere else</button>
        {open ? renderModal(() => setOpen(false)) : null}
      </>
    );
  }
  return render(<Harness />);
}

const opener = () => screen.getByRole('button', { name: /open it/i });

describe('true modals — dialog semantics', () => {
  const cases = [
    {
      name: 'ComposeModal',
      heading: /new conversation/i,
      render: (onClose) => <ComposeModal sending={false} onSubmit={jest.fn()} onClose={onClose} />,
    },
    {
      name: 'WorkorderModal',
      heading: /workorder/i,
      render: (onClose) => (
        <WorkorderModal workorderId="WO123" detail={null} loading={false} onClose={onClose} />
      ),
    },
    {
      name: 'ProductLookupModal',
      heading: /product price/i,
      render: (onClose) => (
        <ProductLookupModal
          products={[]}
          loaded
          search=""
          setSearch={jest.fn()}
          onClose={onClose}
        />
      ),
    },
  ];

  test.each(cases)('$name exposes role="dialog" and aria-modal', async ({ render: r }) => {
    renderWithOpener(r);
    await userEvent.click(opener());

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  // Without a name, a screen reader announces "dialog" and nothing else — the user has no
  // idea which one opened.
  test.each(cases)('$name is named by its own heading', async ({ render: r, heading }) => {
    renderWithOpener(r);
    await userEvent.click(opener());

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading')).toHaveTextContent(heading);
    expect(dialog).toHaveAccessibleName(heading);
  });

  test.each(cases)('$name moves focus inside itself when it opens', async ({ render: r }) => {
    renderWithOpener(r);
    await userEvent.click(opener());

    const dialog = screen.getByRole('dialog');
    expect(dialog).toContainElement(document.activeElement);
  });

  // The actual reported bug: Tab must not walk out into the inbox behind the modal.
  test.each(cases)('$name keeps Tab inside the dialog', async ({ render: r }) => {
    renderWithOpener(r);
    await userEvent.click(opener());
    const dialog = screen.getByRole('dialog');

    // Enough tabs to leave any of these dialogs several times over if the trap is absent.
    for (let i = 0; i < 12; i += 1) {
      await userEvent.tab();
      expect(dialog).toContainElement(document.activeElement);
    }
  });

  test.each(cases)('$name keeps Shift+Tab inside the dialog', async ({ render: r }) => {
    renderWithOpener(r);
    await userEvent.click(opener());
    const dialog = screen.getByRole('dialog');

    for (let i = 0; i < 12; i += 1) {
      await userEvent.tab({ shift: true });
      expect(dialog).toContainElement(document.activeElement);
    }
  });

  // Closing without restoring focus dumps a keyboard user back at the top of the document,
  // losing their place in a long conversation list.
  test.each(cases)('$name returns focus to the opener when it closes', async ({ render: r }) => {
    renderWithOpener(r);
    await userEvent.click(opener());
    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener()).toHaveFocus();
  });
});

describe('true modals — Escape', () => {
  // ComposeModal already guarded Escape (never mid-send, or the draft is lost). These two are
  // read-only lookups with nothing to lose, and had NO Escape handling at all.
  test('WorkorderModal closes on Escape', async () => {
    const onClose = jest.fn();
    render(<WorkorderModal workorderId="WO123" detail={null} loading={false} onClose={onClose} />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('ProductLookupModal closes on Escape', async () => {
    const onClose = jest.fn();
    render(
      <ProductLookupModal products={[]} loaded search="" setSearch={jest.fn()} onClose={onClose} />,
    );
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // Regression guard on the behaviour F20's review specifically asked for: a stalled send must
  // not let Escape discard the draft.
  test('ComposeModal still refuses Escape mid-send', async () => {
    const onClose = jest.fn();
    render(<ComposeModal sending onSubmit={jest.fn()} onClose={onClose} />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('assign picker — a popover, NOT a modal', () => {
  const reps = [
    { id: 'AA', name: 'Alex Rep', linked: true },
    { id: 'BB', name: 'Bo Rep', linked: true },
  ];

  function renderPicker(props = {}) {
    const onToggle = jest.fn();
    function Harness() {
      const [show, setShow] = useState(false);
      return (
        <AssigneeBar
          assignees={[]}
          reps={reps}
          myPodiumUid={null}
          show={show}
          setShow={setShow}
          onToggle={onToggle}
          saving={false}
          {...props}
        />
      );
    }
    return { onToggle, ...render(<Harness />) };
  }

  const trigger = () => screen.getByRole('button', { name: /assign/i });

  test('the trigger advertises the popover it controls', async () => {
    renderPicker();
    expect(trigger()).toHaveAttribute('aria-haspopup');
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(trigger());
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
  });

  test('Escape closes it and puts focus back on the trigger', async () => {
    renderPicker();
    await userEvent.click(trigger());
    expect(screen.getByText('Alex Rep')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByText('Alex Rep')).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  // The point of the split. If someone "fixes" this by reaching for the modal helper, this
  // fails — which is the intent.
  test('it is NOT announced as a modal dialog', async () => {
    renderPicker();
    await userEvent.click(trigger());

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  });
});
