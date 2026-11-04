import type { Db } from '../db/connection.js';
import { addDays, nowLocal, todayLocal } from '../domain/datetime.js';
import type { ActivityItem, DashboardStats } from '../domain/types.js';
import { cashInHandPaisa } from './cash.js';
import { stockValuePaisa } from './inventory.js';
import { customerCount, totalDuePaisa } from './customers.js';
import { supplierCount, totalPayablePaisa } from './suppliers.js';
import { productCounts } from './products.js';

export function dashboardStats(db: Db): DashboardStats {
  const today = todayLocal();
  const money = (sql: string, ...p: any[]): number => {
    const row = db.prepare(sql).get(...p) as { v: number | null } | undefined;
    return Number(row?.v ?? 0);
  };
  const counts = productCounts(db);
  const todaySales = db
    .prepare(
      `SELECT COALESCE(SUM(total_paisa),0) total, COALESCE(SUM(profit_paisa),0) profit, COUNT(*) c
         FROM sales WHERE status <> 'voided' AND date(sale_date) = date(?)`,
    )
    .get(today) as { total: number; profit: number; c: number };
  return {
    today_sales_paisa: todaySales.total,
    today_profit_paisa: todaySales.profit,
    today_sales_count: todaySales.c,
    total_sales_paisa: money("SELECT COALESCE(SUM(total_paisa),0) v FROM sales WHERE status <> 'voided'"),
    total_profit_paisa: money("SELECT COALESCE(SUM(profit_paisa),0) v FROM sales WHERE status <> 'voided'"),
    total_due_paisa: totalDuePaisa(db),
    total_payable_paisa: totalPayablePaisa(db),
    total_customers: customerCount(db),
    total_suppliers: supplierCount(db),
    total_products: counts.total,
    stock_value_paisa: stockValuePaisa(db),
    total_purchases_paisa: money("SELECT COALESCE(SUM(total_paisa),0) v FROM purchases WHERE status <> 'voided'"),
    total_expenses_paisa: money("SELECT COALESCE(SUM(amount_paisa),0) v FROM expenses WHERE status = 'active'"),
    cash_in_hand_paisa: cashInHandPaisa(db),
    low_stock_count: counts.low,
    out_of_stock_count: counts.out,
    today_expense_paisa: money(
      "SELECT COALESCE(SUM(amount_paisa),0) v FROM expenses WHERE status = 'active' AND date(expense_date) = date(?)",
      today,
    ),
    today_collection_paisa: money(
      `SELECT COALESCE(SUM(p.amount_paisa),0) v FROM payments p WHERE p.status='active' AND p.direction='in'
         AND p.kind NOT IN ('sale') AND date(p.payment_date) = date(?)`,
      today,
    ),
  };
}

export interface RecentBundle {
  sales: any[];
  purchases: any[];
  payments: any[];
  expenses: any[];
}

export function recentActivity(db: Db, limit = 8): RecentBundle {
  const sales = db
    .prepare(
      `SELECT s.id, s.invoice_no, s.sale_date, s.total_paisa, s.due_paisa, COALESCE(c.name,'ওয়াক-ইন') customer_name
         FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
        WHERE s.status <> 'voided' ORDER BY s.id DESC LIMIT ?`,
    )
    .all(limit);
  const purchases = db
    .prepare(
      `SELECT p.id, p.purchase_no, p.purchase_date, p.total_paisa, COALESCE(s.name,'—') supplier_name
         FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id ORDER BY p.id DESC LIMIT ?`,
    )
    .all(limit);
  const payments = db
    .prepare(
      `SELECT pm.id, pm.payment_date, pm.amount_paisa, pm.direction, pm.kind, COALESCE(c.name, s.name,'—') party,
              COALESCE(m.name,'') method
         FROM payments pm LEFT JOIN customers c ON c.id = pm.customer_id
         LEFT JOIN suppliers s ON s.id = pm.supplier_id LEFT JOIN payment_methods m ON m.id = pm.method_id
        WHERE pm.status = 'active' AND pm.kind NOT IN ('sale','purchase')
        ORDER BY pm.id DESC LIMIT ?`,
    )
    .all(limit);
  const expenses = db
    .prepare(
      `SELECT e.id, e.expense_date, e.amount_paisa, e.description, COALESCE(ec.name,'') category
         FROM expenses e LEFT JOIN expense_categories ec ON ec.id = e.category_id
        WHERE e.status = 'active' ORDER BY e.id DESC LIMIT ?`,
    )
    .all(limit);
  return { sales, purchases, payments, expenses };
}

