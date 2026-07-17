// G4 — printable lot labels for the HotLabel HL-M6.
//
// Stock: 80 mm × 50 mm (changed from 50 × 30 on 17 Jul 2026 at Nick's request).
//
// Generates a Code 128 barcode of the lot number (universal for USB scanners) plus a
// human-readable lot number, SKU and product name, then opens a print window sized to the
// sticker. The barcode SVG is generated in-app and injected as self-contained markup, so
// the print window needs no scripts/libraries.
import JsBarcode from 'jsbarcode';

// ---- Sticker geometry -------------------------------------------------------
// One place, because @page and .label MUST agree: if they drift the printer either clips
// the label or spreads it across two stickers. Everything else is derived from these, so
// a future stock change is LABEL_W/LABEL_H + a reprint test, not a hunt through the CSS.
const LABEL_W = 80;   // mm
const LABEL_H = 50;   // mm
const PADDING = 2.5;  // mm — keeps ink off the die-cut edge

// The barcode is the whole point of the label, so give it the usable width: wider modules
// scan more reliably on a worn or angled sticker. 2.5mm of slack each side of the padding.
// At 70mm a real lot number (L00042) prints a ~30 mil X-dimension — very comfortable.
const BARCODE_W = LABEL_W - PADDING * 2 - 5; // 70mm
// NB this is a BOUNDING BOX, not the bar height. JsBarcode sets a viewBox and no
// preserveAspectRatio, so the SVG scales uniformly (no distortion) and letterboxes: a
// short lot number is WIDTH-constrained, inking ~15.6mm and centring the rest. Raising
// this alone therefore buys dead space, not taller bars — widen the label instead.
const BARCODE_H = 18;                        // mm

// Text stack, in print order. Sizes scaled ~1.6× with the stock (50→80 wide, 30→50 tall).
const TEXT = {
  lotnum: { size: 19, lineHeight: 1, marginTop: 1 },   // read-by-eye fallback — biggest
  sku: { size: 11, lineHeight: 1.1 },
  name: { size: 9, lineHeight: 1.05, maxHeight: 10 },  // mm — clipped, never overflows
};

function esc(s) {
  return String(s ?? '').replace(/[<>&"]/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]
  ));
}

function barcodeSvgString(text) {
  const holder = document.createElement('div');
  holder.style.position = 'absolute';
  holder.style.left = '-9999px';
  holder.style.top = '0';
  document.body.appendChild(holder);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  holder.appendChild(svg);
  try {
    JsBarcode(svg, String(text), {
      format: 'CODE128',
      displayValue: false,
      margin: 0,
      height: 40,
      width: 2,
    });
    return new XMLSerializer().serializeToString(svg);
  } finally {
    document.body.removeChild(holder);
  }
}

/**
 * Build the print document. PURE — no DOM, no window — so the geometry can be checked
 * offline (scripts/lot-label-smoke.mjs) instead of by burning stickers. `barcodeFor`
 * returns the barcode SVG markup for a lot number; printLotLabels passes the real one.
 * @param {Array<{lot_number:string, product_sku:string, product_name:string}>} lots
 * @param {(lotNumber:string) => string} barcodeFor
 */
export function buildLotLabelsHtml(lots, barcodeFor) {
  // Filter here, not in the caller: a lot with no number would print a barcode reading
  // "undefined" onto physical stock. This is the function anything else should call.
  const labels = (lots || []).filter((l) => l && l.lot_number).map((l) => `
    <div class="label">
      <div class="bc">${barcodeFor(l.lot_number)}</div>
      <div class="lotnum">${esc(l.lot_number)}</div>
      <div class="sku">${esc(l.product_sku)}</div>
      <div class="name">${esc(l.product_name)}</div>
    </div>`).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><title>Lot labels</title>
  <style>
    @page { size: ${LABEL_W}mm ${LABEL_H}mm; margin: 0; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    .label {
      width: ${LABEL_W}mm; height: ${LABEL_H}mm; padding: ${PADDING}mm;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      page-break-after: always; overflow: hidden;
      font-family: Arial, Helvetica, sans-serif; text-align: center;
    }
    .label:last-child { page-break-after: auto; }
    /* display:block so the SVG isn't an inline element — inline adds ~1mm of descender
       space below the baseline, which silently eats the stack's slack. */
    .bc svg { width: ${BARCODE_W}mm; height: ${BARCODE_H}mm; display: block; }
    .lotnum { font-family: 'Courier New', monospace; font-weight: 700; font-size: ${TEXT.lotnum.size}pt; line-height: ${TEXT.lotnum.lineHeight}; margin-top: ${TEXT.lotnum.marginTop}mm; }
    .sku { font-size: ${TEXT.sku.size}pt; line-height: ${TEXT.sku.lineHeight}; }
    .name { font-size: ${TEXT.name.size}pt; line-height: ${TEXT.name.lineHeight}; max-height: ${TEXT.name.maxHeight}mm; overflow: hidden; }
  </style></head><body>${labels}
  <script>window.onload=function(){window.focus();window.print();};</script>
  </body></html>`;
}

/** The geometry, exported so the smoke can assert it adds up. */
export const LABEL_GEOMETRY = { LABEL_W, LABEL_H, PADDING, BARCODE_W, BARCODE_H, TEXT };

// lots: array of { lot_number, product_sku, product_name }
export function printLotLabels(lots) {
  // buildLotLabelsHtml filters too; this early return just avoids opening an empty popup.
  const list = (lots || []).filter((l) => l && l.lot_number);
  if (!list.length) return;

  const html = buildLotLabelsHtml(list, barcodeSvgString);

  // Roughly the sticker's aspect, scaled up with the stock (was 420×320 for 50×30).
  const w = window.open('', '_blank', 'width=660,height=500');
  if (!w) {
    alert('Please allow pop-ups to print lot labels.');
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
}
