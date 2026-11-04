/**
 * Independent audit suite (2026-11 final audit).
 *
 * These tests assert *specification-level* behaviour — what a retail shop
 * actually needs to be true — rather than mirroring the implementation. They
 * exist to catch financial and data-integrity defects, so several of them were
 * written before the corresponding fix.
 */
import { describe, expect, it } from 'vitest';
import {
  adjustStock,
  cashInHandPaisa,
  closeCashSession,
  createExpense,
  createPurchase,
  createSale,
  createSaleReturn,
  dashboardStats,
  getCustomer,
  getProduct,
  getSale,
  listExpenseCategories,
  openCashSession,
  receiveCustomerPayment,
  runReport,
  sessionTotals,
  voidSale,
  type Db,
} from '../src/index.js';
import { makeTestDb, seedProducts, type TestContext } from './helpers.js';

function movementSum(db: Db, productId: number): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(qty_base_milli),0) v FROM stock_movements WHERE product_id = ?')
    .get(productId) as { v: number };
  return row.v;
}

function customerBalance(ctx: TestContext, id: number): number {
  return (ctx.db.prepare('SELECT balance_paisa b FROM customers WHERE id = ?').get(id) as { b: number }).b;
}

function supplierBalance(ctx: TestContext, id: number): number {
  return (ctx.db.prepare('SELECT balance_paisa b FROM suppliers WHERE id = ?').get(id) as { b: number }).b;
}

function peakNow(ctx: TestContext): void {
  openCashSession(ctx.db, { userId: ctx.actor.id, openingCash: 5_000_000, note: 'দিনের শুরু' });
}

describe('database invariants after a mixed trading day', () => {
  it('keeps stock, dues, payables and cash consistent and free of orphans', () => {
    const ctx = makeTestDb();
    const ids = seedProducts(ctx);
    const { db } = ctx;
    peakNow(ctx);

    // 1. Buy 10 kg rice on credit, pay 200.00 in cash.
    createPurchase(db, {
      supplierId: ids.supplier.id,
      lines: [{ productId: ids.rice.id, unitId: ctx.unitKgId, qtyMilli: 10_000, unitPricePaisa: 7000 }],
      paidPaisa: 20_000,
      defaultMethodId: ctx.cashMethodId,
      actor: ctx.actor,
    });
    // 2. Cash sale 2 kg with 200.00 tendered → 40.00 change.
    createSale(db, {
      lines: [{ productId: ids.rice.id, unitId: ctx.unitKgId, qtyMilli: 2000 }],
      paidPaisa: 20_000,
      defaultMethodId: ctx.cashMethodId,
      actor: ctx.actor,
    });
    // 3. Credit sale 1 kg to a known customer.
    const dueSale = createSale(db, {
      customerId: ids.customer.id,
      lines: [{ productId: ids.rice.id, unitId: ctx.unitKgId, qtyMilli: 1000 }],
      actor: ctx.actor,
    });
    // 4. Collect 30.00 of the due.
    receiveCustomerPayment(db, { customerId: ids.customer.id, amount: 3000, methodId: ctx.cashMethodId }, ctx.actor);
    // 5. A 5.00 expense.
    const cats = listExpenseCategories(db);
    createExpense(db, { categoryId: cats[0]!.id, amountPaisa: 500, methodId: ctx.cashMethodId, description: 'চা' }, ctx.actor);
    // 6. Return 0.5 kg from the credit sale (no cash refund needed).
    const dueLine = getSale(db, dueSale.saleId)!.items![0]!;
    createSaleReturn(db, { saleId: dueSale.saleId, items: [{ lineId: dueLine.id, qtyMilli: 500 }], refundPaisa: 0, actor: ctx.actor });
    // 7. A sale that is cancelled the same day.
    const toVoid = createSale(db, {
      lines: [{ productId: ids.rice.id, unitId: ctx.unitKgId, qtyMilli: 1000 }],
      paidPaisa: 8000,
      defaultMethodId: ctx.cashMethodId,
      actor: ctx.actor,
    });
    voidSale(db, toVoid.saleId, 'ভুল এন্ট্রি', ctx.actor);
    // 8. A physical count that finds 200 g missing.
    const before = getProduct(db, ids.rice.id)!.stock_base_milli;
    adjustStock(db, { productId: ids.rice.id, newQtyBaseMilli: before - 200, reason: 'গণনায় ঘাটতি', actor: ctx.actor });

    // --- orphan / integrity checks -------------------------------------
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect((db.pragma('integrity_check', { simple: true }) as string).toLowerCase()).toBe('ok');

    // --- stock ledger must equal the product's stored stock ------------
    for (const product of db.prepare('SELECT id, stock_base_milli FROM products').all() as {
      id: number;
      stock_base_milli: number;
    }[]) {
      expect(movementSum(db, product.id)).toBe(product.stock_base_milli);
    }
    // 10 kg bought − 2 − 1 + 0.5 − 1 + 1 (void) − 0.2 counted
    expect(getProduct(db, ids.rice.id)!.stock_base_milli).toBe(10_000_000 - 2_000_000 - 1_000_000 + 500_000 - 200);

    // --- party balances -------------------------------------------------
    expect(customerBalance(ctx, ids.customer.id)).toBe(8000 - 3000 - 4000);
    // paid 8000 of 70000, no purchase returns
    expect(supplierBalance(ctx, ids.supplier.id)).toBe(50_000);
    // opening 50,000.00 − 200.00 purchase − 5.00 expense + (160.00 sale − 40.00 change) + 30.00 collection
    expect(cashInHandPaisa(db)).toBe(5_000_000 - 20_000 - 500 + 16_000 + 3000);

    // --- notices ---------------------------------------------------------
    const dash = dashboardStats(db);
    expect(dash.cash_in_hand_paisa).toBe(cashInHandPaisa(db));
    ctx.cleanup();
  });
});

