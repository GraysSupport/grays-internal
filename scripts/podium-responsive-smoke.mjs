// scripts/podium-responsive-smoke.mjs — offline smoke for F19 increments 2b and 2d.
//
// 2b (below): no page scrolls sideways because of a table.
// 2d (section 3): nothing the page renders sits UNDER the fixed Home/Back overlay on a phone.
//
// F19's acceptance line is "every page usable at ~375 px". Increment 2a gave the portal navigation
// on a phone; this increment fixes the defect that makes the pages you navigate TO unusable once
// you get there: a wide <table> with nothing to scroll it.
//
// A table is the one element that cannot be squeezed. Give it seven columns of names, emails and
// SKUs and its min-content width lands well past 375 px, so unless an ancestor scrolls
// horizontally the *document body* does — every heading, button and filter on the page slides off
// with it, and on a table with a hard `min-w-[900px]` there is no width at which the page is
// readable at all. Ten of the portal's table pages already wrap the table in an
// `overflow-x-auto` div; this smoke is the contract that says ALL of them must.
//
// WHY A SOURCE SCAN AND NOT A RENDER TEST: jsdom has no layout engine (the F26 build learned this
// the hard way — `offsetParent` is always null there), so no jsdom test can measure that anything
// overflowed. Whether the wrapper is PRESENT is a structural fact, and structural facts are what
// a source scan checks honestly. The paired RTL test in src/pages/__tests__/tableScroll.test.js
// asserts the wrapper really is the table's parent in the rendered DOM.
//
// It is also deliberately a repo-wide scan rather than a list of known-bad files: the point is
// that the NEXT table anyone adds is checked too, on a codebase where a plain grep for
// "overflow-x" in a file gave two false negatives (peloton's tab bar has one and its table does
// not; collections/[id] has one on its second table and not its first).
//
// WHAT THIS DOES NOT CLAIM — read before treating a green run as "375px is done":
//   - It proves a table's PARENT is a scroller. It does not prove no page scrolls sideways: a
//     wide non-table element, or a `min-w-` on an ancestor of the scroller, would still break
//     F19's acceptance line and pass every check here.
//   - It scans `src/pages/**/*.js` only. There is no <table> in `src/components` today (checked),
//     and widening it would report any legitimate wrapper COMPONENT (`<Scroller><table/></Scroller>`)
//     as a violation. If a component ever renders a table, widen this deliberately.
//   - It reads source, so a class computed at runtime is invisible to it —
//     `className={compact ? 'overflow-x-auto' : 'overflow-hidden'}` passes.
//   - The print-document skip is backtick PARITY over the whole file, which would also be tripped
//     by a stray backtick in a comment, and misses a print document built with single quotes.
//     Both are absent from this repo today.
//
//   node scripts/podium-responsive-smoke.mjs

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PAGES_DIR = join(ROOT, 'src', 'pages');

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ---------------------------------------------------------------------------
// The analyser (pure — the fixtures below are its own tests)
// ---------------------------------------------------------------------------

// Every JSX tag in `text`, in order. `text[j-1] !== '='` keeps an arrow function inside a prop
// (`onClick={() => …}`) from being mistaken for the end of the tag.
function tagsIn(text) {
  const out = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '<' && /[A-Za-z/]/.test(text[i + 1] || '')) {
      let j = i + 1;
      while (j < text.length && !(text[j] === '>' && text[j - 1] !== '=')) j += 1;
      const raw = text.slice(i, j + 1);
      out.push({ raw, closing: raw[1] === '/', selfClosing: /\/>$/.test(raw) });
      i = j;
    }
  }
  return out;
}

