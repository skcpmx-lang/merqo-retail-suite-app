import type { Db } from '../db/connection.js';
import { nowLocal } from '../domain/datetime.js';
import { normalizeText } from '../domain/text.js';
import { toBaseMilli } from '../domain/money.js';
import { audit } from './audit.js';
import { getSettings } from './settings.js';
import { createPurchase, computePurchase, type PurchaseLineInput } from './purchases.js';
import { nextDocumentNumber } from './invoice.js';

type Actor = { id: number; username: string };

export type PurchaseOrderStatus = 'open' | 'partial' | 'received' | 'cancelled';

export interface PurchaseOrderLineInput {
  productId: number;
  unitId?: number | null;
  qtyMilli: number;
  unitCostPaisa: number;
  discountPaisa?: number | null;
}

export interface PurchaseOrderInput {
  supplierId?: number | null;
  lines: PurchaseOrderLineInput[];
  orderDate?: string;
  expectedDate?: string | null;
  locationId?: number | null;
  note?: string | null;
  orderDiscountType?: 'none' | 'percent' | 'fixed';
  orderDiscountValue?: number;
  taxPercentX100?: number;
  actor: Actor;
}

export interface PurchaseOrderItemRow {
  id: number;
  po_id: number;
  product_id: number;
  product_name: string;
  unit_id: number | null;
  unit_label: string | null;
  qty_milli: number;
  factor_milli: number;
  qty_base_milli: number;
  received_base_milli: number;
  unit_cost_paisa: number;
  line_total_paisa: number;
  /** Derived: still to be delivered, in base milli. */
  remaining_base_milli: number;
  sku?: string | null;
}

export interface PurchaseOrder {
  id: number;
  po_no: string;
  supplier_id: number | null;
  supplier_name?: string | null;
  location_id: number | null;
  order_date: string;
  expected_date: string | null;
  status: PurchaseOrderStatus;
  subtotal_paisa: number;
  discount_paisa: number;
  tax_paisa: number;
  total_paisa: number;
  note: string | null;
  cancel_reason: string | null;
  user_id: number | null;
  created_at: string;
  updated_at: string;
  items?: PurchaseOrderItemRow[];
  receipts?: any[];
  /** Derived: 0–100, share of ordered value already received. */
  received_percent?: number;
}

/**
 * Purchase orders never touch stock or the ledger — only a receipt does. That
 * separation is what makes partial delivery safe: an order is a promise, a
 * purchase document is the goods.
 */
