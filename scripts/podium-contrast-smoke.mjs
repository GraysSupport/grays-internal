// scripts/podium-contrast-smoke.mjs — offline smoke for F30 (inbox text contrast).
//
// F30 was raised as "6 gray-on-color findings in src/pages/inbox.js" from a design-hook audit.
// Re-deriving it changed the finding twice over, and both corrections are the reason this file
// computes ratios instead of describing them:
//
//   - ALL SIX HOOK FINDINGS ARE FALSE POSITIVES. Every one is a mutually-exclusive ternary
//     (`cond ? 'bg-blue-500 text-white' : 'bg-white text-gray-700'`), so the grey never lands on
//     the colour — the hook matches both branches of one className string. The same six were
//     logged and dismissed during F4, so this file asserts the property that MAKES them false
//     positives rather than dismissing them by eye a third time.
//   - THE REAL DEFECTS WERE ADJACENT, LARGER, AND UNFLAGGED. `text-gray-400` was the page's
//     de-emphasis token across 34 sites at 2.54:1 on white — and, found only by measuring after
//     a code review corrected the surface, the outbound bubble's own white message text sat at
//     3.68:1 on `bg-blue-500`. That is the actual conversation, failing worse than any grey.
//
// Everything here is computed from the real Tailwind values with the real WCAG 2.1 formula, so
// a palette change breaks the file loudly instead of silently invalidating its claims. Thresholds
// are the published ones. Every affected site is text-[10px]/[11px]/xs/sm — none reaches the
// large-text carve-out — so AA 4.5:1 applies throughout.
//
// Why it matters here: the row that raised it says reps read this page "on the warehouse floor".
// High ambient light on a phone is the worst case for washed-out text.
//
// WHAT THIS DOES NOT CLAIM: it reasons over palette values and source tokens. jsdom has no
// layout or paint, so nothing here observes a rendered pixel. It models the four surfaces the
// inbox actually paints; an element placed on some fifth surface is outside what it can see.
//
//   node scripts/podium-contrast-smoke.mjs

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const INBOX = join(SRC, 'pages', 'inbox.js');

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

// Tailwind 3.4 defaults (tailwind.config.js extends nothing), for every token this page pairs.
export const PALETTE = {
  white: '#ffffff',
  'gray-50': '#f9fafb',
  'gray-100': '#f3f4f6',
  'gray-200': '#e5e7eb',
  'gray-300': '#d1d5db',
  'gray-400': '#9ca3af',
  'gray-500': '#6b7280',
  'gray-600': '#4b5563',
  'gray-700': '#374151',
  'gray-800': '#1f2937',
  'gray-900': '#111827',
  'blue-50': '#eff6ff',
  'blue-100': '#dbeafe',
  'blue-500': '#3b82f6',
  'blue-600': '#2563eb',
  'blue-700': '#1d4ed8',
  'blue-400': '#60a5fa',
  'blue-800': '#1e40af',
  'amber-50': '#fffbeb',
  'amber-100': '#fef3c7',
  'amber-500': '#f59e0b',
  'amber-600': '#d97706',
  'amber-700': '#b45309',
  'amber-800': '#92400e',
  'amber-900': '#78350f',
  'green-100': '#dcfce7',
  'green-700': '#15803d',
  'green-800': '#166534',
  'emerald-100': '#d1fae5',
  'emerald-800': '#065f46',
  'red-100': '#fee2e2',
  'red-600': '#dc2626',
  'red-700': '#b91c1c',
  'pink-100': '#fce7f3',
  'pink-800': '#9d174d',
  'purple-100': '#f3e8ff',
  'purple-800': '#6b21a8',
  'yellow-100': '#fef9c3',
  'yellow-800': '#854d0e',
  // F33 widened this file from inbox.js to the whole portal. The other pages paint with 23
  // tokens the inbox never used, and an ABSENT token is not a safe default: failingPairs SKIPS
  // any token it cannot resolve, so a pairing built from one is invisible to the scan rather
  // than passing it. F30 proved the point — a mutant swapping the attachment chip to
  // bg-blue-400 sailed through purely because blue-400 was missing here. Adding these turned up
  // four real failures no earlier scan could see, the worst being white on bg-yellow-500 at
  // 1.92:1. Tailwind 3.4 defaults.
  'amber-400': '#fbbf24',
  'emerald-700': '#047857',
  'green-400': '#4ade80',
  'green-500': '#22c55e',
  'green-600': '#16a34a',
  'indigo-100': '#e0e7ff',
  'indigo-500': '#6366f1',
  'indigo-600': '#4f46e5',
  'indigo-700': '#4338ca',
  'indigo-800': '#3730a3',
  'orange-100': '#ffedd5',
  'orange-500': '#f97316',
  'orange-700': '#c2410c',
  'purple-700': '#7e22ce',
  'red-500': '#ef4444',
  'red-800': '#991b1b',
  'red-900': '#7f1d1d',
  'sky-400': '#38bdf8',
  'sky-700': '#0369a1',
  'yellow-400': '#facc15',
  'yellow-500': '#eab308',
  'yellow-700': '#a16207',
};

