import type { Db } from '../db/connection.js';
import { nowLocal } from '../domain/datetime.js';
import {
  costValuePaisa,
  lineValuePaisa,
  percentOfPaisa,
  resolveDiscount,
  toBaseMilli,
} from '../domain/money.js';
import type { Product, Sale, SaleItem } from '../domain/types.js';
import { audit } from './audit.js';
import { addCashMovement, ensureOpenSession } from './cash.js';
import { applyMovement } from './inventory.js';
import { isPostingEnabled, postSale, reverseDocument } from './accounting.js';
import { nextDocumentNumber } from './invoice.js';
import { insertPayment } from './payments.js';
import { markSerialsSold, releaseSerialsForSale } from './stock-ops.js';
import { assertCreditLimit, customerPriceLevel, earnLoyaltyForSale, reverseLoyaltyForSale } from './crm.js';
import { getSettings } from './settings.js';
import {
  checkCoupon,
  checkGiftCard,
  consumeGiftCard,
  giftCardMethodId,
  recordCouponRedemption,
  restoreCouponsForSale,
  restoreGiftCardsForSale,
} from './promotions.js';
import { productPriceBreakdown, type PriceLevel } from './products.js';

export interface SaleLineInput {
  productId: number;
  unitId?: number | null;
  /** Quantity in milli of the chosen unit (0.25 kg → 250). */
  qtyMilli: number;
  /** Override unit price in poisa (permission controlled). */
  unitPricePaisa?: number | null;
  /** Line-level discount in poisa. */
  discountPaisa?: number | null;
  priceLevel?: PriceLevel;
  /** Serial/IMEI numbers sold on this line (optional). */
  serials?: string[];
}

export interface SalePaymentInput {
  methodId: number;
  amount: number;
  reference?: string | null;
  note?: string | null;
}

export interface SaleInput {
  customerId?: number | null;
  lines: SaleLineInput[];
  orderDiscountType?: 'none' | 'percent' | 'fixed';
  orderDiscountValue?: number;
  payments?: SalePaymentInput[];
  /** Used when the UI sends a single paid amount with one method. */
  paidPaisa?: number;
  defaultMethodId?: number | null;
  note?: string | null;
  saleDate?: string;
  taxPercentX100?: number;
  actor: { id: number; username: string };
  /** Set true by an authorised user to override the configured negative stock rule. */
  overrideNegativeStock?: boolean;
  /** Set by an authorised user (pos.price_edit) to sell under the price floor. */
  allowBelowMinPrice?: boolean;
  /** Set by an authorised user (pos.discount) to exceed a product's max discount. */
  allowDiscountOverride?: boolean;
  /** Promotion code (percentage or fixed discount). */
  couponCode?: string | null;
  /** Stored-value card code used as a tender. */
  giftCardCode?: string | null;
  /** How much of the bill should be taken from the card (defaults to the rest). */
  giftCardAmountPaisa?: number | null;
}

export interface SaleComputation {
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  costTotal: number;
  profit: number;
  couponCode: string | null;
  couponDiscount: number;
  giftCardApplied: number;
  paid: number;
  due: number;
  change: number;
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
    costMicro: number;
    costTotal: number;
  }[];
}

/**
 * Pure pricing engine — no database writes. Used by the POS screen for the live
 * cart preview and by `createSale` for the persisted document, so the numbers on
 * screen and the numbers in the database can never disagree.
 */
function normalizeCoupon(code: string | null | undefined): string {
  return String(code ?? '').trim().toUpperCase();
}

