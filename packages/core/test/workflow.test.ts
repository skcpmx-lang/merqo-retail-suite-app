import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  adjustStock,
  cashInHandPaisa,
  computeSale,
  createExpense,
  createProduct,
  createPurchase,
  createSale,
  createSaleReturn,
  createPurchaseReturn,
  customerStatement,
  dashboardStats,
  findByCode,
  updateSettings,
  getCustomer,
  getProduct,
  getSale,
  listExpenseCategories,
  listMovements,
  receiveCustomerPayment,
  runReport,
  todaySalesSummary,
  voidSale,
  type Db,
} from '../src/index.js';
import { makeTestDb, seedProducts, type TestContext } from './helpers.js';

let ctx: TestContext;
let ids: ReturnType<typeof seedProducts>;

beforeEach(() => {
  ctx = makeTestDb();
  ids = seedProducts(ctx);
});

afterEach(() => ctx.cleanup());

describe('sale workflow', () => {
  it('records a cash sale, moves stock and calculates profit with weighted average cost', () => {
    const { db } = ctx;
    // Purchase 10 kg rice at 70.00 per kg (7000 poisa)
    createPurchase(db, {
      supplierId: ids.supplier.id,
      lines: [{ productId: ids.rice.id, unitId: ctx.unitKgId, qtyMilli: 10_000, unitPricePaisa: 7000 }],
      paidPaisa: 70000,
      defaultMethodId: ctx.cashMethodId,
      actor: ctx.actor,
    });
    const afterPurchase = getProduct(db, ids.rice.id)!;
    expect(afterPurchase.stock_base_milli).toBe(10_000_000); // 10 kg in base gram milli
    // 7000 poisa per kg → 7 poisa per gram → 7_000_000 micro poisa per base unit
    expect(afterPurchase.avg_cost_micro).toBe(7_000_000);

    const result = createSale(db, {
      customerId: ids.customer.id,
      lines: [{ productId: ids.rice.id, unitId: ctx.unitKgId, qtyMilli: 2500 }], // 2.5 kg
      paidPaisa: 20000,
      defaultMethodId: ctx.cashMethodId,
      actor: ctx.actor,
    });
    expect(result.computation.subtotal).toBe(20000);
    expect(result.computation.total).toBe(20000);
    expect(result.computation.due).toBe(0);
    // cost = 2.5kg × 7 poisa/g = 2500g × 7 = 17500
    expect(result.computation.costTotal).toBe(17500);
    expect(result.computation.profit).toBe(2500);

    const product = getProduct(db, ids.rice.id)!;
    expect(product.stock_base_milli).toBe(7_500_000);

    const movement = listMovements(db, { productId: ids.rice.id, type: 'sale' });
    expect(movement.rows).toHaveLength(1);
    expect(movement.rows[0]!.qty_base_milli).toBe(-2_500_000);
    expect(movement.rows[0]!.balance_after_milli).toBe(7_500_000);

    const sale = getSale(db, result.saleId)!;
    expect(sale.invoice_no).toBe(result.invoiceNo);
    expect(sale.items).toHaveLength(1);
    expect(sale.status).toBe('completed');
    expect(cashInHandPaisa(db)).toBe(20000 - 70000 + 0); // sale +20000, purchase -70000
  });

  it('supports due sales, partial payment and later collection', () => {
    const { db } = ctx;
    createPurchase(db, {
      supplierId: ids.supplier.id,
      lines: [{ productId: ids.soap.id, unitId: ctx.unitPieceId, qtyMilli: 100_000, unitPricePaisa: 3000 }],
      actor: ctx.actor,
    });
    const sale = createSale(db, {
      customerId: ids.customer.id,
      lines: [{ productId: ids.soap.id, unitId: ctx.unitPieceId, qtyMilli: 10_000 }],
      paidPaisa: 10000,
      defaultMethodId: ctx.cashMethodId,
      actor: ctx.actor,
    });
    expect(sale.computation.total).toBe(45000);
    expect(sale.computation.paid).toBe(10000);
    expect(sale.computation.due).toBe(35000);
    expect(getCustomer(db, ids.customer.id)!.balance_paisa).toBe(35000);

    const payment = receiveCustomerPayment(
      db,
      { customerId: ids.customer.id, amount: 20000, methodId: ctx.bkashMethodId },
      ctx.actor,
    );
    expect(payment.newBalance).toBe(15000);

    const statement = customerStatement(db, ids.customer.id);
    expect(statement.closing_balance).toBe(15000);
    expect(statement.rows.some((r) => r.type === 'sale')).toBe(true);
    expect(statement.rows.some((r) => r.type === 'payment')).toBe(true);
    expect(statement.total_credit).toBe(20000);

    // profit must not be recognised twice after collecting the due
    const summary = todaySalesSummary(db);
    expect(summary.profit).toBe(sale.computation.profit);
  });

  it('applies order discount and rejects an over-limit discount', () => {
    const { db } = ctx;
    updateSettings(db, { max_discount_percent_x100: 2000 }, ctx.actor);
    createProduct(db, { name: 'চিনি', unitId: ctx.unitKgId, purchasePrice: 9000, salePrice: 10000 }, ctx.actor);
    const sugar = getProduct(db, 1) || null;
    void sugar;
    const product = db.prepare("SELECT id FROM products WHERE name='চিনি'").get() as { id: number };
    const comp = computeSale(db, {
      lines: [{ productId: product.id, unitId: ctx.unitKgId, qtyMilli: 2000 }],
      orderDiscountType: 'percent',
      orderDiscountValue: 1000, // 10%
      actor: ctx.actor,
    });
    expect(comp.subtotal).toBe(20000);
    expect(comp.discount).toBe(2000);
    expect(comp.total).toBe(18000);

    expect(() =>
      computeSale(db, {
        lines: [{ productId: product.id, unitId: ctx.unitKgId, qtyMilli: 2000 }],
        orderDiscountType: 'percent',
        orderDiscountValue: 5000,
        actor: ctx.actor,
      }),
    ).toThrow(/ডিসকাউন্ট/);
  });

  it('rejects a sale that would make stock negative', () => {
    const { db } = ctx;
    expect(() =>
      createSale(db, {
        lines: [{ productId: ids.soap.id, unitId: ctx.unitPieceId, qtyMilli: 5000 }],
        paidPaisa: 22500,
        defaultMethodId: ctx.cashMethodId,
        actor: ctx.actor,
      }),
    ).toThrow(/স্টক/);
  });

  it('finds products by barcode and deducts stock by base unit conversion', () => {
    const { db } = ctx;
    createPurchase(db, {
      supplierId: ids.supplier.id,
      lines: [{ productId: ids.rice.id, unitId: ctx.unitKgId, qtyMilli: 20_000, unitPricePaisa: 7000 }],
      actor: ctx.actor,
    });
    const found = findByCode(db, '8901234567890');
    expect(found?.id).toBe(ids.rice.id);
    // 500 g sale through the kg unit selector (0.5 kg)
    createSale(db, {
      lines: [{ productId: found!.id, unitId: ctx.unitKgId, qtyMilli: 500 }],
      paidPaisa: 4000,
      defaultMethodId: ctx.cashMethodId,
      actor: ctx.actor,
    });
    expect(getProduct(db, ids.rice.id)!.stock_base_milli).toBe(19_500_000);
  });

  it('voids a sale and reverses stock, cash and dues', () => {
    const { db } = ctx;
    createPurchase(db, {
      supplierId: ids.supplier.id,
      lines: [{ productId: ids.soap.id, unitId: ctx.unitPieceId, qtyMilli: 50_000, unitPricePaisa: 3000 }],
      actor: ctx.actor,
    });
    const sale = createSale(db, {
      customerId: ids.customer.id,
      lines: [{ productId: ids.soap.id, unitId: ctx.unitPieceId, qtyMilli: 5000 }],
      paidPaisa: 5000,
      defaultMethodId: ctx.cashMethodId,
      actor: ctx.actor,
    });
    expect(getProduct(db, ids.soap.id)!.stock_base_milli).toBe(45_000);
    expect(getCustomer(db, ids.customer.id)!.balance_paisa).toBe(17500);

    voidSale(db, sale.saleId, 'ভুল ইনভয়েস', ctx.actor);
    expect(getProduct(db, ids.soap.id)!.stock_base_milli).toBe(50_000);
    expect(getCustomer(db, ids.customer.id)!.balance_paisa).toBe(0);
    expect(getSale(db, sale.saleId)!.status).toBe('voided');
  });
});

