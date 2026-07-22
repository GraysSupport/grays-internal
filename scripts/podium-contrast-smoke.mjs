// scripts/podium-contrast-smoke.mjs — offline smoke for F30 (inbox text contrast).
//
// F30 was raised as "6 gray-on-color findings in src/pages/inbox.js" from a design-hook audit.
// Re-deriving it found the real shape is bigger and simpler than six scattered spots: the inbox
// uses `text-gray-400` as its de-emphasis token — timestamps, "Unassigned", panel headings,
// empty states, modal close buttons — and at #9ca3af that token FAILS WCAG AA against every
// surface it is used on. It is not a matter of taste, and this file exists so it is not argued
// about by eye: the ratios below are computed from the real palette values with the real WCAG
// formula, and the thresholds are the published ones.
//
// Why it matters here specifically: the row that raised it says reps read this page "on the
// warehouse floor" — high ambient light on a phone screen is the worst case for washed-out
// grey, and the affected text includes the timestamps and assignment state they scan for.
//
// The remedy is one token step, `text-gray-400` -> `text-gray-500` (#6b7280), which clears AA on
// both inbox surfaces while staying clearly de-emphasised against the gray-700/900 body text —
// so the visual hierarchy the grey was there to express is preserved. Anything genuinely
// decorative would need a documented exemption rather than a silent one.
//
// WHAT THIS DOES NOT CLAIM: it checks the de-emphasis token against the two surfaces the inbox
// actually paints (white panels, the gray-50 thread). It is not a full-page contrast audit — it
// cannot see an element's real background, only the pairs asserted here, and it covers inbox.js
// alone because that is F30's scope.
//
//   node scripts/podium-contrast-smoke.mjs

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const INBOX = join(ROOT, 'src', 'pages', 'inbox.js');

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ---------------------------------------------------------------------------
// WCAG 2.1 contrast (pure)
// ---------------------------------------------------------------------------

