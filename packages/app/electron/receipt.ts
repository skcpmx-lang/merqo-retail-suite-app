import { escapeHtml } from '@sauda/core';
import { formatPaisa } from '@sauda/core';
import type { AppSettings, Sale } from '@sauda/core';

/**
 * Thermal receipt renderer for 58 mm / 80 mm paper.
 * The SAME HTML is used for the on-screen preview and for printing, so what the
 * cashier sees is exactly what the printer produces.
 */
export interface ReceiptOptions {
  sale: Sale;
  settings: AppSettings;
  logoDataUrl?: string | null;
  duplicate?: boolean;
  barcodeSvgDataUrl?: string | null;
  businessCopyLabel?: string;
}

export function receiptWidthMm(settings: AppSettings): number {
  return settings.receipt_width === 58 ? 58 : 80;
}

export function receiptCss(settings: AppSettings): string {
  const width = receiptWidthMm(settings);
  const font = Math.max(7, Math.min(22, settings.receipt_font_size || 11));
  const padding = width === 58 ? 2 : 3;
  return `
  @page { size: ${width}mm auto; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body {
    width: ${width}mm;
    padding: ${padding}mm ${padding}mm ${padding + 2}mm ${padding}mm;
    font-family: 'Nirmala UI', 'Noto Sans Bengali', 'SolaimanLipi', 'Segoe UI', sans-serif;
    font-size: ${font}px;
    line-height: 1.35;
    color: #000;
    -webkit-print-color-adjust: exact;
  }
  .center { text-align: center; }
  .right { text-align: right; }
  .bold { font-weight: 700; }
  .big { font-size: ${font + 2}px; }
  .muted { font-size: ${font - 1}px; }
  .biz-name { font-size: ${font + 4}px; font-weight: 800; letter-spacing: .2px; }
  .hr { border-top: 1px dashed #000; margin: 4px 0; }
  .solid { border-top: 1px solid #000; margin: 4px 0; }
  table { width: 100%; border-collapse: collapse; }
  td, th { padding: 1px 0; vertical-align: top; font-size: ${font}px; }
  th { text-align: left; font-weight: 700; border-bottom: 1px solid #000; }
  .item-name { font-weight: 600; word-break: break-word; }
  .qty { text-align: right; white-space: nowrap; }
  .amount { text-align: right; white-space: nowrap; }
  .total-row td { font-weight: 800; font-size: ${font + 2}px; }
  .footer { margin-top: 6px; text-align: center; font-size: ${font - 1}px; }
  .logo { max-height: 14mm; max-width: 60%; object-fit: contain; }
  .dup { border: 1px solid #000; padding: 1px 4px; display: inline-block; font-size: ${font - 1}px; }
  .feed { height: 8mm; }
  .cut { border-top: 1px dashed #999; margin-top: 4px; }
  `;
}

function formatQtyShort(qtyMilli: number): string {
  const value = qtyMilli / 1000;
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

export function buildReceiptHtml(opts: ReceiptOptions): string {
  const { sale, settings } = opts;
  const sym = settings.currency_symbol || '৳';
  const money = (p: number) => `${sym} ${formatPaisa(p)}`;
  const paid = sale.paid_paisa;
  const items = (sale.items ?? [])
    .map((item) => {
      const qty = formatQtyShort(item.qty_milli);
      return `<tr>
        <td class="item-name" colspan="2">${escapeHtml(item.product_name)}</td>
      </tr>
      <tr>
        <td class="qty">${escapeHtml(qty)} ${escapeHtml(item.unit_short_name ?? '')} × ${formatPaisa(item.unit_price_paisa)}</td>
        <td class="amount">${formatPaisa(item.line_total_paisa)}</td>
      </tr>
      ${item.discount_paisa > 0 ? `<tr><td class="qty muted">ডিসকাউন্ট</td><td class="amount muted">-${formatPaisa(item.discount_paisa)}</td></tr>` : ''}`;
    })
    .join('');

  const address = settings.business_address ? `<div class="muted">${escapeHtml(settings.business_address)}</div>` : '';
  const phone = settings.business_phone ? `<div class="muted">মোবাইল: ${escapeHtml(settings.business_phone)}</div>` : '';
  const logo =
    settings.receipt_show_logo && opts.logoDataUrl
      ? `<div class="center"><img class="logo" src="${opts.logoDataUrl}" alt="logo" /></div>`
      : '';
  const header = settings.receipt_header ? `<div class="center muted">${escapeHtml(settings.receipt_header)}</div>` : '';
  const footer = settings.receipt_footer ? `<div class="footer">${escapeHtml(settings.receipt_footer)}</div>` : '';
  const barcode = opts.barcodeSvgDataUrl
    ? `<div class="center"><img src="${opts.barcodeSvgDataUrl}" style="max-width:90%;height:12mm" alt="barcode"/></div>`
    : '';

  return `<!doctype html>
<html lang="bn">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(sale.invoice_no)}</title>
<style>${receiptCss(settings)}</style>
</head>
<body>
  ${logo}
  <div class="center biz-name">${escapeHtml(settings.business_name || 'আমার দোকান')}</div>
  ${address}
  ${phone}
  ${header}
  <div class="hr"></div>
  ${opts.duplicate ? '<div class="center"><span class="dup">ডুপ্লিকেট কপি</span></div>' : ''}
  <div>ইনভয়েস: <span class="bold">${escapeHtml(sale.invoice_no)}</span></div>
  <div>তারিখ: ${escapeHtml(sale.sale_date.slice(0, 16))}</div>
  <div>ক্যাশিয়ার: ${escapeHtml(sale.cashier_name ?? '—')}</div>
  <div>কাস্টমার: ${escapeHtml(sale.customer_name ?? 'ওয়াক-ইন কাস্টমার')}</div>
  <div class="hr"></div>
  <table>
    <thead><tr><th>প্রোডাক্ট</th><th class="amount">টাকা</th></tr></thead>
    <tbody>${items}</tbody>
  </table>
  <div class="hr"></div>
  <table>
    <tr><td>সাবটোটাল</td><td class="amount">${formatPaisa(sale.subtotal_paisa)}</td></tr>
    ${sale.discount_paisa > 0 ? `<tr><td>ডিসকাউন্ট</td><td class="amount">-${formatPaisa(sale.discount_paisa)}</td></tr>` : ''}
    ${sale.tax_paisa > 0 ? `<tr><td>ভ্যাট</td><td class="amount">${formatPaisa(sale.tax_paisa)}</td></tr>` : ''}
    <tr class="total-row"><td>সর্বমোট</td><td class="amount">${money(sale.total_paisa)}</td></tr>
    <tr><td>পরিশোধ</td><td class="amount">${formatPaisa(paid)}</td></tr>
    ${sale.due_paisa > 0 ? `<tr><td class="bold">বাকি</td><td class="amount bold">${formatPaisa(sale.due_paisa)}</td></tr>` : ''}
    ${sale.change_paisa > 0 ? `<tr><td>ফেরত (চেঞ্জ)</td><td class="amount">${formatPaisa(sale.change_paisa)}</td></tr>` : ''}
  </table>
  <div class="hr"></div>
  <div class="muted">পেমেন্ট: ${escapeHtml(sale.status === 'completed' ? 'সম্পন্ন' : sale.status)}</div>
  ${barcode}
  ${footer}
  <div class="feed"></div>
  <div class="cut"></div>
</body>
</html>`;
}
