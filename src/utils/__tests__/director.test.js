import { periodPresets, formatDollars, formatPct, changeBadge, monthsBetween, monthLabel, conditionLabel } from '../director';

// G22a — pure helpers behind the Director's View.

describe('director utils', () => {
  test('the Australian financial year is the default preset (1 Jul – 30 Jun)', () => {
    const p = periodPresets(new Date('2026-10-30T03:00:00Z'));
    expect(p[0]).toMatchObject({ key: 'fy', label: 'This financial year to date (FY2027)', from: '2026-07-01', to: '2026-10-30', compare: 'year' }); // capped at today: like-for-like
    expect(p.find((x) => x.key === 'prev-fy')).toMatchObject({ from: '2025-07-01', to: '2026-06-30', label: 'Last financial year (FY2026)', compare: 'year' });
  });

  test('before July the FY started the previous calendar year', () => {
    const p = periodPresets(new Date('2026-03-15T03:00:00Z'));
    expect(p[0]).toMatchObject({ from: '2025-07-01', to: '2026-03-15' });
  });

  test('calendar year, last 12 months and this month (Melbourne date)', () => {
    // 30 Oct 2026, 1 am in Melbourne is still 29 Oct in UTC — the Melbourne date wins.
    const p = periodPresets(new Date('2026-10-29T14:00:00Z'));
    expect(p.find((x) => x.key === 'calendar')).toMatchObject({ from: '2026-01-01', to: '2026-10-30', compare: 'year' });
    expect(p.find((x) => x.key === 'last12')).toMatchObject({ from: '2025-10-31', to: '2026-10-30', compare: '1' });
    expect(p.find((x) => x.key === 'month')).toMatchObject({ from: '2026-10-01', to: '2026-10-30', compare: '1' });
  });

  test('money: whole dollars, AUD', () => {
    expect(formatDollars(890031)).toBe('$890,031');
    expect(formatDollars(1795.4)).toBe('$1,795');
    expect(formatDollars(-400)).toBe('−$400');
    expect(formatDollars(null)).toBe('—');
  });

  test('percentages', () => {
    expect(formatPct(0.75)).toBe('75%');
    expect(formatPct(0.8512)).toBe('85%');
    expect(formatPct(null)).toBe('—');
  });

  test('change vs previous period', () => {
    expect(changeBadge(120, 100)).toEqual({ dir: 'up', text: '▲ 20%' });
    expect(changeBadge(80, 100)).toEqual({ dir: 'down', text: '▼ 20%' });
    expect(changeBadge(100, 100)).toEqual({ dir: 'flat', text: '— 0%' });
    expect(changeBadge(50, 0)).toEqual({ dir: 'up', text: 'new' });
    expect(changeBadge(50, null)).toBeNull();
  });

  test('months in a range', () => {
    expect(monthsBetween('2025-11-15', '2026-02-01')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(monthLabel('2026-02')).toBe('Feb 2026');
  });
});

describe('conditionLabel (owner, 30 Oct 2026 — website labelling)', () => {
  test('known codes get their names, the code kept in brackets', () => {
    expect(conditionLabel('CS')).toBe('Clean and Serviced (CS)');
    expect(conditionLabel('CCG')).toBe('Check, Clean and Go (CCG)');
    expect(conditionLabel('AT')).toBe('As Traded (AT)');
    expect(conditionLabel('Reco')).toBe('Fully Reconditioned (Reco)');
  });
  test('anything else is shown as stored', () => {
    expect(conditionLabel('New')).toBe('New');
    expect(conditionLabel('Not set')).toBe('Not set');
    expect(conditionLabel('XYZ')).toBe('XYZ');
    expect(conditionLabel('constructor')).toBe('constructor');
  });
  test('older imports with other spacing or capitals still match', () => {
    expect(conditionLabel('RECO')).toBe('Fully Reconditioned (RECO)');
    expect(conditionLabel('cs ')).toBe('Clean and Serviced (cs)');
  });
});
