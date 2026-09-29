// G8 — the pure run-plan logic behind the temporary delivery run planner.
//
// Everything a driver ends up holding (stop order, the CSV, the printed sheet) is produced by
// these functions, so they are pinned directly rather than only through the page.

import {
  emptyPlan,
  toStop,
  addRun,
  updateRun,
  removeRun,
  addStop,
  removeStop,
  moveStop,
  plannedKeys,
  buildCsv,
  buildRunSheetHtml,
  loadPlan,
  savePlan,
  refreshStops,
  clearPlan,
  PLAN_STORAGE_KEY,
} from '../tempRun';

const deliveryRow = {
  delivery_type: 'Standard + Installation',
  delivery_id: 101, workorder_id: 9, invoice_id: '20431',
  customer_name: 'Demo Customer', customer_phone: '0400 000 000', customer_address: '1 Test St',
  delivery_suburb: 'Altona North', delivery_state: 'VIC',
  items_text: '1.00 × Treadmill (Grade A), 2.50 × Plates', notes: 'Rear access',
};
const woRow = {
  workorder_id: 12, invoice_id: '20500',
  customer_name: 'Another Customer', customer_phone: '+61 411 111 111', customer_address: '2 Test Rd',
  delivery_suburb: 'Geelong', delivery_state: 'VIC', items_text: '2.00 × Dumbbell rack',
  notes: 'Internal: customer owes $200, chase before dispatch',
};

function planWithTwoStops() {
  let plan = emptyPlan();
  const runId = plan.runs[0].id;
  plan = addStop(plan, runId, toStop(deliveryRow, 'delivery'));
  plan = addStop(plan, runId, toStop(woRow, 'workorder'));
  return { plan, runId };
}

describe('toStop', () => {
  test('keys a delivery and a workorder distinctly and keeps the run-sheet fields', () => {
    const d = toStop(deliveryRow, 'delivery');
    const w = toStop(woRow, 'workorder');
    expect(d.key).toBe('D-101');
    expect(w.key).toBe('W-12');
    expect(d).toMatchObject({ customer_name: 'Demo Customer', phone: '0400 000 000', address: '1 Test St', workorder_id: 9, invoice_id: '20431', notes: 'Rear access' });
  });

  test('carries the delivery type (installation matters to the driver)', () => {
    expect(toStop(deliveryRow, 'delivery').delivery_type).toBe('Standard + Installation');
    expect(toStop(woRow, 'workorder').delivery_type).toBe('');
  });

  test('workorder notes are INTERNAL — kept off the driver-facing notes field', () => {
    const w = toStop(woRow, 'workorder');
    expect(w.notes).toBe('');
    expect(w.internal_notes).toBe('Internal: customer owes $200, chase before dispatch');
    expect(toStop(deliveryRow, 'delivery').notes).toBe('Rear access');
  });

  test('tidies Postgres numeric quantities ("1.00 ×" → "1 ×", keeps real fractions)', () => {
    expect(toStop(deliveryRow, 'delivery').items_text).toBe('1 × Treadmill (Grade A), 2.5 × Plates');
  });
});