describe('sale return refunds and customer dues', () => {
  it('applies a return against an outstanding due instead of refunding cash', () => {
    const ctx = makeTestDb();
    const ids = seedProducts(ctx);
    const { db } = ctx;
    createPurchase(db, {
      supplierId: ids.supplier.id,
      lines: [{ productId: ids.rice.id, unitId: ctx.unitKgId, qtyMilli: 10_000, unitPricePaisa: 7000 }],
      actor: ctx.actor,
    });
    const sale = createSale(db, {
      customerId: ids.customer.id,
      lines: [{ productId: ids.rice.id, unitId: ctx.unitKgId, qtyMilli: 2000 }],
      actor: ctx.actor,
    });
    expect(customerBalance(ctx, ids.customer.id)).toBe(16_000);

    const line = getSale(db, sale.saleId)!.items![0]!;
    const ret = createSaleReturn(db, {
      saleId: sale.saleId,
      items: [{ lineId: line.id, qtyMilli: 1000 }],
      refundPaisa: 8000,
      refundMethodId: ctx.cashMethodId,
      actor: ctx.actor,
    });

    // The customer owes 16,000.00 and returns 8,000.00 of goods: they must end
    // up owing 8,000.00 — they must NOT be handed 8,000.00 cash on top.
    expect(customerBalance(ctx, ids.customer.id)).toBe(8000);
    expect(ret.refund).toBe(0);
    expect(ret.appliedToDue).toBe(8000);
    expect(cashInHandPaisa(db)).toBe(0);
    ctx.cleanup();
  });

  it('pays out a cash refund only up to the credit created by the return', () => {
    const ctx = makeTestDb();
    const ids = seedProducts(ctx);
    const { db } = ctx;
    createPurchase(db, {
      supplierId: ids.supplier.id,
      lines: [{ productId: ids.rice.id, unitId: ctx.unitKgId, qtyMilli: 10_000, unitPricePaisa: 7000 }],
      actor: ctx.actor,
    });
    const sale = createSale(db, {
      customerId: ids.customer.id,
      lines: [{ productId: ids.rice.id, unitId: ctx.unitKgId, qtyMilli: 1000 }],
      paidPaisa: 8000,
      defaultMethodId: ctx.cashMethodId,
      actor: ctx.actor,
    });
    expect(customerBalance(ctx, ids.customer.id)).toBe(0);

    const line = getSale(db, sale.saleId)!.items![0]!;
    const ret = createSaleReturn(db, {
      saleId: sale.saleId,
      items: [{ lineId: line.id, qtyMilli: 500 }],
      refundPaisa: 4000,
      refundMethodId: ctx.cashMethodId,
      actor: ctx.actor,
    });
    // Goods were paid for, so the customer really gets the money back and ends
    // with a clean balance.
    expect(ret.refund).toBe(4000);
    expect(ret.appliedToDue).toBe(0);
    expect(customerBalance(ctx, ids.customer.id)).toBe(0);
    expect(cashInHandPaisa(db)).toBe(8000 - 4000);
    ctx.cleanup();
  });

  it('clamps a refund that exceeds the credit and reports the rest as due relief', () => {
    const ctx = makeTestDb();
    const ids = seedProducts(ctx);
    const { db } = ctx;
    createPurchase(db, {
      supplierId: ids.supplier.id,
      lines: [{ productId: ids.rice.id, unitId: ctx.unitKgId, qtyMilli: 10_000, unitPricePaisa: 7000 }],
      actor: ctx.actor,
    });
    const sale = createSale(db, {
      customerId: ids.customer.id,
      lines: [{ productId: ids.rice.id, unitId: ctx.unitKgId, qtyMilli: 2000 }],
      paidPaisa: 8000, // 80.00 paid, 80.00 still due
      defaultMethodId: ctx.cashMethodId,
      actor: ctx.actor,
    });
    expect(customerBalance(ctx, ids.customer.id)).toBe(8000);

    const line = getSale(db, sale.saleId)!.items![0]!;
    const ret = createSaleReturn(db, {
      saleId: sale.saleId,
      items: [{ lineId: line.id, qtyMilli: 1000 }],
      refundPaisa: 8000,
      refundMethodId: ctx.cashMethodId,
      actor: ctx.actor,
    });
    // 80.00 return against an 80.00 due: the due disappears, no cash moves.
    expect(ret.total).toBe(8000);
    expect(ret.refund).toBe(0);
    expect(customerBalance(ctx, ids.customer.id)).toBe(0);
    expect(cashInHandPaisa(db)).toBe(8000);
    ctx.cleanup();
  });

  it('keeps the customer statement in step with the stored balance', () => {
    const ctx = makeTestDb();
    const ids = seedProducts(ctx);
    const { db } = ctx;
    createPurchase(db, {
      supplierId: ids.supplier.id,
      lines: [{ productId: ids.rice.id, unitId: ctx.unitKgId, qtyMilli: 10_000, unitPricePaisa: 7000 }],
      actor: ctx.actor,
    });
    const sale = createSale(db, {
      customerId: ids.customer.id,
      lines: [{ productId: ids.rice.id, unitId: ctx.unitKgId, qtyMilli: 2000 }],
      paidPaisa: 8000,
      defaultMethodId: ctx.cashMethodId,
      actor: ctx.actor,
    });
    const line = getSale(db, sale.saleId)!.items![0]!;
    createSaleReturn(db, {
      saleId: sale.saleId,
      items: [{ lineId: line.id, qtyMilli: 1000 }],
      refundPaisa: 8000,
      refundMethodId: ctx.cashMethodId,
      actor: ctx.actor,
    });
    receiveCustomerPayment(db, { customerId: ids.customer.id, amount: 2000, methodId: ctx.cashMethodId }, ctx.actor);
    // 160.00 invoice, 80.00 paid, 80.00 returned (settles the due), then the
    // customer pays 20.00 more → a 20.00 advance (negative balance).
    const cust = getCustomer(db, ids.customer.id)!;
    expect(cust.balance_paisa).toBe(-2000);
    ctx.cleanup();
  });
});

