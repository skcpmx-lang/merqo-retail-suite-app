import { zipSync, strToU8 } from 'fflate';
import { csvCell, normalizeText } from '../domain/text.js';
import { formatPaisa } from '../domain/money.js';
import type { ReportColumn } from '../domain/types.js';

export interface ExportTable {
  name: string;
  columns: ReportColumn[];
  rows: Record<string, any>[];
  totals?: Record<string, number | string>;
}

function cellText(col: ReportColumn, value: unknown): string {
  if (value === null || value === undefined) return '';
  if (col.format === 'money') return String(Number(value) / 100);
  if (col.format === 'qty') return String(Number(value) / 1000);
  if (col.format === 'percent') return String(Number(value) / 100);
  return normalizeText(String(value));
}

/** UTF-8 CSV with BOM so Excel opens Bangla correctly. */
export function tableToCsv(table: ExportTable): string {
  const lines: string[] = [];
  lines.push(table.columns.map((c) => csvCell(c.label)).join(','));
  for (const row of table.rows) {
    lines.push(table.columns.map((c) => csvCell(cellText(c, row[c.key]))).join(','));
  }
  if (table.totals) {
    const totalLine = table.columns.map((c) => {
      const v = table.totals?.[c.key];
      return csvCell(v === undefined ? '' : c.format === 'money' ? String(Number(v) / 100) : String(v));
    });
    totalLine[0] = csvCell('সর্বমোট');
    lines.push(totalLine.join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export function moneyText(paisa: number): string {
  return formatPaisa(paisa);
}

/* ------------------------------------------------------------------ */
/* Minimal, standards-compliant XLSX writer (no external binary deps)  */
/* ------------------------------------------------------------------ */

function escXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // strip control characters that break XML
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

function colName(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function sheetXml(table: ExportTable): string {
  const rowsXml: string[] = [];
  const headerCells = table.columns
    .map((c, i) => `<c r="${colName(i)}1" t="inlineStr" s="1"><is><t>${escXml(c.label)}</t></is></c>`)
    .join('');
  rowsXml.push(`<row r="1">${headerCells}</row>`);
  table.rows.forEach((row, rIdx) => {
    const r = rIdx + 2;
    const cells = table.columns
      .map((c, cIdx) => {
        const raw = row[c.key];
        const ref = `${colName(cIdx)}${r}`;
        if (raw === null || raw === undefined || raw === '') return '';
        const isNumber = c.format === 'money' || c.format === 'qty' || c.format === 'int' || c.format === 'percent';
        if (isNumber && Number.isFinite(Number(raw))) {
          const value =
            c.format === 'money' ? Number(raw) / 100 : c.format === 'qty' ? Number(raw) / 1000 : c.format === 'percent' ? Number(raw) / 100 : Number(raw);
          return `<c r="${ref}"><v>${value}</v></c>`;
        }
        return `<c r="${ref}" t="inlineStr"><is><t>${escXml(String(raw))}</t></is></c>`;
      })
      .join('');
    rowsXml.push(`<row r="${r}">${cells}</row>`);
  });
  if (table.totals) {
    const r = table.rows.length + 2;
    const cells = table.columns
      .map((c, cIdx) => {
        if (cIdx === 0) return `<c r="${colName(0)}${r}" t="inlineStr" s="1"><is><t>সর্বমোট</t></is></c>`;
        const v = table.totals?.[c.key];
        if (v === undefined) return '';
        const num = c.format === 'money' ? Number(v) / 100 : c.format === 'qty' ? Number(v) / 1000 : Number(v);
        return `<c r="${colName(cIdx)}${r}" s="1"><v>${num}</v></c>`;
      })
      .join('');
    rowsXml.push(`<row r="${r}">${cells}</row>`);
  }
  const widths = table.columns
    .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.max(12, Math.min(46, (c.width ?? 120) / 7))}" customWidth="1"/>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetPr><outlinePr summaryBelow="1" summaryRight="1"/></sheetPr>
<cols>${widths}</cols>
<sheetData>${rowsXml.join('')}</sheetData>
</worksheet>`;
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Nirmala UI"/></font><font><b/><sz val="11"/><name val="Nirmala UI"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/** Build a valid .xlsx workbook from one or more tables. */
export function tablesToXlsx(tables: ExportTable[]): Uint8Array {
  const sheets = tables.length ? tables : [{ name: 'Sheet1', columns: [], rows: [] }];
  const files: Record<string, Uint8Array> = {};
  const sheetEntries = sheets
    .map((t, i) => {
      const safeName = escXml((t.name || `Sheet${i + 1}`).replace(/[\\/*?:[\]]/g, ' ').slice(0, 31));
      return { name: safeName || `Sheet${i + 1}`, xml: sheetXml(t), index: i + 1 };
    });

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheetEntries
  .map(
    (s) =>
      `<Override PartName="/xl/worksheets/sheet${s.index}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  )
  .join('')}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheetEntries.map((s) => `<sheet name="${s.name}" sheetId="${s.index}" r:id="rId${s.index}"/>`).join('')}</sheets>
</workbook>`;

  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheetEntries
  .map(
    (s) =>
      `<Relationship Id="rId${s.index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${s.index}.xml"/>`,
  )
  .join('')}
<Relationship Id="rId${sheetEntries.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  files['[Content_Types].xml'] = strToU8(contentTypes);
  files['_rels/.rels'] = strToU8(rels);
  files['xl/workbook.xml'] = strToU8(workbook);
  files['xl/_rels/workbook.xml.rels'] = strToU8(wbRels);
  files['xl/styles.xml'] = strToU8(STYLES_XML);
  for (const s of sheetEntries) files[`xl/worksheets/sheet${s.index}.xml`] = strToU8(s.xml);

  return zipSync(files, { level: 6 });
}

/* ------------------------------------------------------------------ */
/* CSV parsing (RFC 4180, tolerant of BOM + CRLF)                      */
/* ------------------------------------------------------------------ */

export function parseCsv(text: string, maxRows = 50_000): { headers: string[]; rows: string[][] } {
  const clean = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && clean[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      if (rows.length > maxRows) throw new Error(`ফাইলে খুব বেশি ডেটা (সর্বোচ্চ ${maxRows} লাইন)।`);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.some((c) => c.trim() !== '')) rows.push(row);
  }
  if (!rows.length) throw new Error('ফাইলটি খালি।');
  const headers = (rows.shift() ?? []).map((h) => normalizeText(h));
  return { headers, rows };
}
