import { describe, expect, it } from 'vitest';
import {
  buildInvoiceHtml,
  buildLabelSheetHtml,
  buildLicenseDocumentHtml,
  buildPurchaseDocumentHtml,
  buildReceiptHtml,
  buildReportHtml,
  buildStatementHtml,
  buildStockDocumentHtml,
  money,
  qty,
  groupDigits,
} from '../src/index.js';

const brand = {
  name: 'সাউদা জেনারেল স্টোর',
  address: 'চকবাজার, চট্টগ্রাম',
  phone: '01812345678',
  logoDataUrl: null,
  documentFooter: 'সকল মূল্য ভ্যাটসহ',
};
const fmt = { currency: '৳', bengaliDigits: 0 as const };

const lines = [
  { name: 'মিনিকেট চাল ৫ কেজি', sku: 'RICE-5', unit: 'প্যাকেট', qtyMilli: 2000, unitPricePaisa: 38_000, totalPaisa: 76_000 },
  { name: 'সয়াবিন তেল ১ লিটার', unit: 'বোতল', qtyMilli: 1000, unitPricePaisa: 18_500, discountPaisa: 500, totalPaisa: 18_000 },
];

describe('print: formatting', () => {
  it('groups Bangladeshi style and never loses paisa', () => {
    expect(money(0, fmt)).toBe('0.00');
    expect(money(123_456_789, fmt)).toBe('1,234,567.89');
    expect(groupDigits(1_500_000)).toBe('15,00,000');
    expect(qty(2_500, fmt)).toBe('2.5');
    expect(qty(1000, fmt)).toBe('1');
    expect(money(100, { currency: '৳', bengaliDigits: 1 })).toBe('১.০০');
  });
});

