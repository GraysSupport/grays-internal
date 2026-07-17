// scripts/lot-label-smoke.mjs — offline smoke for the HotLabel HL-M6 lot labels (G4).
//
//   node scripts/lot-label-smoke.mjs
//
// The label is PRINT output: getting it wrong costs a roll of stickers and a trip to the
// workshop, and the failure is silent in code review (the CSS looks fine either way). So
// this asserts the geometry ADDS UP rather than just eyeballing numbers:
//   • @page and .label agree — if they drift, the printer clips the label or spreads it
//     across two stickers. This is the single most likely regression on a size change.
//   • the barcode fits inside the label's usable width
//   • the whole text stack fits inside the usable height
//   • a product name with HTML in it can't break the document
//
// No DOM and no printer needed: buildLotLabelsHtml is pure and takes the barcode
// generator as an argument.

const { buildLotLabelsHtml, LABEL_GEOMETRY } = await import('../src/utils/lotLabels.js');

let passed = 0;
function check(name, cond, detail) {
  if (!cond) throw new Error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const PT_TO_MM = 0.352778;
const fakeBarcode = (lot) => `<svg data-lot="${lot}"></svg>`;
const LOTS = [
  { lot_number: 'LOT-0001', product_sku: 'TM-95T', product_name: 'Life Fitness 95T Treadmill' },
  { lot_number: 'LOT-0002', product_sku: 'RW-C2', product_name: 'Concept2 RowErg' },
];

const html = buildLotLabelsHtml(LOTS, fakeBarcode);
const { LABEL_W, LABEL_H, PADDING, BARCODE_W, BARCODE_H, TEXT } = LABEL_GEOMETRY;

console.log('HotLabel HL-M6 lot label smoke — pure, no DOM\n');

console.log('stock size (80 × 50 mm as of 17 Jul 2026):');
{
  check('geometry is the 80 × 50 stock', LABEL_W === 80 && LABEL_H === 50, `${LABEL_W}×${LABEL_H}`);
  check('@page is the sticker size', new RegExp(`@page \\{ size: ${LABEL_W}mm ${LABEL_H}mm;`).test(html));
  check('.label is the same size as @page (drift here = clipped or split labels)',
    new RegExp(`width: ${LABEL_W}mm; height: ${LABEL_H}mm;`).test(html));
  check('no stale 50mm/30mm geometry left anywhere', !/\b50mm 30mm\b/.test(html) && !/width: 50mm; height: 30mm/.test(html));
}

console.log('\neverything fits inside the sticker:');
{
  const usableW = LABEL_W - PADDING * 2;
  const usableH = LABEL_H - PADDING * 2;

  check('barcode fits the usable width', BARCODE_W <= usableW, `${BARCODE_W}mm in ${usableW}mm`);
  check('barcode is wide enough to be worth scanning (>60% of the label)', BARCODE_W / LABEL_W > 0.6);

  // The stack: barcode + lotnum(+1mm margin) + sku + name(capped).
  const stackH = BARCODE_H
    + 1 + TEXT.lotnum.size * TEXT.lotnum.lineHeight * PT_TO_MM
    + TEXT.sku.size * TEXT.sku.lineHeight * PT_TO_MM
    + TEXT.name.maxHeight;
  check('the whole text stack fits the usable height', stackH <= usableH, `${stackH.toFixed(1)}mm in ${usableH}mm`);
  check('and leaves some slack for font metrics', usableH - stackH >= 2, `slack ${(usableH - stackH).toFixed(1)}mm`);

  check('the lot number is the biggest text (read-by-eye fallback)',
    TEXT.lotnum.size > TEXT.sku.size && TEXT.lotnum.size > TEXT.name.size);
  check('text got bigger with the bigger stock, not left at the old sizes',
    TEXT.lotnum.size > 12 && TEXT.sku.size > 7 && TEXT.name.size > 6);
}

console.log('\ncontent:');
{
  check('one label per lot', (html.match(/class="label"/g) || []).length === LOTS.length);
  check('each label carries its own barcode', html.includes('data-lot="LOT-0001"') && html.includes('data-lot="LOT-0002"'));
  check('lot number is printed as text too', html.includes('LOT-0001'));
  check('sku is printed', html.includes('TM-95T'));
  check('product name is printed', html.includes('Life Fitness 95T Treadmill'));
  check('one sticker each — page break after every label', /page-break-after: always/.test(html));
  check('no lots → no labels, still a valid document', !/class="label"/.test(buildLotLabelsHtml([], fakeBarcode)));
}

console.log('\nescaping (a product name is free text from the collection form):');
{
  const nasty = buildLotLabelsHtml(
    [{ lot_number: 'LOT-1', product_sku: 'X', product_name: '<script>alert(1)</script> & "quotes"' }],
    fakeBarcode
  );
  check('markup in a product name cannot break the document', !/<script>alert\(1\)<\/script>/.test(nasty));
  check('it is escaped, not dropped', nasty.includes('&lt;script&gt;') && nasty.includes('&amp;') && nasty.includes('&quot;'));
}

console.log(`\n✅ lot label smoke: ${passed} checks passed`);
