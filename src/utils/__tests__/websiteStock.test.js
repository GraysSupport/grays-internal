import { websiteRowLabel, websiteStockSummary, canRetryWebsiteStock } from '../websiteStock';

const row = (status, extra = {}) => ({ sku: 'TEC-TR600', status, result: null, last_error: null, ...extra });

describe('websiteRowLabel — one line per item on the workorder page', () => {
  test('sent decrease shows before → after', () => {
    expect(websiteRowLabel(row('sent', { result: { action: 'decrease', before: 6, after: 5 } }))).toEqual({ text: 'Updated: 6 → 5', tone: 'ok' });
  });
  test('sent sold-out says it was marked sold out', () => {
    expect(websiteRowLabel(row('sent', { result: { action: 'soldout', before: 1, after: 0 } })).text).toBe('Updated: 1 → 0, marked sold out');
  });
  test('sent with a human check is a warning', () => {
    const l = websiteRowLabel(row('sent', { result: { action: 'soldout', before: 1, after: 0, check: true }, last_error: 'Website showed 1 but 3 sold — check by hand' }));
    expect(l.tone).toBe('warn');
    expect(l.text).toMatch(/check by hand/);
  });
  test('website sale needs nothing', () => {
    expect(websiteRowLabel(row('sent', { result: { action: 'none', before: 4, after: 4 } })).text).toMatch(/website sale/i);
  });
  test('WB sold-out only', () => {
    expect(websiteRowLabel(row('sent', { result: { action: 'soldout_only', before: 0, after: 0 } })).text).toMatch(/marked sold out/);
  });
  test('dry run reads "would set"', () => {
    expect(websiteRowLabel(row('dry_run', { result: { action: 'decrease', before: 3, after: 2 } }))).toEqual({ text: 'Dry run — would set 3 → 2 (update by hand)', tone: 'muted' });
  });
  test('failed is a warning that says it will retry', () => {
    const l = websiteRowLabel(row('failed', { last_error: 'Website not reachable' }));
    expect(l.tone).toBe('warn');
    expect(l.text).toMatch(/Website not reachable/);
    expect(l.text).toMatch(/retr/i);
  });
  test('needs_human shows the reason', () => {
    expect(websiteRowLabel(row('needs_human', { last_error: 'SKU not on the website' }))).toEqual({ text: 'Needs you: SKU not on the website', tone: 'warn' });
  });
  test('pending, sending and cancelled', () => {
    expect(websiteRowLabel(row('pending')).tone).toBe('muted');
    expect(websiteRowLabel(row('sending')).text).toMatch(/sending/i);
    expect(websiteRowLabel(row('cancelled')).text).toMatch(/cancelled/i);
  });
  test('result may arrive as a JSON string', () => {
    expect(websiteRowLabel(row('sent', { result: '{"action":"decrease","before":2,"after":1}' })).text).toBe('Updated: 2 → 1');
  });
});

describe('websiteStockSummary — one line per workorder in the GS popup', () => {
  test('no rows → not synced automatically', () => {
    expect(websiteStockSummary([]).state).toBe('none');
    expect(websiteStockSummary(undefined).text).toMatch(/by hand/i);
  });
  test('a row that needs a human wins, naming the SKU', () => {
    const s = websiteStockSummary([row('sent', { result: { action: 'decrease', before: 2, after: 1 } }), row('needs_human', { sku: 'G25-NOWEB', last_error: 'SKU not on the website' })]);
    expect(s.state).toBe('needs_you');
    expect(s.text).toMatch(/G25-NOWEB/);
    expect(s.tone).toBe('warn');
  });
  test('more than one needing a human says how many more', () => {
    const s = websiteStockSummary([row('needs_human', { sku: 'A', last_error: 'x' }), row('needs_human', { sku: 'B', last_error: 'y' })]);
    expect(s.text).toMatch(/\+1 more/);
  });
  test('failed / pending → retrying', () => {
    expect(websiteStockSummary([row('failed', { last_error: 'down' })]).state).toBe('retrying');
    expect(websiteStockSummary([row('pending')]).state).toBe('retrying');
  });
  test('dry run → GS still updates by hand', () => {
    const s = websiteStockSummary([row('dry_run', { result: { action: 'decrease', before: 3, after: 2 } })]);
    expect(s.state).toBe('dry_run');
    expect(s.text).toMatch(/by hand/i);
  });
  test('all sent → done', () => {
    expect(websiteStockSummary([row('sent', { result: { action: 'decrease', before: 3, after: 2 } })]).state).toBe('done');
  });
  test('only cancelled rows → none', () => {
    expect(websiteStockSummary([row('cancelled')]).state).toBe('none');
  });
});

