import type { Db } from '../db/connection.js';
import { addDays, nowLocal, startOfMonth, todayLocal } from '../domain/datetime.js';
import type { ReportColumn, ReportFilter, ReportId, ReportResult, SeriesPoint } from '../domain/types.js';
import { balanceSheet, dayBook, journalEntries, profitAndLoss, trialBalance } from './accounting.js';
import { reorderSuggestions } from './stock-ops.js';
import { deadStock } from './stock-ops.js';

export interface ReportMeta {
  id: ReportId;
  title: string;
  description: string;
  group: 'sales' | 'profit' | 'purchase' | 'expense' | 'party' | 'stock' | 'cash' | 'return' | 'accounting' | 'crm' | 'ops';
  needsRange: boolean;
}

export const REPORT_CATALOG: ReportMeta[] = [
  { id: 'sales_daily', title: 'দৈনিক সেলস রিপোর্ট', description: 'প্রতিদিনের বিক্রয়, ডিসকাউন্ট ও প্রফিট', group: 'sales', needsRange: true },
  { id: 'sales_range', title: 'সেলস রিপোর্ট (ইনভয়েস)', description: 'নির্বাচিত সময়ের প্রতিটি ইনভয়েস', group: 'sales', needsRange: true },
  { id: 'sales_detail', title: 'সেলস ডিটেইল (প্রোডাক্ট)', description: 'প্রতিটি প্রোডাক্ট লাইন ধরে বিক্রয়', group: 'sales', needsRange: true },
  { id: 'profit_loss', title: 'প্রফিট ও লস রিপোর্ট', description: 'রেভিনিউ, COGS, প্রফিট ও এক্সপেন্স', group: 'profit', needsRange: true },
  { id: 'product_performance', title: 'প্রোডাক্ট পারফরম্যান্স', description: 'প্রোডাক্টভিত্তিক বিক্রয় ও প্রফিট', group: 'profit', needsRange: true },
  { id: 'best_selling', title: 'বেস্ট সেলিং প্রোডাক্ট', description: 'সর্বাধিক বিক্রীত প্রোডাক্ট', group: 'profit', needsRange: true },
  { id: 'slow_moving', title: 'স্লো মুভিং প্রোডাক্ট', description: 'যেসব প্রোডাক্ট কম বিক্রি হয়', group: 'profit', needsRange: true },
  { id: 'category_sales', title: 'ক্যাটাগরি ওয়াইজ সেলস', description: 'ক্যাটাগরি অনুযায়ী বিক্রয়', group: 'sales', needsRange: true },
  { id: 'cashier_sales', title: 'ক্যাশিয়ার ওয়াইজ সেলস', description: 'প্রত্যেক ক্যাশিয়ারের বিক্রয়', group: 'sales', needsRange: true },
  { id: 'payment_method_sales', title: 'পেমেন্ট মেথড ওয়াইজ সেলস', description: 'পেমেন্ট মাধ্যম অনুযায়ী আদায়', group: 'sales', needsRange: true },
  { id: 'customer_sales', title: 'কাস্টমার ওয়াইজ সেলস', description: 'কাস্টমারভিত্তিক বিক্রয় ও বাকি', group: 'party', needsRange: true },
  { id: 'customer_due', title: 'কাস্টমার বাকি রিপোর্ট', description: 'বর্তমান সব বাকি', group: 'party', needsRange: false },
  { id: 'purchases', title: 'পারচেজ রিপোর্ট', description: 'নির্বাচিত সময়ের পারচেজ', group: 'purchase', needsRange: true },
  { id: 'purchase_detail', title: 'পারচেজ ডিটেইল (প্রোডাক্ট)', description: 'প্রোডাক্ট লাইন ধরে পারচেজ', group: 'purchase', needsRange: true },
  { id: 'supplier_purchase', title: 'সাপ্লায়ার ওয়াইজ পারচেজ', description: 'সাপ্লায়ারভিত্তিক ক্রয়', group: 'purchase', needsRange: true },
  { id: 'supplier_payable', title: 'সাপ্লায়ার পাওনাবিলি', description: 'সাপ্লায়ারকে দেয় বাকি', group: 'party', needsRange: false },
  { id: 'expenses', title: 'এক্সপেন্স রিপোর্ট', description: 'ক্যাটাগরি অনুযায়ী এক্সপেন্স সারাংশ', group: 'expense', needsRange: true },
  { id: 'expense_detail', title: 'এক্সপেন্স ডিটেইল', description: 'প্রতিটি এক্সপেন্স এন্ট্রি', group: 'expense', needsRange: true },
  { id: 'stock', title: 'স্টক রিপোর্ট', description: 'সব প্রোডাক্টের বর্তমান স্টক', group: 'stock', needsRange: false },
  { id: 'low_stock', title: 'লো স্টক রিপোর্ট', description: 'সর্বনিম্ন স্টকে পৌঁছে যাওয়া প্রোডাক্ট', group: 'stock', needsRange: false },
  { id: 'out_of_stock', title: 'স্টক শেষ রিপোর্ট', description: 'স্টক শূন্য প্রোডাক্ট', group: 'stock', needsRange: false },
  { id: 'stock_valuation', title: 'স্টক ভ্যালুয়েশন', description: 'ওয়েটেড অ্যাভারেজ কস্টে স্টকের মূল্য', group: 'stock', needsRange: false },
  { id: 'stock_movement', title: 'স্টক মুভমেন্ট রিপোর্ট', description: 'প্রতিটি স্টক পরিবর্তনের ইতিহাস', group: 'stock', needsRange: true },
  { id: 'inventory_adjustment', title: 'ইনভেন্টরি অ্যাডজাস্টমেন্ট', description: 'সমন্বয়, নষ্ট ও মেয়াদোত্তীর্ণ', group: 'stock', needsRange: true },
  { id: 'cash_register', title: 'ক্যাশ রেজিস্টার রিপোর্ট', description: 'ক্যাশ সেশন ও ক্যাশ মুভমেন্ট', group: 'cash', needsRange: true },
  { id: 'payment_collection', title: 'পেমেন্ট কালেকশন রিপোর্ট', description: 'সব পেমেন্ট আদায় ও পরিশোধ', group: 'cash', needsRange: true },
  { id: 'returns', title: 'রিটার্ন ও রিফান্ড রিপোর্ট', description: 'সেলস ও পারচেজ রিটার্ন', group: 'return', needsRange: true },
  /* ---------------- v1.0.1 ---------------- */
  { id: 'trial_balance', title: 'ট্রায়াল ব্যালান্স', description: 'সব হিসাব খাতের ডেবিট-ক্রেডিট সমন্বয়', group: 'accounting', needsRange: true },
  { id: 'ledger_pl', title: 'লাভ-ক্ষতি (লেজার)', description: 'ডাবল-এন্ট্রি লেজার থেকে আয়, ক্রয়মূল্য ও ব্যয়', group: 'accounting', needsRange: true },
  { id: 'balance_sheet', title: 'ব্যালান্স শিট', description: 'সম্পদ, দায় ও মূলধনের স্থিতি', group: 'accounting', needsRange: false },
  { id: 'cash_flow', title: 'ক্যাশ ফ্লো', description: 'নগদ ও ব্যাংকে টাকার প্রবাহ', group: 'accounting', needsRange: true },
  { id: 'day_book', title: 'দিনের বই (ডে বুক)', description: 'একদিনের সব জার্নাল এন্ট্রি', group: 'accounting', needsRange: true },
  { id: 'journal_list', title: 'জার্নাল এন্ট্রি তালিকা', description: 'স্বয়ংক্রিয় ও ম্যানুয়াল ভাউচার', group: 'accounting', needsRange: true },
  { id: 'account_balances', title: 'হিসাব খাতের ব্যালান্স', description: 'প্রতিটি খাতের খোলা ও বর্তমান ব্যালান্স', group: 'accounting', needsRange: true },
  { id: 'loyalty_report', title: 'লয়্যালটি পয়েন্ট রিপোর্ট', description: 'কাস্টমারভিত্তিক পয়েন্ট ও লেনদেন', group: 'crm', needsRange: true },
  { id: 'credit_limit_report', title: 'বাকির সীমা রিপোর্ট', description: 'সীমা ছাড়ানো ও কাছাকাছি কাস্টমার', group: 'crm', needsRange: false },
  { id: 'customer_aging', title: 'কাস্টমার বাকির বয়স বিশ্লেষণ', description: '০-৩০ / ৩১-৬০ / ৬১-৯০ / ৯০+ দিন', group: 'crm', needsRange: false },
  { id: 'supplier_aging', title: 'সাপ্লায়ার পাওনার বয়স বিশ্লেষণ', description: 'কবে থেকে কত পাওনা', group: 'crm', needsRange: false },
  { id: 'stock_transfers', title: 'স্টক ট্রান্সফার রিপোর্ট', description: 'লোকেশন থেকে লোকেশনে পাঠানো মাল', group: 'ops', needsRange: true },
  { id: 'stock_count_variance', title: 'স্টক গণনার পার্থক্য', description: 'সিস্টেম বনাম গণনা করা স্টক', group: 'ops', needsRange: false },
  { id: 'reorder_report', title: 'রিঅর্ডার প্রস্তাব', description: 'কী কিনতে হবে ও কেন', group: 'ops', needsRange: false },
  { id: 'dead_stock', title: 'মৃত স্টক রিপোর্ট', description: '৬০ দিনে বিক্রি হয়নি এমন পণ্য', group: 'ops', needsRange: false },
  { id: 'serial_register', title: 'সিরিয়াল / IMEI রেজিস্টার', description: 'সিরিয়ালভিত্তিক স্টক ও বিক্রয়', group: 'ops', needsRange: false },
  { id: 'hourly_sales', title: 'ঘণ্টাভিত্তিক বিক্রয়', description: 'কোন সময়ে বেশি বিক্রি হয়', group: 'sales', needsRange: true },
  { id: 'discount_report', title: 'ডিসকাউন্ট রিপোর্ট', description: 'লাইন ও ইনভয়েস ডিসকাউন্টের হিসাব', group: 'sales', needsRange: true },
  { id: 'tax_summary', title: 'ভ্যাট / ট্যাক্স সারাংশ', description: 'কনফিগার করা হারে ধরা ভ্যাট (কোনো আইনি দাবি নয়)', group: 'sales', needsRange: true },
];