export function createPurchaseOrder(db: Db, input: PurchaseOrderInput): PurchaseOrder {
  if (!input.lines?.length) throw new Error('অর্ডারে অন্তত একটি প্রোডাক্ট থাকতে হবে।');
  const settings = getSettings(db);
  const supplierId = input.supplierId ?? null;
  if (supplierId) {
    const supplier = db.prepare('SELECT id, is_active FROM suppliers WHERE id = ?').get(supplierId) as
      | { id: number; is_active: number }
      | undefined;
    if (!supplier) throw new Error('সাপ্লায়ার পাওয়া যায়নি।');
    if (supplier.is_active !== 1) throw new Error('সাপ্লায়ার নিষ্ক্রিয় — অর্ডার করা যাবে না।');
  }

  const prepared = input.lines.map((line) => {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(line.productId) as
      | { id: number; name: string; unit_id: number | null; primary_unit_id: number | null }
      | undefined;
    if (!product) throw new Error('প্রোডাক্ট পাওয়া যায়নি।');
    const unitId = line.unitId ?? product.unit_id ?? product.primary_unit_id;
    const unit = db.prepare('SELECT id, short_name, factor_milli FROM units WHERE id = ?').get(unitId) as
      | { id: number; short_name: string; factor_milli: number }
      | undefined;
    if (!unit) throw new Error('ইউনিট পাওয়া যায়নি।');
    const qtyMilli = Math.round(line.qtyMilli);
    if (!Number.isFinite(qtyMilli) || qtyMilli <= 0) throw new Error(`"${product.name}" এর পরিমাণ সঠিক নয়।`);
    const cost = Math.round(line.unitCostPaisa);
    if (!Number.isFinite(cost) || cost < 0) throw new Error('ক্রয়মূল্য সঠিক নয়।');
    const gross = Math.round((qtyMilli * cost) / 1000);
    const discount = Math.max(0, Math.min(gross, Math.round(line.discountPaisa ?? 0)));
    return {
      productId: product.id,
      productName: product.name,
      unitId: unit.id,
      unitLabel: unit.short_name,
      qtyMilli,
      factorMilli: unit.factor_milli,
      qtyBaseMilli: toBaseMilli(qtyMilli, unit.factor_milli),
      unitCost: cost,
      lineTotal: gross - discount,
    };
  });
  const subtotal = prepared.reduce((s, l) => s + l.lineTotal, 0);
  let discount = 0;
  if (input.orderDiscountType === 'percent' && input.orderDiscountValue) {
    discount = Math.floor((subtotal * Math.round(input.orderDiscountValue)) / 10_000);
  } else if (input.orderDiscountType === 'fixed' && input.orderDiscountValue) {
    discount = Math.round(input.orderDiscountValue);
  }
  discount = Math.max(0, Math.min(subtotal, discount));
  const taxPercent = Math.round(input.taxPercentX100 ?? settings.vat_percent_x100 ?? 0);
  const taxable = subtotal - discount;
  const tax = taxPercent > 0 ? Math.floor((taxable * taxPercent) / 10_000) : 0;
  const total = taxable + tax;

  return db.transaction(() => {
    const poNo = nextDocumentNumber(db, settings, 'po');
    const now = nowLocal();
    const res = db
      .prepare(
        `INSERT INTO purchase_orders (po_no, supplier_id, location_id, order_date, expected_date, status,
           subtotal_paisa, discount_paisa, tax_paisa, total_paisa, note, user_id, created_at, updated_at)
         VALUES (?,?,?,?,?,'open',?,?,?,?,?,?,?,?)`,
      )
      .run(
        poNo,
        supplierId,
        input.locationId ?? null,
        input.orderDate ?? now.slice(0, 10),
        input.expectedDate ?? null,
        subtotal,
        discount,
        tax,
        total,
        input.note ?? null,
        input.actor.id,
        now,
        now,
      );
    const poId = Number(res.lastInsertRowid);
    const insertItem = db.prepare(
      `INSERT INTO purchase_order_items (po_id, product_id, product_name, unit_id, unit_label, qty_milli,
         factor_milli, qty_base_milli, received_base_milli, unit_cost_paisa, line_total_paisa)
       VALUES (?,?,?,?,?,?,?,?,0,?,?)`,
    );
    for (const l of prepared) {
      insertItem.run(poId, l.productId, l.productName, l.unitId, l.unitLabel, l.qtyMilli, l.factorMilli, l.qtyBaseMilli, l.unitCost, l.lineTotal);
    }
    audit(db, {
      userId: input.actor.id,
      username: input.actor.username,
      action: 'po.create',
      entity: 'purchase_order',
      entityId: poId,
      details: { poNo, supplierId, total, lines: prepared.length },
    });
    return getPurchaseOrder(db, poId)!;
  })();
}