describe('canRetryWebsiteStock — when the Retry button shows', () => {
  test('failed or pending rows can be retried', () => {
    expect(canRetryWebsiteStock([row('failed')])).toBe(true);
    expect(canRetryWebsiteStock([row('pending')])).toBe(true);
  });
  test('a lookup that needed a human (nothing sent) can be retried', () => {
    expect(canRetryWebsiteStock([row('needs_human', { result: { action: 'needs_human' } })])).toBe(true);
  });
  test('an update the website may have applied cannot', () => {
    expect(canRetryWebsiteStock([row('needs_human', { result: null })])).toBe(false);
  });
  test('sent, dry run and cancelled cannot', () => {
    expect(canRetryWebsiteStock([row('sent'), row('dry_run'), row('cancelled')])).toBe(false);
    expect(canRetryWebsiteStock(undefined)).toBe(false);
  });
});

describe('G25e1 — a cancelled item added back to the website', () => {
  const add = (status, extra = {}) => row(status, { kind: 'increase', reverses_id: 1, ...extra });
  test('sent increase: "Added back: 2 → 3"', () => {
    expect(websiteRowLabel(add('sent', { result: { action: 'increase', before: 2, after: 3 } }))).toEqual({ text: 'Added back: 2 → 3', tone: 'ok' });
  });
  test('sent restock of a Sold product says it is back on sale (was Sold)', () => {
    expect(websiteRowLabel(add('sent', { result: { action: 'restock', before: 0, after: 1, was_sold: true } })).text).toBe('Added back: 0 → 1, back on sale (was Sold)');
  });
  test('restock without the Sold tick says "was sold out"', () => {
    expect(websiteRowLabel(add('sent', { result: { action: 'restock', before: 0, after: 2, was_sold: false } })).text).toBe('Added back: 0 → 2, back on sale (was sold out)');
  });
  test('dry run reads "would add N back"', () => {
    expect(websiteRowLabel(add('dry_run', { qty: 1, result: { action: 'increase', before: 2, after: 3 } }))).toEqual({ text: 'Dry run — would add 1 back (2 → 3) — add it back by hand', tone: 'muted' });
  });
  test('needs you keeps the reason', () => {
    expect(websiteRowLabel(add('needs_human', { result: { action: 'manual' }, last_error: 'no website record — update the website by hand' }))).toEqual({ text: 'Needs you: no website record — update the website by hand', tone: 'warn' });
  });
  test('pending add-back waits to be sent', () => {
    expect(websiteRowLabel(add('pending')).text).toMatch(/^Waiting to add back/);
  });
  test('a closed add-back says why', () => {
    expect(websiteRowLabel(add('cancelled', { last_error: 'Item back on the workorder before the add-back was sent — nothing sent' })).text).toBe('Add-back not needed — Item back on the workorder before the add-back was sent — nothing sent');
  });
  test('a sale closed by a cancel says so (not "workorder cancelled")', () => {
    expect(websiteRowLabel(row('cancelled', { kind: 'decrease', last_error: 'Item cancelled before the website was updated — nothing sent' })).text).toBe('Not sent — Item cancelled before the website was updated — nothing sent');
  });
  test('a flagged add-back (manual) can never be retried', () => {
    expect(canRetryWebsiteStock([add('needs_human', { result: { action: 'manual' } })])).toBe(false);
  });
  test('summary: a flagged add-back makes the workorder "needs you"', () => {
    expect(websiteStockSummary([row('sent', { result: { action: 'decrease', before: 3, after: 2 } }), add('needs_human', { result: { action: 'manual' }, last_error: 'check by hand' })]).state).toBe('needs_you');
  });
});