const AA_NORMAL = 4.5; // WCAG 2.1 SC 1.4.3, normal-size text
const round = (n) => Math.round(n * 100) / 100;
const ratioOf = (fg, bg) => contrastRatio(PALETTE[fg], PALETTE[bg]);

// The four surfaces the inbox actually paints text onto. The first version of this file listed
// only the first two, and code review found two changed sites sitting below AA on the others —
// so the list being COMPLETE is load-bearing, not decorative.
const SURFACES = ['white', 'gray-50', 'gray-100', 'blue-50'];

// ---------------------------------------------------------------------------
// The source scanner (pure, so the fixtures below can falsify it)
// ---------------------------------------------------------------------------

/**
 * Strip comments, preserving line count so reported line numbers stay true.
 *
 * The leading class on the line-comment pattern is `[^\S\n]` (horizontal whitespace), NOT `\s`.
 * `\s` matches newlines, so the old pattern greedily ate every blank line PRECEDING a comment
 * and collapsed them — silently shifting every line number this file reports. A fixture pins it.
 */
export function stripAside(src) {
  const blank = (m) => '\n'.repeat((m.match(/\n/g) || []).length);
  return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/^[^\S\n]*\/\/.*$/gm, '');
}

/**
 * Every string literal in the source, with the offset it started at.
 *
 * This is the unit that matters: in JSX, each branch of a ternary is its own literal, so tokens
 * that share a literal are tokens that actually render together. Code review showed why the
 * previous "nearest preceding bg- class" approach could not work — it was order-dependent
 * (`text-gray-400 bg-blue-500` scored differently from the reverse) and blind to the multi-line
 * template classNames that dominate this file, which is how it missed the outbound bubble.
 */
export function styleChunks(src) {
  const chunks = [];
  const re = /'([^'\n]*)'|"([^"\n]*)"|`([\s\S]*?)`/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m[3] === undefined) {
      chunks.push({ text: m[1] ?? m[2], index: m.index });
      continue;
    }
    // A template literal is TWO kinds of thing: its own static class text, and one or more
    // ${…} expressions that usually hold the ternary branches. An earlier version blanked the
    // expressions — which silently discarded the branches, the single most common place a
    // pairing hides in this file. Mutation testing caught it: reverting the attachment chip to
    // a light blue went unnoticed because its classes live inside a ${…}. Recurse instead.
    const tpl = m[3];
    const base = m.index + 1;
    let statics = tpl;
    for (const expr of tpl.matchAll(/\$\{([\s\S]*?)\}/g)) {
      for (const inner of styleChunks(expr[1])) {
        chunks.push({ text: inner.text, index: base + expr.index + 2 + inner.index });
      }
      statics = statics.split(expr[0]).join(' '.repeat(expr[0].length));
    }
    chunks.push({ text: statics, index: base });
  }
  return chunks;
}