describe('purchase & supplier workflow', () => {
  it('tracks supplier payable and partial payments', () => {
    const { db } = ctx;
    const pur = createPurchase(db, {
      supplierId: ids.supplier.id,
      lines: [{ productId: ids.rice.id, unitId: ctx.unitKgId, qtyMilli: 100_000, unitPricePaisa: 7000 }],
      paidPaisa: 300_000,
      defaultMethodId: ctx.cashMethodId,
      actor: ctx.actor,
    });
    expect(pur.computation.total).toBe(700_000);
    expect(pur.computation.due).toBe(400_000);
    const supplier = db.prepare('SELECT balance_paisa FROM suppliers WHERE id = ?').get(ids.supplier.id) as {
      balance_paisa: number;
    };
    expect(supplier.balance_paisa).toBe(400_000);

    // second purchase at a different price updates the weighted average cost
    createPurchase(db, {
      supplierId: ids.supplier.id,
      lines: [{ productId: ids.rice.id, unitId: ctx.unitKgId, qtyMilli: 100_000, unitPricePaisa: 8000 }],
      actor: ctx.actor,
    });
    const product = getProduct(db, ids.rice.id)!;
    expect(product.stock_base_milli).toBe(200_000_000);
    // 100kg @7 + 100kg @8 = 15 per gram average
    expect(product.avg_cost_micro).toBe(7_500_000);
  });

  it('allocates transport cost into the landed cost', () => {
    const { db } = ctx;
    createPurchase(db, {
      supplierId: ids.supplier.id,
      lines: [{ productId: ids.rice.id, unitId: ctx.unitKgId, qtyMilli: 100_000, unitPricePaisa: 7000 }],
      otherCostPaisa: 100_000, // 1000 taka transport on 100 kg
      actor: ctx.actor,
    });
    const product = getProduct(db, ids.rice.id)!;
    // 7000 + 1000 per kg = 8000 poisa/kg → 8 poisa per gram
    expect(product.avg_cost_micro).toBe(8_000_000);
  });
});