// The element that actually ENCLOSES whatever follows `text` — i.e. the table's real parent.
//
// Walking back to the nearest opening tag is not enough, and the first version of this file got
// it wrong in both directions (code review caught both):
//   - a sibling that has already closed (`<div className="overflow-x-auto"></div>` above the
//     table) is not a parent, and neither is a self-closing one (`<div … />`) — counting either
//     one lets a genuinely body-scrolling page pass;
//   - but a sibling INSIDE the wrapper (a scroll hint, `{loading && <Spinner />}`, a toolbar)
//     is perfectly correct markup, and rejecting it would block a legitimate change.
// So walk backwards keeping a depth counter: each closing tag opens a subtree to skip, each
// matching opening tag closes it, and the first opening tag left unclosed is the parent.
export function enclosingTag(text) {
  const tags = tagsIn(text);
  let skip = 0;
  for (let k = tags.length - 1; k >= 0; k -= 1) {
    const t = tags[k];
    if (t.closing) skip += 1;
    else if (t.selfClosing) continue;
    else if (skip > 0) skip -= 1;
    else return t.raw;
  }
  return null;
}

// Anything that gives the element a horizontal scrollbar counts. `overflow-auto` and
// `overflow-scroll` set BOTH axes, so they satisfy this just as well as the `-x-` forms —
// register.js already uses one and it is not a defect.
export function isScrollWrapper(tag) {
  return /\boverflow-(x-)?(auto|scroll)\b/.test(tag);
}