export function computeSale(
  db: Db,
  input: SaleInput,
  settings = getSettings(db),
): SaleComputation {
  if (!input.lines || input.lines.length === 0) throw new Error('কার্টে অন্তত একটি প্রোডাক্ট থাকতে হবে।');
  const lines: SaleComputation['lines'] = [];
  let subtotal = 0;
  let costTotal = 0;
  // A customer's agreed price level (wholesale/special) applies unless the
  // cashier explicitly picks a level per line.
  const salePriceLevel = customerPriceLevel(db, input.customerId);

  for (const line of input.lines) {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(line.productId) as Product | undefined;
    if (!product) throw new Error('প্রোডাক্ট পাওয়া যায়নি।');
    if (product.is_active !== 1) throw new Error(`"${product.name}" প্রোডাক্টটি বর্তমানে নিষ্ক্রিয়।`);
    const qtyMilli = Math.round(line.qtyMilli);
    if (!Number.isFinite(qtyMilli) || qtyMilli <= 0) throw new Error(`"${product.name}" এর পরিমাণ সঠিক নয়।`);

    const unitId = line.unitId ?? product.primary_unit_id ?? product.unit_id;
    const unit = db.prepare('SELECT * FROM units WHERE id = ?').get(unitId) as
      | { id: number; short_name: string; factor_milli: number; is_active: number }
      | undefined;
    if (!unit) throw new Error('ইউনিট পাওয়া যায়নি।');
    const qtyBaseMilli = toBaseMilli(qtyMilli, unit.factor_milli);
    if (qtyBaseMilli <= 0) throw new Error(`"${product.name}" এর পরিমাণ খুবই কম।`);

    let unitPrice: number;
    if (line.unitPricePaisa != null && line.unitPricePaisa > 0) {
      unitPrice = Math.round(line.unitPricePaisa);
    } else {
      const breakdown = productPriceBreakdown(product, line.priceLevel ?? salePriceLevel);
      // product-level price is per primary unit; convert to the chosen unit
      const primaryFactor = (db
        .prepare('SELECT factor_milli FROM units WHERE id = ?')
        .get(product.primary_unit_id ?? product.unit_id) as { factor_milli: number }).factor_milli;
      const perBase = breakdown.final / primaryFactor;
      unitPrice = Math.max(0, Math.round(perBase * unit.factor_milli));
    }
    // Price floor and per-product discount cap are enforced here so no caller
    // (POS screen, import, script) can bypass them.
    const minSale = Math.max(0, Number((product as any).min_sale_price ?? 0));
    if (minSale > 0 && unitPrice < minSale && !input.allowBelowMinPrice) {
      throw new Error(
        `"${product.name}" এর সর্বনিম্ন বিক্রয়মূল্য ${(minSale / 100).toFixed(2)} টাকা — এর কম দামে বিক্রয়ের অনুমতি নেই।`,
      );
    }
    const gross = lineValuePaisa(qtyMilli, unitPrice);
    let discount = Math.round(line.discountPaisa ?? 0);
    const maxPct = (product as any).max_discount_percent_x100;
    if (maxPct != null && maxPct >= 0 && !input.allowDiscountOverride) {
      const cap = Math.floor((gross * maxPct) / 10_000);
      if (discount > cap) {
        throw new Error(
          `"${product.name}" এ সর্বোচ্চ ${(maxPct / 100).toFixed(2)}% ডিসকাউন্ট অনুমোদিত — অনুমতি ছাড়া বেশি দেওয়া যাবে না।`,
        );
      }
    }
    if (discount < 0) throw new Error('লাইন ডিসকাউন্ট ঋণাত্মক হতে পারবে না।');
    if (discount > gross) discount = gross;
    const lineTotal = gross - discount;
    const costMicro = product.avg_cost_micro ?? 0;
    const lineCost = costValuePaisa(qtyBaseMilli, costMicro);

    subtotal += lineTotal;
    costTotal += lineCost;
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
      costMicro,
      costTotal: lineCost,
    });
  }

  const discount = resolveDiscount({
    subtotal,
    type: input.orderDiscountType ?? 'none',
    value: input.orderDiscountValue ?? 0,
  });
  if (discount > 0 && settings.max_discount_percent_x100 > 0) {
    const percentX100 = Math.round((discount * 10000) / Math.max(1, subtotal));
    if (percentX100 > settings.max_discount_percent_x100) {
      throw new Error(
        `ডিসকাউন্ট অনুমোদিত সীমার (${(settings.max_discount_percent_x100 / 100).toFixed(0)}%) বেশি।`,
      );
    }
  }
  // Promotion code: validated against the basket *after* manual discounts, so a
  // coupon can never be stacked into a negative bill.
  let couponCode: string | null = null;
  let couponDiscount = 0;
  if (input.couponCode && normalizeCoupon(input.couponCode)) {
    const probe = checkCoupon(db, {
      code: input.couponCode,
      subtotalPaisa: subtotal - discount,
      customerId: input.customerId ?? null,
    });
    if (!probe.ok) throw new Error(probe.reason ?? 'কুপন ব্যবহার করা যাচ্ছে না।');
    couponCode = probe.coupon!.code;
    couponDiscount = probe.discountPaisa;
  }

  const taxable = subtotal - discount - couponDiscount;
  const taxPercent = input.taxPercentX100 ?? settings.vat_percent_x100 ?? 0;
  const tax = taxPercent > 0 ? percentOfPaisa(taxable, taxPercent) : 0;
  const total = taxable + tax;

  let paid = 0;
  if (input.payments && input.payments.length) {
    paid = input.payments.reduce((sum, p) => sum + Math.round(p.amount), 0);
  } else if (input.paidPaisa != null) {
    paid = Math.round(input.paidPaisa);
  }
  if (paid < 0) throw new Error('পরিশোধিত টাকার পরিমাণ ঋণাত্মক হতে পারবে না।');
  const change = paid > total ? paid - total : 0;
  const appliedPaid = paid - change;

  // Stored value settles whatever the cash tenders leave open.
  let giftCardApplied = 0;
  if (input.giftCardCode && normalizeCoupon(input.giftCardCode)) {
    const open = total - appliedPaid;
    if (open > 0) {
      const probe = checkGiftCard(db, {
        code: input.giftCardCode,
        amountPaisa: input.giftCardAmountPaisa != null ? Math.min(input.giftCardAmountPaisa, open) : open,
      });
      if (!probe.ok) throw new Error(probe.reason ?? 'কার্ড ব্যবহার করা যাচ্ছে না।');
      giftCardApplied = probe.usablePaisa;
    }
  }

  const paidTotal = appliedPaid + giftCardApplied;
  const due = total - paidTotal;
  const profit = taxable - costTotal;

  return {
    subtotal,
    discount,
    tax,
    total,
    costTotal,
    profit,
    couponCode,
    couponDiscount,
    giftCardApplied,
    paid: paidTotal,
    due,
    change,
    lines,
  };
}

