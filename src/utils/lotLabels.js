// G4 — printable lot labels for the HotLabel HL-M6 (50 mm × 30 mm).
// Generates a Code 128 barcode of the lot number (universal for USB scanners)
// plus a human-readable lot number, SKU and product name, then opens a print
// window sized to the sticker. The barcode SVG is generated in-app and injected
// as self-contained markup, so the print window needs no scripts/libraries.
import JsBarcode from 'jsbarcode';

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

// lots: array of { lot_number, product_sku, product_name }
export function printLotLabels(lots) {
  const list = (lots || []).filter((l) => l && l.lot_number);
  if (!list.length) return;

  const labels = list.map((l) => `
    <div class="label">
      <div class="bc">${barcodeSvgString(l.lot_number)}</div>
      <div class="lotnum">${esc(l.lot_number)}</div>
      <div class="sku">${esc(l.product_sku)}</div>
      <div class="name">${esc(l.product_name)}</div>
    </div>`).join('');

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Lot labels</title>
  <style>
    @page { size: 50mm 30mm; margin: 0; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    .label {
      width: 50mm; height: 30mm; padding: 1.5mm;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      page-break-after: always; overflow: hidden;
      font-family: Arial, Helvetica, sans-serif; text-align: center;
    }
    .label:last-child { page-break-after: auto; }
    .bc svg { width: 44mm; height: 11mm; }
    .lotnum { font-family: 'Courier New', monospace; font-weight: 700; font-size: 12pt; line-height: 1; margin-top: 0.5mm; }
    .sku { font-size: 7pt; line-height: 1.1; }
    .name { font-size: 6pt; line-height: 1.05; max-height: 6mm; overflow: hidden; }
  </style></head><body>${labels}
  <script>window.onload=function(){window.focus();window.print();};</script>
  </body></html>`;

  const w = window.open('', '_blank', 'width=420,height=320');
  if (!w) {
    alert('Please allow pop-ups to print lot labels.');
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
}