describe('plan editing', () => {
  test('starts with one empty run', () => {
    const plan = emptyPlan();
    expect(plan.runs).toHaveLength(1);
    expect(plan.runs[0].stops).toEqual([]);
  });

  test('adding the same stop twice (to any run) is a no-op — one customer, one stop', () => {
    let { plan, runId } = planWithTwoStops();
    plan = addRun(plan);
    const second = plan.runs[1].id;
    const again = addStop(plan, second, toStop(deliveryRow, 'delivery'));
    expect(again.runs[1].stops).toEqual([]);
    expect(again.runs[0].stops).toEqual(['D-101', 'W-12']);
    expect(plannedKeys(again)).toEqual(new Set(['D-101', 'W-12']));
    expect(runId).toBe(plan.runs[0].id);
  });

  test('moveStop reorders within a run and clamps out-of-range moves', () => {
    const { plan, runId } = planWithTwoStops();
    const moved = moveStop(plan, runId, 0, 1);
    expect(moved.runs[0].stops).toEqual(['W-12', 'D-101']);
    expect(moveStop(plan, runId, 0, -1).runs[0].stops).toEqual(['D-101', 'W-12']);
    expect(moveStop(plan, runId, 1, 5).runs[0].stops).toEqual(['D-101', 'W-12']);
  });

  test('removeStop drops the stop and its snapshot', () => {
    const { plan, runId } = planWithTwoStops();
    const out = removeStop(plan, runId, 'D-101');
    expect(out.runs[0].stops).toEqual(['W-12']);
    expect(out.stops['D-101']).toBeUndefined();
  });

  test('removeRun frees its stops; the last run is never removed', () => {
    let { plan } = planWithTwoStops();
    plan = addRun(plan);
    const first = plan.runs[0].id;
    const out = removeRun(plan, first);
    expect(out.runs).toHaveLength(1);
    expect(plannedKeys(out).size).toBe(0);
    expect(removeRun(out, out.runs[0].id).runs).toHaveLength(1);
  });

  test('updateRun sets carrier and day', () => {
    const { plan, runId } = planWithTwoStops();
    const out = updateRun(plan, runId, { carrier: 'Nelson', day: '2026-10-02' });
    expect(out.runs[0]).toMatchObject({ carrier: 'Nelson', day: '2026-10-02' });
  });

  test('editing never mutates the previous plan (React state safety)', () => {
    const { plan, runId } = planWithTwoStops();
    const snapshot = JSON.stringify(plan);
    moveStop(plan, runId, 0, 1);
    removeStop(plan, runId, 'W-12');
    updateRun(plan, runId, { carrier: 'X' });
    expect(JSON.stringify(plan)).toBe(snapshot);
  });
});

describe('refreshStops', () => {
  test('updates planned snapshots from live rows (corrected phone) and keeps order', () => {
    const { plan, runId } = planWithTwoStops();
    const live = [toStop({ ...deliveryRow, customer_phone: '0499 999 999' }, 'delivery')];
    const out = refreshStops(plan, live);
    expect(out.stops['D-101'].phone).toBe('0499 999 999');
    expect(out.stops['W-12'].phone).toBe('+61 411 111 111'); // not live → snapshot kept
    expect(out.runs.find((r) => r.id === runId).stops).toEqual(['D-101', 'W-12']);
  });

  test('returns the same object when nothing changed (no needless re-save)', () => {
    const { plan } = planWithTwoStops();
    expect(refreshStops(plan, [toStop(deliveryRow, 'delivery')])).toBe(plan);
  });
});

describe('buildCsv', () => {
  test('one row per stop, in run order, with stop numbers', () => {
    let { plan, runId } = planWithTwoStops();
    plan = updateRun(plan, runId, { carrier: 'Nelson', day: '2026-10-02' });
    plan = moveStop(plan, runId, 1, 0);
    const lines = buildCsv(plan).trim().split('\r\n');
    expect(lines[0]).toBe('Run,Carrier,Day,Stop,Customer,Phone,Customer address,Delivery suburb,State,Type,Items,WO,Invoice,Notes');
    expect(lines[1].startsWith('1,Nelson,2026-10-02,1,Another Customer,')).toBe(true);
    expect(lines[2].startsWith('1,Nelson,2026-10-02,2,Demo Customer,')).toBe(true);
    expect(lines).toHaveLength(3);
  });

  test('quotes commas/quotes/newlines and keeps an international phone intact', () => {
    let plan = emptyPlan();
    const runId = plan.runs[0].id;
    plan = addStop(plan, runId, toStop({ ...deliveryRow, notes: 'Ring "first"\nthen knock', customer_phone: '+61 411 111 111' }, 'delivery'));
    const csv = buildCsv(plan);
    expect(csv).toContain(',Standard + Installation,'); // no comma inside → left unquoted
    expect(csv).toContain('"Ring ""first""\nthen knock"');
    expect(csv).toContain(',+61 411 111 111,');
  });

  test('neutralises spreadsheet formula injection in free text', () => {
    let plan = emptyPlan();
    const runId = plan.runs[0].id;
    plan = addStop(plan, runId, toStop({ ...deliveryRow, customer_name: '=HYPERLINK("http://x")', notes: '@SUM(A1)' }, 'delivery'));
    const csv = buildCsv(plan);
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(csv).toContain(`'@SUM(A1)`);
  });
});

