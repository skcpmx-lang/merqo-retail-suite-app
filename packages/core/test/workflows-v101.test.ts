import { describe, expect, it } from 'vitest';
import {
  assembleBundle,
  cancelHeldSale,
  cashInHandPaisa,
  createCreditNote,
  createCustomer,
  createExchange,
  createLocation,
  createProduct,
  createPurchase,
  createSale,
  createStockCount,
  createSupplier,
  createTransfer,
  creditCheck,
  defaultLocationId,
  getCustomer,
  getSale,
  holdSale,
  inventoryValuation,
  listHeldSales,
  locationStock,
  loyaltySummary,
  postStockCount,
  priceLevelValue,
  receiveCustomerPayment,
  reconcile,
  reorderSuggestions,
  resumeHeldSale,
  runReport,
  setBundle,
  setCountedQty,
  setCreditLimit,
  setCustomerPriceLevel,
  trialBalance,
  updateSettings,
} from '../src/index.js';
import { makeTestDb } from './helpers.js';

const RANGE = { from: '2000-01-01', to: '2999-12-31' };

function expectCleanBooks(db: any) {
  const checks = reconcile(db, RANGE);
  const bad = checks.filter((c) => !c.ok);
  expect(bad).toEqual([]);
  const tb = trialBalance(db, RANGE);
  expect(tb.balanced).toBe(true);
}

describe('E2E-1: POS hold → resume → split payment → sale', () => {
  it('completes a parked cart with two payment methods', () => {
    const ctx = makeTestDb();
    const p = createProduct(
      ctx.db,
      { name: 'চাল', unitId: ctx.unitPieceId, salePrice: 10_000, openingStockMilli: 100_000, openingCostMicro: 6_000_000_000 },
      ctx.actor,
    );
    const held = holdSale(ctx.db, {
      lines: [{ productId: p.id, unitId: ctx.unitPieceId, qtyMilli: 5000 }],
      totalPaisa: 50_000,
      note: 'কাস্টমার ফিরে আসবে',
      actor: ctx.actor,
    });
    expect(listHeldSales(ctx.db).length).toBe(1);

    const resumed = resumeHeldSale(ctx.db, held.id, ctx.actor);
    const lines = JSON.parse(resumed.lines_json) as any[];

    const sale = createSale(ctx.db, {
      lines: [
        {
          productId: lines[0].productId,
          unitId: lines[0].unitId,
          qtyMilli: lines[0].qtyMilli,
          unitPricePaisa: 10_000,
        },
      ],
      payments: [
        { methodId: ctx.cashMethodId, amount: 30_000 },
        { methodId: ctx.bkashMethodId, amount: 20_000 },
      ],
      actor: ctx.actor,
    });
    expect(sale.computation.paid).toBe(50_000);
    const saved = getSale(ctx.db, sale.saleId)!;
    expect(saved.due_paisa).toBe(0);
    const methods = ctx.db
      .prepare("SELECT COUNT(DISTINCT method_id) c FROM payments WHERE sale_id = ? AND status = 'active'")
      .get(sale.saleId) as { c: number };
    expect(methods.c).toBe(2);
    expect(cashInHandPaisa(ctx.db)).toBe(30_000);
    expectCleanBooks(ctx.db);
    expect(() => cancelHeldSale(ctx.db, held.id, 'পরীক্ষা', ctx.actor)).toThrow(/বাতিল করা যাবে না/);
    ctx.cleanup();
  });
});

