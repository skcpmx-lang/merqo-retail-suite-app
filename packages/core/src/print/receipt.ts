import type { PrintFormat } from './base.js';
import { bn, documentShell, printEscapeHtml, money, qty } from './base.js';

export interface ReceiptItem {
  product_name: string;
  qty_milli: number;
  unit_short_name?: string | null;
  unit_price_paisa: number;
  discount_paisa?: number;
  line_total_paisa: number;
}

export interface ReceiptPayment {
  method_name: string;
  amount_paisa: number;
}

export interface ReceiptSale {
  invoice_no: string;
  sale_date: string;
  cashier_name?: string | null;
  customer_name?: string | null;
  subtotal_paisa: number;
  discount_paisa: number;
  coupon_discount_paisa?: number;
  tax_paisa: number;
  total_paisa: number;
  paid_paisa: number;
  due_paisa: number;
  change_paisa: number;
  gift_card_paisa?: number;
  loyalty_points_earned?: number;
  customer_points?: number;
  items: ReceiptItem[];
  payments?: ReceiptPayment[];
  status?: string;
}

export interface ReceiptOptions {
  sale: ReceiptSale;
  width: 58 | 80;
  fontSize?: number;
  brand: {
    name: string;
    address?: string;
    phone?: string;
    logoDataUrl?: string | null;
    header?: string;
    footer?: string;
    showLogo?: boolean;
  };
  fmt: PrintFormat & { bengaliDigits: 0 | 1 };
  duplicate?: boolean;
  /** QR payload (e.g. the invoice URL/text) rendered in the footer. */
  qrDataUrl?: string | null;
  barcodeSvgDataUrl?: string | null;
  emptyText?: string;
}

const THERMAL_CSS = `
body{font-size:9.6pt;line-height:1.4}
table.items td{padding:1.6pt 0;font-size:9.6pt}
table.items th{font-size:7.6pt;padding:1pt 0;border-bottom:1px solid #111}
.item-name{font-weight:600;word-break:break-word}
.qty{white-space:nowrap;text-align:right}
.amount{white-space:nowrap;text-align:right}
.hr{border-top:1px dashed #333;margin:3pt 0}
.solid{border-top:.9pt solid #111;margin:3pt 0}
.dupe{border:.8pt solid #111;padding:.5pt 4pt;display:inline-block;font-size:7.6pt}
.feed{height:7mm}
.cut{border-top:1px dashed #999;margin-top:3pt}
.small-tot td{padding:1pt 0}
.qr{display:block;margin:2mm auto 0;width:24mm;height:24mm}
.loyalty{font-size:8pt;margin-top:2pt}
`;

