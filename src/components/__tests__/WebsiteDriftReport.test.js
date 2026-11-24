import { render, screen, fireEvent } from '@testing-library/react';
import WebsiteDriftReport from '../WebsiteDriftReport';

// 25 Nov 2026 (owner): "969 couldn't be read … No differences — the website matches the portal."
// When products couldn't be read the page must never claim the website matches.

const report = (counts, errors = [], rows = []) => ({ createdAt: '2026-11-24T23:50:00Z', checkedAt: '2026-11-24T23:50:00Z', counts, errors, rows, source: 'live' });

function mockReport(r) {
  global.fetch = jest.fn(async (url) => ({
    ok: true, status: 200,
    json: async () => (String(url).includes('resource=report') ? { report: r } : { available: true, ...r }),
  }));
}

test('nothing could be read → says so, never "the website matches"', async () => {
  mockReport(report({ checked: 969, mismatches: 0, notOnWebsite: 0, unknown: 969 }, ['Website timed out']));
  render(<WebsiteDriftReport />);
  expect(await screen.findByText(/couldn't read the website/i)).toBeInTheDocument();
  expect(screen.queryByText(/matches the portal/i)).not.toBeInTheDocument();
});

test('some products unread, no differences found → "no differences among the ones read", with the unread count', async () => {
  mockReport(report({ checked: 969, mismatches: 0, notOnWebsite: 0, unknown: 200 }, ['Website timed out']));
  render(<WebsiteDriftReport />);
  expect(await screen.findByText(/no differences in the 769 products that could be read/i)).toBeInTheDocument();
  expect(screen.getByText(/200 couldn't be checked/i)).toBeInTheDocument();
  expect(screen.queryByText(/the website matches the portal/i)).not.toBeInTheDocument();
});

test('everything read and equal → "the website matches the portal"', async () => {
  mockReport(report({ checked: 969, mismatches: 0, notOnWebsite: 0, unknown: 0 }));
  render(<WebsiteDriftReport />);
  expect(await screen.findByText(/no differences — the website matches the portal/i)).toBeInTheDocument();
});

test('Check now shows the live result', async () => {
  mockReport(report({ checked: 10, mismatches: 0, notOnWebsite: 0, unknown: 10 }, ['Website timed out']));
  render(<WebsiteDriftReport />);
  await screen.findByText(/couldn't read the website/i);
  fireEvent.click(screen.getByRole('button', { name: /check now/i }));
  expect(await screen.findAllByText(/couldn't read the website/i)).not.toHaveLength(0);
});