describe('E2E-2: partial return → credit note → loyalty reversal', () => {
  it('keeps money, stock and points consistent', () => {
    const ctx = makeTestDb();
    updateSettings(ctx.db, { loyalty_enabled: 1, loyalty_points_per_100: 1, loyalty_redeem_value_paisa: 100 } as any);
    const p = createProduct(
      ctx.db,
      { name: 'সাবান', unitId: ctx.unitPieceId, salePrice: 4000, openingStockMilli: 100_000, openingCostMicro: 3_000_000_000 },
      ctx.actor,
    );
    const customer = createCustomer(ctx.db, { name: 'করিম', phone: '01710000000' }, ctx.actor);
    const sale = createSale(ctx.db, {
      customerId: customer.id,
      lines: [{ productId: p.id, unitId: ctx.unitPieceId, qtyMilli: 25_000, unitPricePaisa: 4000 }],
      payments: [{ methodId: ctx.cashMethodId, amount: 100_000 }],
      actor: ctx.actor,
    });
    expect(loyaltySummary(ctx.db, customer.id).points).toBe(10); // 1000 taka → 10 points

    const line = ctx.db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').get(sale.saleId) as any;
    const note = createCreditNote(ctx.db, {
      saleId: sale.saleId,
      items: [{ lineId: line.id, qtyMilli: 10_000 }],
      actor: ctx.actor,
    });
    expect(note.total).toBe(40_000);
    expect(getCustomer(ctx.db, customer.id)!.balance_paisa).toBe(-40_000); // store credit

    const stock = ctx.db.prepare('SELECT stock_base_milli s FROM products WHERE id = ?').get(p.id) as { s: number };
    expect(stock.s).toBe(85_000); // 15 sold of 100
    expectCleanBooks(ctx.db);
    ctx.cleanup();
  });
});

describe('E2E-3: walk-in exchange', () => {
  it('refunds the old item and collects for the new one', () => {
    const ctx = makeTestDb();
    const a = createProduct(ctx.db, { name: 'শার্ট', unitId: ctx.unitPieceId, salePrice: 50_000, openingStockMilli: 50_000, openingCostMicro: 30_000_000_000 }, ctx.actor);
    const b = createProduct(ctx.db, { name: 'প্যান্ট', unitId: ctx.unitPieceId, salePrice: 80_000, openingStockMilli: 50_000, openingCostMicro: 50_000_000_000 }, ctx.actor);
    const sale = createSale(ctx.db, {
      lines: [{ productId: a.id, unitId: ctx.unitPieceId, qtyMilli: 1000, unitPricePaisa: 50_000 }],
      payments: [{ methodId: ctx.cashMethodId, amount: 50_000 }],
      actor: ctx.actor,
    });
    const line = ctx.db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').get(sale.saleId) as any;
    const before = cashInHandPaisa(ctx.db);
    const ex = createExchange(ctx.db, {
      saleId: sale.saleId,
      returnItems: [{ lineId: line.id, qtyMilli: 1000 }],
      newLines: [{ productId: b.id, unitId: ctx.unitPieceId, qtyMilli: 1000, unitPricePaisa: 80_000 }],
      methodId: ctx.cashMethodId,
      actor: ctx.actor,
    });
    expect(ex.returnedTotal).toBe(50_000);
    expect(ex.newTotal).toBe(80_000);
    // 500 taka refunded, 800 taka collected → drawer +300 taka
    expect(cashInHandPaisa(ctx.db)).toBe(before + 30_000);
    const shirt = ctx.db.prepare('SELECT stock_base_milli s FROM products WHERE id = ?').get(a.id) as { s: number };
    expect(shirt.s).toBe(50_000);
    expectCleanBooks(ctx.db);
    ctx.cleanup();
  });
});

