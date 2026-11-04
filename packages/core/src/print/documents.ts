import type { BrandInfo, PrintFormat } from './base.js';
import {
  INFO_CSS,
  documentShell,
  printEscapeHtml,
  infoGrid,
  money,
  moneyWithSymbol,
  qty,
  table,
  totalsBlock,
  dateText,
  dateTimeText,
} from './base.js';

export interface DocFormat extends PrintFormat {
  currency: string;
  bengaliDigits: 0 | 1;
}

export interface DocLine {
  name: string;
  sku?: string | null;
  unit?: string | null;
  qtyMilli: number;
  unitPricePaisa: number;
  discountPaisa?: number;
  totalPaisa: number;
}

export interface PartyBlock {
  title: string;
  name?: string | null;
  phone?: string | null;
  address?: string | null;
  extra?: (string | null | undefined)[];
}

function party(block: PartyBlock): { title: string; lines: (string | null | undefined)[] } {
  return {
    title: block.title,
    lines: [block.name || 'ওয়াক-ইন কাস্টমার', block.phone ? `ফোন: ${block.phone}` : null, block.address, ...(block.extra ?? [])],
  };
}

function lineTable(lines: DocLine[], fmt: DocFormat, opts: { showDiscount?: boolean } = {}): string {
  const columns = [
    { label: '#', width: '5%', align: 'right' as const },
    { label: 'বিবরণ' },
    { label: 'পরিমাণ', align: 'right' as const, width: '13%' },
    { label: 'দর', align: 'right' as const, width: '15%' },
    ...(opts.showDiscount ? [{ label: 'ছাড়', align: 'right' as const, width: '11%' }] : []),
    { label: 'মোট', align: 'right' as const, width: '16%' },
  ];
  const rows = lines.map((l, i) => [
    String(i + 1),
    `${printEscapeHtml(l.name)}${l.sku ? `<div class="tiny muted">${printEscapeHtml(l.sku)}</div>` : ''}`,
    `${printEscapeHtml(qty(l.qtyMilli, fmt))}${l.unit ? ` ${printEscapeHtml(l.unit)}` : ''}`,
    printEscapeHtml(money(l.unitPricePaisa, fmt)),
    ...(opts.showDiscount ? [l.discountPaisa ? printEscapeHtml(money(l.discountPaisa, fmt)) : '—'] : []),
    printEscapeHtml(money(l.totalPaisa, fmt)),
  ]);
  return table(columns, rows, { emptyText: 'কোনো লাইন নেই।' });
}

/* ------------------------------------------------------------------ */
/* Sales invoice / money receipt (A4)                                  */
/* ------------------------------------------------------------------ */

export interface InvoiceDoc {
  title?: string;
  number: string;
  date: string;
  status?: string;
  party: PartyBlock;
  lines: DocLine[];
  subtotalPaisa: number;
  discountPaisa: number;
  couponCode?: string | null;
  couponDiscountPaisa?: number;
  taxPaisa: number;
  totalPaisa: number;
  paidPaisa: number;
  duePaisa: number;
  changePaisa?: number;
  payments?: { method: string; amountPaisa: number; reference?: string | null }[];
  note?: string | null;
  cashier?: string | null;
}

