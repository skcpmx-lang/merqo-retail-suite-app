import type { Db } from '../db/connection.js';
import { nowLocal } from '../domain/datetime.js';
import { lineValuePaisa, roundDiv } from '../domain/money.js';
import type { ReturnDoc, ReturnItem } from '../domain/types.js';
import { audit } from './audit.js';
import { ensureOpenSession } from './cash.js';
import { applyMovement } from './inventory.js';
import { isPostingEnabled, postPurchaseReturn, postSaleReturn } from './accounting.js';
import { nextDocumentNumber } from './invoice.js';
import { insertPayment } from './payments.js';
import { getSettings } from './settings.js';
import { getSale } from './sales.js';
import { getPurchase } from './purchases.js';
import { reverseLoyaltyForSale } from './crm.js';

export interface ReturnItemInput {
  lineId: number;
  qtyMilli: number;
  condition?: 'good' | 'damaged' | 'expired';
}

export interface SaleReturnInput {
  saleId: number;
  items: ReturnItemInput[];
  restock?: boolean;
  refundPaisa?: number;
  refundMethodId?: number | null;
  note?: string | null;
  returnDate?: string;
  actor: { id: number; username: string };
}

export interface ReturnResult {
  returnId: number;
  returnNo: string;
  total: number;
  /** Cash that actually left (or entered) the drawer for this return. */
  refund: number;
  /** Part of the returned value that settled an outstanding balance instead of cash. */
  appliedToDue: number;
}