/**
 * Text/background pairs that share a literal and fail AA.
 * Resolving both tokens through the palette — rather than allowlisting "light-looking" colour
 * names — is what lets this see any hue, and stops it flagging pairings that actually pass
 * (`bg-amber-50 text-gray-500` is 4.66:1 and is not a defect).
 */
export function failingPairs(src, { allow = [] } = {}) {
  const stripped = stripAside(src);
  const offenders = [];
  for (const chunk of styleChunks(stripped)) {
    const bg = (chunk.text.match(/\bbg-([a-z]+-\d00|white)\b/) || [])[1];
    if (!bg || !PALETTE[bg]) continue;
    for (const m of chunk.text.matchAll(/\btext-([a-z]+-\d00|white)\b/g)) {
      const fg = m[1];
      if (!PALETTE[fg]) continue;
      const ratio = contrastRatio(PALETTE[fg], PALETTE[bg]);
      if (ratio >= AA_NORMAL) continue;
      const pair = `text-${fg} on bg-${bg}`;
      if (allow.includes(pair)) continue;
      offenders.push(`line ${stripped.slice(0, chunk.index).split('\n').length}: ${pair} (${round(ratio)}:1)`);
    }
  }
  return offenders;
}

/** Uses of a grey text token that fails AA on every surface this page paints. */
export function failingGreysIn(src) {
  const stripped = stripAside(src);
  const found = [];
  for (const m of stripped.matchAll(/\btext-(?:gray|slate|zinc|neutral)-(\d00)\b/g)) {
    const token = m[0].replace('text-', '');
    const hex = PALETTE[token];
    // Unknown token, or one that clears AA somewhere it could legitimately sit: not a finding.
    if (hex && SURFACES.some((s) => contrastRatio(hex, PALETTE[s]) >= AA_NORMAL)) continue;
    found.push(`${m[0]} at line ${stripped.slice(0, m.index).split('\n').length}`);
  }
  return found;
}

/**
 * Pairs left failing ON PURPOSE would go here, each with the row that will fix it — listed
 * rather than silently skipped, so an exemption cannot grow without an edit to this line.
 *
 * It is deliberately EMPTY. The palette-resolving scanner found two more real failures that the
 * earlier name-matching one structurally could not see — every primary button (`bg-blue-500` +
 * white = 3.68:1) and the internal-note controls (`bg-amber-500` + white = **2.15:1**, the worst
 * pairing on the page) — and an exemption list holding the page's own buttons would have made
 * the guard's headline claim meaningless. They were darkened instead: blue-600 (5.17) and
 * amber-700 (5.02), hovers one step further.
 */
const KNOWN_FAILING = [];

/**
 * Every rendering source file in the portal. Tests are excluded because they deliberately carry
 * fixture classNames (a suite asserting a failing pairing is caught would otherwise fail the
 * scan that catches it).
 */
export function portalSourceFiles(root = SRC) {
  const out = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir).sort()) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        if (entry !== '__tests__') walk(p);
      } else if (entry.endsWith('.js')) {
        out.push(p);
      }
    }
  })(root);
  return out;
}

const rel = (p) => relative(ROOT, p).split(sep).join('/');

