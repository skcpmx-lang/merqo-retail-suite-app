import type { Db } from '../db/connection.js';
import { dayEnd, dayStart, nowLocal } from '../domain/datetime.js';
import { lineValuePaisa, resolveDiscount, roundDiv, toBaseMilli } from '../domain/money.js';
import type { Product, Purchase, PurchaseItem } from '../domain/types.js';
import { audit } from './audit.js';
import { ensureOpenSession } from './cash.js';
import { applyMovement } from './inventory.js';
import { isPostingEnabled, postPurchase, reverseDocument } from './accounting.js';
import { nextDocumentNumber } from './invoice.js';
import { insertPayment } from './payments.js';
import { getSettings } from './settings.js';

export interface PurchaseLineInput {
  productId: number;
  unitId?: number | null;
  qtyMilli: number;
  unitPricePaisa: number;
  discountPaisa?: number | null;
  batchNo?: string | null;
  expiryDate?: string | null;
}

export interface PurchaseInput {
  supplierId?: number | null;
  lines: PurchaseLineInput[];
  orderDiscountType?: 'none' | 'percent' | 'fixed';
  orderDiscountValue?: number;
  otherCostPaisa?: number;
  paidPaisa?: number;
  payments?: { methodId: number; amount: number; reference?: string | null }[];
  defaultMethodId?: number | null;
  note?: string | null;
  purchaseDate?: string;
  actor: { id: number; username: string };
}

export interface PurchaseComputation {
  subtotal: number;
  discount: number;
  otherCost: number;
  total: number;
  paid: number;
  due: number;
  lines: {
    productId: number;
    productName: string;
    unitId: number;
    unitLabel: string;
    factorMilli: number;
    qtyMilli: number;
    qtyBaseMilli: number;
    unitPrice: number;
    discount: number;
    lineTotal: number;
    /** Effective landed cost (poisa) of the whole line including allocated extras. */
    landedTotal: number;
    costMicro: number;
    batchNo?: string | null;
    expiryDate?: string | null;
  }[];
}