function resolveRange(f: ReportFilter): { from: string; to: string } {
  const to = f.to ? f.to.slice(0, 10) : todayLocal();
  const from = f.from ? f.from.slice(0, 10) : startOfMonth(to);
  return { from, to };
}

function money(n: number | null | undefined): number {
  return Number(n ?? 0);
}

const COLS = {
  date: { key: 'date', label: 'তারিখ', format: 'date' as const, width: 100 },
  invoice: { key: 'invoice_no', label: 'ইনভয়েস', format: 'text' as const },
  customer: { key: 'customer_name', label: 'কাস্টমার', format: 'text' as const },
  qty: { key: 'qty', label: 'পরিমাণ', format: 'qty' as const, align: 'right' as const },
  money: (key: string, label: string): ReportColumn => ({ key, label, format: 'money', align: 'right' }),
  qtyCol: (key: string, label: string): ReportColumn => ({ key, label, format: 'qty', align: 'right' }),
  text: (key: string, label: string): ReportColumn => ({ key, label, format: 'text' }),
  int: (key: string, label: string): ReportColumn => ({ key, label, format: 'int', align: 'right' }),
};

function sumBy(rows: Record<string, any>[], key: string): number {
  return rows.reduce((s, r) => s + (Number(r[key]) || 0), 0);
}

function numericTotals(columns: ReportColumn[], rows: Record<string, any>[]): Record<string, number | string> {
  const totals: Record<string, number | string> = {};
  for (const c of columns) {
    if (c.format === 'money' || c.format === 'qty' || c.format === 'int') {
      totals[c.key] = sumBy(rows, c.key);
    }
  }
  return totals;
}