describe('E2E-4: godown transfer → physical count → reorder', () => {
  it('moves stock between locations, corrects it and suggests a purchase', () => {
    const ctx = makeTestDb();
    const p = createProduct(
      ctx.db,
      { name: 'চিনি', unitId: ctx.unitPieceId, salePrice: 12_000, openingStockMilli: 100_000, openingCostMicro: 9_000_000_000, minStockMilli: 99_000 },
      ctx.actor,
    );
    const godown = createLocation(ctx.db, { name: 'গুদাম-১', kind: 'godown' }, ctx.actor);
    createTransfer(ctx.db, {
      fromLocationId: defaultLocationId(ctx.db),
      toLocationId: godown.id,
      items: [{ productId: p.id, qtyBaseMilli: 70_000 }],
      actor: ctx.actor,
    });
    const levels = locationStock(ctx.db, p.id);
    expect(levels.find((l) => l.location_id === godown.id)!.qty_base_milli).toBe(70_000);
    const total = ctx.db.prepare('SELECT stock_base_milli s FROM products WHERE id = ?').get(p.id) as { s: number };
    expect(total.s).toBe(100_000);

    const count = createStockCount(ctx.db, { locationId: godown.id, actor: ctx.actor });
    setCountedQty(ctx.db, count.id, p.id, 68_000); // 2 pcs short
    postStockCount(ctx.db, count.id, ctx.actor);
    const after = ctx.db.prepare('SELECT stock_base_milli s FROM products WHERE id = ?').get(p.id) as { s: number };
    expect(after.s).toBe(98_000);

    expect(reorderSuggestions(ctx.db, {}).some((r: any) => r.id === p.id)).toBe(true);
    expectCleanBooks(ctx.db);
    ctx.cleanup();
  });
});

describe('E2E-5: purchase → partial payment → accounting reports', () => {
  it('agrees with the ledger at every step', () => {
    const ctx = makeTestDb();
    const p = createProduct(
      ctx.db,
      { name: 'ডাল', unitId: ctx.unitPieceId, salePrice: 15_000, openingStockMilli: 0 },
      ctx.actor,
    );
    const supplier = createSupplier(ctx.db, { name: 'মেসার্স ট্রেডার্স', phone: '01812345678' }, ctx.actor);
    const purchase = createPurchase(ctx.db, {
      supplierId: supplier.id,
      lines: [{ productId: p.id, unitId: ctx.unitPieceId, qtyMilli: 20_000, unitPricePaisa: 12_000 }],
      discountPaisa: 0,
      paidPaisa: 100_000,
      actor: ctx.actor,
    } as any);
    expect(purchase.purchaseId).toBeGreaterThan(0);

    const sale = createSale(ctx.db, {
      lines: [{ productId: p.id, unitId: ctx.unitPieceId, qtyMilli: 5000, unitPricePaisa: 15_000 }],
      payments: [{ methodId: ctx.cashMethodId, amount: 75_000 }],
      actor: ctx.actor,
    });
    expect(sale.computation.profit).toBeGreaterThan(0);

    const pl = runReport(ctx.db, 'ledger_pl', RANGE);
    expect(Number(pl.totals.netProfit)).toBeGreaterThan(0);
    const ap = ctx.db.prepare('SELECT balance_paisa b FROM suppliers WHERE id = ?').get(supplier.id) as { b: number };
    expect(ap.b).toBeGreaterThan(0); // 2400 - 1000 = 1400 taka still owed
    expectCleanBooks(ctx.db);
    ctx.cleanup();
  });
});

describe('E2E-6: credit limit → block → payment → allow', () => {
  it('enforces the cap and releases it after collection', () => {
    const ctx = makeTestDb();
    updateSettings(ctx.db, { credit_limit_enforced: 1 } as any);
    const p = createProduct(ctx.db, { name: 'মসলা', unitId: ctx.unitPieceId, salePrice: 10_000, openingStockMilli: 100_000 }, ctx.actor);
    const customer = createCustomer(ctx.db, { name: 'হাসান', phone: '01711111111' }, ctx.actor);
    setCreditLimit(ctx.db, customer.id, 100_000, ctx.actor); // 1000 taka

    const dueSale = () =>
      createSale(ctx.db, {
        customerId: customer.id,
        lines: [{ productId: p.id, unitId: ctx.unitPieceId, qtyMilli: 10_000, unitPricePaisa: 10_000 }],
        payments: [],
        actor: ctx.actor,
      });
    dueSale(); // exactly 1000 taka
    expect(creditCheck(ctx.db, customer.id, 1).ok).toBe(false);
    expect(() => dueSale()).toThrow(/বাকির সীমা/);

    receiveCustomerPayment(
      ctx.db,
      { customerId: customer.id, amount: 60_000, methodId: ctx.cashMethodId, note: 'আংশিক আদায়' },
      ctx.actor,
    );
    expect(creditCheck(ctx.db, customer.id, 50_000).ok).toBe(true);
    const ok = createSale(ctx.db, {
      customerId: customer.id,
      lines: [{ productId: p.id, unitId: ctx.unitPieceId, qtyMilli: 5000, unitPricePaisa: 10_000 }],
      payments: [],
      actor: ctx.actor,
    });
    expect(ok.saleId).toBeGreaterThan(0);
    expectCleanBooks(ctx.db);
    ctx.cleanup();
  });
});