describe('buildRunSheetHtml', () => {
  test('is branded, labelled as not booked, and carries the sales phone', () => {
    const { plan } = planWithTwoStops();
    const html = buildRunSheetHtml(plan);
    expect(html).toContain('Temporary run — not booked');
    expect(html).toContain('1300 769 556');
    expect(html).toContain('graysfitness.com.au');
    expect(html).toContain('#B50B1D');
    expect(html).toContain('Inter');
    expect(html).toContain('Demo Customer');
    expect(html).toContain('0400 000 000');
  });

  test('never prints internal workorder notes', () => {
    const { plan } = planWithTwoStops();
    expect(buildRunSheetHtml(plan)).not.toContain('owes $200');
    expect(buildCsv(plan)).not.toContain('owes $200');
  });

  test('prints suburb + state and leaves the customer address off the sheet (Nick, 29 Sep 2026)', () => {
    const { plan } = planWithTwoStops();
    const html = buildRunSheetHtml(plan);
    expect(html).toContain('Altona North VIC');
    expect(html).not.toContain('1 Test St');
    expect(html).not.toMatch(/Customer address/);
  });

  test('shows the delivery type on the sheet', () => {
    const { plan } = planWithTwoStops();
    expect(buildRunSheetHtml(plan)).toContain('Standard + Installation');
  });

  test('waits for fonts before printing so Inter is used', () => {
    expect(buildRunSheetHtml(emptyPlan())).toContain('document.fonts');
  });

  test('escapes customer-entered text', () => {
    let plan = emptyPlan();
    plan = addStop(plan, plan.runs[0].id, toStop({ ...woRow, customer_name: '<img src=x onerror=alert(1)>' }, 'workorder'));
    const html = buildRunSheetHtml(plan);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  test('prints the planned day in Australian format', () => {
    let { plan, runId } = planWithTwoStops();
    plan = updateRun(plan, runId, { day: '2026-10-02' });
    expect(buildRunSheetHtml(plan)).toContain('Fri 2 Oct 2026');
  });

  test('skips empty runs', () => {
    let { plan } = planWithTwoStops();
    plan = addRun(plan);
    const html = buildRunSheetHtml(plan);
    expect((html.match(/class="run"/g) || []).length).toBe(1);
  });
});

describe('persistence (browser only)', () => {
  beforeEach(() => localStorage.clear());

  test('round-trips through localStorage', () => {
    const { plan } = planWithTwoStops();
    savePlan(plan);
    expect(JSON.parse(localStorage.getItem(PLAN_STORAGE_KEY)).runs[0].stops).toEqual(['D-101', 'W-12']);
    expect(loadPlan()).toEqual(plan);
  });

  test('a corrupt or missing entry falls back to an empty plan', () => {
    expect(loadPlan().runs).toHaveLength(1);
    localStorage.setItem(PLAN_STORAGE_KEY, '{not json');
    expect(loadPlan().runs[0].stops).toEqual([]);
    localStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify({ runs: 'nope' }));
    expect(loadPlan().runs[0].stops).toEqual([]);
  });

  test('normalises a damaged saved plan: orphan/duplicate keys dropped, strings defaulted', () => {
    const { plan } = planWithTwoStops();
    const damaged = {
      runs: [
        { id: plan.runs[0].id, carrier: null, day: undefined, stops: ['D-101', 'GHOST', 'D-101'] },
        { id: 'run-2', stops: ['W-12', 'D-101'] },
      ],
      stops: plan.stops,
    };
    localStorage.setItem(PLAN_STORAGE_KEY, JSON.stringify(damaged));
    const out = loadPlan();
    expect(out.runs[0]).toMatchObject({ carrier: '', day: '', stops: ['D-101'] });
    expect(out.runs[1]).toMatchObject({ carrier: '', day: '', stops: ['W-12'] });
  });

  test('clearPlan removes the saved run', () => {
    savePlan(planWithTwoStops().plan);
    clearPlan();
    expect(localStorage.getItem(PLAN_STORAGE_KEY)).toBeNull();
  });

  test('storage that throws (private window) does not break anything', () => {
    const spy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    const get = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    expect(() => savePlan(emptyPlan())).not.toThrow();
    expect(loadPlan().runs).toHaveLength(1);
    spy.mockRestore();
    get.mockRestore();
  });
});
