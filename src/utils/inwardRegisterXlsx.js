// Dependency-free .xlsx writer for the Inward Equipment Register export.
//
// Produces a real OOXML (.xlsx) workbook entirely in the browser — no SheetJS /
// exceljs dependency (avoids bundle bloat and the deprecated-`xlsx` npm CVE).
// The generated file is a minimal, valid SpreadsheetML package inside a STORED
// (uncompressed) ZIP. Verified to open in Excel and in openpyxl.
//
// Layout mirrors the "Inward goods green docket" template:
//   Row 1  INWARD EQUIPMENT REGISTER            (bold title)
//   Row 2  Date Collecting: <dd/mm/yyyy>
//   Row 3  Gym Equipment was Collected from: <name>
//   Row 4  Qty | Item | Lot Number - Notes      (bold header)
//   Row 5+ <qty> | <item> | <lot numbers / notes>

const xmlEscape = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function colLetter(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; }
  return s;
}

// rows: array of arrays of cells. cell = null | { v, t: 's' | 'n', s?: styleIdx }
function sheetXml(rows, widths) {
  let o = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  o += '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';
  o += '<cols>' + widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>';
  o += '<sheetData>';
  rows.forEach((cells, ri) => {
    const r = ri + 1;
    o += `<row r="${r}">`;
    cells.forEach((cell, ci) => {
      if (cell == null || cell.v === '' || cell.v == null) return;
      const ref = colLetter(ci + 1) + r;
      const s = cell.s ? ` s="${cell.s}"` : '';
      if (cell.t === 'n') o += `<c r="${ref}"${s}><v>${Number(cell.v)}</v></c>`;
      else o += `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(cell.v)}</t></is></c>`;
    });
    o += '</row>';
  });
  o += '</sheetData></worksheet>';
  return o;
}

const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="3">' +
  '<font><sz val="11"/><name val="Calibri"/></font>' +
  '<font><b/><sz val="14"/><name val="Calibri"/></font>' +
  '<font><b/><sz val="11"/><name val="Calibri"/></font>' +
  '</fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="3">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
  '</Types>';

const RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  '</Relationships>';

function workbookXml(sheetName) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets><sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
}

const WORKBOOK_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  '</Relationships>';

// ---- tiny STORED (uncompressed) ZIP ----
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function concat(list) {
  let n = 0; for (const a of list) n += a.length;
  const out = new Uint8Array(n); let o = 0;
  for (const a of list) { out.set(a, o); o += a.length; }
  return out;
}
const u16 = (n) => new Uint8Array([n & 255, (n >>> 8) & 255]);
const u32 = (n) => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);

function zipStore(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameB = enc.encode(f.name);
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    // local file header (DOS date 1980-01-01 = 33, time 0)
    const lh = concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(33),
      u32(crc), u32(data.length), u32(data.length), u16(nameB.length), u16(0), nameB,
    ]);
    parts.push(lh, data);
    central.push(concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(33),
      u32(crc), u32(data.length), u32(data.length),
      u16(nameB.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameB,
    ]));
    offset += lh.length + data.length;
  }
  const centralBytes = concat(central);
  const eocd = concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(centralBytes.length), u32(offset), u16(0),
  ]);
  return concat([...parts, centralBytes, eocd]);
}

/**
 * Build the Inward Equipment Register workbook as a Uint8Array of .xlsx bytes.
 * @param {Object}   p
 * @param {string}   p.collectedFrom  supplier / location name
 * @param {string}   p.dateStr        collecting date, already formatted (dd/mm/yyyy)
 * @param {Array<{qty:number,item:string,notes:string}>} p.rows
 * @param {string}  [p.sheetName]
 */
export function buildInwardRegisterXlsx({ collectedFrom, dateStr, rows, sheetName = 'Inward Equip' }) {
  const S_TITLE = 1, S_HEAD = 2;
  const grid = [];
  grid.push([{ v: 'INWARD EQUIPMENT REGISTER', t: 's', s: S_TITLE }]);
  grid.push([{ v: `Date Collecting: ${dateStr || ''}`, t: 's' }]);
  grid.push([{ v: `Gym Equipment was Collected from: ${collectedFrom || ''}`, t: 's' }]);
  grid.push([
    { v: 'Qty', t: 's', s: S_HEAD },
    { v: 'Item', t: 's', s: S_HEAD },
    { v: 'Lot Number - Notes', t: 's', s: S_HEAD },
  ]);
  for (const r of rows || []) {
    grid.push([
      { v: Number(r.qty || 0), t: 'n' },
      { v: r.item || '', t: 's' },
      { v: r.notes || '', t: 's' },
    ]);
  }
  const sheet = sheetXml(grid, [8, 52, 34]);
  return zipStore([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: RELS },
    { name: 'xl/workbook.xml', data: workbookXml(sheetName) },
    { name: 'xl/_rels/workbook.xml.rels', data: WORKBOOK_RELS },
    { name: 'xl/styles.xml', data: STYLES_XML },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ]);
}

/** Build the workbook and trigger a browser download. */
export function downloadInwardRegisterXlsx({ collectedFrom, dateStr, rows, fileName, sheetName }) {
  const bytes = buildInwardRegisterXlsx({ collectedFrom, dateStr, rows, sheetName });
  const blob = new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName || 'inward-equipment-register.xlsx';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