export interface CreateSaleResult {
  saleId: number;
  invoiceNo: string;
  computation: SaleComputation;
}

export function createSale(db: Db, input: SaleInput): CreateSaleResult {
  const settings = getSettings(db);
  const computation = computeSale(db, input, settings);

  if (computation.due > 0) {
    if (!settings.allow_due_sale) throw new Error('বাকিতে বিক্রয় এই মুহূর্তে বন্ধ আছে (সেটিংস দেখুন)।');
    if (!input.customerId) throw new Error('বাকিতে বিক্রয়ের জন্য কাস্টমার নির্বাচন করতে হবে।');
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(input.customerId) as
      | { id: number; is_walkin: number }
      | undefined;
    if (!customer) throw new Error('কাস্টমার পাওয়া যায়নি।');
    if (customer.is_walkin) throw new Error('ওয়াক-ইন কাস্টমারের নামে বাকি বিক্রয় করা যাবে না।');
    // Credit limit is enforced here (not in the UI) so every caller is covered.
    assertCreditLimit(db, input.customerId, computation.due);
  }

  const payments = (input.payments ?? []).filter((p) => Math.round(p.amount) > 0);
  let effectivePayments = payments.map((p) => ({ ...p, amount: Math.round(p.amount) }));
  // The stored-value part of `paid` gets its own tender row below, so the cash
  // fallback must only cover what the customer actually handed over.
  const cashPaid = computation.paid - computation.giftCardApplied;
  if (!effectivePayments.length && cashPaid > 0) {
    const methodId = input.defaultMethodId ?? settings.default_payment_method_id;
    if (!methodId) throw new Error('পেমেন্ট মেথড নির্বাচন করুন।');
    effectivePayments = [{ methodId, amount: cashPaid }];
  }
  // Fold the change into the last payment so recorded cash equals real cash.
  const paidSum = effectivePayments.reduce((s, p) => s + p.amount, 0);
  if (paidSum > computation.total) {
    let excess = paidSum - computation.total;
    for (let i = effectivePayments.length - 1; i >= 0 && excess > 0; i--) {
      const take = Math.min(effectivePayments[i]!.amount, excess);
      effectivePayments[i]!.amount -= take;
      excess -= take;
    }
    effectivePayments = effectivePayments.filter((p) => p.amount > 0);
  }

  const allowNegative = input.overrideNegativeStock || settings.allow_negative_stock === 1;

  const run = db.transaction((): CreateSaleResult => {
    const invoiceNo = nextDocumentNumber(db, settings, 'sale');
    const session = input.actor?.id ? ensureOpenSession(db, input.actor.id) : null;
    const saleDate = input.saleDate ?? nowLocal();
    const res = db
      .prepare(
        `INSERT INTO sales (invoice_no, customer_id, user_id, sale_date, subtotal_paisa, discount_paisa, tax_paisa,
           total_paisa, paid_paisa, due_paisa, change_paisa, cost_total_paisa, profit_paisa, status, note,
           cash_session_id, coupon_code, coupon_discount_paisa, gift_card_paisa, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'completed',?,?,?,?,?,?)`,
      )
      .run(
        invoiceNo,
        input.customerId ?? null,
        input.actor.id,
        saleDate,
        computation.subtotal,
        computation.discount + computation.couponDiscount,
        computation.tax,
        computation.total,
        computation.paid,
        computation.due,
        computation.change,
        computation.costTotal,
        computation.profit,
        input.note ? input.note : null,
        session?.id ?? null,
        computation.couponCode,
        computation.couponDiscount,
        computation.giftCardApplied,
        nowLocal(),
      );
    const saleId = Number(res.lastInsertRowid);

    const insertItem = db.prepare(
      `INSERT INTO sale_items (sale_id, product_id, product_name, unit_id, unit_label, qty_milli, factor_milli,
         qty_base_milli, unit_price_paisa, discount_paisa, line_total_paisa, cost_micro, cost_total_paisa,
         returned_qty_milli, batch_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,NULL)`,
    );
    for (const line of computation.lines) {
      insertItem.run(
        saleId,
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
        line.costMicro,
        line.costTotal,
      );
      const soldProduct = db
        .prepare('SELECT is_service FROM products WHERE id = ?')
        .get(line.productId) as { is_service: number } | undefined;
      if (soldProduct?.is_service === 1) {
        // Services have no inventory: nothing to deduct, nothing to consume.
        continue;
      }
      applyMovement(db, {
        productId: line.productId,
        type: 'sale',
        qtyBaseMilli: -line.qtyBaseMilli,
        unitLabel: line.unitLabel,
        qtyInputMilli: line.qtyMilli,
        refType: 'sale',
        refId: saleId,
        userId: input.actor.id,
        force: allowNegative,
        allowNegative,
      });
      consumeBatches(db, line.productId, line.qtyBaseMilli);
    }

    // Serial/IMEI tracking: every supplied serial must be available, and a line
    // cannot hand out more serials than the quantity actually sold.
    let serialCursor = 0;
    for (const line of input.lines) {
      const serials = (line.serials ?? []).map((x) => String(x).trim()).filter(Boolean);
      if (serials.length === 0) continue;
      const soldLine = computation.lines[serialCursor];
      serialCursor++;
      if (soldLine && serials.length > Math.ceil(soldLine.qtyMilli / 1000)) {
        throw new Error(`"${soldLine.productName}" — বিক্রির পরিমাণের চেয়ে বেশি সিরিয়াল দেওয়া হয়েছে।`);
      }
      markSerialsSold(db, serials, saleId, input.actor);
    }

    if (computation.due !== 0 && input.customerId) {
      db.prepare('UPDATE customers SET balance_paisa = balance_paisa + ?, updated_at = ? WHERE id = ?').run(
        computation.due,
        nowLocal(),
        input.customerId,
      );
    }

    if (computation.couponCode && computation.couponDiscount > 0) {
      const couponRow = db.prepare('SELECT id FROM coupons WHERE code = ?').get(computation.couponCode) as
        | { id: number }
        | undefined;
      if (!couponRow) throw new Error('কুপনটি আর পাওয়া যাচ্ছে না।');
      recordCouponRedemption(db, {
        couponId: couponRow.id,
        saleId,
        customerId: input.customerId ?? null,
        code: computation.couponCode,
        discountPaisa: computation.couponDiscount,
        userId: input.actor.id,
      });
    }

    if (computation.giftCardApplied > 0 && input.giftCardCode) {
      const methodId = giftCardMethodId(db);
      if (!methodId) throw new Error('গিফট কার্ড পেমেন্ট মেথড পাওয়া যায়নি।');
      consumeGiftCard(db, {
        code: input.giftCardCode,
        amountPaisa: computation.giftCardApplied,
        saleId,
        userId: input.actor.id,
      });
      insertPayment(db, {
        kind: 'sale',
        partyType: input.customerId ? 'customer' : 'none',
        customerId: input.customerId ?? null,
        saleId,
        amount: computation.giftCardApplied,
        methodId,
        reference: normalizeCoupon(input.giftCardCode),
        note: 'স্টোরড ভ্যালু',
        userId: input.actor.id,
        date: saleDate,
        direction: 'in',
        affectsBalance: false,
      });
    }

    for (const p of effectivePayments) {
      insertPayment(db, {
        kind: 'sale',
        partyType: input.customerId ? 'customer' : 'none',
        customerId: input.customerId ?? null,
        saleId,
        amount: p.amount,
        methodId: p.methodId,
        reference: p.reference ?? invoiceNo,
        note: p.note ?? null,
        userId: input.actor.id,
        date: saleDate,
        direction: 'in',
        affectsBalance: false,
      });
    }

    audit(db, {
      userId: input.actor.id,
      username: input.actor.username,
      action: 'sale.create',
      entity: 'sale',
      entityId: saleId,
      details: {
        invoiceNo,
        total: computation.total,
        paid: computation.paid,
        due: computation.due,
        cost: computation.costTotal,
        profit: computation.profit,
        items: computation.lines.length,
        coupon: computation.couponCode,
        couponDiscount: computation.couponDiscount,
        giftCard: computation.giftCardApplied,
      },
    });
    if (isPostingEnabled(db)) postSale(db, saleId);
    earnLoyaltyForSale(db, saleId, input.actor);

    return { saleId, invoiceNo, computation };
  });

  return run();
}