export function computePurchase(db: Db, input: PurchaseInput): PurchaseComputation {
  if (!input.lines || input.lines.length === 0) throw new Error('পারচেজে অন্তত একটি প্রোডাক্ট থাকতে হবে।');
  const lines: PurchaseComputation['lines'] = [];
  let subtotal = 0;
  for (const line of input.lines) {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(line.productId) as Product | undefined;
    if (!product) throw new Error('প্রোডাক্ট পাওয়া যায়নি।');
    const qtyMilli = Math.round(line.qtyMilli);
    if (!Number.isFinite(qtyMilli) || qtyMilli <= 0) throw new Error(`"${product.name}" এর পরিমাণ সঠিক নয়।`);
    const unitId = line.unitId ?? product.unit_id;
    const unit = db.prepare('SELECT * FROM units WHERE id = ?').get(unitId) as
      | { id: number; short_name: string; factor_milli: number }
      | undefined;
    if (!unit) throw new Error('ইউনিট পাওয়া যায়নি।');
    const unitPrice = Math.round(line.unitPricePaisa);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new Error('ক্রয়মূল্য সঠিক নয়।');
    const qtyBaseMilli = toBaseMilli(qtyMilli, unit.factor_milli);
    const gross = lineValuePaisa(qtyMilli, unitPrice);
    let discount = Math.round(line.discountPaisa ?? 0);
    if (discount < 0 || discount > gross) throw new Error('লাইন ডিসকাউন্ট সঠিক নয়।');
    const lineTotal = gross - discount;
    subtotal += lineTotal;
    lines.push({
      productId: product.id,
      productName: product.name,
      unitId: unit.id,
      unitLabel: unit.short_name,
      factorMilli: unit.factor_milli,
      qtyMilli,
      qtyBaseMilli,
      unitPrice,
      discount,
      lineTotal,
      landedTotal: lineTotal,
      costMicro: roundDiv(lineTotal * 1_000_000_000, qtyBaseMilli),
      batchNo: line.batchNo ?? null,
      expiryDate: line.expiryDate ?? null,
    });
  }
  const discount = resolveDiscount({
    subtotal,
    type: input.orderDiscountType ?? 'none',
    value: input.orderDiscountValue ?? 0,
  });
  const otherCost = Math.round(input.otherCostPaisa ?? 0);
  if (otherCost < 0) throw new Error('অতিরিক্ত খরচ ঋণাত্মক হতে পারবে না।');
  const total = subtotal - discount + otherCost;

  // Allocate order-level discount and extra costs to lines proportionally so the
  // weighted average cost reflects the true landed cost.
  const netBase = subtotal - discount;
  const allocatedExtra = new Map<number, number>();
  if (otherCost > 0 && subtotal > 0) {
    for (const [idx, line] of lines.entries()) {
      const share = roundDiv(otherCost * line.lineTotal, subtotal);
      allocatedExtra.set(idx, share);
    }
    const diff = otherCost - [...allocatedExtra.values()].reduce((a, b) => a + b, 0);
    if (diff !== 0 && lines.length) allocatedExtra.set(0, (allocatedExtra.get(0) ?? 0) + diff);
  }
  for (const [idx, line] of lines.entries()) {
    const discountShare = netBase !== subtotal ? roundDiv(line.lineTotal * discount, subtotal) : 0;
    const extra = allocatedExtra.get(idx) ?? 0;
    line.landedTotal = line.lineTotal - discountShare + extra;
    if (line.landedTotal < 0) line.landedTotal = 0;
    line.costMicro = Math.round(roundDiv(line.landedTotal * 1_000_000_000, line.qtyBaseMilli));
  }

  let paid = 0;
  if (input.payments?.length) paid = input.payments.reduce((s, p) => s + Math.round(p.amount), 0);
  else if (input.paidPaisa != null) paid = Math.round(input.paidPaisa);
  if (paid < 0) throw new Error('পরিশোধিত টাকার পরিমাণ সঠিক নয়।');
  if (paid > total) paid = total;

  return { subtotal, discount, otherCost, total, paid, due: total - paid, lines };
}