function decorate(db: Db, row: PurchaseOrder): PurchaseOrder {
  const items = db
    .prepare(
      `SELECT i.*, p.sku FROM purchase_order_items i
        LEFT JOIN products p ON p.id = i.product_id
       WHERE i.po_id = ? ORDER BY i.id`,
    )
    .all(row.id) as PurchaseOrderItemRow[];
  for (const item of items) {
    item.remaining_base_milli = Math.max(0, item.qty_base_milli - item.received_base_milli);
  }
  const receipts = db
    .prepare(
      `SELECT r.*, pu.purchase_no FROM purchase_order_receipts r
        LEFT JOIN purchases pu ON pu.id = r.purchase_id
       WHERE r.po_id = ? ORDER BY r.id`,
    )
    .all(row.id) as any[];
  const ordered = items.reduce((s, i) => s + i.qty_base_milli, 0);
  const received = items.reduce((s, i) => s + i.received_base_milli, 0);
  const supplier = row.supplier_id
    ? (db.prepare('SELECT name FROM suppliers WHERE id = ?').get(row.supplier_id) as { name: string } | undefined)
    : undefined;
  return {
    ...row,
    supplier_name: supplier?.name ?? null,
    items,
    receipts,
    received_percent: ordered > 0 ? Math.round((received / ordered) * 100) : 0,
  };
}

export function getPurchaseOrder(db: Db, id: number): PurchaseOrder | null {
  const row = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id) as PurchaseOrder | undefined;
  return row ? decorate(db, row) : null;
}

export function getPurchaseOrderByNo(db: Db, no: string): PurchaseOrder | null {
  const row = db.prepare('SELECT * FROM purchase_orders WHERE po_no = ?').get(no) as PurchaseOrder | undefined;
  return row ? decorate(db, row) : null;
}

export function listPurchaseOrders(
  db: Db,
  filter: { q?: string; status?: PurchaseOrderStatus | 'all'; supplierId?: number | null; from?: string; to?: string; limit?: number; offset?: number } = {},
): { rows: PurchaseOrder[]; total: number } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.status && filter.status !== 'all') {
    where.push('o.status = ?');
    params.push(filter.status);
  }
  if (filter.supplierId) {
    where.push('o.supplier_id = ?');
    params.push(filter.supplierId);
  }
  if (filter.q) {
    where.push('(o.po_no LIKE ? OR s.name LIKE ?)');
    const like = `%${normalizeText(filter.q)}%`;
    params.push(like, like);
  }
  if (filter.from) {
    where.push('o.order_date >= ?');
    params.push(filter.from);
  }
  if (filter.to) {
    where.push('o.order_date <= ?');
    params.push(filter.to);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM purchase_orders o LEFT JOIN suppliers s ON s.id = o.supplier_id ${clause}`)
      .get(...params) as { n: number }
  ).n;
  const rows = db
    .prepare(
      `SELECT o.*, s.name AS supplier_name FROM purchase_orders o
         LEFT JOIN suppliers s ON s.id = o.supplier_id
         ${clause}
        ORDER BY o.order_date DESC, o.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, filter.limit ?? 100, filter.offset ?? 0) as PurchaseOrder[];
  return { rows, total };
}

export function purchaseOrderRemaining(db: Db, poId: number): PurchaseOrderItemRow[] {
  const order = getPurchaseOrder(db, poId);
  if (!order) throw new Error('অর্ডার পাওয়া যায়নি।');
  return (order.items ?? []).filter((i) => i.remaining_base_milli > 0);
}

export interface ReceiveInput {
  poId: number;
  /** Which line, how much (in the line's own unit) and optionally a new cost. */
  items: { poItemId: number; qtyMilli: number; unitCostPaisa?: number | null; batchNo?: string | null; expiryDate?: string | null }[];
  paidPaisa?: number;
  payments?: { methodId: number; amount: number; reference?: string | null }[];
  defaultMethodId?: number | null;
  otherCostPaisa?: number;
  note?: string | null;
  purchaseDate?: string;
  actor: Actor;
}

/**
 * Receive (all or part of) a purchase order.
 *
 * The goods land through the normal `createPurchase` path, so stock, weighted
 * average cost, supplier payable and the ledger all move exactly as they do for
 * a hand-entered purchase — there is no second, "special" code path that could
 * drift from the accounting.
 */
