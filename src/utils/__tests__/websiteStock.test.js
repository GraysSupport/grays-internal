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