export function createPurchase(db: Db, input: PurchaseInput): { purchaseId: number; purchaseNo: string; computation: PurchaseComputation } {
  const settings = getSettings(db);
  const computation = computePurchase(db, input);
  // A credit purchase must belong to somebody. Without a supplier the ledger
  // would carry a "payable" that no supplier record can ever settle, which
  // silently inflates liabilities and breaks reconciliation forever.
  if (computation.due !== 0 && !input.supplierId) {
    throw new Error('বাকি থাকলে সাপ্লায়ার নির্বাচন করুন — নইলে পুরো টাকা পরিশোধ করতে হবে।');
  }
  let payments = (input.payments ?? []).filter((p) => Math.round(p.amount) > 0).map((p) => ({ ...p, amount: Math.round(p.amount) }));
  if (!payments.length && computation.paid > 0) {
    const methodId = input.defaultMethodId ?? settings.default_payment_method_id;
    if (!methodId) throw new Error('পেমেন্ট মেথড নির্বাচন করুন।');
    payments = [{ methodId, amount: computation.paid }];
  }

  const run = db.transaction(() => {
    const purchaseNo = nextDocumentNumber(db, settings, 'purchase');
    const session = ensureOpenSession(db, input.actor.id);
    const purchaseDate = input.purchaseDate ?? nowLocal();
    const res = db
      .prepare(
        `INSERT INTO purchases (purchase_no, supplier_id, user_id, purchase_date, subtotal_paisa, discount_paisa,
           other_cost_paisa, total_paisa, paid_paisa, due_paisa, status, note, cash_session_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,'completed',?,?,?)`,
      )
      .run(
        purchaseNo,
        input.supplierId ?? null,
        input.actor.id,
        purchaseDate,
        computation.subtotal,
        computation.discount,
        computation.otherCost,
        computation.total,
        computation.paid,
        computation.due,
        input.note ? input.note : null,
        session.id,
        nowLocal(),
      );
    const purchaseId = Number(res.lastInsertRowid);
    const insertItem = db.prepare(
      `INSERT INTO purchase_items (purchase_id, product_id, product_name, unit_id, unit_label, qty_milli,
         factor_milli, qty_base_milli, unit_price_paisa, discount_paisa, line_total_paisa, returned_qty_milli)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,0)`,
    );
    const insertBatch = db.prepare(
      `INSERT INTO batches (product_id, batch_no, expiry_date, qty_base_milli, cost_micro, purchase_id, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    );
    for (const [idx, line] of computation.lines.entries()) {
      insertItem.run(
        purchaseId,
        line.productId,
        line.productName,
        line.unitId,
        line.unitLabel,
        line.qtyMilli,
        line.factorMilli,
        line.qtyBaseMilli,
        line.unitPrice,
        line.discount,
        line.lineTotal,
      );
      let batchId: number | null = null;
      if (line.batchNo || line.expiryDate) {
        const bres = insertBatch.run(
          line.productId,
          line.batchNo ?? `B${purchaseId}-${idx + 1}`,
          line.expiryDate ?? null,
          line.qtyBaseMilli,
          line.costMicro,
          purchaseId,
          nowLocal(),
        );
        batchId = Number(bres.lastInsertRowid);
      }
      applyMovement(db, {
        productId: line.productId,
        type: 'purchase',
        qtyBaseMilli: line.qtyBaseMilli,
        unitLabel: line.unitLabel,
        qtyInputMilli: line.qtyMilli,
        refType: 'purchase',
        refId: purchaseId,
        userId: input.actor.id,
        incomingCostMicro: line.costMicro,
        batchId,
      });
    }

    if (computation.due !== 0 && input.supplierId) {
      db.prepare('UPDATE suppliers SET balance_paisa = balance_paisa + ?, updated_at = ? WHERE id = ?').run(
        computation.due,
        nowLocal(),
        input.supplierId,
      );
    }
    for (const p of payments) {
      insertPayment(db, {
        kind: 'purchase',
        partyType: input.supplierId ? 'supplier' : 'none',
        supplierId: input.supplierId ?? null,
        purchaseId,
        amount: p.amount,
        methodId: p.methodId,
        reference: purchaseNo,
        userId: input.actor.id,
        date: purchaseDate,
        direction: 'out',
        affectsBalance: false,
      });
    }
    audit(db, {
      userId: input.actor.id,
      username: input.actor.username,
      action: 'purchase.create',
      entity: 'purchase',
      entityId: purchaseId,
      details: { purchaseNo, total: computation.total, paid: computation.paid, due: computation.due },
    });
    if (isPostingEnabled(db)) postPurchase(db, purchaseId);

    return { purchaseId, purchaseNo, computation };
  });
  return run();
}

export interface PurchaseFilter {
  search?: string;
  from?: string;
  to?: string;
  supplierId?: number | null;
  status?: 'all' | 'completed' | 'voided' | 'returned';
  hasDue?: boolean;
  page?: number;
  pageSize?: number;
}

export function listPurchases(db: Db, f: PurchaseFilter = {}): { rows: Purchase[]; total: number } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.from) {
    where.push('p.purchase_date >= ?');
    params.push(dayStart(f.from));
  }
  if (f.to) {
    where.push('p.purchase_date <= ?');
    params.push(dayEnd(f.to));
  }
  if (f.supplierId) {
    where.push('p.supplier_id = ?');
    params.push(f.supplierId);
  }
  if (f.status && f.status !== 'all') {
    where.push('p.status = ?');
    params.push(f.status);
  }
  if (f.hasDue) where.push('p.due_paisa > 0');
  if (f.search) {
    const like = `%${f.search}%`;
    where.push('(p.purchase_no LIKE ? OR s.name LIKE ? OR s.company LIKE ?)');
    params.push(like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const base = `FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id LEFT JOIN users u ON u.id = p.user_id ${clause}`;
  const total = (db.prepare(`SELECT COUNT(*) c ${base}`).get(...params) as { c: number }).c;
  const page = Math.max(1, f.page ?? 1);
  const pageSize = Math.min(500, Math.max(10, f.pageSize ?? 50));
  const rows = db
    .prepare(
      `SELECT p.*, s.name AS supplier_name, s.company AS supplier_company, u.username AS user_name
       ${base} ORDER BY p.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize) as Purchase[];
  return { rows, total };
}

export function getPurchase(db: Db, id: number): Purchase | null {
  const purchase = db
    .prepare(
      `SELECT p.*, s.name AS supplier_name, u.username AS user_name FROM purchases p
         LEFT JOIN suppliers s ON s.id = p.supplier_id LEFT JOIN users u ON u.id = p.user_id WHERE p.id = ?`,
    )
    .get(id) as Purchase | undefined;
  if (!purchase) return null;
  purchase.items = db
    .prepare(
      `SELECT pi.*, u.short_name AS unit_short_name FROM purchase_items pi
         LEFT JOIN units u ON u.id = pi.unit_id WHERE pi.purchase_id = ? ORDER BY pi.id`,
    )
    .all(id) as PurchaseItem[];
  return purchase;
}

export function getPurchaseByNo(db: Db, no: string): Purchase | null {
  const row = db.prepare('SELECT id FROM purchases WHERE purchase_no = ?').get(no.trim()) as { id: number } | undefined;
  return row ? getPurchase(db, row.id) : null;
}

export function voidPurchase(db: Db, purchaseId: number, reason: string, actor: { id: number; username: string }): void {
  const purchase = getPurchase(db, purchaseId);
  if (!purchase) throw new Error('পারচেজ পাওয়া যায়নি।');
  if (purchase.status === 'voided') throw new Error('এই পারচেজ আগেই বাতিল করা হয়েছে।');
  if (!reason || !reason.trim()) throw new Error('বাতিল করার কারণ লিখতে হবে।');
  const returns = (
    db.prepare("SELECT COUNT(*) c FROM returns WHERE purchase_id = ? AND status = 'completed'").get(purchaseId) as {
      c: number;
    }
  ).c;
  if (returns > 0) throw new Error('এই পারচেজে রিটার্ন হয়েছে — বাতিল করা যাবে না।');

  const run = db.transaction(() => {
    for (const item of purchase.items ?? []) {
      applyMovement(db, {
        productId: item.product_id,
        type: 'purchase_return',
        qtyBaseMilli: -item.qty_base_milli,
        unitLabel: item.unit_short_name ?? null,
        refType: 'purchase_void',
        refId: purchaseId,
        reason: `পারচেজ বাতিল: ${reason}`,
        userId: actor.id,
        force: true,
      });
    }
    db.prepare('DELETE FROM batches WHERE purchase_id = ?').run(purchaseId);
    if (purchase.supplier_id && purchase.due_paisa !== 0) {
      db.prepare('UPDATE suppliers SET balance_paisa = balance_paisa - ?, updated_at = ? WHERE id = ?').run(
        purchase.due_paisa,
        nowLocal(),
        purchase.supplier_id,
      );
    }
    db.prepare("UPDATE payments SET status = 'reversed' WHERE purchase_id = ? AND status = 'active'").run(purchaseId);
    db.prepare("UPDATE purchases SET status = 'voided' WHERE id = ?").run(purchaseId);
    if (isPostingEnabled(db)) {
      reverseDocument(db, 'purchase', purchaseId, { userId: actor.id, memo: `বাতিল: ${purchase.purchase_no} — ${reason}` });
    }
    audit(db, {
      userId: actor.id,
      username: actor.username,
      action: 'purchase.void',
      entity: 'purchase',
      entityId: purchaseId,
      details: { purchaseNo: purchase.purchase_no, total: purchase.total_paisa, reason },
    });
  });
  run();
}