export function relativeLuminance(hex) {
  const h = hex.replace('#', '');
  const channels = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(fg, bg) {
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

// ---------------------------------------------------------------------------
// The source scanners (pure, so the fixtures below can falsify them)
// ---------------------------------------------------------------------------

/** Strip comments, so prose about a token is never mistaken for a use of it. */
export function stripAside(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Every use of a grey text token that fails AA on this page's surfaces. */
export function failingGreysIn(src) {
  const stripped = stripAside(src);
  const found = [];
  const re = /text-gray-(400|300)\b/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    found.push(`${m[0]} at line ${stripped.slice(0, m.index).split('\n').length}`);
  }
  return found;
}

/**
 * Grey text whose nearest preceding background class — i.e. the one in its own ternary branch —
 * is a COLOURED one. This is the property that makes the design hook's six "gray-on-color"
 * findings false positives, expressed as something checkable rather than a judgement call.
 */
export function greyOnColourIn(src) {
  const stripped = stripAside(src);
  const offenders = [];
  const re = /text-gray-\d00\b/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    const before = stripped.slice(0, m.index);
    const bgs = before.match(/bg-[a-z]+(-\d00)?(\/\d+)?/g);
    if (!bgs) continue;
    const nearest = bgs[bgs.length - 1];
    // Only a background in the same className string can be the grey's own background.
    if (/\n/.test(before.slice(before.lastIndexOf(nearest)))) continue;
    if (!/^bg-(white|gray|slate|neutral)/.test(nearest)) {
      offenders.push(`line ${before.split('\n').length}: ${nearest} + ${m[0]}`);
    }
  }
  return offenders;
}

// Tailwind's default palette, for the tokens this page uses.
const PALETTE = {
  white: '#ffffff',
  'gray-50': '#f9fafb',
  'gray-300': '#d1d5db',
  'gray-400': '#9ca3af',
  'gray-500': '#6b7280',
  'gray-700': '#374151',
  'gray-900': '#111827',
  'blue-50': '#eff6ff',
  'blue-100': '#dbeafe',
  'blue-600': '#2563eb',
};

const AA_NORMAL = 4.5; // WCAG 2.1 1.4.3, normal-size text
const round = (n) => Math.round(n * 100) / 100;

// The two surfaces the inbox paints de-emphasised text onto.
const SURFACES = ['white', 'gray-50'];

console.log('F30 inbox contrast smoke — pure, no DOM, no network\n');

console.log('the contrast formula itself (known values):');
{
  check('black on white is 21:1', round(contrastRatio('#000000', '#ffffff')) === 21);
  check('white on white is 1:1', round(contrastRatio('#ffffff', '#ffffff')) === 1);
  check('it is symmetric', round(contrastRatio('#9ca3af', '#ffffff')) === round(contrastRatio('#ffffff', '#9ca3af')));
  // A published reference point: #767676 is the canonical "smallest grey that passes AA on white".
  check('#767676 on white clears AA (the canonical boundary grey)', contrastRatio('#767676', '#ffffff') >= AA_NORMAL);
  // The sRGB curve has a LINEAR segment below 0.03928 that none of the palette colours reach,
  // so breaking it was invisible to every other check here (a surviving mutant). #050505 sits
  // inside that segment: 5/255 = 0.0196 -> /12.92 = 0.001517, and the channel weights sum to 1.
  check(
    'the linear segment of the sRGB curve is implemented, not just the power one',
    Math.abs(relativeLuminance('#050505') - (5 / 255 / 12.92)) < 1e-9,
  );
  check('#777777 … and one step lighter does not', contrastRatio('#797979', '#ffffff') < AA_NORMAL);
}

console.log('\nwhy the old token had to change — measured, not asserted:');
{
  for (const surface of SURFACES) {
    const ratio = contrastRatio(PALETTE['gray-400'], PALETTE[surface]);
    check(
      `text-gray-400 on ${surface} FAILS AA (${round(ratio)}:1 < ${AA_NORMAL})`,
      ratio < AA_NORMAL,
      'if this ever passes, the palette moved and this whole file needs re-deriving',
    );
  }
  check('text-gray-300 would be worse still', contrastRatio(PALETTE['gray-300'], PALETTE.white) < contrastRatio(PALETTE['gray-400'], PALETTE.white));
}

console.log('\nthe replacement token clears AA on every surface the inbox paints:');
{
  for (const surface of SURFACES) {
    const ratio = contrastRatio(PALETTE['gray-500'], PALETTE[surface]);
    check(`text-gray-500 on ${surface} passes AA (${round(ratio)}:1)`, ratio >= AA_NORMAL);
  }
  check(
    'and it is still clearly de-emphasised against body text',
    contrastRatio(PALETTE['gray-500'], PALETTE.white) < contrastRatio(PALETTE['gray-700'], PALETTE.white),
    'the grey exists to express hierarchy — a fix that flattens it is not a fix',
  );
}

console.log('\nthe outbound bubble — the one the old audit called a false positive, and it was not:');
{
  // The timestamp inside a sent message is `outbound ? text-blue-100 : text-gray-400`. The two
  // branches are mutually exclusive, so the GREY never lands on the blue — that part of the old
  // "gray-on-color" reading really was a false positive. But measuring the branch that does
  // render showed the pairing fails anyway, on its own terms and for a different reason.
  const before = contrastRatio(PALETTE['blue-100'], PALETTE['blue-600']);
  check(
    `text-blue-100 on bg-blue-600 FAILS AA too (${round(before)}:1)`,
    before < AA_NORMAL,
    'assumed to be fine when this file was written; the formula disagreed',
  );

  const after = contrastRatio(PALETTE['blue-50'], PALETTE['blue-600']);
  check(`text-blue-50 on bg-blue-600 passes (${round(after)}:1)`, after >= AA_NORMAL);
  check(
    'and stays de-emphasised against the bubble’s own white body text',
    after < contrastRatio(PALETTE.white, PALETTE['blue-600']),
  );

  check('no sub-AA blue text token remains in inbox.js', !/text-blue-100\b/.test(readFileSync(INBOX, 'utf8')));
}

console.log('\nthe scanners find what they are supposed to find (fixtures):');
{
  // Mutation testing showed why these fixtures exist: with the repo already fixed, every scan
  // below runs over clean input, so deleting its RECORDER left the whole file green. A scanner
  // is only falsifiable against input that contains the thing it looks for.
  check('the failing-token scan reports a gray-400', failingGreysIn('<div className="text-gray-400" />').length === 1);
  check('… and a gray-300', failingGreysIn('<div className="text-gray-300" />').length === 1);
  check('… reports each occurrence', failingGreysIn('text-gray-400 text-gray-400 text-gray-300').length === 3);
  check('… and is silent on the replacement token', failingGreysIn('<div className="text-gray-500" />').length === 0);
  check('… and ignores a mention inside a comment', failingGreysIn('// was text-gray-400 before\n').length === 0);
  check('the hover form is caught too', failingGreysIn('hover:text-gray-400').length === 1);

  check('the grey-on-colour scan reports a real pairing', greyOnColourIn("className={'bg-blue-500 text-gray-700'}").length === 1);
  check('… and accepts the ternary shape that made F30 a false alarm',
    greyOnColourIn("className={on ? 'bg-blue-500 text-white' : 'bg-white text-gray-700'}").length === 0);
  check('… and accepts a light-grey background', greyOnColourIn("className={'bg-gray-100 text-gray-700'}").length === 0);
}

console.log('\nthe inbox no longer ships the failing token:');
{
  const src = readFileSync(INBOX, 'utf8');
  const failing = failingGreysIn(src);
  check('no sub-AA grey text token remains in inbox.js', failing.length === 0, `\n    ${failing.join('\n    ')}`);

  // Guard the guard: if the de-emphasis styling vanished altogether the check above would also
  // pass, and the page would have lost its hierarchy instead of gaining contrast. This is a
  // smoke alarm for wholesale deletion, not a precise contract — the floor is deliberately well
  // below the 51 sites present when it was written.
  const replacements = (stripAside(src).match(/text-gray-500\b/g) || []).length;
  check(`the de-emphasis token is still in use (${replacements} occurrences)`, replacements >= 40, 'did the greys get deleted rather than darkened?');
}

console.log('\nthe two places where the hierarchy had to be restored downward, not upward:');
{
  const src = readFileSync(INBOX, 'utf8');
  // Raising the failing grey one step would have collided with text that renders BESIDE it.
  // These two are the only such pairs in the file, and both are pinned so a later bulk
  // find-and-replace cannot quietly flatten them again.
  check(
    'the conversation list still distinguishes Unassigned from Assigned',
    /'Unassigned', cls: 'text-gray-500'/.test(src) && /'Assigned', cls: 'text-gray-700'/.test(src),
    'these labels sit side by side down the list — identical greys remove the scanning cue',
  );
  check(
    'funnel history still distinguishes the note from its timestamp',
    /text-\[11px\] text-gray-700 break-words/.test(src),
    'note and timestamp render on the same row',
  );
}

console.log('\nthe design hook’s "gray-on-color" findings are ternaries — checked, not assumed:');
{
  // F30 was raised from a design-hook audit reporting 6 gray-on-color findings. Every one is a
  // MUTUALLY-EXCLUSIVE ternary — `cond ? 'bg-blue-500 text-white' : 'bg-white text-gray-700'` —
  // so the grey never lands on the colour; the hook matches both branches of one string. The
  // same finding was logged and dismissed during F4, so rather than dismiss it a third time by
  // eye, this asserts the property that makes it a false positive.
  const offenders = greyOnColourIn(readFileSync(INBOX, 'utf8'));
  check('no grey text sits on a coloured background', offenders.length === 0, `\n    ${offenders.join('\n    ')}`);
}

console.log(`\n✅ contrast smoke: ${passed} checks passed`);