describe('print: receipt', () => {
  it('renders a compliant 80 mm receipt with every money line', () => {
    const html = buildReceiptHtml({
      sale: {
        invoice_no: 'INV-2601-0001',
        sale_date: '2026-01-05 12:30:00',
        customer_name: null,
        cashier_name: 'রফিক',
        subtotal_paisa: 94_000,
        discount_paisa: 500,
        coupon_discount_paisa: 0,
        tax_paisa: 0,
        total_paisa: 93_500,
        paid_paisa: 100_000,
        due_paisa: 0,
        change_paisa: 6_500,
        items: lines,
        payments: [{ method_name: 'ক্যাশ', amount_paisa: 100_000 }],
      },
      width: 80,
      brand: { ...brand, showLogo: false },
      fmt,
    });
    expect(html).toContain('@page { size: 80mm auto');
    expect(html).toContain('INV-2601-0001');
    expect(html).toContain('সাউদা জেনারেল স্টোর');
    expect(html).toContain('935.00');
    expect(html).toContain('65.00'); // change
    expect(html).toContain('ক্যাশ');
    expect(html).toContain('ধন্যবাদ');
  });

  it('prints 58 mm at the narrower page size and marks duplicates', () => {
    const html = buildReceiptHtml({
      sale: {
        invoice_no: 'INV-1',
        sale_date: '2026-01-05 12:30:00',
        subtotal_paisa: 1000,
        discount_paisa: 0,
        tax_paisa: 0,
        total_paisa: 1000,
        paid_paisa: 1000,
        due_paisa: 0,
        change_paisa: 0,
        items: [],
      },
      width: 58,
      brand: { ...brand },
      fmt,
      duplicate: true,
    });
    expect(html).toContain('@page { size: 58mm auto');
    expect(html).toContain('ডুপ্লিকেট কপি');
  });

  it('escapes hostile product names instead of injecting markup', () => {
    const html = buildReceiptHtml({
      sale: {
        invoice_no: 'INV-2',
        sale_date: '2026-01-05 12:30:00',
        subtotal_paisa: 1000,
        discount_paisa: 0,
        tax_paisa: 0,
        total_paisa: 1000,
        paid_paisa: 1000,
        due_paisa: 0,
        change_paisa: 0,
        items: [{ product_name: '<script>alert(1)</script>', qty_milli: 1000, unit_price_paisa: 1000, line_total_paisa: 1000 }],
      },
      width: 80,
      brand: { ...brand },
      fmt,
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('print: A4 documents', () => {
  it('builds a sales invoice with the customer block and totals', () => {
    const html = buildInvoiceHtml({
      doc: {
        number: 'INV-2601-0007',
        date: '2026-01-05',
        party: { title: 'কাস্টমার', name: 'করিম', phone: '01911111111', address: 'আগ্রাবাদ' },
        lines,
        subtotalPaisa: 94_000,
        discountPaisa: 500,
        taxPaisa: 4_675,
        totalPaisa: 98_175,
        paidPaisa: 50_000,
        duePaisa: 48_175,
        cashier: 'রফিক',
      },
      brand,
      fmt,
    });
    expect(html).toContain('@page { size: A4');
    expect(html).toContain('বিক্রয় ইনভয়েস');
    expect(html).toContain('করিম');
    expect(html).toContain('981.75'); // grand total
    expect(html).toContain('481.75'); // due
    expect(html).toContain('সর্বমোট');
    expect(html).toContain('বিক্রেতা');
  });

  it('builds a purchase order that states it is an order, not a receipt', () => {
    const html = buildPurchaseDocumentHtml({
      doc: {
        number: 'PUR-PO-2601-0003',
        date: '2026-01-05',
        expectedDate: '2026-01-09',
        status: 'partial',
        receivedPercent: 40,
        supplier: { title: 'সাপ্লায়ার', name: 'একতা ট্রেডার্স', phone: '01711111111' },
        lines,
        subtotalPaisa: 94_000,
        discountPaisa: 0,
        taxPaisa: 0,
        totalPaisa: 94_000,
        paidPaisa: 0,
        duePaisa: 0,
      },
      brand,
      fmt,
      kind: 'po',
    });
    expect(html).toContain('পারচেজ অর্ডার');
    expect(html).toContain('আংশিক গৃহীত');
    expect(html).toContain('গৃহীত: 40%');
    expect(html).toContain('স্টক বা হিসাব পরিবর্তন হয় না');
  });

  it('builds a statement with opening and closing balances', () => {
    const html = buildStatementHtml({
      title: 'কাস্টমার স্টেটমেন্ট',
      partyName: 'করিম',
      from: '2026-01-01',
      to: '2026-01-31',
      openingPaisa: 10_000,
      closingPaisa: 40_000,
      rows: [
        { date: '2026-01-04', ref: 'INV-1', description: 'বিক্রয়', debitPaisa: 50_000, creditPaisa: 0, balancePaisa: 60_000 },
        { date: '2026-01-10', ref: 'RCV-2', description: 'আদায়', debitPaisa: 0, creditPaisa: 20_000, balancePaisa: 40_000 },
      ],
      brand,
      fmt,
    });
    expect(html).toContain('প্রারম্ভিক ব্যালেন্স');
    expect(html).toContain('সমাপনী ব্যালেন্স');
    expect(html).toContain('400.00');
    expect(html).toContain('সর্বমোট');
  });

  it('renders a generic report with totals and an empty-state', () => {
    const filled = buildReportHtml({
      title: 'ট্রায়াল ব্যালেন্স',
      subtitle: '০১/০১/২০২৬ — ৩১/০১/২০২৬',
      columns: [
        { label: 'খাত' },
        { label: 'ডেবিট', align: 'right' },
        { label: 'ক্রেডিট', align: 'right' },
      ],
      rows: [['নগদ', '1,000.00', '0.00']],
      totals: ['মোট', '1,000.00', '1,000.00'],
      brand,
      landscape: true,
    });
    expect(filled).toContain('A4 landscape');
    expect(filled).toContain('ট্রায়াল ব্যালেন্স');
    expect(filled).toContain('মোট');
    const empty = buildReportHtml({ title: 'খালি রিপোর্ট', columns: [{ label: 'ক' }], rows: [], brand });
    expect(empty).toContain('কোনো তথ্য নেই');
  });

  it('builds stock documents and barcode label sheets', () => {
    const transfer = buildStockDocumentHtml({
      kind: 'transfer',
      title: 'স্টক ট্রান্সফার',
      number: 'TRF-1',
      date: '2026-01-05',
      fromLocation: 'প্রধান দোকান',
      toLocation: 'গুদাম',
      lines: [{ name: 'চাল', sentMilli: 5000, unit: 'প্যাকেট' }],
      brand,
      fmt,
    });
    expect(transfer).toContain('স্টক ট্রান্সফার');
    expect(transfer).toContain('গুদাম');

    const labels = buildLabelSheetHtml({
      labels: [{ name: 'চাল ৫ কেজি', code: '8901234567890', priceText: '৩৮০.০০' }],
      barcodeSvg: () => null,
      size: 'a4',
      columns: 3,
    });
    expect(labels).toContain('--cols:3');
    expect(labels).toContain('8901234567890');
  });

  it('builds the licence certificate with lifetime wording', () => {
    const html = buildLicenseDocumentHtml({
      org: 'সাউদা জেনারেল স্টোর',
      licenseId: 'SAUDA-TEST-1',
      edition: 'pro',
      issuedAt: '2026-01-05 10:00:00',
      expiresAt: null,
      maxDevices: 2,
      features: ['pos', 'reports'],
      fingerprint: 'abc123',
      keyId: 'K1',
      brand,
      version: '1.1.0',
    });
    expect(html).toContain('আজীবন');
    expect(html).toContain('SAUDA-TEST-1');
    expect(html).toContain('pos • reports');
  });
});