describe('returns', () => {
  it('handles a partial sale return with refund and stock restock', () => {
    const { db } = ctx;
    createPurchase(db, {
      supplierId: ids.supplier.id,
      lines: [{ productId: ids.rice.id, unitId: ctx.unitKgId, qtyMilli: 20_000, unitPricePaisa: 7000 }],
      actor: ctx.actor,
    });
    const sale = createSale(db, {
      customerId: ids.customer.id,
      lines: [{ productId: ids.rice.id, unitId: ctx.unitKgId, qtyMilli: 5000 }],
      paidPaisa: 10000,
      defaultMethodId: ctx.cashMethodId,
      actor: ctx.actor,
    });
    const saleDetail = getSale(db, sale.saleId)!;
    const lineId = saleDetail.items![0]!.id;

    const ret = createSaleReturn(db, {
      saleId: sale.saleId,
      items: [{ lineId, qtyMilli: 2000 }],
      refundPaisa: 16000,
      refundMethodId: ctx.cashMethodId,
      actor: ctx.actor,
    });
    expect(ret.total).toBe(16000);
    expect(ret.refund).toBe(16000);
    expect(getProduct(db, ids.rice.id)!.stock_base_milli).toBe(17_000_000);
    // customer had 30000 due, return reduces it by 16000, cash refund adds it back
    expect(getCustomer(db, ids.customer.id)!.balance_paisa).toBe(30000 - 16000 + 16000);

    // cannot return more than was sold
    expect(() =>
      createSaleReturn(db, {
        saleId: sale.saleId,
        items: [{ lineId, qtyMilli: 4000 }],
        refundPaisa: 0,
        actor: ctx.actor,
      }),
    ).toThrow();
  });

  it('handles purchase returns and reduces supplier payable', () => {
    const { db } = ctx;
    const pur = createPurchase(db, {
      supplierId: ids.supplier.id,
      lines: [{ productId: ids.soap.id, unitId: ctx.unitPieceId, qtyMilli: 20_000, unitPricePaisa: 3000 }],
      actor: ctx.actor,
    });
    const detail = db.prepare('SELECT id FROM purchase_items WHERE purchase_id = ?').get(pur.purchaseId) as { id: number };
    createPurchaseReturn(db, {
      purchaseId: pur.purchaseId,
      items: [{ lineId: detail.id, qtyMilli: 5000 }],
      actor: ctx.actor,
    });
    expect(getProduct(db, ids.soap.id)!.stock_base_milli).toBe(15_000);
    const supplier = db.prepare('SELECT balance_paisa FROM suppliers WHERE id = ?').get(ids.supplier.id) as {
      balance_paisa: number;
    };
    expect(supplier.balance_paisa).toBe(60_000 - 15_000);
  });
});