describe('cash register reconciliation', () => {
  it('counts opening cash, sales, collections, expenses and refunds exactly once', () => {
    const ctx = makeTestDb();
    const ids = seedProducts(ctx);
    const { db } = ctx;
    openCashSession(db, { userId: ctx.actor.id, openingCash: 100_000 });

    createPurchase(db, {
      supplierId: ids.supplier.id,
      lines: [{ productId: ids.soap.id, unitId: ctx.unitPieceId, qtyMilli: 100_000, unitPricePaisa: 3000 }],
      actor: ctx.actor,
    });
    createSale(db, {
      lines: [{ productId: ids.soap.id, unitId: ctx.unitPieceId, qtyMilli: 10_000 }],
      paidPaisa: 45_000,
      defaultMethodId: ctx.cashMethodId,
      actor: ctx.actor,
    });
    const sale = createSale(db, {
      customerId: ids.customer.id,
      lines: [{ productId: ids.soap.id, unitId: ctx.unitPieceId, qtyMilli: 10_000 }],
      paidPaisa: 10_000,
      defaultMethodId: ctx.cashMethodId,
      actor: ctx.actor,
    });
    receiveCustomerPayment(db, { customerId: ids.customer.id, amount: 5000, methodId: ctx.cashMethodId }, ctx.actor);
    const cats = listExpenseCategories(db);
    createExpense(db, { categoryId: cats[0]!.id, amountPaisa: 1000, methodId: ctx.cashMethodId, description: 'যাতায়াত' }, ctx.actor);
    const line = getSale(db, sale.saleId)!.items![0]!;
    createSaleReturn(db, {
      saleId: sale.saleId,
      items: [{ lineId: line.id, qtyMilli: 5000 }],
      refundPaisa: 5_000,
      refundMethodId: ctx.cashMethodId,
      actor: ctx.actor,
    });

    const session = sessionTotals(db, 1);
    // opening 1000.00 + 450.00 + 100.00 + 50.00 − 10.00 − 50.00 refund
    // the 50.00 "refund" only settles the outstanding due, so no drawer cash leaves
    expect(session.expected).toBe(100_000 + 45_000 + 10_000 + 5000 - 1000);
    const closed = closeCashSession(db, { userId: ctx.actor.id, countedCash: session.expected, actor: ctx.actor });
    expect(closed.difference_paisa).toBe(0);
    ctx.cleanup();
  });

  it('only moves drawer cash for cash payment methods', () => {
    const ctx = makeTestDb();
    const ids = seedProducts(ctx);
    const { db } = ctx;
    createPurchase(db, {
      supplierId: ids.supplier.id,
      lines: [{ productId: ids.soap.id, unitId: ctx.unitPieceId, qtyMilli: 100_000, unitPricePaisa: 3000 }],
      actor: ctx.actor,
    });
    createSale(db, {
      lines: [{ productId: ids.soap.id, unitId: ctx.unitPieceId, qtyMilli: 10_000 }],
      payments: [
        { methodId: ctx.cashMethodId, amount: 20_000 },
        { methodId: ctx.bkashMethodId, amount: 25_000 },
      ],
      actor: ctx.actor,
    });
    expect(cashInHandPaisa(db)).toBe(20_000);
    const row = db.prepare("SELECT COALESCE(SUM(amount_paisa),0) v FROM payments WHERE method_id = ?").get(ctx.bkashMethodId) as {
      v: number;
    };
    expect(row.v).toBe(25_000);
    ctx.cleanup();
  });
});

