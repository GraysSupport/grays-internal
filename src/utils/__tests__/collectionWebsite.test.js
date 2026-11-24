import { sendConfirmText, notCompletedWarning, reminderText, canTick } from '../collectionWebsite';

describe('G25e2 — Apply Stock to Website dialog text', () => {
  test('confirmation states item count and total quantity', () => {
    expect(sendConfirmText({ items: 4, units: 7 })).toBe('Send 4 items (7 units) to the website?');
    expect(sendConfirmText({ items: 1, units: 1 })).toBe('Send 1 item (1 unit) to the website?');
  });
  test('dry run says nothing is written', () => {
    expect(sendConfirmText({ items: 2, units: 3, dryRun: true })).toBe('Dry run: record 2 items (3 units) as "would send" — nothing is written to the website?');
  });
  test('warning when the collection is not Completed yet (E-D5)', () => {
    expect(notCompletedWarning('In Transit')).toBe('This collection is not Completed yet (status: In Transit). You can still send it, e.g. to list stock before it arrives.');
    expect(notCompletedWarning('Completed')).toBeNull();
  });
  test('reminder: N items not on the website yet (E-D7)', () => {
    expect(reminderText(0)).toBeNull();
    expect(reminderText(1)).toBe('1 item not on the website yet');
    expect(reminderText(3)).toBe('3 items not on the website yet');
  });
  test('only lines with something left can be ticked; do-not-sync lines never', () => {
    expect(canTick({ state: 'ok', remaining: 2 })).toBe(true);
    expect(canTick({ state: 'ok', remaining: 0 })).toBe(false);
    expect(canTick({ state: 'skip', remaining: 0 })).toBe(false);
  });
});