export function buildInvoiceHtml(opts: {
  doc: InvoiceDoc;
  brand: BrandInfo;
  fmt: DocFormat;
  copyOf?: string | null;
  signatureLabels?: [string, string];
}): string {
  const { doc, fmt } = opts;
  const paymentLines = (doc.payments ?? [])
    .map((p) => `${printEscapeHtml(p.method)}: ${printEscapeHtml(money(p.amountPaisa, fmt))}`)
    .join(' • ');
  const body = `
  ${infoGrid([
    party(doc.party),
    {
      title: 'বিবরণ',
      lines: [
        `ইনভয়েস: ${doc.number}`,
        `তারিখ: ${dateText(doc.date, fmt)}`,
        doc.cashier ? `ক্যাশিয়ার: ${doc.cashier}` : null,
        doc.status === 'voided' ? 'অবস্থা: বাতিল' : null,
      ],
    },
  ])}
  ${lineTable(doc.lines, fmt, { showDiscount: true })}
  ${totalsBlock([
    { label: 'সাবটোটাল', value: moneyWithSymbol(doc.subtotalPaisa, fmt), muted: true },
    ...(doc.discountPaisa > 0
      ? [{ label: 'ডিসকাউন্ট', value: `- ${moneyWithSymbol(doc.discountPaisa, fmt)}`, muted: true }]
      : []),
    ...(doc.couponDiscountPaisa && doc.couponDiscountPaisa > 0
      ? [
          {
            label: `কুপন${doc.couponCode ? ` (${doc.couponCode})` : ''}`,
            value: `- ${moneyWithSymbol(doc.couponDiscountPaisa, fmt)}`,
            muted: true,
          },
        ]
      : []),
    ...(doc.taxPaisa > 0 ? [{ label: 'ভ্যাট', value: moneyWithSymbol(doc.taxPaisa, fmt), muted: true }] : []),
    { label: 'সর্বমোট', value: moneyWithSymbol(doc.totalPaisa, fmt), grand: true },
    { label: 'পরিশোধিত', value: moneyWithSymbol(doc.paidPaisa, fmt), muted: true },
    ...(doc.duePaisa > 0 ? [{ label: 'বাকি', value: moneyWithSymbol(doc.duePaisa, fmt) }] : []),
    ...(doc.changePaisa && doc.changePaisa > 0
      ? [{ label: 'ফেরত (চেঞ্জ)', value: moneyWithSymbol(doc.changePaisa, fmt), muted: true }]
      : []),
  ])}
  ${paymentLines ? `<div class="small muted" style="margin-top:6pt">পেমেন্ট — ${paymentLines}</div>` : ''}
  ${doc.note ? `<div class="small" style="margin-top:6pt">নোট: ${printEscapeHtml(doc.note)}</div>` : ''}`;

  return documentShell({
    brand: opts.brand,
    meta: {
      title: doc.title ?? 'বিক্রয় ইনভয়েস',
      number: doc.number,
      copyOf: opts.copyOf ?? null,
      signatureLabels: opts.signatureLabels ?? ['বিক্রেতা', 'কাস্টমার'],
      footerNote: 'এই ইনভয়েসটি কম্পিউটার-জেনারেটেড। মুছে ফেলা বা এডিট করা যায় না — সংশোধন শুধু রিভার্সাল এন্ট্রিতে।',
    },
    body,
    css: INFO_CSS,
  });
}

/* ------------------------------------------------------------------ */
/* Purchase order / purchase invoice                                   */
/* ------------------------------------------------------------------ */

export interface PurchaseDoc {
  title?: string;
  number: string;
  date: string;
  status?: string;
  supplier: PartyBlock;
  lines: DocLine[];
  subtotalPaisa: number;
  discountPaisa: number;
  taxPaisa: number;
  otherCostPaisa?: number;
  totalPaisa: number;
  paidPaisa: number;
  duePaisa: number;
  note?: string | null;
  expectedDate?: string | null;
  receivedPercent?: number;
}

