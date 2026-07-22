// scripts/podium-responsive-smoke.mjs — offline smoke for F19 increment 2b (no page scrolls sideways).
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

// The last JSX opening tag in `text`. Walks backwards so closing tags (`</div>`) and JSX
// expression punctuation (`{cond && (`) are skipped naturally. `text[j-1] !== '='` keeps an
// arrow function inside a prop (`onClick={() => …}`) from being mistaken for the end of the tag.
export function lastOpenTag(text) {
  for (let i = text.length - 1; i >= 0; i -= 1) {
    if (text[i] === '<' && /[A-Za-z]/.test(text[i + 1] || '')) {
      let j = i + 1;
      while (j < text.length && !(text[j] === '>' && text[j - 1] !== '=')) j += 1;
      return { tag: text.slice(i, j + 1), end: j };
    }
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
    // on screen and only revealed by `@media print`. Deliberately narrow — it keys off the
    // table's OWN print-scoped class, so an ordinary `w-full` table is still caught.
    const ownTag = src.slice(m.index, src.indexOf('>', m.index) + 1);
    if (/\bprint[-:]/.test(ownTag)) continue;
    const parent = lastOpenTag(before);
    if (!parent) {
      violations.push({ line, reason: 'no enclosing element' });
      continue;
    }
    // Anything between the candidate tag and the <table> means the candidate is a sibling that
    // already closed, not the table's parent.
    const between = before.slice(parent.end + 1);
    if (between.includes('<')) {
      violations.push({ line, reason: `nearest wrapper closed before the table (${between.trim().slice(0, 40)})` });
      continue;
    }
    if (!isScrollWrapper(parent.tag)) {
      violations.push({ line, reason: `parent is not overflow-x-auto: ${parent.tag.replace(/\s+/g, ' ').slice(0, 90)}` });
    }
  }
  return violations;
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
    'a self-closing sibling between wrapper and table is reported, not silently accepted',
    auditSource('<div className="overflow-x-auto">\n<Spinner />\n<table className="w-full" />').length === 1,
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

console.log(`\n✅ responsive smoke: ${passed} checks passed`);
