import type { Db } from '../db/connection.js';
import { foldForSearch } from '../domain/text.js';

export interface SearchHit {
  kind: 'product' | 'customer' | 'supplier' | 'sale' | 'purchase' | 'expense';
  id: number;
  title: string;
  subtitle: string;
  amount_paisa: number | null;
  meta?: string | null;
}

/** Global search box used by the top navigation bar. */
export function searchEverything(db: Db, term: string, limitPerKind = 6): SearchHit[] {
  const raw = (term ?? '').trim();
  if (!raw) return [];
  const like = `%${foldForSearch(raw)}%`;
  const numeric = /^\d+$/.test(raw);
  const hits: SearchHit[] = [];

  const products = db
    .prepare(
      `SELECT p.id, p.name, p.sku, p.stock_base_milli, u.short_name AS unit
         FROM products p LEFT JOIN units u ON u.id = p.unit_id
        WHERE p.is_active = 1 AND (p.search_text LIKE ? OR p.sku LIKE ? OR p.product_code LIKE ?
              OR p.id IN (SELECT product_id FROM product_barcodes WHERE code LIKE ?))
        ORDER BY p.name_sort LIMIT ?`,
    )
    .all(like, like, like, like, limitPerKind) as any[];
  for (const p of products) {
    hits.push({
      kind: 'product',
      id: p.id,
      title: p.name,
      subtitle: `${p.sku ?? '—'} • স্টক: ${(p.stock_base_milli / 1000).toFixed(2)} ${p.unit ?? ''}`,
      amount_paisa: null,
    });
  }

  const customers = db
    .prepare('SELECT id, name, phone, balance_paisa FROM customers WHERE search_text LIKE ? OR phone LIKE ? LIMIT ?')
    .all(like, like, limitPerKind) as any[];
  for (const c of customers) {
    hits.push({
      kind: 'customer',
      id: c.id,
      title: c.name,
      subtitle: c.phone ?? 'মোবাইল নেই',
      amount_paisa: c.balance_paisa,
    });
  }

  const suppliers = db
    .prepare('SELECT id, name, phone, company, balance_paisa FROM suppliers WHERE search_text LIKE ? LIMIT ?')
    .all(like, limitPerKind) as any[];
  for (const s of suppliers) {
    hits.push({
      kind: 'supplier',
      id: s.id,
      title: s.name,
      subtitle: s.company ?? s.phone ?? '',
      amount_paisa: s.balance_paisa,
    });
  }

  if (raw.length >= 2) {
    const sales = db
      .prepare(
        `SELECT s.id, s.invoice_no, s.total_paisa, s.sale_date, c.name AS customer
           FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
          WHERE s.invoice_no LIKE ? ORDER BY s.id DESC LIMIT ?`,
      )
      .all(like, limitPerKind) as any[];
    for (const s of sales) {
      hits.push({
        kind: 'sale',
        id: s.id,
        title: s.invoice_no,
        subtitle: `${s.sale_date} • ${s.customer ?? 'ওয়াক-ইন'}`,
        amount_paisa: s.total_paisa,
      });
    }
    const purchases = db
      .prepare(
        `SELECT p.id, p.purchase_no, p.total_paisa, p.purchase_date, s.name AS supplier
           FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id
          WHERE p.purchase_no LIKE ? OR s.name LIKE ? ORDER BY p.id DESC LIMIT ?`,
      )
      .all(like, like, limitPerKind) as any[];
    for (const p of purchases) {
      hits.push({
        kind: 'purchase',
        id: p.id,
        title: p.purchase_no,
        subtitle: `${p.purchase_date} • ${p.supplier ?? '—'}`,
        amount_paisa: p.total_paisa,
      });
    }
  }
  void numeric;
  return hits;
}
