/**
 * Shared print primitives.
 *
 * Every printable document is plain HTML + CSS so it renders identically in the
 * Electron print window, in a browser preview and in a PDF export. Nothing here
 * touches the database — callers pass data in, which makes the whole print layer
 * unit-testable.
 */

export type PageSize = 'a4' | 'a5' | '58mm' | '80mm';

export function printEscapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const BN_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];

export function bn(value: string | number): string {
  return String(value).replace(/[0-9]/g, (d) => BN_DIGITS[Number(d)]!);
}

/** Uses the Western grouping Bangladesh actually writes on invoices. */
export function groupDigits(n: number): string {
  const neg = n < 0;
  const s = Math.abs(Math.round(n)).toString();
  if (s.length <= 3) return (neg ? '-' : '') + s;
  const last3 = s.slice(-3);
  let rest = s.slice(0, -3);
  rest = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return (neg ? '-' : '') + rest + ',' + last3;
}

export interface PrintFormat {
  currency: string;
  bengaliDigits: 0 | 1;
}

export function money(paisa: number | null | undefined, fmt: PrintFormat): string {
  const value = Number(paisa ?? 0) / 100;
  const text = value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${fmt.bengaliDigits ? bn(text) : text}`;
}

export function moneyWithSymbol(paisa: number | null | undefined, fmt: PrintFormat): string {
  return `${fmt.currency}${money(paisa, fmt)}`;
}

export function qty(milli: number | null | undefined, fmt: PrintFormat): string {
  const value = Number(milli ?? 0) / 1000;
  const text = Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  return fmt.bengaliDigits ? bn(text) : text;
}

export function dateText(value: string | null | undefined, fmt: PrintFormat): string {
  if (!value) return '—';
  const date = value.slice(0, 10).split('-');
  if (date.length !== 3) return printEscapeHtml(value);
  const text = `${date[2]}/${date[1]}/${date[0]}`;
  return fmt.bengaliDigits ? bn(text) : text;
}

export function dateTimeText(value: string | null | undefined, fmt: PrintFormat): string {
  if (!value) return '—';
  const [d, t = ''] = value.split(' ');
  return `${dateText(d, fmt)}${t ? ' ' + (fmt.bengaliDigits ? bn(t.slice(0, 5)) : t.slice(0, 5)) : ''}`;
}

export interface BrandInfo {
  name: string;
  address?: string;
  phone?: string;
  email?: string;
  website?: string;
  logoDataUrl?: string | null;
  footer?: string;
  documentFooter?: string;
}

export interface DocMeta {
  title: string;
  number?: string;
  date?: string;
  size?: PageSize;
  /** Extra line under the title (e.g. "সাপ্লায়ার: রহিম ট্রেডার্স"). */
  subtitle?: string;
  /** Right-aligned meta rows in the header block. */
  meta?: { label: string; value: string }[];
  footerNote?: string;
  showSignature?: boolean;
  signatureLabels?: [string, string];
  copyOf?: string | null;
  /** Text shown when the document has no rows. */
  emptyText?: string;
}

const PAGE_CSS: Record<PageSize, string> = {
  a4: '@page { size: A4; margin: 12mm 10mm 14mm 10mm; }',
  a5: '@page { size: A5; margin: 8mm 8mm 10mm 8mm; }',
  '58mm': '@page { size: 58mm auto; margin: 2mm; }',
  '80mm': '@page { size: 80mm auto; margin: 3mm; }',
};

const BASE_CSS = `
:root{
  --ink:#111827; --muted:#667085; --line:#d0d5dd; --line-soft:#e5e7eb;
  --brand:#0b5d52; --danger:#b42318; --surface:#fff; --zebra:#f7f9f9;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;color:var(--ink);background:#fff;
  font-family:'Noto Sans Bengali','Nirmala UI','Segoe UI',Arial,sans-serif;
  -webkit-print-color-adjust:exact; print-color-adjust:exact;}
body{font-size:10.5pt;line-height:1.45}
.num{font-variant-numeric:tabular-nums; font-feature-settings:'tnum' 1}
table{width:100%;border-collapse:collapse}
thead{display:table-header-group}
tr{break-inside:avoid; page-break-inside:avoid}
th,td{padding:4.5pt 5pt;text-align:left;vertical-align:top}
thead th{font-size:8.6pt;letter-spacing:.03em;text-transform:uppercase;color:var(--muted);
  border-bottom:1px solid var(--line);font-weight:600}
tbody tr:nth-child(even){background:var(--zebra)}
td.r,th.r{text-align:right}
td.c,th.c{text-align:center}
.totals{margin-top:8pt;display:flex;justify-content:flex-end}
.totals table{width:58%;min-width:200pt}
.totals td{padding:2.5pt 5pt}
.totals tr.grand td{border-top:1.2pt solid var(--ink);font-weight:700;font-size:11.5pt;padding-top:5pt}
.muted{color:var(--muted)}
.small{font-size:8.6pt}
.tiny{font-size:7.6pt}
.bold{font-weight:600}
.center{text-align:center}
.right{text-align:right}
.nowrap{white-space:nowrap}
.doc-foot{margin-top:14pt;padding-top:6pt;border-top:1px solid var(--line-soft);
  color:var(--muted);font-size:8pt;display:flex;justify-content:space-between;gap:8pt}
.sign{display:flex;justify-content:space-between;gap:24pt;margin-top:26pt}
.sign div{flex:1;border-top:1px solid var(--line);padding-top:4pt;text-align:center;font-size:8.5pt;color:var(--muted)}
.pill{display:inline-block;padding:1pt 6pt;border-radius:999px;border:1px solid var(--line);
  font-size:8pt;color:var(--muted)}
.pill.danger{color:var(--danger);border-color:#f3c0bb}
.empty{padding:18pt 0;text-align:center;color:var(--muted);font-size:9pt}
`;

function brandBlock(brand: BrandInfo, size: PageSize, compact: boolean): string {
  const logo = brand.logoDataUrl
    ? `<img class="logo" src="${printEscapeHtml(brand.logoDataUrl)}" alt="" />`
    : '';
  const contact = [brand.address, brand.phone ? `ফোন: ${brand.phone}` : '', brand.email, brand.website]
    .filter(Boolean)
    .join(' • ');
  if (compact) {
    return `<div class="brand compact">
      ${logo}
      <div class="biz-name">${printEscapeHtml(brand.name)}</div>
      ${contact ? `<div class="biz-contact">${printEscapeHtml(contact)}</div>` : ''}
    </div>`;
  }
  return `<header class="brand">
    ${logo}
    <div class="biz-text">
      <div class="biz-name">${printEscapeHtml(brand.name)}</div>
      ${contact ? `<div class="biz-contact">${printEscapeHtml(contact)}</div>` : ''}
    </div>
  </header>`;
}

const A4_BRAND_CSS = `
.brand{display:flex;align-items:flex-start;gap:12pt;padding-bottom:9pt;border-bottom:2pt solid var(--brand);margin-bottom:11pt}
.brand .logo{max-height:52pt;max-width:130pt;object-fit:contain}
.brand .biz-name{font-size:17pt;font-weight:700;letter-spacing:-.01em;line-height:1.15;color:var(--brand)}
.brand .biz-contact{font-size:8.6pt;color:var(--muted);margin-top:2pt}
.doc-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16pt;margin-bottom:10pt}
.doc-title{font-size:14pt;font-weight:700;margin:0;letter-spacing:-.01em}
.doc-sub{font-size:9pt;color:var(--muted);margin-top:2pt}
.doc-meta{min-width:180pt}
.doc-meta table{width:auto;margin-left:auto}
.doc-meta td{padding:1.5pt 0 1.5pt 12pt;font-size:9pt}
.doc-meta td.k{color:var(--muted)}
.copy{float:right;border:1px solid var(--line);border-radius:3pt;padding:1pt 6pt;font-size:8pt;color:var(--muted)}
`;

const THERMAL_BRAND_CSS = `
.brand.compact{text-align:center;margin-bottom:4mm}
.brand.compact .logo{max-height:14mm;max-width:38mm;object-fit:contain;display:block;margin:0 auto 1.5mm}
.biz-name{font-size:12pt;font-weight:700;line-height:1.2}
.biz-contact{font-size:7.6pt;color:#333;margin-top:.6mm;line-height:1.3}
.copy{margin-top:1mm;font-size:7.5pt}
`;

export interface ShellOptions {
  brand: BrandInfo;
  meta: DocMeta;
  body: string;
  /** Extra CSS appended after the shared sheet. */
  css?: string;
  /** Shown on the right of the footer; defaults to the app name. */
  credit?: string;
  totalPages?: number;
}

/** Wraps a document body in the full printable shell. */
export function documentShell(opts: ShellOptions): string {
  const size = opts.meta.size ?? 'a4';
  const compact = size === '58mm' || size === '80mm';
  const fmt = { currency: '৳', bengaliDigits: 0 as const };
  const metaRows = (opts.meta.meta ?? [])
    .map(
      (m) =>
        `<tr><td class="k">${printEscapeHtml(m.label)}</td><td class="right num">${printEscapeHtml(m.value)}</td></tr>`,
    )
    .join('');
  const metaBlock = metaRows
    ? `<div class="doc-meta"><table>${metaRows}</table></div>`
    : '';
  const copy = opts.meta.copyOf ? `<span class="copy">${printEscapeHtml(opts.meta.copyOf)}</span>` : '';
  const head = compact
    ? `<div class="center"><div class="doc-title">${printEscapeHtml(opts.meta.title)}</div>
        ${opts.meta.subtitle ? `<div class="doc-sub">${printEscapeHtml(opts.meta.subtitle)}</div>` : ''}</div>`
    : `<div class="doc-head">
        <div>
          <h1 class="doc-title">${printEscapeHtml(opts.meta.title)}</h1>
          ${opts.meta.subtitle ? `<div class="doc-sub">${printEscapeHtml(opts.meta.subtitle)}</div>` : ''}
        </div>
        ${metaBlock}
      </div>`;
  const signature =
    opts.meta.showSignature === false
      ? ''
      : `<div class="sign">
          <div>${printEscapeHtml(opts.meta.signatureLabels?.[0] ?? 'প্রস্তুতকারী')}</div>
          <div>${printEscapeHtml(opts.meta.signatureLabels?.[1] ?? 'গ্রহণকারী')}</div>
        </div>`;
  const footNote = opts.meta.footerNote
    ? `<div class="small muted" style="margin-top:8pt">${printEscapeHtml(opts.meta.footerNote)}</div>`
    : '';
  const footer = compact
    ? `<div class="doc-foot compact muted center">${printEscapeHtml(opts.brand.footer ?? 'ধন্যবাদ! আবার আসবেন।')}</div>`
    : `<div class="doc-foot">
        <span>${printEscapeHtml(opts.brand.name)}${opts.brand.documentFooter ? ' — ' + printEscapeHtml(opts.brand.documentFooter) : ''}</span>
        <span>${printEscapeHtml(opts.credit ?? 'Sauda Retail Suite')}${opts.totalPages ? ` • ${totalPagesText(opts.totalPages, fmt)}` : ''}</span>
      </div>`;

  return `<!doctype html>
<html lang="bn">
<head>
<meta charset="utf-8" />
<title>${printEscapeHtml(opts.meta.title)}${opts.meta.number ? ' — ' + printEscapeHtml(opts.meta.number) : ''}</title>
<style>
${PAGE_CSS[size]}
${BASE_CSS}
${compact ? THERMAL_BRAND_CSS : A4_BRAND_CSS}
${opts.css ?? ''}
</style>
</head>
<body>
${copy}
${brandBlock(opts.brand, size, compact)}
${head}
${opts.body || `<div class="empty">${printEscapeHtml(opts.meta.emptyText ?? 'কোনো তথ্য নেই।')}</div>`}
${footNote}
${signature}
${footer}
</body>
</html>`;
}

function totalPagesText(n: number, fmt: PrintFormat): string {
  const text = `${n} পৃষ্ঠা`;
  return fmt.bengaliDigits ? bn(text) : text;
}

/* ------------------------------------------------------------------ */
/* Tables                                                              */
/* ------------------------------------------------------------------ */

export type Align = 'left' | 'right' | 'center';

export interface TableColumn {
  label: string;
  align?: Align;
  width?: string;
  /** Small caption printed under the header cell. */
  hint?: string;
}

export function table(
  columns: TableColumn[],
  rows: (string | number | null | undefined)[][],
  opts: { emptyText?: string; totalsRow?: (string | number | null | undefined)[]; className?: string } = {},
): string {
  const head = columns
    .map(
      (c) =>
        `<th class="${c.align === 'right' ? 'r' : c.align === 'center' ? 'c' : ''}"${
          c.width ? ` style="width:${printEscapeHtml(c.width)}"` : ''
        }>${printEscapeHtml(c.label)}${c.hint ? `<div class="tiny muted" style="font-weight:400">${printEscapeHtml(c.hint)}</div>` : ''}</th>`,
    )
    .join('');
  if (!rows.length) {
    return `<table class="${opts.className ?? ''}"><thead><tr>${head}</tr></thead></table>
      <div class="empty">${printEscapeHtml(opts.emptyText ?? 'কোনো তথ্য নেই।')}</div>`;
  }
  const body = rows
    .map(
      (row) =>
        `<tr>${row
          .map((cell, i) => {
            const align = columns[i]?.align;
            return `<td class="${align === 'right' ? 'r num' : align === 'center' ? 'c' : ''}">${cell ?? ''}</td>`;
          })
          .join('')}</tr>`,
    )
    .join('');
  const totals = opts.totalsRow
    ? `<tfoot><tr class="bold">${opts.totalsRow
        .map((cell, i) => {
          const align = columns[i]?.align;
          return `<td class="${align === 'right' ? 'r num' : align === 'center' ? 'c' : ''}" style="border-top:1.2pt solid var(--ink)">${cell ?? ''}</td>`;
        })
        .join('')}</tr></tfoot>`
    : '';
  return `<table class="${opts.className ?? ''}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${totals}</table>`;
}

export interface TotalLine {
  label: string;
  value: string;
  grand?: boolean;
  muted?: boolean;
}

export function totalsBlock(lines: TotalLine[]): string {
  if (!lines.length) return '';
  const rows = lines
    .map(
      (l) =>
        `<tr class="${l.grand ? 'grand' : ''}${l.muted ? ' muted' : ''}"><td>${printEscapeHtml(l.label)}</td><td class="r num">${printEscapeHtml(l.value)}</td></tr>`,
    )
    .join('');
  return `<div class="totals"><table>${rows}</table></div>`;
}

/** Two-column info grid used for "bill to" / "supplier" blocks. */
export function infoGrid(blocks: { title: string; lines: (string | null | undefined)[] }[]): string {
  const cells = blocks
    .map(
      (b) => `<div class="info-block">
        <div class="info-title">${printEscapeHtml(b.title)}</div>
        ${b.lines
          .filter((x) => x !== null && x !== undefined && String(x).trim() !== '')
          .map((x) => `<div class="info-line">${printEscapeHtml(x)}</div>`)
          .join('')}
      </div>`,
    )
    .join('');
  return `<div class="info-grid">${cells}</div>`;
}

export const INFO_CSS = `
.info-grid{display:flex;gap:18pt;margin:0 0 10pt}
.info-block{flex:1;border:1px solid var(--line-soft);border-radius:4pt;padding:7pt 9pt;background:#fcfdfd}
.info-title{font-size:8pt;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:3pt}
.info-line{font-size:9.4pt;line-height:1.5}
`;