export function createSaleReturn(db: Db, input: SaleReturnInput): ReturnResult {
  const sale = getSale(db, input.saleId);
  if (!sale) throw new Error('মূল ইনভয়েস পাওয়া যায়নি।');
  if (sale.status === 'voided') throw new Error('বাতিল করা ইনভয়েসে রিটার্ন করা যাবে না।');
  if (!input.items?.length) throw new Error('রিটার্নের জন্য অন্তত একটি প্রোডাক্ট নির্বাচন করুন।');
  const settings = getSettings(db);
  const restock = input.restock !== false;

  const computed: { item: ReturnItem; saleItemId: number; costMicro: number }[] = [];
  let total = 0;
  for (const req of input.items) {
    const saleItem = (sale.items ?? []).find((i) => i.id === req.lineId);
    if (!saleItem) throw new Error('ইনভয়েসের লাইন পাওয়া যায়নি।');
    const remaining = saleItem.qty_milli - saleItem.returned_qty_milli;
    const qty = Math.round(req.qtyMilli);
    if (qty <= 0) throw new Error('রিটার্ন পরিমাণ ০ এর চেয়ে বড় হতে হবে।');
    if (qty > remaining) {
      throw new Error(
        `"${saleItem.product_name}" এর সর্বোচ্চ ${(remaining / 1000).toFixed(3)} ফেরত দেওয়া সম্ভব।`,
      );
    }
    const gross = lineValuePaisa(qty, saleItem.unit_price_paisa);
    const discountShare = saleItem.qty_milli > 0 ? roundDiv(saleItem.discount_paisa * qty, saleItem.qty_milli) : 0;
    let lineTotal = gross - discountShare;
    if (lineTotal < 0) lineTotal = 0;
    total += lineTotal;
    const qtyBase = roundDiv(qty * saleItem.factor_milli, 1000);
    const condition = req.condition ?? 'good';
    computed.push({
      saleItemId: saleItem.id,
      costMicro: saleItem.cost_micro,
      item: {
        id: 0,
        return_id: 0,
        product_id: saleItem.product_id,
        product_name: saleItem.product_name,
        qty_milli: qty,
        factor_milli: saleItem.factor_milli,
        qty_base_milli: qtyBase,
        unit_price_paisa: saleItem.unit_price_paisa,
        line_total_paisa: lineTotal,
        condition,
        restocked: restock && condition === 'good' ? 1 : 0,
        sale_item_id: saleItem.id,
        purchase_item_id: null,
      },
    });
  }

  // A refund may only pay out money the shop actually owes this customer.
  // Returning goods against an unpaid invoice reduces the due instead of
  // handing cash over the counter (otherwise the customer both keeps the money
  // and still owes the full invoice).
  const balanceBefore = sale.customer_id
    ? ((db.prepare('SELECT balance_paisa b FROM customers WHERE id = ?').get(sale.customer_id) as { b: number } | undefined)?.b ?? 0)
    : 0;
  const creditAfterReturn = sale.customer_id ? Math.max(0, total - balanceBefore) : total;
  const requested =
    input.refundPaisa === undefined ? Math.min(total, creditAfterReturn) : Math.round(input.refundPaisa);
  if (!Number.isFinite(requested) || requested < 0) throw new Error('রিফান্ডের পরিমাণ সঠিক নয়।');
  if (requested > total) throw new Error('রিফান্ড রিটার্নের মোট টাকার চেয়ে বেশি হতে পারবে না।');
  const refund = Math.min(requested, creditAfterReturn);
  // Everything that is not handed back as cash settles the party's balance —
  // including the part the caller never asked to refund.
  const appliedToDue = total - refund;
  if (refund > 0 && !input.refundMethodId) throw new Error('রিফান্ডের পেমেন্ট মেথড নির্বাচন করুন।');

  const run = db.transaction((): ReturnResult => {
    const returnNo = nextDocumentNumber(db, settings, 'return');
    const session = ensureOpenSession(db, input.actor.id);
    const returnDate = input.returnDate ?? nowLocal();
    const res = db
      .prepare(
        `INSERT INTO returns (return_no, kind, sale_id, customer_id, user_id, return_date, total_paisa,
           cost_total_paisa, refund_paisa, refund_method_id, restock, status, note, cash_session_id, created_at)
         VALUES (?, 'sale', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)`,
      )
      .run(
        returnNo,
        input.saleId,
        sale.customer_id ?? null,
        input.actor.id,
        returnDate,
        total,
        computed.reduce((sum, c) => sum + roundDiv(c.costMicro * c.item.qty_base_milli, 1000 * 1_000_000), 0),
        refund,
        input.refundMethodId ?? null,
        restock ? 1 : 0,
        input.note ?? null,
        session.id,
        nowLocal(),
      );
    const returnId = Number(res.lastInsertRowid);
    const insertItem = db.prepare(
      `INSERT INTO return_items (return_id, sale_item_id, product_id, product_name, unit_label, qty_milli,
         factor_milli, qty_base_milli, unit_price_paisa, line_total_paisa, cost_micro, cost_total_paisa, condition,
         restocked)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const c of computed) {
      const item = c.item;
      const costTotal = roundDiv(c.costMicro * item.qty_base_milli, 1000 * 1_000_000);
      insertItem.run(
        returnId,
        item.sale_item_id,
        item.product_id,
        item.product_name,
        null,
        item.qty_milli,
        item.factor_milli,
        item.qty_base_milli,
        item.unit_price_paisa,
        item.line_total_paisa,
        c.costMicro,
        costTotal,
        item.condition,
        item.restocked,
      );
      db.prepare('UPDATE sale_items SET returned_qty_milli = returned_qty_milli + ? WHERE id = ?').run(
        item.qty_milli,
        item.sale_item_id,
      );
      if (item.restocked === 1) {
        applyMovement(db, {
          productId: item.product_id,
          type: 'sale_return',
          qtyBaseMilli: item.qty_base_milli,
          refType: 'return',
          refId: returnId,
          reason: 'সেলস রিটার্ন (ভালো কন্ডিশন)',
          userId: input.actor.id,
          force: true,
          incomingCostMicro: c.costMicro,
        });
      } else if (item.condition === 'damaged' || item.condition === 'expired') {
        db.prepare(
          `INSERT INTO stock_movements (product_id, type, qty_base_milli, balance_after_milli, ref_type, ref_id,
             reason, user_id, created_at)
           SELECT id, ?, 0, stock_base_milli, 'return', ?, ?, ?, ? FROM products WHERE id = ?`,
        ).run(
          item.condition === 'damaged' ? 'damage' : 'expiry',
          String(returnId),
          `রিটার্ন — ${item.condition === 'damaged' ? 'নষ্ট' : 'মেয়াদোত্তীর্ণ'} (স্টকে ফেরানো হয়নি)`,
          input.actor.id,
          nowLocal(),
          item.product_id,
        );
      }
    }

    if (sale.customer_id) {
      db.prepare('UPDATE customers SET balance_paisa = balance_paisa - ?, updated_at = ? WHERE id = ?').run(
        total,
        nowLocal(),
        sale.customer_id,
      );
    }
    if (refund > 0 && input.refundMethodId) {
      insertPayment(db, {
        kind: 'refund',
        partyType: sale.customer_id ? 'customer' : 'none',
        customerId: sale.customer_id ?? null,
        saleId: input.saleId,
        amount: refund,
        methodId: input.refundMethodId,
        reference: returnNo,
        note: 'সেলস রিটার্ন রিফান্ড',
        userId: input.actor.id,
        date: returnDate,
        direction: 'out',
        affectsBalance: true,
      });
    }

    const outstanding = (
      db
        .prepare('SELECT SUM(qty_milli - returned_qty_milli) v FROM sale_items WHERE sale_id = ?')
        .get(input.saleId) as { v: number | null }
    ).v;
    if (!outstanding || outstanding <= 0) {
      db.prepare("UPDATE sales SET status = 'returned' WHERE id = ?").run(input.saleId);
      // Fully returned invoice: the loyalty points earned on it are reversed.
      reverseLoyaltyForSale(db, input.saleId, `সম্পূর্ণ রিটার্ন ${returnNo}`, input.actor);
    }

    audit(db, {
      userId: input.actor.id,
      username: input.actor.username,
      action: 'return.sale',
      entity: 'return',
      entityId: returnId,
      details: { returnNo, saleId: input.saleId, total, refund, appliedToDue, restock },
    });
    if (isPostingEnabled(db)) postSaleReturn(db, returnId);
    return { returnId, returnNo, total, refund, appliedToDue };
  });
  return run();
}

export interface PurchaseReturnInput {
  purchaseId: number;
  items: ReturnItemInput[];
  refundPaisa?: number;
  refundMethodId?: number | null;
  note?: string | null;
  returnDate?: string;
  actor: { id: number; username: string };
}

export function createPurchaseReturn(db: Db, input: PurchaseReturnInput): ReturnResult {
  const purchase = getPurchase(db, input.purchaseId);
  if (!purchase) throw new Error('মূল পারচেজ পাওয়া যায়নি।');
  if (purchase.status === 'voided') throw new Error('বাতিল করা পারচেজে রিটার্ন করা যাবে না।');
  if (!input.items?.length) throw new Error('রিটার্নের জন্য অন্তত একটি প্রোডাক্ট নির্বাচন করুন।');
  const settings = getSettings(db);

  const computed: { item: ReturnItem; purchaseItemId: number }[] = [];
  let total = 0;
  for (const req of input.items) {
    const pItem = (purchase.items ?? []).find((i) => i.id === req.lineId);
    if (!pItem) throw new Error('পারচেজের লাইন পাওয়া যায়নি।');
    const remaining = pItem.qty_milli - pItem.returned_qty_milli;
    const qty = Math.round(req.qtyMilli);
    if (qty <= 0) throw new Error('রিটার্ন পরিমাণ ০ এর চেয়ে বড় হতে হবে।');
    if (qty > remaining)
      throw new Error(`"${pItem.product_name}" এর সর্বোচ্চ ${(remaining / 1000).toFixed(3)} ফেরত দেওয়া সম্ভব।`);
    const gross = lineValuePaisa(qty, pItem.unit_price_paisa);
    const discountShare = pItem.qty_milli > 0 ? roundDiv(pItem.discount_paisa * qty, pItem.qty_milli) : 0;
    const lineTotal = Math.max(0, gross - discountShare);
    total += lineTotal;
    const qtyBase = roundDiv(qty * pItem.factor_milli, 1000);
    computed.push({
      purchaseItemId: pItem.id,
      item: {
        id: 0,
        return_id: 0,
        product_id: pItem.product_id,
        product_name: pItem.product_name,
        qty_milli: qty,
        factor_milli: pItem.factor_milli,
        qty_base_milli: qtyBase,
        unit_price_paisa: pItem.unit_price_paisa,
        line_total_paisa: lineTotal,
        condition: 'good',
        restocked: 0,
        sale_item_id: null,
        purchase_item_id: pItem.id,
      },
    });
  }

  // Symmetric rule: the supplier only pays us back for goods we had already
  // paid for. Otherwise the return simply reduces what we owe them.
  const payableBefore = purchase.supplier_id
    ? ((db.prepare('SELECT balance_paisa b FROM suppliers WHERE id = ?').get(purchase.supplier_id) as { b: number } | undefined)?.b ?? 0)
    : 0;
  const creditAfterReturn = purchase.supplier_id ? Math.max(0, total - payableBefore) : total;
  const requested = input.refundPaisa === undefined ? 0 : Math.round(input.refundPaisa);
  if (!Number.isFinite(requested) || requested < 0 || requested > total)
    throw new Error('রিফান্ডের পরিমাণ সঠিক নয়।');
  const refund = Math.min(requested, creditAfterReturn);
  const appliedToDue = total - refund;
  if (refund > 0 && !input.refundMethodId) throw new Error('রিফান্ডের পেমেন্ট মেথড নির্বাচন করুন।');

  const run = db.transaction((): ReturnResult => {
    const returnNo = nextDocumentNumber(db, settings, 'return_purchase');
    const session = ensureOpenSession(db, input.actor.id);
    const returnDate = input.returnDate ?? nowLocal();
    const res = db
      .prepare(
        `INSERT INTO returns (return_no, kind, purchase_id, supplier_id, user_id, return_date, total_paisa,
           cost_total_paisa, refund_paisa, refund_method_id, restock, status, note, cash_session_id, created_at)
         VALUES (?, 'purchase', ?, ?, ?, ?, ?, 0, ?, ?, 0, 'completed', ?, ?, ?)`,
      )
      .run(
        returnNo,
        input.purchaseId,
        purchase.supplier_id ?? null,
        input.actor.id,
        returnDate,
        total,
        refund,
        input.refundMethodId ?? null,
        input.note ?? null,
        session.id,
        nowLocal(),
      );
    const returnId = Number(res.lastInsertRowid);
    const insertItem = db.prepare(
      `INSERT INTO return_items (return_id, purchase_item_id, product_id, product_name, unit_label, qty_milli,
         factor_milli, qty_base_milli, unit_price_paisa, line_total_paisa, cost_micro, cost_total_paisa, condition,
         restocked)
       VALUES (?,?,?,?,?,?,?,?,?,?,0,0,'good',0)`,
    );
    for (const c of computed) {
      insertItem.run(
        returnId,
        c.purchaseItemId,
        c.item.product_id,
        c.item.product_name,
        null,
        c.item.qty_milli,
        c.item.factor_milli,
        c.item.qty_base_milli,
        c.item.unit_price_paisa,
        c.item.line_total_paisa,
      );
      db.prepare('UPDATE purchase_items SET returned_qty_milli = returned_qty_milli + ? WHERE id = ?').run(
        c.item.qty_milli,
        c.purchaseItemId,
      );
      applyMovement(db, {
        productId: c.item.product_id,
        type: 'purchase_return',
        qtyBaseMilli: -c.item.qty_base_milli,
        refType: 'return',
        refId: returnId,
        reason: 'পারচেজ রিটার্ন',
        userId: input.actor.id,
        force: true,
      });
    }
    if (purchase.supplier_id) {
      db.prepare('UPDATE suppliers SET balance_paisa = balance_paisa - ?, updated_at = ? WHERE id = ?').run(
        total,
        nowLocal(),
        purchase.supplier_id,
      );
    }
    if (refund > 0 && input.refundMethodId) {
      insertPayment(db, {
        kind: 'purchase_refund',
        partyType: purchase.supplier_id ? 'supplier' : 'none',
        supplierId: purchase.supplier_id ?? null,
        purchaseId: input.purchaseId,
        amount: refund,
        methodId: input.refundMethodId,
        reference: returnNo,
        note: 'পারচেজ রিটার্ন রিফান্ড',
        userId: input.actor.id,
        date: returnDate,
        direction: 'in',
        affectsBalance: purchase.supplier_id != null,
      });
    }
    const outstanding = (
      db
        .prepare('SELECT SUM(qty_milli - returned_qty_milli) v FROM purchase_items WHERE purchase_id = ?')
        .get(input.purchaseId) as { v: number | null }
    ).v;
    if (!outstanding || outstanding <= 0) {
      db.prepare("UPDATE purchases SET status = 'returned' WHERE id = ?").run(input.purchaseId);
    }
    audit(db, {
      userId: input.actor.id,
      username: input.actor.username,
      action: 'return.purchase',
      entity: 'return',
      entityId: returnId,
      details: { returnNo, purchaseId: input.purchaseId, total, refund, appliedToDue },
    });
    if (isPostingEnabled(db)) postPurchaseReturn(db, returnId);
    return { returnId, returnNo, total, refund, appliedToDue };
  });
  return run();
}

export function listReturns(
  db: Db,
  f: { kind?: 'sale' | 'purchase' | 'all'; from?: string; to?: string; search?: string; page?: number; pageSize?: number } = {},
): { rows: ReturnDoc[]; total: number } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.kind && f.kind !== 'all') {
    where.push('r.kind = ?');
    params.push(f.kind);
  }
  if (f.from) {
    where.push('date(r.return_date) >= date(?)');
    params.push(f.from);
  }
  if (f.to) {
    where.push('date(r.return_date) <= date(?)');
    params.push(f.to);
  }
  if (f.search) {
    const like = `%${f.search}%`;
    where.push('(r.return_no LIKE ? OR c.name LIKE ? OR s.name LIKE ?)');
    params.push(like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const base = `FROM returns r LEFT JOIN customers c ON c.id = r.customer_id
    LEFT JOIN suppliers s ON s.id = r.supplier_id
    LEFT JOIN sales sa ON sa.id = r.sale_id
    LEFT JOIN purchases pu ON pu.id = r.purchase_id ${clause}`;
  const total = (db.prepare(`SELECT COUNT(*) c ${base}`).get(...params) as { c: number }).c;
  const page = Math.max(1, f.page ?? 1);
  const pageSize = Math.min(200, Math.max(10, f.pageSize ?? 50));
  const rows = db
    .prepare(
      `SELECT r.*, COALESCE(c.name, s.name) AS party_name, COALESCE(sa.invoice_no, pu.purchase_no) AS ref_no
       ${base} ORDER BY r.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize) as ReturnDoc[];
  return { rows, total };
}

export function getReturn(db: Db, id: number): ReturnDoc | null {
  const row = db
    .prepare(
      `SELECT r.*, COALESCE(c.name, s.name) AS party_name, COALESCE(sa.invoice_no, pu.purchase_no) AS ref_no
         FROM returns r LEFT JOIN customers c ON c.id = r.customer_id
         LEFT JOIN suppliers s ON s.id = r.supplier_id
         LEFT JOIN sales sa ON sa.id = r.sale_id
         LEFT JOIN purchases pu ON pu.id = r.purchase_id WHERE r.id = ?`,
    )
    .get(id) as ReturnDoc | undefined;
  if (!row) return null;
  row.items = db
    .prepare('SELECT * FROM return_items WHERE return_id = ? ORDER BY id')
    .all(id) as ReturnItem[];
  return row;
}