export function activityFeed(db: Db, limit = 12): ActivityItem[] {
  const items: ActivityItem[] = [];
  const sales = db
    .prepare(
      `SELECT s.id, s.invoice_no, s.sale_date, s.total_paisa, COALESCE(c.name,'ওয়াক-ইন') customer_name
         FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
        WHERE s.status <> 'voided' ORDER BY s.id DESC LIMIT ?`,
    )
    .all(limit) as any[];
  for (const s of sales) {
    items.push({
      id: `sale-${s.id}`,
      kind: 'sale',
      title: `বিক্রয় ${s.invoice_no}`,
      subtitle: s.customer_name,
      amount_paisa: s.total_paisa,
      at: s.sale_date,
    });
  }
  const purchases = db
    .prepare(
      `SELECT p.id, p.purchase_no, p.purchase_date, p.total_paisa, COALESCE(s.name,'—') supplier_name
         FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id ORDER BY p.id DESC LIMIT ?`,
    )
    .all(limit) as any[];
  for (const p of purchases) {
    items.push({
      id: `purchase-${p.id}`,
      kind: 'purchase',
      title: `পারচেজ ${p.purchase_no}`,
      subtitle: p.supplier_name,
      amount_paisa: p.total_paisa,
      at: p.purchase_date,
    });
  }
  const payments = db
    .prepare(
      `SELECT pm.id, pm.payment_date, pm.amount_paisa, pm.direction, pm.kind,
              COALESCE(c.name, s.name,'—') party
         FROM payments pm LEFT JOIN customers c ON c.id = pm.customer_id
         LEFT JOIN suppliers s ON s.id = pm.supplier_id
        WHERE pm.status = 'active' AND pm.kind NOT IN ('sale','purchase')
        ORDER BY pm.id DESC LIMIT ?`,
    )
    .all(limit) as any[];
  for (const p of payments) {
    items.push({
      id: `payment-${p.id}`,
      kind: 'payment',
      title: p.direction === 'in' ? 'বাকি আদায়' : 'সাপ্লায়ার পেমেন্ট',
      subtitle: p.party,
      amount_paisa: p.amount_paisa,
      at: p.payment_date,
    });
  }
  const expenses = db
    .prepare(
      `SELECT e.id, e.expense_date, e.amount_paisa, e.description FROM expenses e
        WHERE e.status = 'active' ORDER BY e.id DESC LIMIT ?`,
    )
    .all(limit) as any[];
  for (const e of expenses) {
    items.push({
      id: `expense-${e.id}`,
      kind: 'expense',
      title: 'এক্সপেন্স',
      subtitle: e.description,
      amount_paisa: e.amount_paisa,
      at: e.expense_date,
    });
  }
  return items
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, limit);
}

/** Business-health numbers for the dashboard trend cards. */
export function trends(db: Db): {
  week_sales: number;
  week_profit: number;
  prev_week_sales: number;
  prev_week_profit: number;
  month_sales: number;
  month_profit: number;
  top_products: { name: string; qty_base: number; revenue: number }[];
} {
  const today = todayLocal();
  const weekFrom = addDays(today, -6);
  const prevFrom = addDays(today, -13);
  const prevTo = addDays(today, -7);
  const monthFrom = `${today.slice(0, 7)}-01`;
  const sum = (from: string, to: string) =>
    db
      .prepare(
        `SELECT COALESCE(SUM(total_paisa),0) sales, COALESCE(SUM(profit_paisa),0) profit FROM sales
          WHERE status <> 'voided' AND date(sale_date) BETWEEN date(?) AND date(?)`,
      )
      .get(from, to) as { sales: number; profit: number };
  const week = sum(weekFrom, today);
  const prev = sum(prevFrom, prevTo);
  const month = sum(monthFrom, today);
  const top = db
    .prepare(
      `SELECT p.name, SUM(si.qty_base_milli) qty_base, SUM(si.line_total_paisa) revenue
         FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id
        WHERE s.status <> 'voided' AND date(s.sale_date) BETWEEN date(?) AND date(?)
        GROUP BY si.product_id ORDER BY revenue DESC LIMIT 5`,
    )
    .all(monthFrom, today) as { name: string; qty_base: number; revenue: number }[];
  return {
    week_sales: week.sales,
    week_profit: week.profit,
    prev_week_sales: prev.sales,
    prev_week_profit: prev.profit,
    month_sales: month.sales,
    month_profit: month.profit,
    top_products: top,
  };
}
