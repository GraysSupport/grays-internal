// scripts/podium-formgrid-smoke.mjs — offline smoke for F19 increment 2e.
//
// THE RULE: on a phone, a form control must not sit in a grid track narrower than a third of
// its row.
//
// WHAT IT IS FOR — the defect that shipped in create_workorder.js. Its item row is
// `grid grid-cols-5`, unconditional, so it stays five columns wide at every viewport. Measured
// in Chrome at 375×812 (page `p-6` + card `p-6` leave the row 279px):
//
//     control                       track   text area   verdict
//     Search product… (col-span-2)   107px       89px    cramped
//     Qty                             49px       31px    ~2 characters
//     Condition <select>              49px       31px    its own label needs 116px —
//                                                        scrollWidth 128 vs clientWidth 47
//     Search technician…              49px       31px    ~2 characters
//
// WHY THE INCREMENT 2c VIEWPORT AUDIT COULD NOT SEE IT: Tailwind's `grid-cols-5` is
// `repeat(5, minmax(0, 1fr))`, so the tracks CRUSH rather than overflow. The document never
// scrolls sideways (measured: scrollWidth 375 = clientWidth 375), which is exactly the signal
// that audit looked for. A page can be entirely unusable without moving that metric one pixel.
//
// WHY A THIRD, AND WHY ONLY THE BASE BREAKPOINT: the threshold is calibrated against the one
// viewport F19's acceptance line names (~375px) and the widest form row this repo puts there
// (279px). A third of that is 93px; the defect's tracks are 49px. Above the base breakpoint the
// same ratio means something different — at 640px a quarter-row track is 146px, which is not a
// defect — so this checks the base tier only and claims nothing about `sm:`/`md:`. The fix for
// this defect deliberately restores its five columns at `md` and not at `sm`, because 640px was
// ALSO measured as too narrow for the Condition select (100px box vs 128px of content) even
// though the relative rule would call it fine.
//
// WHAT THIS DOES NOT CLAIM — read before treating a green run as "the forms are fine on a phone":
//   - It is a source scan of `src/pages/**/*.js`. jsdom has no layout engine, so nothing offline
//     can measure that a control was too narrow to use; the numbers above come from a real
//     browser and the paired RTL test (src/pages/__tests__/formGridStacking.test.js) proves the
//     stacking in the RENDERED DOM, where JSX nesting and conditionals have been resolved.
//   - It sees `<input>`, `<select>` and `<textarea>` written as JSX. A control rendered by a
//     COMPONENT (`<CustomerPicker />`) is invisible to it. Buttons are deliberately out of scope:
//     an icon-only button is legitimately narrow.
//   - A className computed at runtime (`className={`grid grid-cols-${n}`}`) carries no literal
//     column count and is skipped — pinned as a fixture below so the blind spot is explicit.
//   - It reasons about COLUMN SHARE, not pixels: it cannot know how wide the container is. A
//     two-column row of controls inside a 200px sidebar would pass and still be unusable.
//
//   node scripts/podium-formgrid-smoke.mjs

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

// Every JSX tag in `text`, in order, with its offsets. `text[j - 1] !== '='` keeps an arrow
// function inside a prop (`onChange={(e) => …}`) from being mistaken for the end of the tag.
//
// FRAGMENTS ARE TAGGED, NOT IGNORED. The first cut matched `<` only when a letter or `/`
// followed, which reads `</>` as an ordinary closing tag while its `<>` opener is invisible —
// so every fragment silently CLOSED the element containing it. On create_workorder.js's own
// item row that ended the product cell early and reported the wrong child at the wrong line.
// A fragment is transparent to CSS grid (its children are the grid's children), so the walk
// below treats these markers as depth-neutral rather than as elements.
//
// This duplicates the scanner in podium-responsive-smoke.mjs on purpose: that module runs its
// whole suite at import time, so importing it here would run it twice and couple the two
// suites' exit codes together.
export function tagsIn(text) {
  const out = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '<' && /[A-Za-z/>]/.test(text[i + 1] || '')) {
      let j = i + 1;
      while (j < text.length && !(text[j] === '>' && text[j - 1] !== '=')) j += 1;
      const raw = text.slice(i, j + 1);
      const fragment = raw === '<>' || raw === '</>';
      out.push({
        raw,
        start: i,
        end: j,
        fragment,
        closing: !fragment && raw[1] === '/',
        selfClosing: !fragment && /\/>$/.test(raw),
        name: fragment ? '' : (raw.match(/^<\/?\s*([A-Za-z][\w.]*)/) || [, ''])[1],
      });
      i = j;
    }
  }
  return out;
}