export function buildPurchaseDocumentHtml(opts: {
  doc: PurchaseDoc;
  brand: BrandInfo;
  fmt: DocFormat;
  kind: 'purchase' | 'po' | 'return';
}): string {
  const { doc, fmt, kind } = opts;
  const title =
    doc.title ??
    (kind === 'po' ? 'পারচেজ অর্ডার' : kind === 'return' ? 'পারচেজ রিটার্ন' : 'ক্রয় ইনভয়েস');
  const meta = [
    `নং: ${doc.number}`,
    `তারিখ: ${dateText(doc.date, fmt)}`,
    doc.expectedDate ? `প্রত্যাশিত: ${dateText(doc.expectedDate, fmt)}` : null,
    kind === 'po' && doc.status ? `অবস্থা: ${statusText(doc.status)}` : null,
    kind === 'po' && doc.receivedPercent != null ? `গৃহীত: ${doc.receivedPercent}%` : null,
  ].filter(Boolean) as string[];

  const body = `
  ${infoGrid([party(doc.supplier), { title: 'বিবরণ', lines: meta }])}
  ${lineTable(doc.lines, fmt, { showDiscount: true })}
  ${totalsBlock([
    { label: 'সাবটোটাল', value: moneyWithSymbol(doc.subtotalPaisa, fmt), muted: true },
    ...(doc.discountPaisa > 0
      ? [{ label: 'ডিসকাউন্ট', value: `- ${moneyWithSymbol(doc.discountPaisa, fmt)}`, muted: true }]
      : []),
    ...(doc.otherCostPaisa && doc.otherCostPaisa > 0
      ? [{ label: 'অন্যান্য খরচ', value: moneyWithSymbol(doc.otherCostPaisa, fmt), muted: true }]
      : []),
    ...(doc.taxPaisa > 0 ? [{ label: 'ভ্যাট', value: moneyWithSymbol(doc.taxPaisa, fmt), muted: true }] : []),
    { label: 'সর্বমোট', value: moneyWithSymbol(doc.totalPaisa, fmt), grand: true },
    ...(kind === 'po'
      ? []
      : [
          { label: 'পরিশোধিত', value: moneyWithSymbol(doc.paidPaisa, fmt), muted: true },
          ...(doc.duePaisa > 0 ? [{ label: 'বাকি', value: moneyWithSymbol(doc.duePaisa, fmt) }] : []),
        ]),
  ])}
  ${doc.note ? `<div class="small" style="margin-top:6pt">নোট: ${printEscapeHtml(doc.note)}</div>` : ''}`;

  return documentShell({
    brand: opts.brand,
    meta: {
      title,
      number: doc.number,
      signatureLabels: kind === 'po' ? ['অর্ডারকারী', 'সাপ্লায়ার'] : ['গ্রহণকারী', 'সাপ্লায়ার'],
      footerNote:
        kind === 'po'
          ? 'এটি একটি অর্ডার — পণ্য গ্রহণের আগে স্টক বা হিসাব পরিবর্তন হয় না।'
          : undefined,
    },
    body,
    css: INFO_CSS,
  });
}

function statusText(status: string): string {
  switch (status) {
    case 'open':
      return 'খোলা';
    case 'partial':
      return 'আংশিক গৃহীত';
    case 'received':
      return 'সম্পূর্ণ গৃহীত';
    case 'cancelled':
      return 'বাতিল';
    default:
      return status;
  }
}

/* ------------------------------------------------------------------ */
/* Party statement / ledger                                            */
/* ------------------------------------------------------------------ */

export interface PartyStatementRow {
  date: string;
  ref: string;
  description: string;
  debitPaisa: number;
  creditPaisa: number;
  balancePaisa: number;
}

export function buildStatementHtml(opts: {
  title: string;
  partyName: string;
  partyMeta?: (string | null | undefined)[];
  from: string;
  to: string;
  openingPaisa: number;
  rows: PartyStatementRow[];
  closingPaisa: number;
  brand: BrandInfo;
  fmt: DocFormat;
}): string {
  const { fmt } = opts;
  const columns = [
    { label: 'তারিখ', width: '11%' },
    { label: 'রেফারেন্স', width: '18%' },
    { label: 'বিবরণ' },
    { label: 'ডেবিট', align: 'right' as const, width: '13%' },
    { label: 'ক্রেডিট', align: 'right' as const, width: '13%' },
    { label: 'ব্যালেন্স', align: 'right' as const, width: '15%' },
  ];
  const rows = opts.rows.map((r) => [
    printEscapeHtml(dateText(r.date, fmt)),
    printEscapeHtml(r.ref || '—'),
    printEscapeHtml(r.description),
    r.debitPaisa ? printEscapeHtml(money(r.debitPaisa, fmt)) : '',
    r.creditPaisa ? printEscapeHtml(money(r.creditPaisa, fmt)) : '',
    printEscapeHtml(money(r.balancePaisa, fmt)),
  ]);
  const body = `
  ${infoGrid([
    { title: opts.title, lines: [opts.partyName, ...(opts.partyMeta ?? [])] },
    { title: 'সময়কাল', lines: [`শুরু: ${dateText(opts.from, fmt)}`, `শেষ: ${dateText(opts.to, fmt)}`] },
  ])}
  <table>
    <tbody>
      <tr><td class="muted">প্রারম্ভিক ব্যালেন্স</td><td class="r num bold">${printEscapeHtml(moneyWithSymbol(opts.openingPaisa, fmt))}</td></tr>
    </tbody>
  </table>
  ${table(columns, rows, {
    emptyText: 'এই সময়ে কোনো লেনদেন নেই।',
    totalsRow: ['', '', 'সর্বমোট', printEscapeHtml(money(opts.rows.reduce((s, r) => s + r.debitPaisa, 0), fmt)), printEscapeHtml(money(opts.rows.reduce((s, r) => s + r.creditPaisa, 0), fmt)), ''],
  })}
  ${totalsBlock([{ label: 'সমাপনী ব্যালেন্স', value: moneyWithSymbol(opts.closingPaisa, fmt), grand: true }])}`;
  return documentShell({
    brand: opts.brand,
    meta: { title: opts.title, subtitle: opts.partyName },
    body,
    css: INFO_CSS,
  });
}