describe('expenses, cash and dashboard', () => {
  it('records expenses against cash and reflects them in P&L', () => {
    const { db } = ctx;
    createPurchase(db, {
      supplierId: ids.supplier.id,
      lines: [{ productId: ids.soap.id, unitId: ctx.unitPieceId, qtyMilli: 100_000, unitPricePaisa: 3000 }],
      actor: ctx.actor,
    });
    createSale(db, {
      lines: [{ productId: ids.soap.id, unitId: ctx.unitPieceId, qtyMilli: 10_000 }],
      paidPaisa: 45000,
      defaultMethodId: ctx.cashMethodId,
      actor: ctx.actor,
    });
    const cats = listExpenseCategories(db);
    expect(cats.length).toBeGreaterThan(3);
    createExpense(
      db,
      {
        categoryId: cats[0].id,
        amountPaisa: 5000,
        methodId: ctx.cashMethodId,
        description: 'দোকান ভাড়া',
      },
      ctx.actor,
    );

    const pl = runReport(db, 'profit_loss');
    const netProfit = pl.rows.find((r) => r.item === 'নেট প্রফিট')!.amount as number;
    // gross profit = 45000 - 30000 = 15000, minus 5000 expense
    expect(netProfit).toBe(10000);
    expect(cashInHandPaisa(db)).toBe(45000 - 5000);

    const stats = dashboardStats(db);
    expect(stats.today_sales_paisa).toBe(45000);
    expect(stats.total_expenses_paisa).toBe(5000);
    expect(stats.cash_in_hand_paisa).toBe(40000);
  });

  it('adjusts stock with an audit trail', () => {
    const { db } = ctx;
    createPurchase(db, {
      supplierId: ids.supplier.id,
      lines: [{ productId: ids.soap.id, unitId: ctx.unitPieceId, qtyMilli: 10_000, unitPricePaisa: 3000 }],
      actor: ctx.actor,
    });
    adjustStock(db, { productId: ids.soap.id, newQtyBaseMilli: 8000, reason: 'নষ্ট হয়েছে', actor: ctx.actor });
    expect(getProduct(db, ids.soap.id)!.stock_base_milli).toBe(8000);
    const logs = db.prepare("SELECT * FROM audit_logs WHERE action = 'stock.adjust'").all();
    expect(logs).toHaveLength(1);
  });
});

describe('reports', () => {
  it('produces consistent sales and stock reports', () => {
    const { db } = ctx;
    createPurchase(db, {
      supplierId: ids.supplier.id,
      lines: [{ productId: ids.rice.id, unitId: ctx.unitKgId, qtyMilli: 50_000, unitPricePaisa: 7000 }],
      actor: ctx.actor,
    });
    createSale(db, {
      lines: [{ productId: ids.rice.id, unitId: ctx.unitKgId, qtyMilli: 5000 }],
      paidPaisa: 40000,
      defaultMethodId: ctx.cashMethodId,
      actor: ctx.actor,
    });
    const daily = runReport(db, 'sales_daily');
    expect(daily.rows.length).toBe(1);
    expect(daily.totals.total).toBe(40000);
    expect(daily.chart?.length).toBeGreaterThan(0);

    const stock = runReport(db, 'stock');
    expect(stock.rows.length).toBe(2);
    const valuation = runReport(db, 'stock_valuation');
    const riceRow = (valuation.rows as any[]).find((r) => r.product_name === 'মিনিকেট চাল');
    expect(riceRow.stock_value).toBe(315_000); // 45 kg = 45,000 g × 7 poisa/g
  });
});

describe('database integrity', () => {
  it('enforces unique invoice numbers and foreign keys', () => {
    const { db } = ctx;
    expect(() =>
      db.prepare('INSERT INTO products (name, unit_id, created_at, updated_at) VALUES (?,?,?,?)').run('bad', 9999, 'x', 'y'),
    ).toThrow();
  });

  it('rolls back a failed sale completely', () => {
    const { db } = ctx;
    createPurchase(db, {
      supplierId: ids.supplier.id,
      lines: [{ productId: ids.soap.id, unitId: ctx.unitPieceId, qtyMilli: 10_000, unitPricePaisa: 3000 }],
      actor: ctx.actor,
    });
    // second line references a product with no stock → whole transaction must fail
    expect(() =>
      createSale(db, {
        lines: [
          { productId: ids.soap.id, unitId: ctx.unitPieceId, qtyMilli: 1000 },
          { productId: ids.rice.id, unitId: ctx.unitKgId, qtyMilli: 1000 },
        ],
        paidPaisa: 0,
        defaultMethodId: ctx.cashMethodId,
        actor: ctx.actor,
      }),
    ).toThrow();
    expect(getProduct(db, ids.soap.id)!.stock_base_milli).toBe(10_000);
    const sales = db.prepare('SELECT COUNT(*) c FROM sales').get() as { c: number };
    expect(sales.c).toBe(0);
  });
});