describe('E2E-7: bundle assembly → sale → valuation', () => {
  it('keeps inventory value identical through assembly and sale', () => {
    const ctx = makeTestDb();
    const childA = createProduct(ctx.db, { name: 'ক-উপকরণ', unitId: ctx.unitPieceId, salePrice: 10_000, openingStockMilli: 50_000, openingCostMicro: 8_000_000_000 }, ctx.actor);
    const childB = createProduct(ctx.db, { name: 'খ-উপকরণ', unitId: ctx.unitPieceId, salePrice: 20_000, openingStockMilli: 50_000, openingCostMicro: 12_000_000_000 }, ctx.actor);
    const pack = createProduct(ctx.db, { name: 'কম্বো প্যাক', unitId: ctx.unitPieceId, salePrice: 35_000, openingStockMilli: 0 }, ctx.actor);

    setBundle(ctx.db, pack.id, [{ childId: childA.id, qtyBaseMilli: 1000 }, { childId: childB.id, qtyBaseMilli: 1000 }], ctx.actor);
    const before = inventoryValuation(ctx.db, {}).totals.value_paisa;
    assembleBundle(ctx.db, { parentId: pack.id, count: 3, actor: ctx.actor });
    const after = inventoryValuation(ctx.db, {}).totals.value_paisa;
    expect(Math.abs(after - before)).toBeLessThanOrEqual(5);

    const sale = createSale(ctx.db, {
      lines: [{ productId: pack.id, unitId: ctx.unitPieceId, qtyMilli: 1000, unitPricePaisa: 35_000 }],
      payments: [{ methodId: ctx.cashMethodId, amount: 35_000 }],
      actor: ctx.actor,
    });
    expect(sale.computation.profit).toBe(15_000); // 350 − 200 cost
    expectCleanBooks(ctx.db);
    ctx.cleanup();
  });
});

describe('E2E-8: customer price level applies to the bill', () => {
  it('bills a wholesale customer at the wholesale price', () => {
    const ctx = makeTestDb();
    const p = createProduct(
      ctx.db,
      { name: 'তেল', unitId: ctx.unitPieceId, salePrice: 20_000, wholesalePrice: 17_000, openingStockMilli: 50_000 },
      ctx.actor,
    );
    const customer = createCustomer(ctx.db, { name: 'পাইকারি দোকান', phone: '01722222222' }, ctx.actor);
    setCustomerPriceLevel(ctx.db, customer.id, 'wholesale', ctx.actor);

    const retail = createSale(ctx.db, {
      lines: [{ productId: p.id, unitId: ctx.unitPieceId, qtyMilli: 1000 }],
      payments: [{ methodId: ctx.cashMethodId, amount: 20_000 }],
      actor: ctx.actor,
    });
    const wholesale = createSale(ctx.db, {
      customerId: customer.id,
      lines: [{ productId: p.id, unitId: ctx.unitPieceId, qtyMilli: 1000 }],
      payments: [{ methodId: ctx.cashMethodId, amount: 17_000 }],
      actor: ctx.actor,
    });
    expect(retail.computation.total).toBe(priceLevelValue(p, 'retail'));
    expect(wholesale.computation.total).toBe(priceLevelValue(p, 'wholesale'));
    expect(wholesale.computation.total).toBeLessThan(retail.computation.total);
    expectCleanBooks(ctx.db);
    ctx.cleanup();
  });
});
