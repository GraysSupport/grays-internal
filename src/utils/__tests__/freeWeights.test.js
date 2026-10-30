import {
  FREE_WEIGHT_CATEGORIES, MOVE_REASONS, LADDERS, formatKg, formatAud, stockStatus,
  filterProducts, buildCsv, parseWeightList,
} from '../freeWeights';

// G21 — pure helpers behind the Brand New Free Weights tab.

const LINE = {
  id: 1, brand: 'Trigrip', name: 'Olympic Rubber Weight', category: 'plate', active: true,
  variants: [
    { id: 11, weight_kg: 1.25, stock: 0, price: 19, reorder_level: 4, active: true, unit_cost: 9.5 },
    { id: 12, weight_kg: 2.5, stock: 3, price: 32, reorder_level: 4, active: true, unit_cost: null },
    { id: 13, weight_kg: 20, stock: 8, price: 1795, reorder_level: 2, active: true, unit_cost: 900 },
  ],
};
const DB = {
  id: 2, brand: 'Grays', name: 'Hex Dumbbell', category: 'dumbbell', active: true,
  variants: [{ id: 21, weight_kg: 10, stock: 6, price: 45.5, reorder_level: null, active: true }],
};

describe('freeWeights utils', () => {
  test('categories and reasons are keyed + labelled', () => {
    expect(FREE_WEIGHT_CATEGORIES.map((c) => c.key)).toEqual(['plate', 'bumper', 'dumbbell', 'kettlebell', 'bar', 'collar', 'other']);
    expect(MOVE_REASONS.map((r) => r.key)).toEqual(['received', 'sold', 'adjustment', 'damaged', 'returned']);
  });

  test('ladders: plates and 2.5–50 kg dumbbells in 2.5 kg steps', () => {
    expect(LADDERS.plate).toEqual([1.25, 2.5, 5, 10, 15, 20, 25]);
    expect(LADDERS.dumbbell[0]).toBe(2.5);
    expect(LADDERS.dumbbell.at(-1)).toBe(50);
    expect(LADDERS.dumbbell).toHaveLength(20);
  });

  test('formatKg', () => {
    expect(formatKg(1.25)).toBe('1.25 kg');
    expect(formatKg(20)).toBe('20 kg');
    expect(formatKg(2.5)).toBe('2.5 kg');
  });

  test('formatAud: no decimals on whole dollars, cents otherwise', () => {
    expect(formatAud(1795)).toBe('$1,795');
    expect(formatAud(12.5)).toBe('$12.50');
    expect(formatAud(0)).toBe('$0');
    expect(formatAud(null)).toBe('—');
  });

  test('stockStatus: out / low (≤ reorder level) / ok', () => {
    expect(stockStatus(LINE.variants[0])).toBe('out');
    expect(stockStatus(LINE.variants[1])).toBe('low');
    expect(stockStatus(LINE.variants[2])).toBe('ok');
    expect(stockStatus(DB.variants[0])).toBe('ok'); // no reorder level set
  });

  test('filterProducts: search by brand, name and weight', () => {
    expect(filterProducts([LINE, DB], { term: 'trigrip' })).toEqual([LINE]);
    expect(filterProducts([LINE, DB], { term: 'hex dumb' })).toEqual([DB]);
    expect(filterProducts([LINE, DB], { term: '20kg' })).toEqual([LINE]);
    expect(filterProducts([LINE, DB], { term: '10 kg' })).toEqual([DB]);
    expect(filterProducts([LINE, DB], { term: '' })).toEqual([LINE, DB]);
  });

  test('filterProducts: category and low-stock-only', () => {
    expect(filterProducts([LINE, DB], { category: 'dumbbell' })).toEqual([DB]);
    expect(filterProducts([LINE, DB], { lowOnly: true })).toEqual([LINE]);
  });

  test('buildCsv: one row per weight; cost only when allowed', () => {
    const plain = buildCsv([LINE], { canSeeCost: false }).split('\r\n');
    expect(plain[0]).toBe('"Brand","Product","Category","Weight (kg)","SKU","On hand","Price (inc GST)","Reorder level"');
    expect(plain).toHaveLength(4);
    expect(plain[3]).toBe('"Trigrip","Olympic Rubber Weight","Plates","20","","8","1795.00","2"');
    expect(plain.join()).not.toMatch(/Unit cost/);
    const cost = buildCsv([LINE], { canSeeCost: true }).split('\r\n');
    expect(cost[0]).toMatch(/"Unit cost"$/);
    expect(cost[2]).toMatch(/,""$/); // unknown cost stays blank, never 0
  });

  test('buildCsv neutralises spreadsheet formulas', () => {
    const evil = { ...DB, name: '=HYPERLINK("x")' };
    expect(buildCsv([evil], { canSeeCost: false })).toContain(`"'=HYPERLINK(""x"")"`);
  });

  test('parseWeightList reads a typed ladder', () => {
    expect(parseWeightList('1.25, 2.5 ,5;10 kg')).toEqual([1.25, 2.5, 5, 10]);
    expect(parseWeightList('5, 5, x')).toEqual([5]);
  });
});