// The className VALUE of an opening tag, or '' — a class named in any other prop styles nothing.
export function classNameOf(tag) {
  const m = tag.match(/className\s*=\s*(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\}|\{([^}]*)\})/);
  return m ? (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '') : '';
}

// Tailwind applies an unprefixed utility at every width and a prefixed one only from its
// breakpoint up, so only the unprefixed form describes a phone. The leading boundary is a
// character class rather than `\b` precisely so that `sm:grid-cols-5` — which does nothing at
// 375px — is NOT read as the base column count.
const unprefixed = (utility) => new RegExp(`(?:^|[\\s"'\`{])${utility}(?![\\w-])`);

// The number of columns the grid has at the base tier, or null if it is not a base multi-column
// grid. `grid-cols-*` without a `grid` display class styles nothing, so both are required.
export function baseGridCols(className) {
  if (!/(?:^|[\s"'`{])(inline-)?grid(?![\w-])/.test(className)) return null;
  const m = className.match(/(?:^|[\s"'`{])grid-cols-(\d+)(?![\w-])/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 2 ? n : null;
}

// How many columns a child occupies at the base tier. Unspanned children take one; `col-span-full`
// takes the row. A `sm:col-span-2` is not a base span — at 375px that child still takes one.
export function baseColSpan(className, cols) {
  if (unprefixed('col-span-full').test(className)) return cols;
  const m = className.match(/(?:^|[\s"'`{])col-span-(\d+)(?![\w-])/);
  return m ? Number(m[1]) : 1;
}

// The direct children of the element whose opening tag is `tags[gridIdx]`, each with the source
// range of its whole subtree. Depth counting is what makes them DIRECT: a grandchild control
// belongs to the child that encloses it, and a control in the next sibling grid belongs to that
// sibling.
export function directChildren(src, tags, gridIdx) {
  const kids = [];
  let depth = 0;
  for (let k = gridIdx + 1; k < tags.length; k += 1) {
    const t = tags[k];
    if (t.fragment) continue; // transparent: a fragment's children are the grid's children
    if (t.closing) {
      if (depth === 0) break; // the grid's own closing tag
      depth -= 1;
      if (depth === 0 && kids.length) kids[kids.length - 1].to = t.end;
      continue;
    }
    if (depth === 0) kids.push({ tag: t, from: t.start, to: t.end });
    if (!t.selfClosing) depth += 1;
  }
  return kids.map((kid) => ({ ...kid, source: src.slice(kid.from, kid.to + 1) }));
}

export function hasFormControl(source) {
  return /<(input|select|textarea)\b/.test(source);
}

// Every place a page puts a form control in a base-tier track narrower than a third of the row.
export function auditFormGrids(src) {
  const violations = [];
  const tags = tagsIn(src);
  tags.forEach((tag, i) => {
    if (tag.fragment || tag.closing || tag.selfClosing) return;
    const cols = baseGridCols(classNameOf(tag.raw));
    if (!cols) return;
    for (const kid of directChildren(src, tags, i)) {
      if (!hasFormControl(kid.source)) continue;
      const span = baseColSpan(classNameOf(kid.tag.raw), cols);
      if (span * 3 >= cols) continue;
      violations.push({
        line: src.slice(0, kid.from).split('\n').length,
        reason:
          `a form control sits in ${span} of ${cols} base columns — below a third of the row ` +
          `(~${Math.round((279 * span) / cols)}px of a 279px row at 375px). Give the grid a ` +
          'single-column base and restore the columns at a breakpoint.',
      });
    }
  });
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

console.log('F19 incr 2e form-grid smoke — pure, no DOM, no network\n');

// ---------------------------------------------------------------------------
// 1. The analyser's own fixtures. If these pass vacuously the repo scan below is worthless,
//    so every shape that MUST be reported is asserted explicitly, and so is every shape that
//    must NOT be (a guard that flags correct markup gets deleted by the next person).
// ---------------------------------------------------------------------------
const ROW = (grid, product = 'col-span-2') =>
  `<div className="${grid}">\n` +
  `<div className="${product}"><input placeholder="Search product..." /></div>\n` +
  '<input placeholder="Qty" />\n' +
  '<select><option>Reco</option></select>\n' +
  '<div><input placeholder="Search technician..." /></div>\n' +
  '</div>';

console.log('the analyser reports the shapes it must report:');
{
  check(
    'the shipped defect is reported: three controls in one of five columns',
    auditFormGrids(ROW('grid grid-cols-5 gap-2 mb-2')).length === 3,
    'the col-span-2 product cell is 2/5 — above a third, so it is NOT one of the three',
  );

  check(
    'the fix passes: a single-column base with the five columns restored at a breakpoint',
    auditFormGrids(ROW('grid grid-cols-1 md:grid-cols-5 gap-2 mb-2', 'md:col-span-2')).length === 0,
  );

  check(
    'a grid with no base column count at all passes (it is one column on a phone)',
    auditFormGrids(ROW('grid md:grid-cols-5 gap-2', 'md:col-span-2')).length === 0,
    'the collections/[id] shape — `grid sm:grid-cols-4` — must not be flagged',
  );

  check(
    'sm:grid-cols-5 is NOT a base column count — it does nothing at 375px',
    auditFormGrids(ROW('grid sm:grid-cols-5 gap-2', 'sm:col-span-2')).length === 0,
  );

  check(
    'a twelve-column page shell whose single child spans all twelve passes',
    auditFormGrids('<div className="grid grid-cols-12 gap-6 py-6 px-4 flex-1">\n<main className="col-span-12">\n<input placeholder="Search" />\n</main>\n</div>').length === 0,
    'seven delivery_operations/workshop pages use exactly this shell — the discriminating case ' +
      'for reading col-span, without which the guard reports every one of them',
  );

  check(
    'col-span-full is the whole row too',
    auditFormGrids('<div className="grid grid-cols-12 gap-6">\n<main className="col-span-full">\n<input />\n</main>\n</div>').length === 0,
  );

  check(
    'two columns pass — half a row is above the threshold',
    auditFormGrids('<div className="grid grid-cols-2 gap-3">\n<div><input /></div>\n<div><select /></div>\n</div>').length === 0,
    'the leads.js new-lead modal shape. Measured, not assumed: at 375px its two cells are 146px ' +
      'each and neither the value input nor the Source select clips its content',
  );

  check(
    'exactly a third passes',
    auditFormGrids('<div className="grid grid-cols-6 gap-2">\n<div className="col-span-2"><input /></div>\n</div>').length === 0,
    'the boundary is "narrower than a third", not "a third or narrower"',
  );

  check(
    'just under a third is reported',
    auditFormGrids('<div className="grid grid-cols-7 gap-2">\n<div className="col-span-2"><input /></div>\n</div>').length === 1,
    'the other side of the same boundary — without both, the comparison could be inverted and stay green',
  );

  check(
    'a crushed track with no form control in it is not this rule',
    auditFormGrids('<div className="grid grid-cols-5 gap-2">\n<div className="text-xs">Qty</div>\n</div>').length === 0,
  );

  check(
    'a control nested deeper inside the child is still found',
    auditFormGrids('<div className="grid grid-cols-5 gap-2">\n<div><div className="relative"><input /></div></div>\n</div>').length === 1,
  );

  check(
    'a control in the NEXT sibling grid is not attributed to this one',
    auditFormGrids('<div className="grid grid-cols-5 gap-2">\n<div>text</div>\n</div>\n<div className="grid grid-cols-1"><input /></div>').length === 0,
    'depth counting, not "the next input in the file"',
  );

  check(
    'a control in a nested INNER grid is charged to the inner grid, not counted twice',
    auditFormGrids('<div className="grid grid-cols-4 gap-2">\n<div className="col-span-4">\n<div className="grid grid-cols-5">\n<input />\n</div>\n</div>\n</div>').length === 1,
    'the outer child spans the row and is clean; the inner row is the violation',
  );

  check(
    'a self-closing control as a direct child is handled',
    auditFormGrids('<div className="grid grid-cols-5 gap-2">\n<input className="border" />\n</div>').length === 1,
  );

  check(
    'a self-closing sibling does not swallow the children after it',
    auditFormGrids('<div className="grid grid-cols-5 gap-2">\n<Spinner />\n<div className="col-span-5"><input /></div>\n</div>').length === 0,
    'if a self-closing tag opened a subtree, the cleared child after it would never be examined',
  );

  check(
    'a fragment inside a child does not close that child',
    auditFormGrids(
      '<div className="grid grid-cols-5 gap-2">\n' +
        '<div className="col-span-2">\n{!custom ? (\n<>\n<input placeholder="Search product..." />\n</>\n) : (\n' +
        '<div className="space-y-2"><input placeholder="Custom description" /></div>\n)}\n</div>\n' +
        '<input placeholder="Qty" />\n</div>',
    ).length === 1,
    'create_workorder.js\'s own shape. With `</>` read as an ordinary closing tag the product ' +
      'cell ended early, the custom-mode div was mistaken for a grid child, and the row\'s three ' +
      'genuinely crushed controls were never reached — one wrong violation instead of three right ones',
  );

  check(
    'a fragment as a direct child is transparent — its children are the grid\'s children',
    auditFormGrids('<div className="grid grid-cols-5 gap-2">\n<>\n<input />\n<input />\n</>\n</div>').length === 2,
    'a fragment is not a grid item; the inputs inside it are',
  );

  check(
    'an arrow function in a prop does not truncate the tag',
    auditFormGrids('<div onClick={() => go()} className="grid grid-cols-5">\n<input />\n</div>').length === 1,
  );

  check(
    'grid-cols without a grid display class styles nothing and is not checked',
    auditFormGrids('<div className="flex grid-cols-5 gap-2">\n<input />\n</div>').length === 0,
  );

  check(
    'inline-grid counts as a grid',
    auditFormGrids('<div className="inline-grid grid-cols-5 gap-2">\n<input />\n</div>').length === 1,
  );

  check(
    'grid-cols-1 is not a multi-column grid',
    auditFormGrids('<div className="grid grid-cols-1 gap-2">\n<input />\n</div>').length === 0,
  );

  check(
    'the column count must be in a className, not in some other prop',
    auditFormGrids('<div title="grid grid-cols-5" className="grid grid-cols-2">\n<input />\n</div>').length === 0,
    'without the className restriction the title would set the count to five and this would fail',
  );

  check(
    'a computed className carries no literal count and is skipped (a known blind spot)',
    auditFormGrids('<div className={`grid grid-cols-${n} gap-2`}>\n<input />\n</div>').length === 0,
  );

  check(
    'every offending child is reported, not just the first',
    auditFormGrids('<div className="grid grid-cols-5">\n<input />\n<input />\n<input />\n</div>').length === 3,
  );

  check(
    'it reports the line of the offending child',
    auditFormGrids('<div className="grid grid-cols-5">\n<div>x</div>\n<input />\n</div>')[0].line === 3,
  );

  check(
    'a page with no grid at all is clean',
    auditFormGrids('<div className="p-6"><input /></div>').length === 0,
  );
}

// ---------------------------------------------------------------------------
// 2. The repo-wide contract.
// ---------------------------------------------------------------------------
console.log('\nno form control in src/pages sits in a crushed grid track on a phone:');
{
  const files = pageFiles(PAGES_DIR);
  check(`scanned the pages tree (${files.length} files)`, files.length >= 25, 'too few files — did the scan path break?');

  // PINNED, not a floor. A floor cannot fail when the scanner stops finding grids — which is the
  // one failure that would make the scan below silently vacuous. Adding a base multi-column grid
  // is fine: bump this number in the same commit, having checked the new grid against the rule.
  const gridPages = files.filter((f) => tagsIn(readFileSync(f, 'utf8')).some((t) => !t.closing && baseGridCols(classNameOf(t.raw))));
  check(
    `found the pages with a base multi-column grid (${gridPages.length})`,
    gridPages.length === 13,
    `expected 13, found ${gridPages.length}: ${gridPages.map((f) => relative(ROOT, f)).join(', ')}`,
  );

  const offenders = [];
  for (const file of files) {
    for (const v of auditFormGrids(readFileSync(file, 'utf8'))) {
      offenders.push(`${relative(ROOT, file).replace(/\\/g, '/')}:${v.line} — ${v.reason}`);
    }
  }
  check('no page crushes a form control into a sliver of a row', offenders.length === 0, `\n    ${offenders.join('\n    ')}`);
}

console.log(`\n✅ form-grid smoke: ${passed} checks passed`);