describe('financial edge cases', () => {
  it('rejects a payment above the invoice total, keeping change exact', () => {
    const ctx = makeTestDb();
    const ids = seedProducts(ctx);
    const { db } = ctx;
    createPurchase(db, {
      supplierId: ids.supplier.id,
      lines: [{ productId: ids.soap.id, unitId: ctx.unitPieceId, qtyMilli: 10_000, unitPricePaisa: 3000 }],
      actor: ctx.actor,
    });
    const sale = createSale(db, {
      lines: [{ productId: ids.soap.id, unitId: ctx.unitPieceId, qtyMilli: 1000 }],
      paidPaisa: 5000,
      defaultMethodId: ctx.cashMethodId,
      actor: ctx.actor,
    });
    expect(sale.computation.total).toBe(4500);
    expect(sale.computation.change).toBe(500);
    expect(getSale(db, sale.saleId)!.paid_paisa).toBe(4500);
    expect(cashInHandPaisa(db)).toBe(4500);
    ctx.cleanup();
  });

  it('refuses zero and negative quantities at the domain boundary', () => {
    const ctx = makeTestDb();
    const ids = seedProducts(ctx);
    const { db } = ctx;
    createPurchase(db, {
      supplierId: ids.supplier.id,
      lines: [{ productId: ids.soap.id, unitId: ctx.unitPieceId, qtyMilli: 10_000, unitPricePaisa: 3000 }],
      actor: ctx.actor,
    });
    for (const qty of [0, -1000, 0.4]) {
      expect(() =>
        createSale(db, {
          lines: [{ productId: ids.soap.id, unitId: ctx.unitPieceId, qtyMilli: qty }],
          paidPaisa: 0,
          actor: ctx.actor,
        }),
      ).toThrow();
    }
    expect(cashInHandPaisa(db)).toBe(0);
    ctx.cleanup();
  });

  it('handles a large but realistic invoice without drift', () => {
    const ctx = makeTestDb();
    const ids = seedProducts(ctx);
    const { db } = ctx;
    // 2,000 kg of rice at 80.00/kg = 160,000.00
    createPurchase(db, {
      supplierId: ids.supplier.id,
      lines: [{ productId: ids.rice.id, unitId: ctx.unitKgId, qtyMilli: 2_000_000, unitPricePaisa: 7000 }],
      actor: ctx.actor,
    });
    const sale = createSale(db, {
      lines: [{ productId: ids.rice.id, unitId: ctx.unitKgId, qtyMilli: 2_000_000 }],
      orderDiscountType: 'percent',
      orderDiscountValue: 250, // 2.5 %
      paidPaisa: 20_000_000,
      defaultMethodId: ctx.cashMethodId,
      actor: ctx.actor,
    });
    expect(sale.computation.subtotal).toBe(16_000_000);
    expect(sale.computation.discount).toBe(400_000);
    expect(sale.computation.total).toBe(15_600_000);
    expect(sale.computation.change).toBe(20_000_000 - 15_600_000);
    expect(getProduct(db, ids.rice.id)!.stock_base_milli).toBe(0);
    ctx.cleanup();
  });

  it('keeps every report in step with the ledger it summarises', () => {
    const ctx = makeTestDb();
    const ids = seedProducts(ctx);
    const { db } = ctx;
    createPurchase(db, {
      supplierId: ids.supplier.id,
      lines: [{ productId: ids.rice.id, unitId: ctx.unitKgId, qtyMilli: 50_000, unitPricePaisa: 7000 }],
      actor: ctx.actor,
    });
    createSale(db, {
      lines: [{ productId: ids.rice.id, unitId: ctx.unitKgId, qtyMilli: 5000 }],
      paidPaisa: 40_000,
      defaultMethodId: ctx.cashMethodId,
      actor: ctx.actor,
    });
    const dueSale = createSale(db, {
      customerId: ids.customer.id,
      lines: [{ productId: ids.rice.id, unitId: ctx.unitKgId, qtyMilli: 2000 }],
      actor: ctx.actor,
    });
    const cats = listExpenseCategories(db);
    createExpense(db, { categoryId: cats[0]!.id, amountPaisa: 2000, methodId: ctx.cashMethodId, description: 'বিদ্যুৎ' }, ctx.actor);

    const ledger = db
      .prepare("SELECT COALESCE(SUM(total_paisa),0) v FROM sales WHERE status <> 'voided'")
      .get() as { v: number };
    const daily = runReport(db, 'sales_daily');
    expect(daily.totals.total).toBe(ledger.v);

    const pl = runReport(db, 'profit_loss');
    const get = (label: string) => pl.rows.find((r) => r.item === label)!.amount as number;
    // sales profit (40000−35000) + (16000−14000) = 7,000; expenses 2,000
    expect(get('গ্রস প্রফিট')).toBe(7000);
    expect(get('নেট প্রফিট')).toBe(5000);
    expect(get('এক্সপেন্স')).toBe(-2000);

    const valuation = runReport(db, 'stock_valuation');
    const expected = (
      db.prepare('SELECT COALESCE(SUM(ROUND(stock_base_milli * avg_cost_micro / 1000000000.0)),0) v FROM products').get() as {
        v: number;
      }
    ).v;
    expect(valuation.totals.stock_value).toBe(expected);

    const due = runReport(db, 'customer_due');
    const rows = due.rows as { due?: number }[];
    const totalDue = rows.reduce((s, r) => s + Number(r.due ?? 0), 0);
    expect(totalDue).toBe(getCustomer(db, ids.customer.id)!.balance_paisa);
    void dueSale;
    ctx.cleanup();
  });
});