function salesSeries(db: Db, from: string, to: string): SeriesPoint[] {
  const rows = db
    .prepare(
      `SELECT date(sale_date) d, COALESCE(SUM(total_paisa),0) sales, COALESCE(SUM(profit_paisa),0) profit
         FROM sales WHERE status <> 'voided' AND date(sale_date) BETWEEN date(?) AND date(?)
        GROUP BY date(sale_date)`,
    )
    .all(from, to) as { d: string; sales: number; profit: number }[];
  const pur = db
    .prepare(
      `SELECT date(purchase_date) d, COALESCE(SUM(total_paisa),0) v FROM purchases
        WHERE status <> 'voided' AND date(purchase_date) BETWEEN date(?) AND date(?) GROUP BY date(purchase_date)`,
    )
    .all(from, to) as { d: string; v: number }[];
  const exp = db
    .prepare(
      `SELECT date(expense_date) d, COALESCE(SUM(amount_paisa),0) v FROM expenses
        WHERE status = 'active' AND date(expense_date) BETWEEN date(?) AND date(?) GROUP BY date(expense_date)`,
    )
    .all(from, to) as { d: string; v: number }[];
  const map = new Map<string, SeriesPoint>();
  const days = Math.min(400, Math.max(1, Math.round((new Date(`${to}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime()) / 86400000) + 1));
  for (let i = 0; i < days; i++) {
    const d = addDays(from, i);
    map.set(d, { iso: d, label: d.slice(5), sales_paisa: 0, profit_paisa: 0, purchase_paisa: 0, expense_paisa: 0 });
  }
  for (const r of rows) {
    const p = map.get(r.d);
    if (p) {
      p.sales_paisa = money(r.sales);
      p.profit_paisa = money(r.profit);
    }
  }
  for (const r of pur) {
    const p = map.get(r.d);
    if (p) p.purchase_paisa = money(r.v);
  }
  for (const r of exp) {
    const p = map.get(r.d);
    if (p) p.expense_paisa = money(r.v);
  }
  return [...map.values()];
}

/** Runs a report by id. Every number comes straight from the ledger. */
export function runReport(db: Db, id: ReportId, filter: ReportFilter = {}): ReportResult {
  const { from, to } = resolveRange(filter);
  const base: ReportResult = { id, title: '', subtitle: '', columns: [], rows: [], totals: {} };
  const meta = REPORT_CATALOG.find((r) => r.id === id);
  base.title = meta?.title ?? id;
  base.subtitle = meta?.needsRange ? `${from} — ${to}` : 'সর্বশেষ অবস্থা';
  const search = filter.search?.trim().toLowerCase() ?? '';

  switch (id) {
    case 'sales_daily': {
      const rows = db
        .prepare(
          `SELECT date(sale_date) AS date, COUNT(*) AS invoice_count,
                  COALESCE(SUM(subtotal_paisa),0) AS subtotal, COALESCE(SUM(discount_paisa),0) AS discount,
                  COALESCE(SUM(total_paisa),0) AS total, COALESCE(SUM(paid_paisa),0) AS paid,
                  COALESCE(SUM(due_paisa),0) AS due, COALESCE(SUM(cost_total_paisa),0) AS cost,
                  COALESCE(SUM(profit_paisa),0) AS profit
             FROM sales WHERE status <> 'voided' AND date(sale_date) BETWEEN date(?) AND date(?)
            GROUP BY date(sale_date) ORDER BY date DESC`,
        )
        .all(from, to) as Record<string, any>[];
      base.columns = [
        COLS.date,
        COLS.int('invoice_count', 'ইনভয়েস সংখ্যা'),
        COLS.money('subtotal', 'সাবটোটাল'),
        COLS.money('discount', 'ডিসকাউন্ট'),
        COLS.money('total', 'মোট বিক্রয়'),
        COLS.money('paid', 'আদায়'),
        COLS.money('due', 'বাকি'),
        COLS.money('cost', 'খরচ (COGS)'),
        COLS.money('profit', 'প্রফিট'),
      ];
      base.rows = rows;
      base.totals = numericTotals(base.columns, rows);
      base.chart = salesSeries(db, from, to);
      break;
    }
    case 'sales_range': {
      const rows = db
        .prepare(
          `SELECT s.sale_date AS date, s.invoice_no, COALESCE(c.name,'ওয়াক-ইন') AS customer_name,
                  u.username AS cashier, s.subtotal_paisa AS subtotal, s.discount_paisa AS discount,
                  s.tax_paisa AS tax, s.total_paisa AS total, s.paid_paisa AS paid, s.due_paisa AS due,
                  s.profit_paisa AS profit, s.status
             FROM sales s LEFT JOIN customers c ON c.id = s.customer_id LEFT JOIN users u ON u.id = s.user_id
            WHERE date(s.sale_date) BETWEEN date(?) AND date(?)
              AND (? = '' OR s.invoice_no LIKE '%' || ? || '%' OR c.name LIKE '%' || ? || '%')
            ORDER BY s.id DESC`,
        )
        .all(from, to, search, search, search) as Record<string, any>[];
      base.columns = [
        COLS.date,
        COLS.invoice,
        COLS.customer,
        COLS.text('cashier', 'ক্যাশিয়ার'),
        COLS.money('subtotal', 'সাবটোটাল'),
        COLS.money('discount', 'ডিসকাউন্ট'),
        COLS.money('tax', 'ভ্যাট'),
        COLS.money('total', 'মোট'),
        COLS.money('paid', 'পরিশোধ'),
        COLS.money('due', 'বাকি'),
        COLS.money('profit', 'প্রফিট'),
        COLS.text('status', 'স্ট্যাটাস'),
      ];
      base.rows = rows;
      base.totals = numericTotals(base.columns, rows);
      base.chart = salesSeries(db, from, to);
      break;
    }
    case 'sales_detail': {
      const rows = db
        .prepare(
          `SELECT s.sale_date AS date, s.invoice_no, si.product_name, si.unit_label AS unit,
                  si.qty_milli AS qty, si.unit_price_paisa AS unit_price, si.discount_paisa AS discount,
                  si.line_total_paisa AS line_total, si.cost_total_paisa AS cost,
                  (si.line_total_paisa - si.cost_total_paisa) AS profit, si.returned_qty_milli AS returned
             FROM sale_items si JOIN sales s ON s.id = si.sale_id
            WHERE s.status <> 'voided' AND date(s.sale_date) BETWEEN date(?) AND date(?)
              AND (? = '' OR si.product_name LIKE '%' || ? || '%' OR s.invoice_no LIKE '%' || ? || '%')
            ORDER BY s.id DESC, si.id`,
        )
        .all(from, to, search, search, search) as Record<string, any>[];
      base.columns = [
        COLS.date,
        COLS.invoice,
        COLS.text('product_name', 'প্রোডাক্ট'),
        COLS.text('unit', 'ইউনিট'),
        COLS.qtyCol('qty', 'পরিমাণ'),
        COLS.money('unit_price', 'একক দাম'),
        COLS.money('discount', 'ডিসকাউন্ট'),
        COLS.money('line_total', 'লাইন টোটাল'),
        COLS.money('cost', 'খরচ'),
        COLS.money('profit', 'প্রফিট'),
        COLS.qtyCol('returned', 'ফেরত'),
      ];
      base.rows = rows;
      base.totals = numericTotals(base.columns, rows);
      break;
    }
    case 'profit_loss': {
      const sRow = db
        .prepare(
          `SELECT COALESCE(SUM(subtotal_paisa),0) subtotal, COALESCE(SUM(discount_paisa),0) discount,
                  COALESCE(SUM(tax_paisa),0) tax, COALESCE(SUM(total_paisa),0) total,
                  COALESCE(SUM(cost_total_paisa),0) cost
             FROM sales WHERE status <> 'voided' AND date(sale_date) BETWEEN date(?) AND date(?)`,
        )
        .get(from, to) as Record<string, number>;
      const rRow = db
        .prepare(
          `SELECT COALESCE(SUM(total_paisa),0) total, COALESCE(SUM(cost_total_paisa),0) cost
             FROM returns WHERE kind = 'sale' AND status = 'completed'
              AND date(return_date) BETWEEN date(?) AND date(?)`,
        )
        .get(from, to) as Record<string, number>;
      const pRow = db
        .prepare(
          `SELECT COALESCE(SUM(total_paisa),0) total FROM purchases
            WHERE status <> 'voided' AND date(purchase_date) BETWEEN date(?) AND date(?)`,
        )
        .get(from, to) as Record<string, number>;
      const expRow = db
        .prepare(
          `SELECT COALESCE(SUM(amount_paisa),0) total FROM expenses
            WHERE status = 'active' AND date(expense_date) BETWEEN date(?) AND date(?)`,
        )
        .get(from, to) as Record<string, number>;

      const grossRevenue = sRow.total - sRow.tax;
      const salesReturns = rRow.total;
      const netRevenue = grossRevenue - salesReturns;
      const cogs = sRow.cost - rRow.cost;
      const grossProfit = netRevenue - cogs;
      const expenses = expRow.total;
      const netProfit = grossProfit - expenses;
      const rows = [
        { item: 'মোট বিক্রয় (গ্রস)', amount: sRow.total },
        { item: 'ভ্যাট/ট্যাক্স (বাদ)', amount: -sRow.tax },
        { item: 'মোট ডিসকাউন্ট (ইতিমধ্যে বাদ)', amount: -sRow.discount },
        { item: 'সেলস রিটার্ন (বাদ)', amount: -salesReturns },
        { item: 'নেট রেভিনিউ', amount: netRevenue },
        { item: 'বিক্রীত পণ্যের ক্রয়মূল্য (COGS)', amount: -cogs },
        { item: 'গ্রস প্রফিট', amount: grossProfit },
        { item: 'এক্সপেন্স', amount: -expenses },
        { item: 'নেট প্রফিট', amount: netProfit },
        { item: 'মোট পারচেজ (তথ্যমূলক)', amount: pRow.total },
      ];
      base.columns = [
        { key: 'item', label: 'খাত', format: 'text' },
        COLS.money('amount', 'পরিমাণ'),
      ];
      base.rows = rows;
      base.totals = { amount: netProfit };
      base.chart = salesSeries(db, from, to);
      break;
    }
    case 'product_performance':
    case 'best_selling': {
      const rows = db
        .prepare(
          `SELECT si.product_id, p.name AS product_name, c.name AS category_name,
                  SUM(si.qty_base_milli) AS qty_base,
                  SUM(si.line_total_paisa) AS revenue, SUM(si.cost_total_paisa) AS cost,
                  SUM(si.line_total_paisa - si.cost_total_paisa) AS profit,
                  SUM(si.returned_qty_milli) AS returned_qty
             FROM sale_items si JOIN sales s ON s.id = si.sale_id
             LEFT JOIN products p ON p.id = si.product_id
             LEFT JOIN categories c ON c.id = p.category_id
            WHERE s.status <> 'voided' AND date(s.sale_date) BETWEEN date(?) AND date(?)
              AND (? = '' OR p.name LIKE '%' || ? || '%')
            GROUP BY si.product_id
            ORDER BY ${id === 'best_selling' ? 'qty_base DESC' : 'revenue DESC'}
            LIMIT 500`,
        )
        .all(from, to, search, search) as Record<string, any>[];
      base.columns = [
        COLS.text('product_name', 'প্রোডাক্ট'),
        COLS.text('category_name', 'ক্যাটাগরি'),
        COLS.qtyCol('qty_base', 'বিক্রীত (বেস ইউনিট)'),
        COLS.money('revenue', 'রেভিনিউ'),
        COLS.money('cost', 'খরচ'),
        COLS.money('profit', 'প্রফিট'),
        COLS.qtyCol('returned_qty', 'ফেরত'),
      ];
      base.rows = rows;
      base.totals = numericTotals(base.columns, rows);
      break;
    }
    case 'slow_moving': {
      const rows = db
        .prepare(
          `SELECT p.id AS product_id, p.name AS product_name, c.name AS category_name,
                  p.stock_base_milli AS stock, p.sale_price AS sale_price,
                  COALESCE((SELECT SUM(si.qty_base_milli) FROM sale_items si JOIN sales s ON s.id = si.sale_id
                            WHERE si.product_id = p.id AND s.status <> 'voided'
                              AND date(s.sale_date) BETWEEN date(?) AND date(?)), 0) AS sold,
                  COALESCE((SELECT MAX(s.sale_date) FROM sale_items si JOIN sales s ON s.id = si.sale_id
                            WHERE si.product_id = p.id AND s.status <> 'voided'), 'কখনো নয়') AS last_sold
             FROM products p LEFT JOIN categories c ON c.id = p.category_id
            WHERE p.is_active = 1 AND (? = '' OR p.name LIKE '%' || ? || '%')
            ORDER BY sold ASC, p.name_sort ASC LIMIT 300`,
        )
        .all(from, to, search, search) as Record<string, any>[];
      base.columns = [
        COLS.text('product_name', 'প্রোডাক্ট'),
        COLS.text('category_name', 'ক্যাটাগরি'),
        COLS.qtyCol('stock', 'বর্তমান স্টক'),
        COLS.money('sale_price', 'বিক্রয়মূল্য'),
        COLS.qtyCol('sold', 'নির্বাচিত সময়ে বিক্রি'),
        COLS.text('last_sold', 'সর্বশেষ বিক্রয়'),
      ];
      base.rows = rows;
      base.totals = numericTotals(base.columns, rows);
      break;
    }
    case 'category_sales': {
      const rows = db
        .prepare(
          `SELECT COALESCE(c.name,'ক্যাটাগরি নেই') AS category_name,
                  COUNT(DISTINCT s.id) AS invoices, SUM(si.qty_base_milli) AS qty_base,
                  SUM(si.line_total_paisa) AS revenue, SUM(si.cost_total_paisa) AS cost,
                  SUM(si.line_total_paisa - si.cost_total_paisa) AS profit
             FROM sale_items si JOIN sales s ON s.id = si.sale_id
             LEFT JOIN products p ON p.id = si.product_id
             LEFT JOIN categories c ON c.id = p.category_id
            WHERE s.status <> 'voided' AND date(s.sale_date) BETWEEN date(?) AND date(?)
            GROUP BY COALESCE(c.name,'ক্যাটাগরি নেই') ORDER BY revenue DESC`,
        )
        .all(from, to) as Record<string, any>[];
      base.columns = [
        COLS.text('category_name', 'ক্যাটাগরি'),
        COLS.int('invoices', 'ইনভয়েস'),
        COLS.qtyCol('qty_base', 'পরিমাণ'),
        COLS.money('revenue', 'রেভিনিউ'),
        COLS.money('cost', 'খরচ'),
        COLS.money('profit', 'প্রফিট'),
      ];
      base.rows = rows;
      base.totals = numericTotals(base.columns, rows);
      break;
    }
    case 'cashier_sales': {
      const rows = db
        .prepare(
          `SELECT COALESCE(u.username,'অজানা') AS cashier, COUNT(*) AS invoices,
                  COALESCE(SUM(s.total_paisa),0) AS total, COALESCE(SUM(s.paid_paisa),0) AS paid,
                  COALESCE(SUM(s.due_paisa),0) AS due, COALESCE(SUM(s.profit_paisa),0) AS profit,
                  COALESCE(AVG(s.total_paisa),0) AS avg_invoice
             FROM sales s LEFT JOIN users u ON u.id = s.user_id
            WHERE s.status <> 'voided' AND date(s.sale_date) BETWEEN date(?) AND date(?)
            GROUP BY s.user_id ORDER BY total DESC`,
        )
        .all(from, to) as Record<string, any>[];
      base.columns = [
        COLS.text('cashier', 'ক্যাশিয়ার'),
        COLS.int('invoices', 'ইনভয়েস'),
        COLS.money('total', 'মোট বিক্রয়'),
        COLS.money('paid', 'আদায়'),
        COLS.money('due', 'বাকি'),
        COLS.money('profit', 'প্রফিট'),
        COLS.money('avg_invoice', 'গড় ইনভয়েস'),
      ];
      base.rows = rows;
      base.totals = numericTotals(base.columns, rows);
      break;
    }
    case 'payment_method_sales': {
      const rows = db
        .prepare(
          `SELECT COALESCE(m.name,'অনির্ধারিত') AS method_name, m.is_cash,
                  COUNT(*) AS entries, COALESCE(SUM(p.amount_paisa),0) AS total
             FROM payments p LEFT JOIN payment_methods m ON m.id = p.method_id
            WHERE p.status = 'active' AND p.direction = 'in'
              AND date(p.payment_date) BETWEEN date(?) AND date(?)
            GROUP BY p.method_id ORDER BY total DESC`,
        )
        .all(from, to) as Record<string, any>[];
      base.columns = [
        COLS.text('method_name', 'পেমেন্ট মেথড'),
        COLS.text('is_cash', 'ক্যাশ?'),
        COLS.int('entries', 'সংখ্যা'),
        COLS.money('total', 'মোট'),
      ];
      base.rows = rows.map((r) => ({ ...r, is_cash: r.is_cash ? 'হ্যাঁ' : 'না' }));
      base.totals = { total: sumBy(rows, 'total') };
      break;
    }
    case 'customer_sales': {
      const rows = db
        .prepare(
          `SELECT COALESCE(c.name,'ওয়াক-ইন') AS customer_name, c.phone,
                  COUNT(s.id) AS invoices, COALESCE(SUM(s.total_paisa),0) AS total,
                  COALESCE(SUM(s.paid_paisa),0) AS paid, COALESCE(c.balance_paisa,0) AS due
             FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
            WHERE s.status <> 'voided' AND date(s.sale_date) BETWEEN date(?) AND date(?)
              AND (? = '' OR c.name LIKE '%' || ? || '%' OR c.phone LIKE '%' || ? || '%')
            GROUP BY s.customer_id ORDER BY total DESC`,
        )
        .all(from, to, search, search, search) as Record<string, any>[];
      base.columns = [
        COLS.text('customer_name', 'কাস্টমার'),
        COLS.text('phone', 'মোবাইল'),
        COLS.int('invoices', 'ইনভয়েস'),
        COLS.money('total', 'মোট বিক্রয়'),
        COLS.money('paid', 'পরিশোধ'),
        COLS.money('due', 'বর্তমান বাকি'),
      ];
      base.rows = rows;
      base.totals = numericTotals(base.columns, rows);
      break;
    }
    case 'customer_due': {
      const rows = db
        .prepare(
          `SELECT c.name AS customer_name, c.phone, c.address,
                  COALESCE(c.balance_paisa,0) AS due, c.created_at AS since
             FROM customers c
            WHERE c.balance_paisa > 0 AND c.is_active = 1
              AND (? = '' OR c.name LIKE '%' || ? || '%' OR c.phone LIKE '%' || ? || '%')
            ORDER BY due DESC`,
        )
        .all(search, search, search) as Record<string, any>[];
      base.columns = [
        COLS.text('customer_name', 'কাস্টমার'),
        COLS.text('phone', 'মোবাইল'),
        COLS.text('address', 'ঠিকানা'),
        COLS.money('due', 'বাকি'),
        COLS.text('since', 'কাস্টমার থেকে'),
      ];
      base.rows = rows;
      base.totals = { due: sumBy(rows, 'due') };
      break;
    }
    case 'purchases': {
      const rows = db
        .prepare(
          `SELECT p.purchase_date AS date, p.purchase_no, COALESCE(s.name,'—') AS supplier_name,
                  p.subtotal_paisa AS subtotal, p.discount_paisa AS discount, p.other_cost_paisa AS other_cost,
                  p.total_paisa AS total, p.paid_paisa AS paid, p.due_paisa AS due, p.status
             FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id
            WHERE date(p.purchase_date) BETWEEN date(?) AND date(?)
              AND (? = '' OR p.purchase_no LIKE '%' || ? || '%' OR s.name LIKE '%' || ? || '%')
            ORDER BY p.id DESC`,
        )
        .all(from, to, search, search, search) as Record<string, any>[];
      base.columns = [
        COLS.date,
        COLS.text('purchase_no', 'পারচেজ নং'),
        COLS.text('supplier_name', 'সাপ্লায়ার'),
        COLS.money('subtotal', 'সাবটোটাল'),
        COLS.money('discount', 'ডিসকাউন্ট'),
        COLS.money('other_cost', 'অন্যান্য খরচ'),
        COLS.money('total', 'মোট'),
        COLS.money('paid', 'পরিশোধ'),
        COLS.money('due', 'বাকি'),
        COLS.text('status', 'স্ট্যাটাস'),
      ];
      base.rows = rows;
      base.totals = numericTotals(base.columns, rows);
      break;
    }
    case 'purchase_detail': {
      const rows = db
        .prepare(
          `SELECT p.purchase_date AS date, p.purchase_no, pi.product_name, pi.unit_label AS unit,
                  pi.qty_milli AS qty, pi.unit_price_paisa AS unit_price, pi.discount_paisa AS discount,
                  pi.line_total_paisa AS line_total, pi.returned_qty_milli AS returned
             FROM purchase_items pi JOIN purchases p ON p.id = pi.purchase_id
            WHERE p.status <> 'voided' AND date(p.purchase_date) BETWEEN date(?) AND date(?)
              AND (? = '' OR pi.product_name LIKE '%' || ? || '%')
            ORDER BY p.id DESC, pi.id`,
        )
        .all(from, to, search, search) as Record<string, any>[];
      base.columns = [
        COLS.date,
        COLS.text('purchase_no', 'পারচেজ নং'),
        COLS.text('product_name', 'প্রোডাক্ট'),
        COLS.text('unit', 'ইউনিট'),
        COLS.qtyCol('qty', 'পরিমাণ'),
        COLS.money('unit_price', 'একক দাম'),
        COLS.money('discount', 'ডিসকাউন্ট'),
        COLS.money('line_total', 'লাইন টোটাল'),
        COLS.qtyCol('returned', 'ফেরত'),
      ];
      base.rows = rows;
      base.totals = numericTotals(base.columns, rows);
      break;
    }
    case 'supplier_purchase': {
      const rows = db
        .prepare(
          `SELECT COALESCE(s.name,'—') AS supplier_name, s.company, COUNT(p.id) AS purchases,
                  COALESCE(SUM(p.total_paisa),0) AS total, COALESCE(SUM(p.paid_paisa),0) AS paid,
                  COALESCE(s.balance_paisa,0) AS payable
             FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id
            WHERE p.status <> 'voided' AND date(p.purchase_date) BETWEEN date(?) AND date(?)
            GROUP BY p.supplier_id ORDER BY total DESC`,
        )
        .all(from, to) as Record<string, any>[];
      base.columns = [
        COLS.text('supplier_name', 'সাপ্লায়ার'),
        COLS.text('company', 'কোম্পানি'),
        COLS.int('purchases', 'পারচেজ সংখ্যা'),
        COLS.money('total', 'মোট ক্রয়'),
        COLS.money('paid', 'পরিশোধ'),
        COLS.money('payable', 'বর্তমান পাওনা'),
      ];
      base.rows = rows;
      base.totals = numericTotals(base.columns, rows);
      break;
    }
    case 'supplier_payable': {
      const rows = db
        .prepare(
          `SELECT s.name AS supplier_name, s.company, s.phone, COALESCE(s.balance_paisa,0) AS payable
             FROM suppliers s WHERE s.balance_paisa > 0 AND s.is_active = 1
              AND (? = '' OR s.name LIKE '%' || ? || '%' OR s.company LIKE '%' || ? || '%')
            ORDER BY payable DESC`,
        )
        .all(search, search, search) as Record<string, any>[];
      base.columns = [
        COLS.text('supplier_name', 'সাপ্লায়ার'),
        COLS.text('company', 'কোম্পানি'),
        COLS.text('phone', 'মোবাইল'),
        COLS.money('payable', 'পরিশোধযোগ্য'),
      ];
      base.rows = rows;
      base.totals = { payable: sumBy(rows, 'payable') };
      break;
    }
    case 'expenses': {
      const rows = db
        .prepare(
          `SELECT COALESCE(ec.name,'অন্যান্য') AS category_name, COUNT(*) AS entries,
                  COALESCE(SUM(e.amount_paisa),0) AS total
             FROM expenses e LEFT JOIN expense_categories ec ON ec.id = e.category_id
            WHERE e.status = 'active' AND date(e.expense_date) BETWEEN date(?) AND date(?)
            GROUP BY COALESCE(ec.name,'অন্যান্য') ORDER BY total DESC`,
        )
        .all(from, to) as Record<string, any>[];
      base.columns = [COLS.text('category_name', 'ক্যাটাগরি'), COLS.int('entries', 'সংখ্যা'), COLS.money('total', 'মোট')];
      base.rows = rows;
      base.totals = { total: sumBy(rows, 'total') };
      break;
    }
    case 'expense_detail': {
      const rows = db
        .prepare(
          `SELECT e.expense_date AS date, COALESCE(ec.name,'অন্যান্য') AS category_name, e.description,
                  COALESCE(m.name,'') AS method, e.amount_paisa AS amount, e.reference, u.username, e.status
             FROM expenses e LEFT JOIN expense_categories ec ON ec.id = e.category_id
             LEFT JOIN payment_methods m ON m.id = e.method_id LEFT JOIN users u ON u.id = e.user_id
            WHERE date(e.expense_date) BETWEEN date(?) AND date(?)
              AND (? = '' OR e.description LIKE '%' || ? || '%')
            ORDER BY e.id DESC`,
        )
        .all(from, to, search, search) as Record<string, any>[];
      base.columns = [
        COLS.date,
        COLS.text('category_name', 'ক্যাটাগরি'),
        COLS.text('description', 'বিবরণ'),
        COLS.text('method', 'মেথড'),
        COLS.money('amount', 'টাকা'),
        COLS.text('reference', 'রেফারেন্স'),
        COLS.text('username', 'ইউজার'),
        COLS.text('status', 'স্ট্যাটাস'),
      ];
      base.rows = rows.filter((r) => r.status === 'active');
      base.totals = { amount: sumBy(base.rows, 'amount') };
      break;
    }
    case 'stock': {
      const rows = db
        .prepare(
          `SELECT p.name AS product_name, p.sku, COALESCE(c.name,'') AS category_name,
                  ub.short_name AS base_unit, p.stock_base_milli AS stock, p.min_stock_base_milli AS min_stock,
                  p.purchase_price AS purchase_price, p.sale_price AS sale_price
             FROM products p LEFT JOIN categories c ON c.id = p.category_id
             LEFT JOIN units ub ON ub.id = p.unit_id
            WHERE p.is_active = 1 AND (? = '' OR p.name LIKE '%' || ? || '%' OR p.sku LIKE '%' || ? || '%')
            ORDER BY p.name_sort`,
        )
        .all(search, search, search) as Record<string, any>[];
      base.columns = [
        COLS.text('product_name', 'প্রোডাক্ট'),
        COLS.text('sku', 'SKU'),
        COLS.text('category_name', 'ক্যাটাগরি'),
        COLS.text('base_unit', 'বেস ইউনিট'),
        COLS.qtyCol('stock', 'স্টক'),
        COLS.qtyCol('min_stock', 'সর্বনিম্ন'),
        COLS.money('purchase_price', 'ক্রয়মূল্য'),
        COLS.money('sale_price', 'বিক্রয়মূল্য'),
      ];
      base.rows = rows;
      base.totals = { stock: sumBy(rows, 'stock') };
      break;
    }
    case 'low_stock': {
      const rows = db
        .prepare(
          `SELECT p.name AS product_name, p.sku, ub.short_name AS base_unit, p.stock_base_milli AS stock,
                  p.min_stock_base_milli AS min_stock, p.purchase_price AS purchase_price
             FROM products p LEFT JOIN units ub ON ub.id = p.unit_id
            WHERE p.is_active = 1 AND p.stock_base_milli > 0 AND p.stock_base_milli <= p.min_stock_base_milli
            ORDER BY p.name_sort`,
        )
        .all() as Record<string, any>[];
      base.columns = [
        COLS.text('product_name', 'প্রোডাক্ট'),
        COLS.text('sku', 'SKU'),
        COLS.text('base_unit', 'ইউনিট'),
        COLS.qtyCol('stock', 'বর্তমান স্টক'),
        COLS.qtyCol('min_stock', 'সর্বনিম্ন স্টক'),
        COLS.money('purchase_price', 'ক্রয়মূল্য'),
      ];
      base.rows = rows;
      base.totals = { stock: sumBy(rows, 'stock') };
      break;
    }
    case 'out_of_stock': {
      const rows = db
        .prepare(
          `SELECT p.name AS product_name, p.sku, ub.short_name AS base_unit, p.min_stock_base_milli AS min_stock,
                  p.purchase_price AS purchase_price, p.sale_price AS sale_price
             FROM products p LEFT JOIN units ub ON ub.id = p.unit_id
            WHERE p.is_active = 1 AND p.stock_base_milli <= 0 ORDER BY p.name_sort`,
        )
        .all() as Record<string, any>[];
      base.columns = [
        COLS.text('product_name', 'প্রোডাক্ট'),
        COLS.text('sku', 'SKU'),
        COLS.text('base_unit', 'ইউনিট'),
        COLS.qtyCol('min_stock', 'সর্বনিম্ন স্টক'),
        COLS.money('purchase_price', 'ক্রয়মূল্য'),
        COLS.money('sale_price', 'বিক্রয়মূল্য'),
      ];
      base.rows = rows;
      break;
    }
    case 'stock_valuation': {
      const rows = db
        .prepare(
          `SELECT p.name AS product_name, COALESCE(c.name,'') AS category_name, ub.short_name AS base_unit,
                  p.stock_base_milli AS stock,
                  CAST(ROUND(p.avg_cost_micro / 10000.0) AS INTEGER) AS avg_cost_per_1000,
                  CAST(ROUND(CASE WHEN p.stock_base_milli > 0
                       THEN p.stock_base_milli * p.avg_cost_micro / 1000000000.0 ELSE 0 END) AS INTEGER) AS stock_value,
                  CAST(ROUND(CASE WHEN p.stock_base_milli > 0
                       THEN p.stock_base_milli * p.sale_price / 1000.0 ELSE 0 END) AS INTEGER) AS retail_value
             FROM products p LEFT JOIN categories c ON c.id = p.category_id
             LEFT JOIN units ub ON ub.id = p.unit_id
            WHERE p.is_active = 1 ORDER BY stock_value DESC`,
        )
        .all() as Record<string, any>[];
      base.columns = [
        COLS.text('product_name', 'প্রোডাক্ট'),
        COLS.text('category_name', 'ক্যাটাগরি'),
        COLS.text('base_unit', 'ইউনিট'),
        COLS.qtyCol('stock', 'স্টক'),
        COLS.money('stock_value', 'স্টক মূল্য (ক্রয়)'),
        COLS.money('retail_value', 'সম্ভাব্য বিক্রয় মূল্য'),
      ];
      base.rows = rows;
      base.totals = { stock: sumBy(rows, 'stock'), stock_value: sumBy(rows, 'stock_value'), retail_value: sumBy(rows, 'retail_value') };
      break;
    }
    case 'stock_movement': {
      const rows = db
        .prepare(
          `SELECT m.created_at AS date, p.name AS product_name, m.type, m.qty_base_milli AS qty,
                  m.balance_after_milli AS balance, ub.short_name AS unit, m.ref_type, m.ref_id, m.reason,
                  COALESCE(u.username,'') AS username
             FROM stock_movements m JOIN products p ON p.id = m.product_id
             LEFT JOIN units ub ON ub.id = p.unit_id LEFT JOIN users u ON u.id = m.user_id
            WHERE date(m.created_at) BETWEEN date(?) AND date(?)
              AND (? = '' OR p.name LIKE '%' || ? || '%' OR m.ref_id LIKE '%' || ? || '%')
            ORDER BY m.id DESC LIMIT 2000`,
        )
        .all(from, to, search, search, search) as Record<string, any>[];
      base.columns = [
        COLS.text('date', 'সময়'),
        COLS.text('product_name', 'প্রোডাক্ট'),
        COLS.text('type', 'ধরন'),
        COLS.qtyCol('qty', 'পরিবর্তন'),
        COLS.qtyCol('balance', 'ব্যালেন্স'),
        COLS.text('unit', 'ইউনিট'),
        COLS.text('ref_id', 'রেফারেন্স'),
        COLS.text('reason', 'কারণ'),
        COLS.text('username', 'ইউজার'),
      ];
      base.rows = rows;
      break;
    }
    case 'inventory_adjustment': {
      const rows = db
        .prepare(
          `SELECT m.created_at AS date, p.name AS product_name, m.type, m.qty_base_milli AS qty,
                  m.balance_after_milli AS balance, ub.short_name AS unit, m.reason,
                  COALESCE(u.username,'') AS username
             FROM stock_movements m JOIN products p ON p.id = m.product_id
             LEFT JOIN units ub ON ub.id = p.unit_id LEFT JOIN users u ON u.id = m.user_id
            WHERE m.type IN ('adjustment','damage','expiry','opening')
              AND date(m.created_at) BETWEEN date(?) AND date(?)
            ORDER BY m.id DESC LIMIT 2000`,
        )
        .all(from, to) as Record<string, any>[];
      base.columns = [
        COLS.text('date', 'সময়'),
        COLS.text('product_name', 'প্রোডাক্ট'),
        COLS.text('type', 'ধরন'),
        COLS.qtyCol('qty', 'পরিবর্তন'),
        COLS.qtyCol('balance', 'ব্যালেন্স'),
        COLS.text('unit', 'ইউনিট'),
        COLS.text('reason', 'কারণ'),
        COLS.text('username', 'ইউজার'),
      ];
      base.rows = rows;
      break;
    }
    case 'cash_register': {
      const rows = db
        .prepare(
          `SELECT s.opened_at AS date, s.closed_at, COALESCE(u.username,'') AS username,
                  s.opening_cash_paisa AS opening, s.expected_cash_paisa AS expected,
                  s.counted_cash_paisa AS counted, s.difference_paisa AS difference, s.status
             FROM cash_sessions s LEFT JOIN users u ON u.id = s.user_id
            WHERE date(s.opened_at) BETWEEN date(?) AND date(?)
            ORDER BY s.id DESC`,
        )
        .all(from, to) as Record<string, any>[];
      base.columns = [
        COLS.text('date', 'ওপেন'),
        COLS.text('closed_at', 'ক্লোজ'),
        COLS.text('username', 'ক্যাশিয়ার'),
        COLS.money('opening', 'ওপেনিং ক্যাশ'),
        COLS.money('expected', 'হিসাবের ক্যাশ'),
        COLS.money('counted', 'গণনা ক্যাশ'),
        COLS.money('difference', 'পার্থক্য'),
        COLS.text('status', 'স্ট্যাটাস'),
      ];
      base.rows = rows;
      base.totals = numericTotals(base.columns, rows);
      break;
    }
    case 'payment_collection': {
      const rows = db
        .prepare(
          `SELECT p.payment_date AS date, p.kind, p.direction, COALESCE(c.name, s.name,'—') AS party_name,
                  COALESCE(m.name,'') AS method, p.amount_paisa AS amount, COALESCE(u.username,'') AS username,
                  p.reference, p.status
             FROM payments p LEFT JOIN customers c ON c.id = p.customer_id
             LEFT JOIN suppliers s ON s.id = p.supplier_id
             LEFT JOIN payment_methods m ON m.id = p.method_id LEFT JOIN users u ON u.id = p.user_id
            WHERE date(p.payment_date) BETWEEN date(?) AND date(?)
              AND (? = '' OR p.reference LIKE '%' || ? || '%' OR c.name LIKE '%' || ? || '%')
            ORDER BY p.id DESC LIMIT 2000`,
        )
        .all(from, to, search, search, search) as Record<string, any>[];
      base.columns = [
        COLS.text('date', 'সময়'),
        COLS.text('kind', 'ধরন'),
        COLS.text('direction', 'দিক'),
        COLS.text('party_name', 'পক্ষ'),
        COLS.text('method', 'মেথড'),
        COLS.money('amount', 'টাকা'),
        COLS.text('username', 'ইউজার'),
        COLS.text('reference', 'রেফারেন্স'),
        COLS.text('status', 'স্ট্যাটাস'),
      ];
      base.rows = rows.map((r) => ({ ...r, direction: r.direction === 'in' ? 'আদায়' : 'পরিশোধ' }));
      base.totals = { amount: sumBy(rows, 'amount') };
      break;
    }
    case 'returns': {
      const rows = db
        .prepare(
          `SELECT r.return_date AS date, r.return_no, r.kind, COALESCE(c.name, s.name,'—') AS party_name,
                  r.total_paisa AS total, r.refund_paisa AS refund, COALESCE(r.note,'') AS note, r.status
             FROM returns r LEFT JOIN customers c ON c.id = r.customer_id
             LEFT JOIN suppliers s ON s.id = r.supplier_id
            WHERE date(r.return_date) BETWEEN date(?) AND date(?)
            ORDER BY r.id DESC`,
        )
        .all(from, to) as Record<string, any>[];
      base.columns = [
        COLS.date,
        COLS.text('return_no', 'রিটার্ন নং'),
        COLS.text('kind', 'ধরন'),
        COLS.text('party_name', 'পক্ষ'),
        COLS.money('total', 'মোট'),
        COLS.money('refund', 'রিফান্ড'),
        COLS.text('note', 'নোট'),
        COLS.text('status', 'স্ট্যাটাস'),
      ];
      base.rows = rows.map((r) => ({ ...r, kind: r.kind === 'sale' ? 'সেলস রিটার্ন' : 'পারচেজ রিটার্ন' }));
      base.totals = numericTotals(base.columns, rows);
      break;
    }

    /* ================= v1.0.1 accounting reports ================= */
    case 'trial_balance': {
      const tb = trialBalance(db, { from, to });
      base.columns = [
        COLS.text('code', 'কোড'),
        COLS.text('name', 'খাত'),
        COLS.text('type', 'ধরন'),
        COLS.money('debit', 'ডেবিট'),
        COLS.money('credit', 'ক্রেডিট'),
      ];
      base.rows = tb.rows as any;
      base.totals = { debit: tb.totalDebit, credit: tb.totalCredit };
      break;
    }
    case 'ledger_pl': {
      const pl = profitAndLoss(db, { from, to });
      base.columns = [COLS.text('code', 'কোড'), COLS.text('name', 'খাত'), COLS.text('group', 'শ্রেণি'), COLS.money('amount', 'অঙ্ক')];
      base.rows = [
        ...pl.income.map((r) => ({ ...r, group: 'আয়' })),
        ...pl.expenses.map((r) => ({ ...r, group: 'ব্যয়' })),
      ];
      base.totals = { income: pl.totalIncome, expense: pl.totalExpense, grossProfit: pl.grossProfit, netProfit: pl.netProfit };
      break;
    }
    case 'balance_sheet': {
      const bs = balanceSheet(db, to);
      base.subtitle = `${to} তারিখে`;
      base.columns = [COLS.text('code', 'কোড'), COLS.text('name', 'খাত'), COLS.text('group', 'শ্রেণি'), COLS.money('amount', 'ব্যালান্স')];
      base.rows = [
        ...bs.assets.map((r: any) => ({ ...r, group: 'সম্পদ' })),
        ...bs.liabilities.map((r: any) => ({ ...r, group: 'দায়' })),
        ...bs.equity.map((r: any) => ({ ...r, group: 'মূলধন' })),
      ];
      base.totals = {
        totalAssets: bs.totalAssets,
        totalLiabilities: bs.totalLiabilities,
        totalEquity: bs.totalEquity,
        balanced: bs.balanced ? 1 : 0,
      };
      break;
    }
    case 'cash_flow': {
      const rows = db
        .prepare(
          `SELECT j.entry_no, j.entry_date AS date, j.source, j.memo,
                  SUM(l.debit_paisa) AS inflow, SUM(l.credit_paisa) AS outflow
             FROM journal_lines l
             JOIN journal_entries j ON j.id = l.entry_id
             JOIN accounts a ON a.id = l.account_id
            WHERE (a.is_cash = 1 OR a.is_bank = 1) AND date(j.entry_date) BETWEEN date(?) AND date(?)
            GROUP BY j.id ORDER BY j.entry_date, j.id`,
        )
        .all(from, to) as Record<string, any>[];
      const inflow = rows.reduce((s, r) => s + money(r.inflow), 0);
      const outflow = rows.reduce((s, r) => s + money(r.outflow), 0);
      base.columns = [
        COLS.date,
        COLS.text('entry_no', 'ভাউচার'),
        COLS.text('source', 'উৎস'),
        COLS.text('memo', 'বিবরণ'),
        COLS.money('inflow', 'প্রবেশ'),
        COLS.money('outflow', 'বহির্গমন'),
      ];
      base.rows = rows;
      base.totals = { inflow, outflow, net: inflow - outflow };
      break;
    }
    case 'day_book': {
      const day = dayBook(db, from);
      base.subtitle = `${from} তারিখের সব এন্ট্রি`;
      base.columns = [
        COLS.text('entry_no', 'ভাউচার'),
        COLS.text('source', 'উৎস'),
        COLS.text('memo', 'বিবরণ'),
        COLS.money('debit', 'ডেবিট'),
        COLS.money('credit', 'ক্রেডিট'),
      ];
      base.rows = ((day as any).rows ?? []) as any;
      base.totals = numericTotals(base.columns, base.rows);
      break;
    }
    case 'journal_list': {
      const res = journalEntries(db, { from, to, limit: 2000 });
      base.columns = [
        COLS.date,
        COLS.text('entry_no', 'ভাউচার'),
        COLS.text('source', 'উৎস'),
        COLS.text('memo', 'বিবরণ'),
        COLS.money('amount', 'অঙ্ক'),
      ];
      base.rows = res as any;
      base.totals = numericTotals(base.columns, base.rows);
      break;
    }
    case 'account_balances': {
      const rows = db
        .prepare(
          `SELECT a.code, a.name, a.type, a.is_active,
                  COALESCE(SUM(l.debit_paisa),0) AS debit, COALESCE(SUM(l.credit_paisa),0) AS credit,
                  COALESCE(SUM(l.debit_paisa - l.credit_paisa),0) AS balance
             FROM accounts a
             LEFT JOIN journal_lines l ON l.account_id = a.id
             LEFT JOIN journal_entries j ON j.id = l.entry_id AND date(j.entry_date) <= date(?)
            WHERE l.id IS NULL OR j.id IS NOT NULL
            GROUP BY a.id ORDER BY a.code`,
        )
        .all(to) as Record<string, any>[];
      base.columns = [
        COLS.text('code', 'কোড'),
        COLS.text('name', 'খাত'),
        COLS.money('debit', 'ডেবিট'),
        COLS.money('credit', 'ক্রেডিট'),
        COLS.money('balance', 'ব্যালান্স'),
      ];
      base.rows = rows;
      base.totals = { debit: rows.reduce((s, r) => s + money(r.debit), 0), credit: rows.reduce((s, r) => s + money(r.credit), 0) };
      break;
    }
    /* ================= v1.0.1 CRM reports ================= */
    case 'loyalty_report': {
      const rows = db
        .prepare(
          `SELECT c.name AS customer_name, c.phone, c.loyalty_points,
                  COALESCE(SUM(CASE WHEN l.type = 'earn' THEN l.points END),0) AS earned,
                  COALESCE(-SUM(CASE WHEN l.type = 'redeem' THEN l.points END),0) AS redeemed,
                  COALESCE(-SUM(CASE WHEN l.type IN ('reverse','expire') THEN l.points END),0) AS removed,
                  MAX(l.created_at) AS last_activity
             FROM customers c LEFT JOIN loyalty_ledger l ON l.customer_id = c.id
            WHERE c.is_walkin = 0 AND (l.created_at IS NULL OR date(l.created_at) BETWEEN date(?) AND date(?))
            GROUP BY c.id HAVING COALESCE(SUM(l.points),0) <> 0 OR c.loyalty_points <> 0
            ORDER BY c.loyalty_points DESC`,
        )
        .all(from, to) as Record<string, any>[];
      base.columns = [
        COLS.text('customer_name', 'কাস্টমার'),
        COLS.text('phone', 'মোবাইল'),
        { key: 'loyalty_points', label: 'পয়েন্ট', format: 'int', align: 'right' },
        { key: 'earned', label: 'অর্জিত', format: 'int', align: 'right' },
        { key: 'redeemed', label: 'রিডিম', format: 'int', align: 'right' },
        { key: 'removed', label: 'বাতিল/মেয়াদ', format: 'int', align: 'right' },
        { key: 'last_activity', label: 'সর্বশেষ', format: 'text' },
      ];
      base.rows = rows;
      base.totals = { points: rows.reduce((s, r) => s + money(r.loyalty_points), 0) };
      break;
    }
    case 'credit_limit_report': {
      const rows = db
        .prepare(
          `SELECT name, phone, balance_paisa, credit_limit_paisa,
                  (credit_limit_paisa - balance_paisa) AS remaining_paisa,
                  CASE WHEN balance_paisa > credit_limit_paisa THEN 'সীমা ছাড়িয়েছে'
                       WHEN balance_paisa >= credit_limit_paisa * 0.9 THEN 'সীমার কাছাকাছি'
                       ELSE 'স্বাভাবিক' END AS status
             FROM customers
            WHERE is_walkin = 0 AND is_active = 1 AND credit_limit_paisa > 0
            ORDER BY (CAST(balance_paisa AS REAL) / credit_limit_paisa) DESC`,
        )
        .all() as Record<string, any>[];
      base.columns = [
        COLS.text('name', 'কাস্টমার'),
        COLS.text('phone', 'মোবাইল'),
        COLS.money('credit_limit_paisa', 'সীমা'),
        COLS.money('balance_paisa', 'বর্তমান বাকি'),
        COLS.money('remaining_paisa', 'অবশিষ্ট'),
        COLS.text('status', 'অবস্থা'),
      ];
      base.rows = rows;
      base.totals = { limit: rows.reduce((s, r) => s + money(r.credit_limit_paisa), 0), due: rows.reduce((s, r) => s + money(r.balance_paisa), 0) };
      break;
    }
    case 'customer_aging':
    case 'supplier_aging': {
      const isCustomer = id === 'customer_aging';
      const table = isCustomer ? 'customers' : 'suppliers';
      const balanceCol = 'balance_paisa';
      const rows = db
        .prepare(
          `SELECT name, phone, ${balanceCol} AS balance_paisa,
                  COALESCE((SELECT SUM(s.due_paisa) FROM ${isCustomer ? 'sales' : 'purchases'} s
                             WHERE s.${isCustomer ? 'customer_id' : 'supplier_id'} = t.id
                               AND julianday('now','localtime') - julianday(s.${isCustomer ? 'sale_date' : 'purchase_date'}) BETWEEN 0 AND 30),0) AS d0_30,
                  COALESCE((SELECT SUM(s.due_paisa) FROM ${isCustomer ? 'sales' : 'purchases'} s
                             WHERE s.${isCustomer ? 'customer_id' : 'supplier_id'} = t.id
                               AND julianday('now','localtime') - julianday(s.${isCustomer ? 'sale_date' : 'purchase_date'}) BETWEEN 31 AND 60),0) AS d31_60,
                  COALESCE((SELECT SUM(s.due_paisa) FROM ${isCustomer ? 'sales' : 'purchases'} s
                             WHERE s.${isCustomer ? 'customer_id' : 'supplier_id'} = t.id
                               AND julianday('now','localtime') - julianday(s.${isCustomer ? 'sale_date' : 'purchase_date'}) BETWEEN 61 AND 90),0) AS d61_90,
                  COALESCE((SELECT SUM(s.due_paisa) FROM ${isCustomer ? 'sales' : 'purchases'} s
                             WHERE s.${isCustomer ? 'customer_id' : 'supplier_id'} = t.id
                               AND julianday('now','localtime') - julianday(s.${isCustomer ? 'sale_date' : 'purchase_date'}) > 90),0) AS d90_plus
             FROM ${table} t
            WHERE is_active = 1 ${isCustomer ? 'AND is_walkin = 0' : ''} AND balance_paisa > 0
            ORDER BY balance_paisa DESC`,
        )
        .all() as Record<string, any>[];
      base.columns = [
        COLS.text('name', isCustomer ? 'কাস্টমার' : 'সাপ্লায়ার'),
        COLS.text('phone', 'মোবাইল'),
        COLS.money('balance_paisa', 'মোট বাকি'),
        COLS.money('d0_30', '০-৩০ দিন'),
        COLS.money('d31_60', '৩১-৬০ দিন'),
        COLS.money('d61_90', '৬১-৯০ দিন'),
        COLS.money('d90_plus', '৯০+ দিন'),
      ];
      base.rows = rows;
      base.totals = numericTotals(base.columns, rows);
      break;
    }
    /* ================= v1.0.1 stock-ops reports ================= */
    case 'stock_transfers': {
      const rows = db
        .prepare(
          `SELECT t.transfer_no, date(t.transfer_date) AS date, lf.name AS from_name, lt.name AS to_name,
                  (SELECT COUNT(*) FROM stock_transfer_items i WHERE i.transfer_id = t.id) AS item_count,
                  (SELECT COALESCE(SUM(i.qty_base_milli),0) FROM stock_transfer_items i WHERE i.transfer_id = t.id) AS qty_base_milli
             FROM stock_transfers t
             JOIN locations lf ON lf.id = t.from_location
             JOIN locations lt ON lt.id = t.to_location
            WHERE date(t.transfer_date) BETWEEN date(?) AND date(?) ORDER BY t.id DESC`,
        )
        .all(from, to) as Record<string, any>[];
      base.columns = [COLS.date, COLS.text('transfer_no', 'ট্রান্সফার'), COLS.text('from_name', 'থেকে'), COLS.text('to_name', 'গন্তব্য'), COLS.qtyCol('qty_base_milli', 'পরিমাণ'), { key: 'item_count', label: 'আইটেম', format: 'int', align: 'right' }];
      base.rows = rows;
      base.totals = { qty: rows.reduce((s, r) => s + money(r.qty_base_milli), 0) };
      break;
    }
    case 'stock_count_variance': {
      const rows = db
        .prepare(
          `SELECT c.count_no, date(c.created_at) AS date, l.name AS location_name, c.status,
                  p.name AS product_name, i.system_qty_milli, i.counted_qty_milli,
                  (i.counted_qty_milli - i.system_qty_milli) AS diff_milli
             FROM stock_count_items i
             JOIN stock_counts c ON c.id = i.count_id
             JOIN locations l ON l.id = c.location_id
             JOIN products p ON p.id = i.product_id
            WHERE i.counted_qty_milli <> i.system_qty_milli
            ORDER BY c.id DESC, p.name_sort`,
        )
        .all() as Record<string, any>[];
      base.columns = [COLS.date, COLS.text('count_no', 'গণনা'), COLS.text('location_name', 'লোকেশন'), COLS.text('product_name', 'পণ্য'), COLS.qtyCol('system_qty_milli', 'সিস্টেম'), COLS.qtyCol('counted_qty_milli', 'গণনা'), COLS.qtyCol('diff_milli', 'পার্থক্য')];
      base.rows = rows;
      base.totals = { variance: rows.reduce((s, r) => s + money(r.diff_milli), 0) };
      break;
    }
    case 'reorder_report': {
      const rows = reorderSuggestions(db, { leadDays: 7 });
      base.columns = [COLS.text('name', 'পণ্য'), COLS.qtyCol('stock_base_milli', 'স্টক'), COLS.qtyCol('min_stock_base_milli', 'ন্যূনতম'), COLS.qtyCol('suggested_base_milli', 'প্রস্তাবিত ক্রয়'), COLS.money('estimated_value_paisa', 'আনুমানিক খরচ'), COLS.text('reason', 'কারণ')];
      base.rows = rows;
      base.totals = { value: rows.reduce((s: number, r: any) => s + money(r.estimated_value_paisa), 0) };
      break;
    }
    case 'dead_stock': {
      const rows = deadStock(db, 60);
      base.columns = [COLS.text('name', 'পণ্য'), COLS.qtyCol('stock_base_milli', 'স্টক'), COLS.money('value_paisa', 'মূল্য'), COLS.text('last_sold_on', 'সর্বশেষ বিক্রি')];
      base.rows = rows;
      base.totals = { value: rows.reduce((s: number, r: any) => s + money(r.value_paisa), 0) };
      break;
    }
    case 'serial_register': {
      const rows = db
        .prepare(
          `SELECT s.serial, p.name AS product_name, s.status, l.name AS location_name,
                  sa.invoice_no, date(s.updated_at) AS date
             FROM serial_numbers s JOIN products p ON p.id = s.product_id
             LEFT JOIN locations l ON l.id = s.location_id
             LEFT JOIN sales sa ON sa.id = s.sale_id
            ORDER BY s.updated_at DESC LIMIT 5000`,
        )
        .all() as Record<string, any>[];
      base.columns = [COLS.text('serial', 'সিরিয়াল'), COLS.text('product_name', 'পণ্য'), COLS.text('status', 'অবস্থা'), COLS.text('location_name', 'লোকেশন'), COLS.text('invoice_no', 'ইনভয়েস'), COLS.date];
      base.rows = rows;
      base.totals = { count: rows.length };
      break;
    }
    /* ================= v1.0.1 sales analytics ================= */
    case 'hourly_sales': {
      const rows = db
        .prepare(
          `SELECT CAST(strftime('%H', created_at) AS INTEGER) AS hour,
                  COUNT(*) AS invoice_count, SUM(total_paisa) AS total_paisa, SUM(profit_paisa) AS profit_paisa
             FROM sales WHERE status = 'completed' AND date(sale_date) BETWEEN date(?) AND date(?)
            GROUP BY hour ORDER BY hour`,
        )
        .all(from, to) as Record<string, any>[];
      base.columns = [
        { key: 'hour', label: 'ঘণ্টা', format: 'text' },
        { key: 'invoice_count', label: 'ইনভয়েস', format: 'int', align: 'right' },
        COLS.money('total_paisa', 'বিক্রয়'),
        COLS.money('profit_paisa', 'প্রফিট'),
      ];
      base.rows = rows.map((r) => ({ ...r, hour: `${String(r.hour).padStart(2, '0')}:00` }));
      base.totals = numericTotals(base.columns, base.rows);
      break;
    }
    case 'discount_report': {
      const rows = db
        .prepare(
          `SELECT date(s.sale_date) AS date, s.invoice_no, COALESCE(c.name,'ওয়াক-ইন') AS customer_name,
                  s.subtotal_paisa, s.discount_paisa,
                  COALESCE((SELECT SUM(si.discount_paisa) FROM sale_items si WHERE si.sale_id = s.id),0) AS line_discount_paisa,
                  s.total_paisa
             FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
            WHERE s.status = 'completed' AND date(s.sale_date) BETWEEN date(?) AND date(?)
              AND (s.discount_paisa > 0 OR EXISTS (SELECT 1 FROM sale_items si WHERE si.sale_id = s.id AND si.discount_paisa > 0))
            ORDER BY s.id DESC`,
        )
        .all(from, to) as Record<string, any>[];
      base.columns = [COLS.date, COLS.invoice, COLS.customer, COLS.money('subtotal_paisa', 'সাবটোটাল'), COLS.money('line_discount_paisa', 'লাইন ডিসকাউন্ট'), COLS.money('discount_paisa', 'ইনভয়েস ডিসকাউন্ট'), COLS.money('total_paisa', 'মোট')];
      base.rows = rows;
      base.totals = numericTotals(base.columns, rows);
      break;
    }
    case 'tax_summary': {
      const rows = db
        .prepare(
          `SELECT date(sale_date) AS date, COUNT(*) AS invoice_count, SUM(subtotal_paisa) AS subtotal_paisa,
                  SUM(tax_paisa) AS tax_paisa, SUM(total_paisa) AS total_paisa
             FROM sales WHERE status = 'completed' AND date(sale_date) BETWEEN date(?) AND date(?)
            GROUP BY date(sale_date) ORDER BY date`,
        )
        .all(from, to) as Record<string, any>[];
      base.columns = [COLS.date, { key: 'invoice_count', label: 'ইনভয়েস', format: 'int', align: 'right' }, COLS.money('subtotal_paisa', 'নিট বিক্রয়'), COLS.money('tax_paisa', 'ধরা ভ্যাট'), COLS.money('total_paisa', 'সর্বমোট')];
      base.rows = rows;
      base.totals = numericTotals(base.columns, rows);
      break;
    }
    default:
      throw new Error('রিপোর্ট পাওয়া যায়নি।');
  }
  return base;
}

/** Dashboard chart series with day/week/month buckets. */
export function dashboardSeries(
  db: Db,
  from: string,
  to: string,
): SeriesPoint[] {
  return salesSeries(db, from, to);
}

export function seriesFor(db: Db, preset: 'today' | 'week' | 'month' | 'year' | 'custom', from?: string, to?: string): SeriesPoint[] {
  const today = todayLocal();
  const start =
    preset === 'today'
      ? today
      : preset === 'week'
        ? addDays(today, -6)
        : preset === 'month'
          ? addDays(today, -29)
          : preset === 'year'
            ? `${today.slice(0, 4)}-01-01`
            : from || startOfMonth(today);
  return salesSeries(db, start, preset === 'custom' ? to || today : today);
}

export function nowStamp(): string {
  return nowLocal();
}

/** Alias used by the IPC layer / dashboard chart controls. */
export { seriesFor as presetSeries };