/* ------------------------------------------------------------------ */
/* Financial statements / generic report                               */
/* ------------------------------------------------------------------ */

export interface ReportDocColumn {
  label: string;
  align?: 'left' | 'right' | 'center';
  width?: string;
}

export function buildReportHtml(opts: {
  title: string;
  subtitle?: string;
  columns: ReportDocColumn[];
  rows: string[][];
  totals?: string[] | null;
  brand: BrandInfo;
  note?: string | null;
  landscape?: boolean;
  summary?: { label: string; value: string }[];
}): string {
  const body = `
  ${opts.summary?.length ? `<div class="summary">${opts.summary
    .map((s) => `<div><span class="k">${printEscapeHtml(s.label)}</span><span class="v num">${printEscapeHtml(s.value)}</span></div>`)
    .join('')}</div>` : ''}
  ${table(opts.columns, opts.rows, { emptyText: 'এই সময়ের জন্য কোনো তথ্য নেই।', totalsRow: opts.totals ?? undefined })}
  ${opts.note ? `<div class="small muted" style="margin-top:8pt">${printEscapeHtml(opts.note)}</div>` : ''}
  <div class="doc-foot"><span>${printEscapeHtml(opts.brand.name)}</span><span>তৈরি: ${new Date().toLocaleString('en-GB')}</span></div>`;
  return documentShell({
    brand: opts.brand,
    meta: { title: opts.title, subtitle: opts.subtitle, showSignature: false },
    body,
    css: `
      ${opts.landscape ? '@page { size: A4 landscape; margin: 10mm; }' : ''}
      body{font-size:9pt}
      th,td{padding:3.6pt 5pt}
      .summary{display:flex;gap:14pt;margin-bottom:9pt;flex-wrap:wrap}
      .summary>div{border:1px solid var(--line-soft);border-radius:3pt;padding:5pt 9pt;min-width:120pt;display:flex;justify-content:space-between;gap:12pt}
      .summary .k{color:var(--muted);font-size:8.4pt}
      .summary .v{font-weight:700;font-size:10.5pt}
    `,
  });
}

/* ------------------------------------------------------------------ */
/* Stock documents (transfer / count / valuation)                      */
/* ------------------------------------------------------------------ */

