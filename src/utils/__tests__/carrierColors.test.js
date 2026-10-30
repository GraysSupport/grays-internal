import { carrierColor, CARRIER_COLOR_RULES } from '../carrierColors';

// G23 (owner, 30 Oct 2026): every removalist on the books has a colour on the delivery tabs.
// The names are the removalist table as of 30 Oct 2026.
const REMOVALISTS = [
  'Moving Soon', 'DTL Logistics', 'Customer Collect', 'Singh - Van VIC', 'RJD Removals - Robbo', 'Bass Strait Removals',
  'Thompson Removals', 'SA Removals', 'Coastal Breeze Removalist', 'BNL Freight Management', 'Grays', 'Dial A Mover',
  'Iron Armour', 'EJ Shaws', 'Big Post', 'BRS', 'Jets', 'Michael (Installer) - Home Fitness Solutions', 'A Grade Removals',
  'ALLIED', 'Chris Watkins Removals', 'Eastside Removals', 'First Transport (Couriers)', 'Slingshot Removals',
];

describe('carrierColor', () => {
  test.each(REMOVALISTS)('%s has a colour', (name) => {
    expect(carrierColor(name)).toMatch(/^#[0-9a-f]{6,8}$/i);
  });

  test('the four that had none get their own colours', () => {
    expect(carrierColor('Singh - Van VIC')).toBe('#FFC000');
    expect(carrierColor('Dial A Mover')).toBe('#B4A7D6');
    expect(carrierColor('Jets')).toBe('#76D7C4');
    expect(carrierColor('Michael (Installer) - Home Fitness Solutions')).toBe('#E6B8AF');
  });

  test('existing colours are unchanged', () => {
    expect(carrierColor('Moving Soon')).toBe('#F4B084');
    expect(carrierColor('RJD Removals - Robbo')).toBe('#FFFF00');
    expect(carrierColor('Grays')).toBe('#bfd6ebff');
  });

  test('the new colours are not used by any other removalist', () => {
    for (const c of ['#FFC000', '#B4A7D6', '#76D7C4', '#E6B8AF']) {
      expect(CARRIER_COLOR_RULES.filter((r) => r.color.toLowerCase() === c.toLowerCase())).toHaveLength(1);
    }
  });

  test('a removalist added later gets the neutral colour; a blank name gets none', () => {
    expect(carrierColor('Someone New')).toBe('#E5E7EB');
    expect(carrierColor('')).toBeNull();
    expect(carrierColor(null)).toBeNull();
  });
});
