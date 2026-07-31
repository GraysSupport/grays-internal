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

// Every JSX tag in `text`, in order.
//
// TWO SHAPES THIS USED TO MIS-READ (F40, 1 Aug 2026 — both found by the code review of the
// newer sibling guard, scripts/podium-formgrid-smoke.mjs, which hit them for real):
//
//   1. FRAGMENTS. Matching `<` only when a letter or `/` follows reads `</>` as an ordinary
//      closing tag while its `<>` opener is invisible. In `enclosingTag` every stray `</>` then
//      increments the skip counter with nothing to match it, so the walk skips a genuine parent —
//      wrongly reporting a wrapped table (false positive) or, worse, skipping a non-scrolling
//      parent and landing on a scroller above it, which passes a page that really does scroll its
//      body. There are 28 fragments across 16 pages in `src/pages`.
//
//   2. THE END OF A TAG. "The first `>` not preceded by `=`" ends the tag inside
//      `className={`p-2 ${n > 3 ? 'a' : 'b'}`}`, leaving a truncated tag with no readable
//      className. The tag now ends at a `>` outside any brace-delimited prop, with strings,
//      template literals and COMMENTS inside those props skipped. Comments matter: an apostrophe
//      inside a `//` comment (`don't`) otherwise opens a phantom string, the braces never
//      rebalance, and one tag swallows the rest of the file — measured at 9,405 characters in
//      delivery_operations/workorder/[id].js.
//
// NEITHER CHANGES A SINGLE VERDICT IN THIS REPO TODAY: all 23 tables resolve to the same parent
// before and after (measured). This is latent-defect hardening, and the fixtures below are the
// whole visible effect.
//
// Still not understood, and out of reach of a scanner this size: a regex literal in a prop
// (`onChange={e => /['"{]/.test(e)}`) can carry unbalanced quotes or braces. None exists in the
// repo today; a smear assertion in the repo section below is the backstop if one ever appears.
function tagsIn(text) {
  const out = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '<' && /[A-Za-z/>]/.test(text[i + 1] || '')) {
      let j = i + 1;
      let braces = 0;
      let quote = null; // the string/template literal open inside a prop expression, if any
      let comment = null; // 'line' | 'block', likewise
      for (; j < text.length; j += 1) {
        const c = text[j];
        if (comment) {
          if (comment === 'line' && c === '\n') comment = null;
          else if (comment === 'block' && c === '*' && text[j + 1] === '/') { comment = null; j += 1; }
          continue;
        }
        if (quote) {
          if (c === '\\') j += 1;
          else if (c === quote) quote = null;
          continue;
        }
        if (braces > 0 && c === '/' && (text[j + 1] === '/' || text[j + 1] === '*')) {
          comment = text[j + 1] === '/' ? 'line' : 'block';
          j += 1;
        } else if (braces > 0 && (c === '"' || c === "'" || c === '`')) quote = c;
        else if (c === '{') braces += 1;
        else if (c === '}') braces -= 1;
        else if (c === '>' && braces === 0) break;
      }
      const raw = text.slice(i, j + 1);
      // A fragment is transparent to layout and to this walk: it is neither a parent nor a
      // closing tag, so it must not move the depth counter in either direction.
      const fragment = raw === '<>' || raw === '</>';
      out.push({ raw, fragment, closing: !fragment && raw[1] === '/', selfClosing: !fragment && /\/>$/.test(raw) });
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
    if (t.fragment) continue; // transparent — see tagsIn
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

  // --- the two JSX shapes this scanner used to mis-read (F40) -------------------------------
  //
  // Both were found by the code review of the newer sibling guard (podium-formgrid-smoke.mjs,
  // F19 incr 2e), which hit them for real. Neither changes any verdict in this repo TODAY —
  // measured: all 23 tables get the same parent before and after this fix — so these fixtures
  // are the whole visible effect of the change. They pin the direction of each error so it
  // cannot come back silently.

  check(
    'a fragment between the wrapper and the table does not hide the wrapper',
    auditSource('<div className="overflow-x-auto">\n<>\n<Toolbar />\n</>\n<table className="w-full" />\n</div>').length === 0,
    'FALSE POSITIVE: `</>` was read as an ordinary closing tag while its `<>` opener was ' +
      'invisible, so the walk skipped the real wrapper and reported "no enclosing element"',
  );

  check(
    'a fragment does not promote a non-scrolling parent into its scrolling grandparent',
    auditSource('<div className="overflow-x-auto">\n<div className="p-2">\n<>x</>\n<table className="w-full" />\n</div>\n</div>').length === 1,
    'FALSE NEGATIVE, the dangerous direction: the unmatched `</>` made the walk skip the real ' +
      '(non-scrolling) parent and land on the scroller above it, so a body-scrolling page passed',
  );

  check(
    'a fragment is never itself reported as the table\'s parent',
    auditSource('<div className="overflow-x-auto">\n<>\n<table className="w-full" />\n</>\n</div>').length === 0,
    'MUTATION FOUND THIS GAP: marking fragments as ordinary tags keeps the depth walk balanced ' +
      '(`<>` opens, `</>` closes), so every other fixture still passed — but the walk then RETURNS ' +
      '`<>` as the enclosing tag, which is not a scroller, and a correctly wrapped table is reported',
  );

  check(
    'a brace inside a string in a prop is not a real brace',
    auditSource('<div title={"}"} className="overflow-x-auto">\n<table className="w-full" />\n</div>').length === 0,
    'MUTATION FOUND THIS GAP TOO: without skipping strings inside a prop expression the braces ' +
      'close on the one in the string and the tag ends early, losing the className that wraps this table',
  );

  check(
    'a `>` inside a prop expression does not truncate the tag',
    auditSource('<div className={`p-2 ${n > 3 ? "a" : "b"}`}>\n<table className="w-full" />\n</div>').length === 1,
    'the tag used to end inside the comparison, so the parent read as a truncated string with no ' +
      'className — here that is a real defect (no scroller) and it must still be reported',
  );

  check(
    'a `>` inside a prop expression does not truncate a wrapper either',
    auditSource('<div className={`overflow-x-auto ${n > 3 ? "a" : "b"}`}>\n<table className="w-full" />\n</div>').length === 0,
    'the same truncation on a legitimate wrapper reported a false violation',
  );

  check(
    'an apostrophe inside a // comment in a prop does not swallow the rest of the file',
    auditSource(
      '<button onClick={() => {\n// refresh so the per-item slots that don\'t update in place are shown\ngo();\n}}>x</button>\n' +
        '<div className="p-2">\n<table className="w-full" />\n</div>',
    ).length === 1,
    'measured on this repo: comment-blind brace tracking turned workorder/[id].js:918 into a ' +
      'single 9,405-character "tag" that swallowed everything after it, table included',
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

  // The backstop for the failure mode F40 fixed, and for the regex-literal case it did not: when
  // the scanner loses track of where a tag ends, one "tag" swallows the rest of the file and every
  // table inside it silently leaves the scan. Nothing else in this suite can see that — the
  // comment-blind version produced a 9,405-character tag in workorder/[id].js and stayed green.
  // The longest genuine tag in the tree is 1,472 characters (collections/[id].js).
  const longest = files.reduce((worst, file) => {
    for (const tag of tagsIn(readFileSync(file, 'utf8'))) {
      if (tag.raw.length > worst.len) worst = { len: tag.raw.length, file: relative(ROOT, file), head: tag.raw.slice(0, 60) };
    }
    return worst;
  }, { len: 0, file: '', head: '' });
  // Known-unkillable by mutation, and recorded rather than left silently uncovered: raising this
  // threshold cannot fail while no file in the repo smears. It is a backstop for a future
  // mis-parse (a regex literal in a prop is the shape still out of reach), not a property of
  // today's tree. The fixtures above are what prove the scanner reads the two known shapes.
  check(
    `no tag smears across the file (longest is ${longest.len} chars)`,
    longest.len < 2500,
    `${longest.file} has a ${longest.len}-character "tag" starting ${JSON.stringify(longest.head)} — the scanner has ` +
      'lost the end of a tag, and every table inside it is invisible to the scan below',
  );

  const offenders = [];
  for (const file of files) {
    for (const v of auditSource(readFileSync(file, 'utf8'))) {
      offenders.push(`${relative(ROOT, file).replace(/\\/g, '/')}:${v.line} — ${v.reason}`);
    }
  }
  check('no page can scroll the document body sideways', offenders.length === 0, `\n    ${offenders.join('\n    ')}`);
}

console.log(`\n✅ responsive smoke: ${passed} checks passed`);