/**
 * F33: the CTA surfaces, deferred to Nick with a measurement instead of a question.
 *
 * These are REAL failures — `bg-blue-500` + white is 3.68:1 and `bg-amber-500` + white is
 * 2.15:1, the same two F30 darkened inside the inbox. They are exempted rather than fixed
 * because the remedy is a one-step darkening of EVERY primary button in the portal (18 surfaces
 * across 13 files), which changes how every page looks and is the one part of the F33 row that
 * genuinely asks for a human's eye. Deferring it HERE rather than in prose is the point: the
 * guard still covers those pages, the exemption is countable, and acting on the decision is a
 * two-line deletion plus the swap — not a re-investigation.
 *
 * Deliberately NOT in this list, though they are also coloured surfaces: the one-off
 * `bg-yellow-500` toggle (1.92:1 — the worst pairing in the portal), the three `bg-green-500/600`
 * buttons and the green flash banner. Those are isolated sites, not the portal-wide primary-button
 * identity, and exempting the WORST pairing while fixing 4.39:1 greys would make this guard's
 * headline claim dishonest. They were fixed in this increment.
 *
 * `text-blue-500 on bg-white` is likewise absent: it is link text, not a button surface, so
 * fixing it changes no button.
 */
const CTA_DEFERRED = ['text-white on bg-blue-500', 'text-white on bg-amber-500'];

/** Sites the exemption above covers, pinned so it cannot quietly grow to new pages. */
const CTA_DEFERRED_SITES = { 'bg-blue-500': 16, 'bg-amber-500': 2 };