export function receivePurchaseOrder(
  db: Db,
  input: ReceiveInput,
): { purchaseId: number; purchaseNo: string; receiptId: number; status: PurchaseOrderStatus; remainingItems: number; totalPaisa: number } {
  if (!input.items?.length) throw new Error('কোন পণ্য গ্রহণ করছেন তা নির্বাচন করুন।');
  return db.transaction(() => {
    const order = getPurchaseOrder(db, input.poId);
    if (!order) throw new Error('অর্ডার পাওয়া যায়নি।');
    if (order.status === 'cancelled') throw new Error('বাতিল করা অর্ডার গ্রহণ করা যাবে না।');
    if (order.status === 'received') throw new Error('এই অর্ডারের সব পণ্য আগেই গ্রহণ করা হয়েছে।');

    const lines: PurchaseLineInput[] = [];
    const updates: { itemId: number; addBase: number }[] = [];
    for (const req of input.items) {
      const item = (order.items ?? []).find((i) => i.id === req.poItemId);
      if (!item) throw new Error('অর্ডারের লাইন পাওয়া যায়নি।');
      const qtyMilli = Math.round(req.qtyMilli);
      if (!Number.isFinite(qtyMilli) || qtyMilli <= 0) continue;
      const addBase = toBaseMilli(qtyMilli, item.factor_milli);
      if (addBase > item.remaining_base_milli) {
        throw new Error(
          `"${item.product_name}" — অর্ডারের বাকি আছে ${item.remaining_base_milli / 1000}, তার বেশি গ্রহণ করা যাবে না।`,
        );
      }
      lines.push({
        productId: item.product_id,
        unitId: item.unit_id,
        qtyMilli,
        unitPricePaisa: req.unitCostPaisa != null ? Math.round(req.unitCostPaisa) : item.unit_cost_paisa,
        batchNo: req.batchNo ?? null,
        expiryDate: req.expiryDate ?? null,
      });
      updates.push({ itemId: item.id, addBase });
    }
    if (!lines.length) throw new Error('গ্রহণের পরিমাণ শূন্য — অন্তত একটি লাইন পূরণ করুন।');

    const created = createPurchase(db, {
      supplierId: order.supplier_id,
      lines,
      otherCostPaisa: input.otherCostPaisa ?? 0,
      paidPaisa: input.paidPaisa ?? 0,
      payments: input.payments,
      defaultMethodId: input.defaultMethodId ?? null,
      note: input.note ? `${order.po_no} — ${input.note}` : `অর্ডার ${order.po_no} থেকে গ্রহণ`,
      purchaseDate: input.purchaseDate,
      actor: input.actor,
    });

    db.prepare('UPDATE purchases SET purchase_order_id = ? WHERE id = ?').run(order.id, created.purchaseId);
    for (const u of updates) {
      db.prepare('UPDATE purchase_order_items SET received_base_milli = received_base_milli + ? WHERE id = ?').run(
        u.addBase,
        u.itemId,
      );
    }

    // Recompute the order status from the line balances, never from a guess.
    const after = db
      .prepare('SELECT qty_base_milli, received_base_milli FROM purchase_order_items WHERE po_id = ?')
      .all(order.id) as { qty_base_milli: number; received_base_milli: number }[];
    const fullyReceived = after.every((r) => r.received_base_milli >= r.qty_base_milli);
    const nothingReceived = after.every((r) => r.received_base_milli === 0);
    const status: PurchaseOrderStatus = fullyReceived ? 'received' : nothingReceived ? 'open' : 'partial';
    db.prepare('UPDATE purchase_orders SET status = ?, updated_at = ? WHERE id = ?').run(status, nowLocal(), order.id);

    const receiptRes = db
      .prepare(
        `INSERT INTO purchase_order_receipts (po_id, purchase_id, receipt_no, received_at, user_id, total_paisa, note, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        order.id,
        created.purchaseId,
        created.purchaseNo,
        input.purchaseDate ?? nowLocal(),
        input.actor.id,
        created.computation.total,
        input.note ?? null,
        nowLocal(),
      );

    audit(db, {
      userId: input.actor.id,
      username: input.actor.username,
      action: 'po.receive',
      entity: 'purchase_order',
      entityId: order.id,
      details: { poNo: order.po_no, purchaseNo: created.purchaseNo, total: created.computation.total, status },
    });

    const remaining = after.filter((r) => r.received_base_milli < r.qty_base_milli).length;
    return {
      purchaseId: created.purchaseId,
      purchaseNo: created.purchaseNo,
      receiptId: Number(receiptRes.lastInsertRowid),
      status,
      remainingItems: remaining,
      totalPaisa: created.computation.total,
    };
  })();
}

export function cancelPurchaseOrder(db: Db, poId: number, reason: string, actor: Actor): PurchaseOrder {
  // The change and the audit line that records it are one step (v1.1.5, sweep finding A-26).
  // Nested in a caller's transaction this is a savepoint, so a batch still rolls back as a whole.
  return db.transaction(() => {
    const order = getPurchaseOrder(db, poId);
    if (!order) throw new Error('অর্ডার পাওয়া যায়নি।');
    if (order.status === 'cancelled') throw new Error('অর্ডারটি আগেই বাতিল করা হয়েছে।');
    if (!reason?.trim()) throw new Error('বাতিলের কারণ লিখুন।');
    const received = (order.items ?? []).some((i) => i.received_base_milli > 0);
    if (received) {
      throw new Error('কিছু পণ্য ইতিমধ্যে গ্রহণ করা হয়েছে — অর্ডারটি বাতিল করা যাবে না, বাকি লাইন বাতিল করুন।');
    }
    db.prepare('UPDATE purchase_orders SET status = ?, cancel_reason = ?, updated_at = ? WHERE id = ?').run(
      'cancelled',
      reason,
      nowLocal(),
      poId,
    );
    audit(db, {
      userId: actor.id,
      username: actor.username,
      action: 'po.cancel',
      entity: 'purchase_order',
      entityId: poId,
      details: { poNo: order.po_no, reason },
    });
    return getPurchaseOrder(db, poId)!;
  })();
}

/** Preview of what a receipt will cost — used by the receiving screen. */
export function previewReceive(
  db: Db,
  args: { poId: number; items: { poItemId: number; qtyMilli: number }[]; otherCostPaisa?: number },
): { total: number; subtotal: number; lines: number } {
  const order = getPurchaseOrder(db, args.poId);
  if (!order) throw new Error('অর্ডার পাওয়া যায়নি।');
  const lines: PurchaseLineInput[] = [];
  for (const req of args.items) {
    const item = (order.items ?? []).find((i) => i.id === req.poItemId);
    if (!item) continue;
    const qtyMilli = Math.round(req.qtyMilli);
    if (!Number.isFinite(qtyMilli) || qtyMilli <= 0) continue;
    lines.push({ productId: item.product_id, unitId: item.unit_id, qtyMilli, unitPricePaisa: item.unit_cost_paisa });
  }
  if (!lines.length) return { total: 0, subtotal: 0, lines: 0 };
  const computation = computePurchase(db, {
    supplierId: order.supplier_id,
    lines,
    otherCostPaisa: args.otherCostPaisa ?? 0,
    actor: { id: 0, username: 'preview' },
  });
  return { total: computation.total, subtotal: computation.subtotal, lines: lines.length };
}

/** Supplier delivery tracking: open orders with their outstanding value. */
export function purchaseOrderSummary(db: Db): {
  open: number;
  partial: number;
  received: number;
  open_value_paisa: number;
} {
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) AS open,
         SUM(CASE WHEN status='partial' THEN 1 ELSE 0 END) AS partial,
         SUM(CASE WHEN status='received' THEN 1 ELSE 0 END) AS received,
         SUM(CASE WHEN status IN ('open','partial') THEN total_paisa ELSE 0 END) AS open_value
       FROM purchase_orders`,
    )
    .get() as any;
  return {
    open: Number(row?.open ?? 0),
    partial: Number(row?.partial ?? 0),
    received: Number(row?.received ?? 0),
    open_value_paisa: Number(row?.open_value ?? 0),
  };
}