/** Builds the customer receipt (58 mm / 80 mm) — the same HTML is previewed and printed. */
export function buildReceiptHtml(opts: ReceiptOptions): string {
  const { sale, fmt } = opts;
  const showLogo = opts.brand.showLogo !== false;
  const itemRows = (sale.items ?? [])
    .map((item) => {
      const unit = item.unit_short_name ? ` ${printEscapeHtml(item.unit_short_name)}` : '';
      return `<tr>
        <td class="item-name" colspan="2">${printEscapeHtml(item.product_name)}</td>
      </tr>
      <tr>
        <td class="qty muted">${printEscapeHtml(qty(item.qty_milli, fmt))}${unit} × ${printEscapeHtml(money(item.unit_price_paisa, fmt))}</td>
        <td class="amount">${printEscapeHtml(money(item.line_total_paisa, fmt))}</td>
      </tr>${
        item.discount_paisa && item.discount_paisa > 0
          ? `<tr><td class="qty muted">ছাড়</td><td class="amount muted">-${printEscapeHtml(money(item.discount_paisa, fmt))}</td></tr>`
          : ''
      }`;
    })
    .join('');

  const payments = (sale.payments ?? [])
    .map(
      (p) =>
        `<tr><td>${printEscapeHtml(p.method_name)}</td><td class="amount">${printEscapeHtml(money(p.amount_paisa, fmt))}</td></tr>`,
    )
    .join('');

  const totals = `<table class="small-tot">
    <tr><td>সাবটোটাল</td><td class="amount">${printEscapeHtml(money(sale.subtotal_paisa, fmt))}</td></tr>
    ${sale.discount_paisa > 0 ? `<tr><td>ছাড়</td><td class="amount">-${printEscapeHtml(money(sale.discount_paisa, fmt))}</td></tr>` : ''}
    ${sale.coupon_discount_paisa && sale.coupon_discount_paisa > 0 ? `<tr><td>কুপন</td><td class="amount">-${printEscapeHtml(money(sale.coupon_discount_paisa, fmt))}</td></tr>` : ''}
    ${sale.tax_paisa > 0 ? `<tr><td>ভ্যাট</td><td class="amount">${printEscapeHtml(money(sale.tax_paisa, fmt))}</td></tr>` : ''}
    <tr class="bold"><td>সর্বমোট</td><td class="amount">${printEscapeHtml(money(sale.total_paisa, fmt))}</td></tr>
    <tr><td>পরিশোধ</td><td class="amount">${printEscapeHtml(money(sale.paid_paisa, fmt))}</td></tr>
    ${sale.due_paisa > 0 ? `<tr class="bold"><td>বাকি</td><td class="amount">${printEscapeHtml(money(sale.due_paisa, fmt))}</td></tr>` : ''}
    ${sale.change_paisa > 0 ? `<tr><td>ফেরত (চেঞ্জ)</td><td class="amount">${printEscapeHtml(money(sale.change_paisa, fmt))}</td></tr>` : ''}
  </table>`;

  const body = `
  <div class="small">
    <div class="hr"></div>
    <table>
      <tr><td>ইনভয়েস</td><td class="amount bold">${printEscapeHtml(sale.invoice_no)}</td></tr>
      <tr><td>তারিখ</td><td class="amount">${printEscapeHtml(sale.sale_date.slice(0, 16))}</td></tr>
      <tr><td>ক্যাশিয়ার</td><td class="amount">${printEscapeHtml(sale.cashier_name ?? '—')}</td></tr>
      <tr><td>কাস্টমার</td><td class="amount">${printEscapeHtml(sale.customer_name ?? 'ওয়াক-ইন')}</td></tr>
    </table>
    <div class="hr"></div>
    <table class="items">
      <thead><tr><th>প্রোডাক্ট</th><th class="amount">টাকা</th></tr></thead>
      <tbody>${itemRows || `<tr><td colspan="2" class="muted">কোনো পণ্য নেই</td></tr>`}</tbody>
    </table>
    <div class="hr"></div>
    ${totals}
    ${payments ? `<div class="hr"></div><table class="small">${payments}</table>` : ''}
    ${
      (sale.loyalty_points_earned ?? 0) > 0 || (sale.customer_points ?? 0) > 0
        ? `<div class="loyalty">পয়েন্ট: +${printEscapeHtml(String(sale.loyalty_points_earned ?? 0))}${
            sale.customer_points ? ` · মোট ${printEscapeHtml(String(sale.customer_points))}` : ''
          }</div>`
        : ''
    }
    ${opts.qrDataUrl ? `<img class="qr" src="${printEscapeHtml(opts.qrDataUrl)}" alt="" />` : ''}
    ${opts.barcodeSvgDataUrl ? `<div class="center"><img src="${printEscapeHtml(opts.barcodeSvgDataUrl)}" style="max-width:90%;height:11mm" alt="" /></div>` : ''}
    ${opts.brand.header ? `<div class="center muted small">${printEscapeHtml(opts.brand.header)}</div>` : ''}
    <div class="feed"></div>
    <div class="cut"></div>
  </div>`;

  return documentShell({
    brand: {
      name: opts.brand.name,
      address: opts.brand.address,
      phone: opts.brand.phone,
      logoDataUrl: showLogo ? opts.brand.logoDataUrl : null,
      footer: opts.brand.footer,
    },
    meta: {
      title: 'রসিদ',
      number: sale.invoice_no,
      size: opts.width === 58 ? '58mm' : '80mm',
      showSignature: false,
      emptyText: opts.emptyText,
      copyOf: opts.duplicate ? 'ডুপ্লিকেট কপি' : null,
    },
    body,
    css: THERMAL_CSS,
  });
}

/** Printable barcode label sheet (A4 grid or a single thermal label). */
export function buildLabelSheetHtml(opts: {
  labels: { name: string; code: string; priceText?: string; sku?: string | null }[];
  barcodeSvg: (code: string) => string | null;
  size?: 'a4' | '58mm' | '80mm';
  columns?: number;
}): string {
  const size = opts.size ?? 'a4';
  const columns = Math.max(1, Math.min(6, opts.columns ?? (size === 'a4' ? 3 : 1)));
  const cells = opts.labels
    .map(
      (l) => `<div class="label">
        <div class="l-name">${printEscapeHtml(l.name)}</div>
        ${l.sku ? `<div class="l-sku">${printEscapeHtml(l.sku)}</div>` : ''}
        <div class="l-code">${printEscapeHtml(l.code)}</div>
        ${opts.barcodeSvg(l.code) ? `<img class="l-bars" src="${printEscapeHtml(opts.barcodeSvg(l.code)!)}" alt="" />` : ''}
        ${l.priceText ? `<div class="l-price">${printEscapeHtml(l.priceText)}</div>` : ''}
      </div>`,
    )
    .join('');
  return documentShell({
    brand: { name: '' },
    meta: { title: 'বারকোড লেবেল', size, showSignature: false },
    body: `<div class="labels" style="--cols:${columns}">${cells}</div>`,
    css: `
      .brand{display:none}
      .doc-head{display:none}
      .doc-foot{display:none}
      .labels{display:grid;grid-template-columns:repeat(var(--cols),1fr);gap:4mm}
      .label{border:.6pt dashed #999;border-radius:2pt;padding:2mm;text-align:center;break-inside:avoid}
      .l-name{font-size:8.4pt;font-weight:600;line-height:1.2;max-height:2.6em;overflow:hidden}
      .l-sku{font-size:7pt;color:var(--muted)}
      .l-code{font-size:8pt;letter-spacing:.06em;font-family:monospace;margin-top:.6mm}
      .l-bars{width:100%;height:10mm;object-fit:contain;margin-top:.6mm}
      .l-price{font-size:9pt;font-weight:700;margin-top:.4mm}
    `,
  });
}

export function receiptWidth(settings: { receipt_width: number }): 58 | 80 {
  return settings.receipt_width === 58 ? 58 : 80;
}

export { bn };
