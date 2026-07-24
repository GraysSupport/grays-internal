// Tests for the G5 workshop scan-in result modal (replaces the old bottom-right toasts).
// The countdown is the interesting part: it must auto-close exactly once, and a re-render with a
// fresh onClose must NOT restart it — an unattended kiosk station has to clear itself.

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import ScanResultModal from '../ScanResultModal';

const SUCCESS = { kind: 'success', title: 'L00007 → In Workshop', detail: 'TEC-RK3512' };

describe('ScanResultModal', () => {
  test('renders nothing when there is no result', () => {
    const { container } = render(<ScanResultModal result={null} onClose={jest.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  test('shows the title and detail centred, with a countdown', () => {
    render(<ScanResultModal result={SUCCESS} onClose={jest.fn()} />);
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('L00007 → In Workshop')).toBeInTheDocument();
    expect(screen.getByText('TEC-RK3512')).toBeInTheDocument();
    // Both the button and the helper line carry the seconds, starting at the default 5.
    expect(screen.getByRole('button', { name: /close \(5\)/i })).toBeInTheDocument();
    expect(screen.getByText(/closes automatically in 5s/i)).toBeInTheDocument();
  });

  test('the Close button closes it', () => {
    const onClose = jest.fn();
    render(<ScanResultModal result={SUCCESS} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('a backdrop click closes it, a click on the card does not', () => {
    const onClose = jest.fn();
    render(<ScanResultModal result={SUCCESS} onClose={onClose} />);
    // Clicking the card (its heading) must not bubble to the backdrop handler.
    fireEvent.click(screen.getByText('L00007 → In Workshop'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('scan-result-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('Escape closes it', () => {
    const onClose = jest.fn();
    render(<ScanResultModal result={SUCCESS} onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('it auto-closes exactly once after the countdown, ticking down on the way', () => {
    jest.useFakeTimers();
    try {
      const onClose = jest.fn();
      render(<ScanResultModal result={SUCCESS} onClose={onClose} autoCloseSeconds={3} />);
      expect(screen.getByRole('button', { name: /close \(3\)/i })).toBeInTheDocument();

      act(() => { jest.advanceTimersByTime(1000); });
      expect(screen.getByRole('button', { name: /close \(2\)/i })).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();

      act(() => { jest.advanceTimersByTime(2000); });
      expect(onClose).toHaveBeenCalledTimes(1);

      // The interval must have been cleared — no second close as time keeps passing.
      act(() => { jest.advanceTimersByTime(5000); });
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a re-render with a new onClose does NOT restart the countdown', () => {
    jest.useFakeTimers();
    try {
      const first = jest.fn();
      const second = jest.fn();
      const { rerender } = render(
        <ScanResultModal result={SUCCESS} onClose={first} autoCloseSeconds={3} />,
      );
      act(() => { jest.advanceTimersByTime(2000); }); // 2s elapsed on the ORIGINAL clock

      // Same result object, different onClose (the parent re-rendered for an unrelated reason).
      rerender(<ScanResultModal result={SUCCESS} onClose={second} autoCloseSeconds={3} />);

      act(() => { jest.advanceTimersByTime(1000); }); // reaches 3s total — must fire, not reset
      expect(second).toHaveBeenCalledTimes(1);
      expect(first).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('a NEW result restarts the countdown (the next scan replaces the modal)', () => {
    // The kiosk flow that removing autoFocus enables: a tech scans again while the modal is up, so
    // a fresh result object arrives and the 5s clock must start over rather than inherit the old one.
    jest.useFakeTimers();
    try {
      const onClose = jest.fn();
      const { rerender } = render(
        <ScanResultModal result={{ kind: 'success', title: 'First' }} onClose={onClose} autoCloseSeconds={3} />,
      );
      act(() => { jest.advanceTimersByTime(2000); }); // 2s into the FIRST result

      // A different result object (the next scan).
      rerender(
        <ScanResultModal result={{ kind: 'error', title: 'Second' }} onClose={onClose} autoCloseSeconds={3} />,
      );
      expect(screen.getByText('Second')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /close \(3\)/i })).toBeInTheDocument(); // reset to 3

      act(() => { jest.advanceTimersByTime(2000); }); // would have closed the FIRST (2+2>3); must not yet
      expect(onClose).not.toHaveBeenCalled();
      act(() => { jest.advanceTimersByTime(1000); }); // 3s into the SECOND
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('renders the error and warn variants', () => {
    const { rerender } = render(
      <ScanResultModal result={{ kind: 'error', title: 'WRONG ITEM' }} onClose={jest.fn()} />,
    );
    expect(screen.getByText('WRONG ITEM')).toBeInTheDocument();
    rerender(
      <ScanResultModal result={{ kind: 'warn', title: 'Already on this workorder' }} onClose={jest.fn()} />,
    );
    expect(screen.getByText('Already on this workorder')).toBeInTheDocument();
  });
});