function main() {
  console.log('F30 inbox contrast smoke — pure, no DOM, no network\n');

  console.log('the contrast formula itself (known values):');
  {
    check('black on white is 21:1', round(contrastRatio('#000000', '#ffffff')) === 21);
    check('white on white is 1:1', round(contrastRatio('#ffffff', '#ffffff')) === 1);
    check('it is symmetric', round(contrastRatio('#9ca3af', '#ffffff')) === round(contrastRatio('#ffffff', '#9ca3af')));
    check('#767676 on white clears AA (the canonical boundary grey)', contrastRatio('#767676', '#ffffff') >= AA_NORMAL);
    check('#797979 — one step lighter — does not', contrastRatio('#797979', '#ffffff') < AA_NORMAL);
    // The sRGB curve has a LINEAR segment below 0.03928 that no palette colour reaches, so
    // breaking it was invisible to every other check here (a surviving mutant). #050505 is
    // inside it: 5/255 = 0.0196 -> /12.92, and the channel weights sum to 1.
    check(
      'the linear segment of the sRGB curve is implemented, not just the power one',
      Math.abs(relativeLuminance('#050505') - (5 / 255 / 12.92)) < 1e-9,
    );
  }

  console.log('\nwhy the old tokens had to change — measured, not asserted:');
  {
    for (const surface of ['white', 'gray-50']) {
      check(`text-gray-400 on ${surface} FAILS AA (${round(ratioOf('gray-400', surface))}:1)`, ratioOf('gray-400', surface) < AA_NORMAL);
    }
    // Found only after code review corrected the surface: the bubble is bg-blue-500, not -600.
    check(`the old bubble put its own white message text at ${round(ratioOf('white', 'blue-500'))}:1`, ratioOf('white', 'blue-500') < AA_NORMAL);
    check(`text-blue-100 on the old bubble was ${round(ratioOf('blue-100', 'blue-500'))}:1`, ratioOf('blue-100', 'blue-500') < AA_NORMAL);
  }

  console.log('\nthe replacement tokens clear AA on the surfaces they are used on:');
  {
    for (const surface of ['white', 'gray-50']) {
      check(`text-gray-500 on ${surface} passes (${round(ratioOf('gray-500', surface))}:1)`, ratioOf('gray-500', surface) >= AA_NORMAL);
    }
    // gray-500 does NOT clear the other two surfaces — which is exactly why the sites sitting on
    // them use gray-600. Asserting the failure keeps that decision from looking arbitrary.
    for (const surface of ['gray-100', 'blue-50']) {
      check(`text-gray-500 would FAIL on ${surface} (${round(ratioOf('gray-500', surface))}:1) — hence gray-600 there`, ratioOf('gray-500', surface) < AA_NORMAL);
      check(`text-gray-600 on ${surface} passes (${round(ratioOf('gray-600', surface))}:1)`, ratioOf('gray-600', surface) >= AA_NORMAL);
    }
    check('the darkened bubble carries its white text at 5.17:1', ratioOf('white', 'blue-600') >= AA_NORMAL);
    check(`text-blue-50 on the darkened bubble passes (${round(ratioOf('blue-50', 'blue-600'))}:1)`, ratioOf('blue-50', 'blue-600') >= AA_NORMAL);
    check('… and stays de-emphasised against the bubble’s own body text', ratioOf('blue-50', 'blue-600') < ratioOf('white', 'blue-600'));
    check(`the attachment chip’s white label passes on bg-blue-700 (${round(ratioOf('white', 'blue-700'))}:1)`, ratioOf('white', 'blue-700') >= AA_NORMAL);
    check('de-emphasis is still de-emphasis, not body text', ratioOf('gray-500', 'white') < ratioOf('gray-700', 'white'));
  }

  console.log('\nthe conversation row reads on BOTH of its surfaces (white, and blue-50 when selected):');
  {
    // The first fix made "Unassigned" the faintest text on the row — the one state a rep hunts
    // for — and collided it with the timestamp. Colour now carries the meaning instead of weight.
    for (const surface of ['white', 'blue-50']) {
      check(`Unassigned (amber-700) passes on ${surface} (${round(ratioOf('amber-700', surface))}:1)`, ratioOf('amber-700', surface) >= AA_NORMAL);
      check(`You (green-700) passes on ${surface} (${round(ratioOf('green-700', surface))}:1)`, ratioOf('green-700', surface) >= AA_NORMAL);
      check(`Assigned (gray-600) passes on ${surface} (${round(ratioOf('gray-600', surface))}:1)`, ratioOf('gray-600', surface) >= AA_NORMAL);
    }
    check('Unassigned is not the same colour as the timestamp beside it', PALETTE['amber-700'] !== PALETTE['gray-600']);
  }

  console.log('\nthe scanners find what they are supposed to find (fixtures):');
  {
    // Mutation testing showed why these exist: with the repo already fixed every scan runs over
    // clean input, so deleting a RECORDER left the whole file green.
    check('the pair scanner reports a real failing pairing', failingPairs("className={'bg-blue-500 text-white'}").length === 1);
    check('… regardless of token order', failingPairs("className={'text-white bg-blue-500'}").length === 1);
    check('… across a multi-line className', failingPairs('className={`bg-blue-500 rounded\n  text-white px-2`}').length === 1);
    check('… inside a ${…} branch of a template literal — where this file hides most of them',
      failingPairs("className={`rounded ${on ? 'bg-blue-500 text-white' : 'bg-white text-gray-700'}`}").length === 1,
      'blanking these instead of recursing is how the attachment-chip regression stayed green');
    check('… and the template’s own static classes are still read',
      failingPairs("className={`bg-blue-500 text-white ${extra}`}").length === 1);
    check('… and accepts the ternary shape that made F30 a false alarm',
      failingPairs("className={on ? 'bg-blue-600 text-white' : 'bg-white text-gray-700'}").length === 0,
      'the grey lives in the other branch from the colour and never renders on it');
    check('… while still judging each branch on its own merits',
      failingPairs("className={on ? 'bg-blue-600 text-white' : 'bg-white text-gray-400'}").length === 1,
      'a failing branch must not be excused by a passing sibling');
    check('… does not flag a pairing that actually passes (bg-amber-50 + gray-500 = 4.66:1)',
      failingPairs("className={'bg-amber-50 text-gray-500'}").length === 0);
    // The allowlist mechanism is kept (and tested) even though nothing uses it today, so a
    // future deliberate exemption is a one-line, reviewable edit rather than a new mechanism.
    check('… and honours an allowlist when one is given',
      failingPairs("className={'bg-blue-500 text-white'}", { allow: ['text-white on bg-blue-500'] }).length === 0);

    check('the failing-grey scan reports a gray-400', failingGreysIn('<div className="text-gray-400" />').length === 1);
    check('… and its slate/zinc/neutral cousins', failingGreysIn('text-slate-400 text-zinc-400 text-neutral-400').length === 3);
    check('… and is silent on the replacement token', failingGreysIn('<div className="text-gray-500" />').length === 0);
    check('… ignores a mention inside a line comment', failingGreysIn('// was text-gray-400 before\n').length === 0);
    check('… and inside a block comment', failingGreysIn('/* was text-gray-400 */').length === 0);
    check('the hover form is caught too', failingGreysIn('hover:text-gray-400').length === 1);
    check(
      'stripping comments does not shift reported line numbers',
      failingGreysIn('/* a\nb\nc */\ntext-gray-400')[0].endsWith('line 4'),
      'a diagnostic that points at the wrong line sends someone hunting',
    );
    // The check above only ever exercised BLOCK comments, and that gap hid a real defect for the
    // whole of F30: the line-comment pattern led with `\s*`, and `\s` MATCHES NEWLINES, so it ate
    // the blank lines PRECEDING a comment and collapsed them. Every line number this file
    // reported was wrong wherever that shape occurred — by 17 lines in the inbox. It stayed
    // invisible while the scan covered one familiar file; widening it to 10 unfamiliar pages is
    // what makes a wrong line number expensive.
    check(
      '… including when blank lines precede a line comment',
      failingGreysIn('const a=1;\n\n\n// note\ntext-gray-400')[0].endsWith('line 5'),
      'blank lines before a // comment must not be swallowed with it',
    );
  }

  console.log('\nthe inbox itself:');
  {
    const src = readFileSync(INBOX, 'utf8');

    const greys = failingGreysIn(src);
    check('no sub-AA grey text token remains', greys.length === 0, `\n    ${greys.join('\n    ')}`);
    check('no sub-AA blue text token remains', !/text-blue-100\b/.test(stripAside(src)));

    const pairs = failingPairs(src, { allow: KNOWN_FAILING });
    check('NO text/background pairing in the inbox fails AA', pairs.length === 0, `\n    ${pairs.join('\n    ')}`);
    check('… and that claim is unconditional — nothing is exempted', KNOWN_FAILING.length === 0);
    check('the old CTA surfaces are gone', !/\bbg-(blue|amber)-500\b/.test(stripAside(src)));

    // An unknown token is skipped by failingPairs, so a pairing built from one is invisible to
    // it — mutation testing proved the point by swapping the attachment chip to bg-blue-400,
    // which was absent from PALETTE and therefore sailed through. The palette must cover
    // everything the page uses, or the scan quietly checks less than it appears to.
    const unknown = [...new Set(
      [...stripAside(src).matchAll(/\b(?:bg|text)-((?:[a-z]+-\d00)|white)\b/g)].map((m) => m[1]),
    )].filter((t) => !PALETTE[t]);
    check('every colour token the inbox uses is in the palette', unknown.length === 0, `unresolved: ${unknown.join(', ')}`);

    check('SURFACES still lists all four painted surfaces', SURFACES.length === 4
      && ['white', 'gray-50', 'gray-100', 'blue-50'].every((s) => SURFACES.includes(s)),
      'shrinking this list silently narrows every check that iterates it');

    // The two sites that sit on the DARKER surfaces. failingPairs cannot reach them — their
    // className carries no background, because the surface comes from an ancestor — so they are
    // pinned by source. Both were found by code review sitting at 4.39 / 4.44 after the first
    // pass "fixed" them, and mutation testing showed nothing else catches a regression here.
    check('the footer paragraph on the gray-100 shell uses gray-600',
      /<p className="text-xs text-gray-600 mt-3">/.test(src));
    check('the conversation-row timestamp uses gray-600 (a selected row is bg-blue-50)',
      /text-xs text-gray-600">\{formatTime\(c\?\.lastMessageAt\)\}/.test(src));

    // Guard the guard: had the de-emphasis styling been deleted rather than darkened, every
    // check above would also pass. Code review pointed out the earlier floor was unfalsifiable,
    // and that the real property is a conservation law rather than a threshold — the tokens are
    // accounted for exactly, so any change to the count has to be a deliberate edit here.
    const stripped = stripAside(src);
    const g500 = (stripped.match(/text-gray-500\b/g) || []).length;
    const g600 = (stripped.match(/text-gray-600\b/g) || []).length;
    check(
      `the de-emphasis tokens are all accounted for (${g500} × gray-500 + ${g600} × gray-600 = ${g500 + g600})`,
      g500 + g600 === 60,
      'main had 34 gray-400 + 20 gray-500 + 8 gray-600 = 62 de-emphasised sites. Two were ' +
        'deliberately PROMOTED out of the de-emphasis band and are pinned by their own checks ' +
        'above — the funnel note to gray-700, and Unassigned to amber-700 — leaving 60. An exact ' +
        'count rather than a floor, because a floor is unfalsifiable: code review showed >= 40 ' +
        'survived being mutated to >= 0. Any change here should be a deliberate edit with a diff.',
    );
  }

  console.log('\nthe rest of the portal (F33 — same guard, every page):');
  {
    const files = portalSourceFiles();
    // The walk being real is load-bearing: every check below iterates it, so a walk that
    // silently returned [] would report a clean portal. F19's viewport audit made exactly this
    // mistake one level down (a metric that was identically 0), so it is asserted, not assumed.
    check(`the walk found the portal (${files.length} source files)`, files.length >= 30);
    check('… and it excludes the test fixtures', !files.some((f) => f.includes(`${sep}__tests__${sep}`)));
    check('… and it includes both pages and components',
      files.some((f) => f.includes(join('src', 'pages'))) && files.some((f) => f.includes(join('src', 'components'))));

    const sources = files.map((f) => [rel(f), stripAside(readFileSync(f, 'utf8'))]);

    const greys = sources.flatMap(([name, src]) => failingGreysIn(src).map((g) => `${name}: ${g}`));
    check('NO sub-AA grey text token remains anywhere in the portal', greys.length === 0,
      `\n    ${greys.join('\n    ')}`);

    const pairs = sources.flatMap(([name, src]) =>
      failingPairs(src, { allow: CTA_DEFERRED }).map((p) => `${name}: ${p}`));
    check('NO text/background pairing outside the deferred CTA set fails AA', pairs.length === 0,
      `\n    ${pairs.join('\n    ')}`);

    // The exemption is only honest if what it covers stays fixed. Counting the SURFACES (not the
    // failures) means a new blue-500 button on a new page breaks this line instead of being
    // quietly absorbed by the allowlist.
    for (const [token, expected] of Object.entries(CTA_DEFERRED_SITES)) {
      const actual = sources.reduce(
        (n, [, src]) => n + (src.match(new RegExp(`\\b${token}\\b`, 'g')) || []).length, 0);
      check(`the deferred CTA set is still exactly ${expected} × ${token}`, actual === expected,
        `found ${actual} — either a new one was added, or the decision landed and this line should go`);
    }
    check('nothing else is exempted', CTA_DEFERRED.length === 2);

    const unknown = [...new Set(sources.flatMap(([, src]) =>
      [...src.matchAll(/\b(?:bg|text)-((?:[a-z]+-\d00)|white)\b/g)].map((m) => m[1]),
    ))].filter((t) => !PALETTE[t]);
    check('every colour token the portal uses is in the palette', unknown.length === 0,
      `unresolved: ${unknown.join(', ')} — failingPairs SKIPS these, so they are invisible, not passing`);
  }

  console.log(`\n✅ contrast smoke: ${passed} checks passed`);
}

// Only run the suite when executed directly, so the pure helpers above can be imported.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