function consumeBatches(db: Db, productId: number, qtyBaseMilli: number): void {
  const batches = db
    .prepare(
      `SELECT id, qty_base_milli FROM batches WHERE product_id = ? AND qty_base_milli > 0
        ORDER BY CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END, expiry_date, id`,
    )
    .all(productId) as { id: number; qty_base_milli: number }[];
  let remaining = qtyBaseMilli;
  for (const b of batches) {
    if (remaining <= 0) break;
    const take = Math.min(b.qty_base_milli, remaining);
    db.prepare('UPDATE batches SET qty_base_milli = qty_base_milli - ? WHERE id = ?').run(take, b.id);
    remaining -= take;
  }
}

export interface SaleFilter {
  search?: string;
  from?: string;
  to?: string;
  customerId?: number | null;
  userId?: number | null;
  status?: 'all' | 'completed' | 'voided' | 'returned';
  hasDue?: boolean;
  page?: number;
  pageSize?: number;
}

export function listSales(db: Db, f: SaleFilter = {}): { rows: Sale[]; total: number } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.from) {
    where.push('date(s.sale_date) >= date(?)');
    params.push(f.from);
  }
  if (f.to) {
    where.push('date(s.sale_date) <= date(?)');
    params.push(f.to);
  }
  if (f.customerId) {
    where.push('s.customer_id = ?');
    params.push(f.customerId);
  }
  if (f.userId) {
    where.push('s.user_id = ?');
    params.push(f.userId);
  }
  if (f.status && f.status !== 'all') {
    where.push('s.status = ?');
    params.push(f.status);
  }
  if (f.hasDue) where.push('s.due_paisa > 0');
  if (f.search && f.search.trim()) {
    const like = `%${f.search.trim()}%`;
    where.push('(s.invoice_no LIKE ? OR c.name LIKE ? OR c.phone LIKE ?)');
    params.push(like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const base = `FROM sales s LEFT JOIN customers c ON c.id = s.customer_id LEFT JOIN users u ON u.id = s.user_id ${clause}`;
  const total = (db.prepare(`SELECT COUNT(*) c ${base}`).get(...params) as { c: number }).c;
  const page = Math.max(1, f.page ?? 1);
  const pageSize = Math.min(500, Math.max(10, f.pageSize ?? 50));
  const rows = db
    .prepare(
      `SELECT s.*, c.name AS customer_name, c.phone AS customer_phone, u.username AS cashier_name
       ${base} ORDER BY s.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, (page - 1) * pageSize) as Sale[];
  return { rows, total };
}

export function getSale(db: Db, id: number): Sale | null {
  const sale = db
    .prepare(
      `SELECT s.*, c.name AS customer_name, c.phone AS customer_phone, u.username AS cashier_name
         FROM sales s LEFT JOIN customers c ON c.id = s.customer_id LEFT JOIN users u ON u.id = s.user_id
        WHERE s.id = ?`,
    )
    .get(id) as Sale | undefined;
  if (!sale) return null;
  sale.items = db
    .prepare(
      `SELECT si.*, u.short_name AS unit_short_name FROM sale_items si
         LEFT JOIN units u ON u.id = si.unit_id WHERE si.sale_id = ? ORDER BY si.id`,
    )
    .all(id) as SaleItem[];
  return sale;
}

export function getSaleByInvoice(db: Db, invoiceNo: string): Sale | null {
  const row = db.prepare('SELECT id FROM sales WHERE invoice_no = ?').get(invoiceNo.trim()) as
    | { id: number }
    | undefined;
  return row ? getSale(db, row.id) : null;
}

/**
 * Void a completed sale. Reverses stock, payments and the customer balance and
 * keeps the original document for the audit trail (never a hard delete).
 */
export function voidSale(db: Db, saleId: number, reason: string, actor: { id: number; username: string }): void {
  const sale = getSale(db, saleId);
  if (!sale) throw new Error('ইনভয়েস পাওয়া যায়নি।');
  if (sale.status === 'voided') throw new Error('এই ইনভয়েস আগেই বাতিল করা হয়েছে।');
  if (!reason || !reason.trim()) throw new Error('বাতিল করার কারণ লিখতে হবে।');
  const returns = (
    db.prepare("SELECT COUNT(*) c FROM returns WHERE sale_id = ? AND status = 'completed'").get(saleId) as {
      c: number;
    }
  ).c;
  if (returns > 0) throw new Error('এই ইনভয়েসে রিটার্ন হয়েছে — বাতিল করা যাবে না।');

  const run = db.transaction(() => {
    for (const item of sale.items ?? []) {
      applyMovement(db, {
        productId: item.product_id,
        type: 'sale_return',
        qtyBaseMilli: item.qty_base_milli,
        unitLabel: item.unit_short_name ?? null,
        refType: 'sale_void',
        refId: saleId,
        reason: `ইনভয়েস বাতিল: ${reason}`,
        userId: actor.id,
        force: true,
        incomingCostMicro: item.cost_micro,
      });
    }
    if (sale.customer_id && sale.due_paisa !== 0) {
      db.prepare('UPDATE customers SET balance_paisa = balance_paisa - ?, updated_at = ? WHERE id = ?').run(
        sale.due_paisa,
        nowLocal(),
        sale.customer_id,
      );
    }
    const cashPayments = db
      .prepare("SELECT * FROM payments WHERE sale_id = ? AND status = 'active'")
      .all(saleId) as any[];
    for (const p of cashPayments) {
      db.prepare("UPDATE payments SET status = 'reversed' WHERE id = ?").run(p.id);
      const method = db.prepare('SELECT is_cash FROM payment_methods WHERE id = ?').get(p.method_id) as
        | { is_cash: number }
        | undefined;
      if (method?.is_cash) {
        addCashMovement(db, {
          userId: actor.id,
          direction: 'out',
          amount: p.amount_paisa,
          source: 'refund',
          sourceId: p.id,
          note: `ইনভয়েস বাতিল ${sale.invoice_no}`,
        });
      }
    }
    db.prepare("UPDATE sales SET status = 'voided' WHERE id = ?").run(saleId);
    // Stored value (gift card / voucher) taken by this invoice goes back on the
    // card: a void means the sale never happened.
    const giftRestored = restoreGiftCardsForSale(db, {
      saleId,
      userId: actor.id,
      note: `ইনভয়েস বাতিল ${sale.invoice_no}`,
    });
    // A cancelled sale must not consume a coupon use, nor keep its serial/IMEI
    // numbers marked "sold" (v1.1.3: both used to leak permanently).
    const coupons = restoreCouponsForSale(db, { saleId, userId: actor.id, note: `ইনভয়েস বাতিল ${sale.invoice_no}` });
    const serialsReleased = releaseSerialsForSale(db, saleId, {
      actor,
      note: `ইনভয়েস বাতিল ${sale.invoice_no}`,
    });
    // Points earned on a voided invoice are taken back; points the customer
    // spent on it are handed back (the ledger stores the net, so this is exact).
    reverseLoyaltyForSale(db, saleId, `ইনভয়েস বাতিল: ${sale.invoice_no}`, actor);
    if (isPostingEnabled(db)) {
      reverseDocument(db, 'sale', saleId, { userId: actor.id, memo: `বাতিল: ${sale.invoice_no} — ${reason}` });
    }
    audit(db, {
      userId: actor.id,
      username: actor.username,
      action: 'sale.void',
      entity: 'sale',
      entityId: saleId,
      details: {
        invoiceNo: sale.invoice_no,
        total: sale.total_paisa,
        reason,
        giftCardRestored: giftRestored.amountPaisa,
        giftCards: giftRestored.cards,
        couponRestored: coupons.restored ? coupons.code : null,
        couponDiscountReversed: coupons.discountPaisa,
        serialsReleased,
      },
    });
  });
  run();
}

export function todaySalesSummary(db: Db, date = nowLocal().slice(0, 10)): {
  total: number;
  count: number;
  profit: number;
  due: number;
  cash: number;
} {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(total_paisa),0) total, COUNT(*) c, COALESCE(SUM(profit_paisa),0) profit,
              COALESCE(SUM(due_paisa),0) due
         FROM sales WHERE date(sale_date) = date(?) AND status <> 'voided'`,
    )
    .get(date) as { total: number; c: number; profit: number; due: number };
  const cash = db
    .prepare(
      `SELECT COALESCE(SUM(p.amount_paisa),0) v FROM payments p
         JOIN payment_methods m ON m.id = p.method_id
        WHERE date(p.payment_date) = date(?) AND p.status = 'active' AND m.is_cash = 1 AND p.direction = 'in'`,
    )
    .get(date) as { v: number };
  return { total: row.total, count: row.c, profit: row.profit, due: row.due, cash: cash.v };
}