export function buildStockDocumentHtml(opts: {
  kind: 'transfer' | 'count' | 'valuation';
  title: string;
  number: string;
  date: string;
  fromLocation?: string | null;
  toLocation?: string | null;
  lines: { name: string; sku?: string | null; sentMilli?: number; countedMilli?: number; diffMilli?: number; valuePaisa?: number; unit?: string | null }[];
  brand: BrandInfo;
  fmt: DocFormat;
  note?: string | null;
  totalValuePaisa?: number;
}): string {
  const { fmt } = opts;
  const head = [
    { label: '#', align: 'right' as const, width: '5%' },
    { label: 'প্রোডাক্ট' },
    ...(opts.kind === 'transfer' ? [{ label: 'পরিমাণ', align: 'right' as const, width: '16%' }] : []),
    ...(opts.kind === 'count'
      ? [
          { label: 'গণনা', align: 'right' as const, width: '14%' },
          { label: 'পার্থক্য', align: 'right' as const, width: '14%' },
        ]
      : []),
    ...(opts.kind === 'valuation' ? [{ label: 'মূল্য', align: 'right' as const, width: '18%' }] : []),
  ];
  const rows = opts.lines.map((l, i) => [
    String(i + 1),
    `${printEscapeHtml(l.name)}${l.sku ? `<div class="tiny muted">${printEscapeHtml(l.sku)}</div>` : ''}`,
    ...(opts.kind === 'transfer' ? [`${printEscapeHtml(qty(l.sentMilli ?? 0, fmt))} ${printEscapeHtml(l.unit ?? '')}`] : []),
    ...(opts.kind === 'count'
      ? [
          printEscapeHtml(qty(l.countedMilli ?? 0, fmt)),
          printEscapeHtml(qty(l.diffMilli ?? 0, fmt)),
        ]
      : []),
    ...(opts.kind === 'valuation' ? [printEscapeHtml(money(l.valuePaisa ?? 0, fmt))] : []),
  ]);
  const body = `
  ${infoGrid([
    { title: 'তথ্য', lines: [`নং: ${opts.number}`, `তারিখ: ${dateText(opts.date, fmt)}`] },
    {
      title: opts.kind === 'transfer' ? 'গন্তব্য' : 'অবস্থান',
      lines: [opts.fromLocation ?? 'প্রধান গুদাম', opts.toLocation ?? ''],
    },
  ])}
  ${table(head, rows)}
  ${
    opts.totalValuePaisa != null
      ? totalsBlock([{ label: 'মোট মূল্য', value: moneyWithSymbol(opts.totalValuePaisa, fmt), grand: true }])
      : ''
  }
  ${opts.note ? `<div class="small" style="margin-top:6pt">নোট: ${printEscapeHtml(opts.note)}</div>` : ''}`;
  return documentShell({
    brand: opts.brand,
    meta: { title: opts.title, number: opts.number, signatureLabels: ['প্রস্তুতকারী', 'অনুমোদনকারী'] },
    body,
    css: INFO_CSS,
  });
}

/* ------------------------------------------------------------------ */
/* Licence document (customer copy)                                    */
/* ------------------------------------------------------------------ */

export function buildLicenseDocumentHtml(opts: {
  org: string;
  licenseId: string;
  edition: string;
  issuedAt: string;
  expiresAt: string | null;
  maxDevices: number;
  features: string[];
  fingerprint: string;
  keyId: string;
  brand: BrandInfo;
  version: string;
}): string {
  const body = `
  ${infoGrid([
    { title: 'লাইসেন্সধারী', lines: [opts.org] },
    { title: 'লাইসেন্স', lines: [`আইডি: ${opts.licenseId}`, `সংস্করণ: ${opts.edition}`, `কী: ${opts.keyId}`] },
  ])}
  ${table(
    [
      { label: 'বিবরণ' },
      { label: 'মান', align: 'right' as const, width: '40%' },
    ],
    [
      ['ইস্যু তারিখ', printEscapeHtml(opts.issuedAt.slice(0, 10))],
      ['মেয়াদ', opts.expiresAt ? printEscapeHtml(opts.expiresAt.slice(0, 10)) : 'আজীবন'],
      ['ডিভাইস সীমা', String(opts.maxDevices)],
      ['হার্ডওয়্যার ফিঙ্গারপ্রিন্ট', `<span class="tiny">${printEscapeHtml(opts.fingerprint)}</span>`],
      ['সফটওয়্যার সংস্করণ', printEscapeHtml(opts.version)],
    ],
  )}
  <div style="margin-top:10pt">
    <div class="info-title">ফিচার</div>
    <div class="small">${opts.features.map((f) => printEscapeHtml(f)).join(' • ') || '—'}</div>
  </div>
  <div class="small muted" style="margin-top:10pt">
    এই লাইসেন্সটি অফলাইনে Ed25519 স্বাক্ষর দিয়ে যাচাই হয়। কোনোরূপ পরিবর্তন করলে লাইসেন্স বাতিল বলে গণ্য হবে।
  </div>`;
  return documentShell({
    brand: opts.brand,
    meta: { title: 'সফটওয়্যার লাইসেন্স সার্টিফিকেট', number: opts.licenseId, signatureLabels: ['অনুমোদিত স্বাক্ষর', 'লাইসেন্সধারী'] },
    body,
    css: INFO_CSS,
  });
}

export { dateTimeText };
