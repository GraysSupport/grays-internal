// Removalist row colours on the delivery tabs (To Be Booked, Schedule, Completed Deliveries).
// One list for all three pages (it was copied into each). Matched as a lower-case substring of
// the removalist's name, first rule wins.
// G23 (owner, 30 Oct 2026): colours added for the removalists that had none — Singh - Van VIC,
// Dial A Mover, Jets and Michael (Installer) - Home Fitness Solutions.
export const CARRIER_COLOR_RULES = [
  { like: 'moving soon', color: '#F4B084' },
  { like: 'dtl', color: '#BDD7EE' },
  { like: 'coastal', color: '#FDCDFE' }, // Coastal Breeze
  { like: 'bnl', color: '#92D050' },
  { like: 'bass strait', color: '#FEFF43' },
  { like: 'rjd', color: '#FFFF00' },
  { like: 'iron armour', color: '#CCCCFF' },
  { like: 'chris watkins', color: '#6767ff' },
  { like: 'ej shaws', color: '#ff5555' },
  { like: 'a grade', color: '#e9ff63' },
  { like: 'slingshot', color: '#92d050' },
  { like: 'sa removals', color: '#66ccff' },
  { like: 'first transport', color: '#99ffcc' },
  { like: 'big post', color: '#99ffcc' },
  { like: 'allied', color: '#99ffcc' },
  { like: 'customer collect', color: '#9ec2e3' },
  { like: 'eastside', color: '#9efe9c' },
  { like: 'thompson', color: '#ff9999' },
  { like: 'brs', color: '#d0cece' },
  { like: 'singh', color: '#FFC000' },
  { like: 'dial a mover', color: '#B4A7D6' },
  { like: 'jets', color: '#76D7C4' },
  { like: 'home fitness solutions', color: '#E6B8AF' }, // Michael (Installer)
  { like: 'grays', color: '#bfd6ebff' },
];

// A removalist added later still gets a colour (neutral grey) until it is given its own here.
export const DEFAULT_CARRIER_COLOR = '#E5E7EB';

/** Background colour for a removalist's name; null only when there is no name. */
export function carrierColor(name) {
  const s = String(name || '').trim().toLowerCase();
  if (!s) return null;
  const rule = CARRIER_COLOR_RULES.find((r) => s.includes(r.like));
  return rule?.color || DEFAULT_CARRIER_COLOR;
}