// Several pages build a print document as a template-literal HTML string (delivery dockets,
// workshop job sheets). Those tables are rendered onto A4 by a print window, never into the
// portal viewport, so a phone breakpoint is meaningless for them — skip anything inside
// backticks. Parity works because a template literal inside JSX (className={`…`}) is balanced.
function insideTemplateLiteral(before) {
  const backticks = (before.match(/(^|[^\\])`/g) || []).length;
  return backticks % 2 === 1;
}

// Every <table> in `src` that is not directly wrapped by a horizontal-scroll container.
// "Directly" matters: a wrapper elsewhere in the same file protects nothing.
export function auditSource(src) {
  const violations = [];
  const re = /<table\b/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const before = src.slice(0, m.index);
    const line = before.split('\n').length;
    if (insideTemplateLiteral(before)) continue;
    // The same exemption for a print table rendered as real JSX rather than as a string:
    // schedule.js keeps one inside `<div className="print-only">`, which is `display:none`
    // on screen and only revealed by `@media print`.
    //
    // It names the two classes actually in use rather than matching `print` loosely. Code
    // review demonstrated that a looser `\bprint[-:]` also matched Tailwind's `print:` VARIANT
    // utilities (`print:text-xs`, `print:hidden`) — which sit on tables that very much do
    // render into the phone viewport, so an ordinary broken page could exempt itself just by
    // carrying one, silently.
    const ownTag = src.slice(m.index, src.indexOf('>', m.index) + 1);
    if (/\bprint-(only|table)\b/.test(ownTag)) continue;
    const parent = enclosingTag(before);
    if (!parent) {
      violations.push({ line, reason: 'no enclosing element' });
      continue;
    }
    if (!isScrollWrapper(parent)) {
      violations.push({ line, reason: `parent is not a horizontal scroller: ${parent.replace(/\s+/g, ' ').slice(0, 90)}` });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// F19 increment 2d — the fixed Home/Back overlay must not land on the page's own content.
//
// Thirteen pages pin `<HomeButton/><BackButton/>` to the viewport corner with
// `fixed top-4 left-6 z-50`, so the pair floats over whatever the page draws in the top-left
// ~150×56px. On a desktop width nothing is there — the headings are centred far to the right of
// it. At 375px the same centred heading lands directly underneath, and a real browser at
// 375×812 measured the overlay painting on top of the page's own h2 on five pages and on
// register.js's "Register" TAB BUTTON, which means the tap opens Home instead of the tab.
//
// The three pages that already clear it (inbox, leads, settings) do so with a `pt-16`/`py-16`
// container, so that is the shape this checks for: a page that pins the overlay must also
// declare top clearance for it, and the clearance must come AFTER the overlay in the file.
// That ordering rule is deliberately stricter than the physics: a sibling rendered ABOVE the
// overlay clears nothing (the real failure it is aimed at), while padding on an ANCESTOR of the
// overlay would in fact work, because a fixed child ignores its parent's padding. All thirteen
// pages declare it below the overlay, on the content that actually moves, so the strict form
// costs nothing and reads unambiguously; a future page that pads an ancestor instead will be
// reported here and should move the class rather than loosen this.
//
// WHAT THIS DOES NOT CLAIM:
//   - It proves a clearance class is DECLARED in the subtree after the overlay. It cannot prove
//     the class sits on the element that actually encloses the heading — jsdom has no layout
//     engine, so nothing offline can. `src/pages/__tests__/overlayClearance.test.js` proves the
//     parentage in the rendered DOM for four representative pages, and the PR carries the
//     375px browser measurement (28 routes, before/after) for the geometry itself.
//   - It only looks at pages that pin the overlay with `fixed`. A page that renders Home/Back
//     in normal flow needs no clearance and is not checked.
const CLEARANCE = /\b(max-sm:)?(pt|py|mt)-16\b/;

// Every place a page pins the Home/Back pair to the viewport, found from the buttons outward
// rather than by matching the exact class string — the class order differs between files and
// waitlist/index.js renders Back before Home.
export function overlaySites(src) {
  const out = [];
  const re = /<(HomeButton|BackButton)\b/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const parent = enclosingTag(src.slice(0, m.index));
    if (!parent || !/\bfixed\b/.test(parent)) continue;
    const at = m.index;
    if (out.length && out[out.length - 1].parent === parent && at - out[out.length - 1].at < 200) continue; // the pair shares one overlay
    out.push({ at, line: src.slice(0, at).split('\n').length, parent });
  }
  return out;
}

export function auditOverlayClearance(src) {
  const sites = overlaySites(src);
  if (!sites.length) return [];
  const first = sites[0];
  const after = src.slice(first.at);
  if (CLEARANCE.test(after)) return [];
  return [{
    line: first.line,
    reason: 'pins Home/Back over the page but declares no top clearance (pt-16 / py-16 / max-sm:pt-16) after it',
  }];
}

function pageFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...pageFiles(full));
    else if (entry.endsWith('.js') && !entry.endsWith('.test.js')) out.push(full);
  }
  return out;
}

console.log('F19 incr 2b responsive smoke — pure, no DOM, no network\n');

// ---------------------------------------------------------------------------
// 1. The analyser's own fixtures. If these ever pass vacuously the repo scan below
//    is worthless, so each shape that MUST be reported is asserted explicitly.
// ---------------------------------------------------------------------------
console.log('the analyser reports the shapes it must report:');
{
  check('a bare table is a violation', auditSource('<div><table className="w-full" /></div>').length === 1);

  check(
    'a table wrapped in overflow-x-auto passes',
    auditSource('<div className="overflow-x-auto rounded-lg border">\n<table className="min-w-full" />\n</div>').length === 0,
  );

  check(
    'overflow-hidden is NOT accepted (it clips the columns instead of scrolling them)',
    auditSource('<div className="bg-white shadow overflow-hidden">\n<table className="w-full" />').length === 1,
  );

  check(
    'overflow-y-auto alone is NOT accepted',
    auditSource('<div className="max-h-[70vh] overflow-y-auto">\n<table className="w-full" />').length === 1,
  );

  check(
    'a wrapper on a DIFFERENT element in the same file does not cover the table',
    auditSource('<div className="overflow-x-auto"><Tabs /></div>\n<div>\n<table className="w-full" />').length === 1,
    'this is exactly the peloton/collections false negative a plain grep gives',
  );

  check(
    'a scroll wrapper that has already CLOSED does not cover the table below it',
    auditSource('<div className="overflow-x-auto"></div>\n<table className="w-full" />').length === 1,
    'the discriminating case: an earlier fixture passed even with this rule deleted, because ' +
      'there the stale tag was not a scroller either',
  );

  check(
    'a SELF-CLOSING wrapper is not a parent',
    auditSource('<div className="overflow-x-auto" />\n<table className="w-full" />').length === 1,
    'found by code review — it left the table outside any scroller and the scan passed',
  );

  check(
    'a self-closing sibling INSIDE the wrapper is fine — the table is still wrapped',
    auditSource('<div className="overflow-x-auto">\n<Spinner />\n<table className="w-full" />').length === 0,
    'correct markup must not be rejected, or the guard blocks a legitimate change',
  );

  check(
    'a paired sibling inside the wrapper (a scroll hint) is also fine',
    auditSource('<div className="overflow-x-auto">\n<p className="text-xs">Scroll for more</p>\n<table className="w-full" />').length === 0,
  );

  check(
    'a nested subtree inside the wrapper is skipped correctly',
    auditSource('<div className="overflow-x-auto">\n<div><span>hi</span></div>\n<table className="w-full" />').length === 0,
  );

  check(
    'a table with no enclosing element at all is a violation',
    auditSource('<table className="w-full" />').length === 1,
  );

  check(
    'a Tailwind print: VARIANT does not exempt an on-screen table',
    auditSource('<div className="p-6">\n<table className="w-full border print:text-xs" />').length === 1,
    'the print exemption is for print-only/print-table, not for every class containing "print"',
  );

  check(
    'an arrow function in a prop does not truncate the parent tag',
    auditSource('<div onClick={() => go()} className="overflow-x-auto">\n<table className="w-full" />').length === 0,
  );

  check(
    'overflow-auto (both axes) is accepted — it scrolls horizontally too',
    auditSource('<div className="overflow-auto">\n<table className="w-full" />').length === 0,
  );

  check(
    'overflow-x-scroll is accepted',
    auditSource('<div className="overflow-x-scroll">\n<table className="w-full" />').length === 0,
  );

  check(
    'a table inside a print-window template literal is skipped (it prints to paper, not a phone)',
    auditSource('const doc = `<html><body><div><table><tr><td>x</td></tr></table></div></body></html>`;').length === 0,
  );

  check(
    'a real JSX table is STILL reported in a file that also builds a print document',
    auditSource('const doc = `<div><table /></div>`;\nreturn (<div className="p-6">\n<table className="w-full" />\n</div>);').length === 1,
    'the template-literal skip must not swallow the page itself',
  );

  check(
    'a print-only JSX table is skipped (display:none on screen, revealed by @media print)',
    auditSource('<div className="print-only">\n<table className="print-table" />').length === 0,
  );

  check(
    'the print exemption is narrow — an ordinary table in the same shape is still reported',
    auditSource('<div className="print-only">\n<table className="w-full border" />').length === 1,
  );

  check(
    'both scroll axes together still pass',
    auditSource('<div className="overflow-x-auto max-h-[70vh] overflow-y-auto">\n<table className="w-full" />').length === 0,
  );

  const two = auditSource('<div><table /></div>\n<div className="overflow-x-auto"><table /></div>\n<div><table /></div>');
  check('it reports every offending table, not just the first', two.length === 2);
  check('it reports the line number of the offender', two[0].line === 1 && two[1].line === 3);

  check('a file with no table is clean', auditSource('<div className="p-6">nothing here</div>').length === 0);
}

// ---------------------------------------------------------------------------
// 2. The repo-wide contract.
// ---------------------------------------------------------------------------
console.log('\nevery table in src/pages is inside a horizontal-scroll container:');
{
  const files = pageFiles(PAGES_DIR);
  check(`scanned the pages tree (${files.length} files)`, files.length >= 25, 'too few files — did the scan path break?');

  const withTables = files.filter((f) => /<table\b/.test(readFileSync(f, 'utf8')));
  check(`found the table pages (${withTables.length})`, withTables.length >= 15, 'suspiciously few tables found');

  const offenders = [];
  for (const file of files) {
    for (const v of auditSource(readFileSync(file, 'utf8'))) {
      offenders.push(`${relative(ROOT, file).replace(/\\/g, '/')}:${v.line} — ${v.reason}`);
    }
  }
  check('no page can scroll the document body sideways', offenders.length === 0, `\n    ${offenders.join('\n    ')}`);
}

// ---------------------------------------------------------------------------
// 3. F19 increment 2d — the fixed Home/Back overlay clears the page's own content.
// ---------------------------------------------------------------------------
console.log('\nthe overlay analyser reports the shapes it must report:');
{
  const OVERLAY = '<div className="fixed top-4 left-6 z-50 flex gap-2">\n<HomeButton />\n<BackButton />\n</div>\n';

  check(
    'an overlay page with no clearance anywhere is a violation',
    auditOverlayClearance(`${OVERLAY}<div className="min-h-screen bg-gray-100 p-6">\n<h2>Products</h2>\n</div>`).length === 1,
  );

  check(
    'max-sm:pt-16 on the container clears it',
    auditOverlayClearance(`${OVERLAY}<div className="min-h-screen bg-gray-100 p-6 max-sm:pt-16">\n<h2>Products</h2>\n</div>`).length === 0,
  );

  check(
    'the unconditional pt-16 the three already-clear pages use is accepted',
    auditOverlayClearance(`${OVERLAY}<div className="min-h-screen bg-gray-100 pt-16 pb-4 px-3">\n<h2>Inbox</h2>\n</div>`).length === 0,
  );

  check(
    'py-16 (settings) is accepted',
    auditOverlayClearance(`${OVERLAY}<div className="min-h-screen flex flex-col items-center gap-6 py-16 px-4" />`).length === 0,
  );

  check(
    'max-sm:mt-16 is accepted — register clears with margin, its container sits below the tab row',
    auditOverlayClearance(`${OVERLAY}<div className="flex justify-center max-sm:mt-16 mt-6"><button>Register</button></div>`).length === 0,
  );

  check(
    'clearance declared only BEFORE the overlay does not count',
    auditOverlayClearance(`<div className="pt-16" />\n${OVERLAY}<div className="min-h-screen p-6"><h2>Products</h2></div>`).length === 1,
    'a pt-16 on something rendered above the overlay clears nothing — the discriminating case',
  );

  check(
    'a page that renders no Home/Back overlay is not checked',
    auditOverlayClearance('<div className="min-h-screen p-6"><h2>Scan</h2></div>').length === 0,
  );

  check(
    'Home/Back in NORMAL FLOW needs no clearance',
    auditOverlayClearance('<div className="flex gap-2"><HomeButton /><BackButton /></div>\n<div className="p-6"><h2>x</h2></div>').length === 0,
    'the defect is the fixed positioning, not the buttons',
  );

  check(
    'the pair inside one fixed overlay is one site, not two',
    overlaySites(OVERLAY).length === 1,
  );

  check(
    'a nearly-right clearance (pt-14) is NOT accepted — 56px is the overlay bottom, not clearance',
    auditOverlayClearance(`${OVERLAY}<div className="min-h-screen p-6 max-sm:pt-14"><h2>x</h2></div>`).length === 1,
  );

  check(
    'a stray "16" in an unrelated utility is not clearance',
    auditOverlayClearance(`${OVERLAY}<div className="min-h-screen p-6 gap-16 max-w-[1600px]"><h2>x</h2></div>`).length === 1,
    'mutation testing found this one: loosening the pattern to a bare /16/ kept every fixture ' +
      'green, because none of them contained a 16 that was not a clearance',
  );

  check(
    'the overlay is found even when Back is written before Home (waitlist/index.js)',
    overlaySites('<div className="fixed top-4 left-6 z-50 flex gap-2">\n<BackButton />\n<HomeButton />\n</div>').length === 1,
  );
}

console.log('\nevery page that pins the Home/Back overlay clears it:');
{
  const files = pageFiles(PAGES_DIR);
  const overlayPages = files.filter((f) => overlaySites(readFileSync(f, 'utf8')).length > 0);
  check(
    `found the pages that pin the overlay (${overlayPages.length})`,
    overlayPages.length >= 13,
    'fewer overlay pages than the 13 measured at 375px — did the detector break?',
  );

  const offenders = [];
  for (const file of overlayPages) {
    for (const v of auditOverlayClearance(readFileSync(file, 'utf8'))) {
      offenders.push(`${relative(ROOT, file).replace(/\\/g, '/')}:${v.line} — ${v.reason}`);
    }
  }
  check('no page draws its content under the fixed Home/Back overlay', offenders.length === 0, `\n    ${offenders.join('\n    ')}`);
}

console.log(`\n✅ responsive smoke: ${passed} checks passed`);
