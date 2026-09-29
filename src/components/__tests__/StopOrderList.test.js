// StopOrderList — the reorder component G8 ships and G9 (drag-to-reorder on the booked
// schedule) reuses. These pin the two things G9 will lean on that the G8 page tests don't:
//   - canDrop is honoured by EVERY way of moving (drag AND the keyboard/touch buttons), so a
//     G9 "same carrier + same day only" rule can't be bypassed from the keyboard;
//   - keyboard reordering keeps focus on the moved stop and announces the new position.

import React, { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import StopOrderList from '../StopOrderList';

function Harness({ initial = ['Alpha', 'Bravo', 'Charlie'], canDrop }) {
  const [items, setItems] = useState(initial);
  const move = (from, to) => setItems((xs) => {
    const next = [...xs];
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x);
    return next;
  });
  return (
    <StopOrderList
      ariaLabel="Stops"
      items={items}
      getKey={(x) => x}
      getLabel={(x) => x}
      renderItem={(x) => <span data-testid="name">{x}</span>}
      onMove={move}
      canDrop={canDrop}
    />
  );
}

const order = () => screen.getAllByTestId('name').map((n) => n.textContent);

test('Move down reorders, keeps focus on the moved stop, and announces its new position', () => {
  render(<Harness />);
  const btn = screen.getByRole('button', { name: 'Move Alpha down' });
  btn.focus();
  fireEvent.click(btn);
  expect(order()).toEqual(['Bravo', 'Alpha', 'Charlie']);
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move Alpha down' }));
  expect(screen.getByRole('status')).toHaveTextContent('Alpha moved to stop 2 of 3');
});

test('moving to the top keeps focus on the stop (the now-disabled Up hands focus to Down)', () => {
  render(<Harness />);
  const up = screen.getByRole('button', { name: 'Move Bravo up' });
  up.focus();
  fireEvent.click(up);
  expect(order()).toEqual(['Bravo', 'Alpha', 'Charlie']);
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move Bravo down' }));
});

test('canDrop is enforced on the buttons, not just on drag', () => {
  // G9-style rule: Charlie is in a different group and can't swap with Bravo.
  const canDrop = (from, to) => !((from === 1 && to === 2) || (from === 2 && to === 1));
  render(<Harness canDrop={canDrop} />);
  expect(screen.getByRole('button', { name: 'Move Bravo down' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Move Charlie up' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Move Alpha down' })).not.toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Move Bravo down' }));
  expect(order()).toEqual(['Alpha', 'Bravo', 'Charlie']);
});

test('drag and drop reorders, and a rejected drop does nothing', () => {
  const canDrop = (from, to) => to !== 2;
  render(<Harness canDrop={canDrop} />);
  const rows = () => screen.getAllByRole('listitem');
  fireEvent.dragStart(rows()[0]);
  fireEvent.dragOver(rows()[2]);
  fireEvent.drop(rows()[2]);
  expect(order()).toEqual(['Alpha', 'Bravo', 'Charlie']);
  fireEvent.dragStart(rows()[0]);
  fireEvent.dragOver(rows()[1]);
  fireEvent.drop(rows()[1]);
  expect(order()).toEqual(['Bravo', 'Alpha', 'Charlie']);
});
