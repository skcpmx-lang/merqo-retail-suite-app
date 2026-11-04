import { describe, expect, it } from 'vitest';
import {
  adjustGiftCard,
  adjustStock,
  balanceSheet,
  cancelPurchaseOrder,
  checkCoupon,
  checkGiftCard,
  computeSale,
  createCoupon,
  createCustomer,
  createProduct,
  createPurchaseOrder,
  createSale,
  createSupplier,
  expireGiftCards,
  getGiftCardByCode,
  getPurchaseOrder,
  giftCardSummary,
  giftCardTransactions,
  issueGiftCard,
  listCoupons,
  listPurchaseOrders,
  receivePurchaseOrder,
  reconcile,
  refundToGiftCard,
  trialBalance,
  voidGiftCard,
} from '../src/index.js';
import { makeTestDb, seedProducts } from './helpers.js';

const RANGE = { from: '2000-01-01', to: '2999-12-31' };

function expectCleanBooks(db: any) {
  const bad = reconcile(db, RANGE).filter((c: any) => !c.ok);
  expect(bad).toEqual([]);
  expect(trialBalance(db, RANGE).balanced).toBe(true);
}

/**
 * Seeded products carry no opening stock. Stock in through the real service so
 * the ledger gets the matching inventory posting (a raw UPDATE would break the
 * stock-vs-ledger reconciliation on purpose).
 */
function stockUp(db: any, product: any, qtyBaseMilli: number, ctx: any) {
  adjustStock(
    db,
    { productId: product.id, newQtyBaseMilli: qtyBaseMilli, reason: 'টেস্ট প্রারম্ভিক স্টক', costMicro: 6_000_000_000, actor: ctx.actor },
  );
}

function twoTakaProduct(db: any, ctx: any, name = 'পণ্য') {
  return createProduct(
    db,
    { name, unitId: ctx.unitPieceId, salePrice: 10_000, purchasePrice: 6_000, openingStockMilli: 0 },
    ctx.actor,
  );
}

function cashTenderTotal(db: any, cashMethodId: number): number {
  const row = db.prepare('SELECT COALESCE(SUM(amount_paisa),0) AS v FROM payments WHERE method_id = ?').get(cashMethodId) as any;
  return row.v;
}

describe('v1.1 purchase orders', () => {
  it('orders, receives partially, then completes — stock and payable track each receipt', () => {
    const ctx = makeTestDb();
    const product = twoTakaProduct(ctx.db, ctx);
    const supplier = createSupplier(ctx.db, { name: 'একতা ট্রেডার্স', phone: '01711111111' }, ctx.actor);

    const po = createPurchaseOrder(ctx.db, {
      supplierId: supplier.id,
      lines: [{ productId: product.id, qtyMilli: 100_000, unitCostPaisa: 6_000 }],
      actor: ctx.actor,
    });
    expect(po.status).toBe('open');
    expect(po.total_paisa).toBe(600_000);
    expect(po.items?.[0]?.qty_base_milli).toBe(100_000);
    // An order alone must not move stock or the ledger.
    const stockAfterOrder = (ctx.db.prepare('SELECT stock_base_milli FROM products WHERE id = ?').get(product.id) as any)
      .stock_base_milli;
    expect(stockAfterOrder).toBe(0);

    const first = receivePurchaseOrder(ctx.db, {
      poId: po.id,
      items: [{ poItemId: po.items![0]!.id, qtyMilli: 60_000 }],
      actor: ctx.actor,
    });
    expect(first.status).toBe('partial');
    expect(first.totalPaisa).toBe(360_000);
    expect((ctx.db.prepare('SELECT stock_base_milli FROM products WHERE id = ?').get(product.id) as any).stock_base_milli).toBe(60_000);
    expect((ctx.db.prepare('SELECT balance_paisa FROM suppliers WHERE id = ?').get(supplier.id) as any).balance_paisa).toBe(360_000);

    // Cannot receive more than remains.
    expect(() =>
      receivePurchaseOrder(ctx.db, {
        poId: po.id,
        items: [{ poItemId: po.items![0]!.id, qtyMilli: 50_000 }],
        actor: ctx.actor,
      }),
    ).toThrow(/তার বেশি গ্রহণ/);

    const second = receivePurchaseOrder(ctx.db, {
      poId: po.id,
      items: [{ poItemId: po.items![0]!.id, qtyMilli: 40_000 }],
      actor: ctx.actor,
    });
    expect(second.status).toBe('received');
    expect(second.remainingItems).toBe(0);

    const reloaded = getPurchaseOrder(ctx.db, po.id)!;
    expect(reloaded.status).toBe('received');
    expect(reloaded.received_percent).toBe(100);
    expect(reloaded.receipts?.length).toBe(2);
    expect((ctx.db.prepare('SELECT stock_base_milli FROM products WHERE id = ?').get(product.id) as any).stock_base_milli).toBe(100_000);
    expect((ctx.db.prepare('SELECT balance_paisa FROM suppliers WHERE id = ?').get(supplier.id) as any).balance_paisa).toBe(600_000);
    expectCleanBooks(ctx.db);
    ctx.cleanup();
  });

  it('refuses to cancel an order that has already delivered, and lists by status', () => {
    const ctx = makeTestDb();
    const product = twoTakaProduct(ctx.db, ctx);
    const supplier = createSupplier(ctx.db, { name: 'নীল ট্রেডার্স', phone: '01711111112' }, ctx.actor);
    const po = createPurchaseOrder(ctx.db, {
      supplierId: supplier.id,
      lines: [{ productId: product.id, qtyMilli: 10_000, unitCostPaisa: 6_000 }],
      actor: ctx.actor,
    });
    receivePurchaseOrder(ctx.db, {
      poId: po.id,
      items: [{ poItemId: po.items![0]!.id, qtyMilli: 4_000 }],
      actor: ctx.actor,
    });
    expect(() => cancelPurchaseOrder(ctx.db, po.id, 'মনে হয়নি', ctx.actor)).toThrow(/গ্রহণ করা হয়েছে/);
    expect(listPurchaseOrders(ctx.db, { status: 'partial' }).total).toBe(1);

    const po2 = createPurchaseOrder(ctx.db, {
      supplierId: supplier.id,
      lines: [{ productId: product.id, qtyMilli: 5_000, unitCostPaisa: 6_000 }],
      actor: ctx.actor,
    });
    const cancelled = cancelPurchaseOrder(ctx.db, po2.id, 'সাপ্লায়ার মেলেনি', ctx.actor);
    expect(cancelled.status).toBe('cancelled');
    expect(() =>
      receivePurchaseOrder(ctx.db, { poId: po2.id, items: [{ poItemId: po2.items![0]!.id, qtyMilli: 1000 }], actor: ctx.actor }),
    ).toThrow(/বাতিল/);
    ctx.cleanup();
  });

  it('shares one numbering series per month and never reissues a PO number', () => {
    const ctx = makeTestDb();
    const product = twoTakaProduct(ctx.db, ctx);
    const a = createPurchaseOrder(ctx.db, { lines: [{ productId: product.id, qtyMilli: 1000, unitCostPaisa: 1000 }], actor: ctx.actor });
    const b = createPurchaseOrder(ctx.db, { lines: [{ productId: product.id, qtyMilli: 1000, unitCostPaisa: 1000 }], actor: ctx.actor });
    expect(a.po_no).not.toBe(b.po_no);
    expect(a.po_no).toMatch(/^PUR-PO-/);
    ctx.cleanup();
  });
});

describe('v1.1 coupons', () => {
  it('applies a percentage coupon, records the redemption and keeps the ledger exact', () => {
    const ctx = makeTestDb();
    const { rice } = seedProducts(ctx);
    stockUp(ctx.db, rice, 100_000_000, ctx);
    const coupon = createCoupon(ctx.db, { code: 'eid10', kind: 'percent', value: 1000, label: 'ঈদ অফার' }, ctx.actor);
    expect(coupon.code).toBe('EID10');

    const sale = createSale(ctx.db, {
      lines: [{ productId: rice.id, unitId: ctx.unitKgId, qtyMilli: 1000 }],
      couponCode: 'EID10',
      payments: [{ methodId: ctx.cashMethodId, amount: 7200 }],
      actor: ctx.actor,
    });
    expect(sale.computation.couponDiscount).toBe(800);
    expect(sale.computation.total).toBe(7200);
    expect(sale.computation.due).toBe(0);

    const row = ctx.db.prepare('SELECT * FROM coupons WHERE id = ?').get(coupon.id) as any;
    expect(row.used_count).toBe(1);
    const redemption = ctx.db.prepare('SELECT * FROM coupon_redemptions WHERE sale_id = ?').get(sale.saleId) as any;
    expect(redemption.discount_paisa).toBe(800);
    const saved = ctx.db.prepare('SELECT coupon_code, coupon_discount_paisa, discount_paisa FROM sales WHERE id = ?').get(sale.saleId) as any;
    expect(saved.coupon_code).toBe('EID10');
    expect(saved.coupon_discount_paisa).toBe(800);
    // The discount column includes the coupon so the P&L discount line is complete.
    expect(saved.discount_paisa).toBe(800);

    const discountRow = ctx.db
      .prepare(
        `SELECT SUM(jl.debit_paisa - jl.credit_paisa) AS amount FROM journal_lines jl
           JOIN accounts a ON a.id = jl.account_id WHERE a.code = '4100'`,
      )
      .get() as any;
    expect(discountRow.amount).toBe(800);
    expectCleanBooks(ctx.db);
    ctx.cleanup();
  });

  it('enforces minimum spend, usage limit, expiry and per-customer limit', () => {
    const ctx = makeTestDb();
    const { rice } = seedProducts(ctx);
    stockUp(ctx.db, rice, 100_000_000, ctx);
    const customer = createCustomer(ctx.db, { name: 'রফিক', phone: '01933333333' }, ctx.actor);

    createCoupon(
      ctx.db,
      { code: 'MIN500', kind: 'fixed', value: 5000, minPurchasePaisa: 50_000, usageLimit: 2, perCustomerLimit: 1 },
      ctx.actor,
    );
    expect(checkCoupon(ctx.db, { code: 'MIN500', subtotalPaisa: 10_000 }).ok).toBe(false);
    expect(checkCoupon(ctx.db, { code: 'MIN500', subtotalPaisa: 60_000, customerId: customer.id }).discountPaisa).toBe(5000);
    // per-customer limit needs a customer on the bill
    expect(checkCoupon(ctx.db, { code: 'MIN500', subtotalPaisa: 60_000 }).ok).toBe(false);

    createCoupon(ctx.db, { code: 'ONCE', kind: 'fixed', value: 1000, perCustomerLimit: 1 }, ctx.actor);
    const first = createSale(ctx.db, {
      customerId: customer.id,
      lines: [{ productId: rice.id, unitId: ctx.unitKgId, qtyMilli: 4000 }],
      couponCode: 'ONCE',
      actor: ctx.actor,
    });
    expect(first.computation.couponDiscount).toBe(1000);
    expect(() =>
      createSale(ctx.db, {
        customerId: customer.id,
        lines: [{ productId: rice.id, unitId: ctx.unitKgId, qtyMilli: 4000 }],
        couponCode: 'ONCE',
        actor: ctx.actor,
      }),
    ).toThrow(/সর্বোচ্চ বার|সীমা/);

    createCoupon(ctx.db, { code: 'OLD', kind: 'fixed', value: 1000, expiresAt: '2000-01-01 00:00:00' }, ctx.actor);
    expect(checkCoupon(ctx.db, { code: 'OLD', subtotalPaisa: 5000 }).reason).toMatch(/মেয়াদ/);

    // A bad code can never silently pass through the sale engine.
    expect(() =>
      createSale(ctx.db, { lines: [{ productId: rice.id, unitId: ctx.unitKgId, qtyMilli: 1000 }], couponCode: 'NOPE', actor: ctx.actor }),
    ).toThrow(/কুপন/);
    expectCleanBooks(ctx.db);
    ctx.cleanup();
  });

  it('never lets a coupon push the bill below zero and caps percentage discounts', () => {
    const ctx = makeTestDb();
    const { soap } = seedProducts(ctx);
    stockUp(ctx.db, soap, 100_000, ctx);
    createCoupon(ctx.db, { code: 'BIG', kind: 'fixed', value: 99_999 }, ctx.actor);
    createCoupon(ctx.db, { code: 'CAP50', kind: 'percent', value: 5000, maxDiscountPaisa: 500 }, ctx.actor);
    const capped = computeSale(ctx.db, {
      lines: [{ productId: soap.id, unitId: ctx.unitPieceId, qtyMilli: 4000 }],
      couponCode: 'CAP50',
      actor: ctx.actor,
    });
    expect(capped.couponDiscount).toBe(500);
    const floored = computeSale(ctx.db, {
      lines: [{ productId: soap.id, unitId: ctx.unitPieceId, qtyMilli: 1000 }],
      couponCode: 'BIG',
      actor: ctx.actor,
    });
    expect(floored.total).toBe(0);
    expect(floored.couponDiscount).toBe(4500);
    ctx.cleanup();
  });

  it('rejects duplicate and malformed codes', () => {
    const ctx = makeTestDb();
    createCoupon(ctx.db, { code: 'abc123', kind: 'fixed', value: 100 }, ctx.actor);
    expect(() => createCoupon(ctx.db, { code: 'ABC123', kind: 'fixed', value: 100 }, ctx.actor)).toThrow(/আগেই/);
    expect(() => createCoupon(ctx.db, { code: 'ab', kind: 'fixed', value: 100 }, ctx.actor)).toThrow(/৩ অক্ষর/);
    expect(() => createCoupon(ctx.db, { code: 'bad code!', kind: 'fixed', value: 100 }, ctx.actor)).toThrow(/শুধু/);
    expect(listCoupons(ctx.db).total).toBe(1);
    ctx.cleanup();
  });
});

describe('v1.1 gift cards and vouchers', () => {
  it('issues against cash, spends as a tender and keeps the liability exact', () => {
    const ctx = makeTestDb();
    const { rice } = seedProducts(ctx);
    stockUp(ctx.db, rice, 100_000_000, ctx);
    const card = issueGiftCard(ctx.db, { amountPaisa: 100_000, methodId: ctx.cashMethodId, note: 'ঈদ গিফট' }, ctx.actor);
    expect(card.balance_paisa).toBe(100_000);
    expect(giftCardSummary(ctx.db).outstanding_paisa).toBe(100_000);

    const liability = ctx.db
      .prepare(`SELECT SUM(jl.credit_paisa - jl.debit_paisa) AS v FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE a.code='2150'`)
      .get() as any;
    expect(liability.v).toBe(100_000);

    const sale = createSale(ctx.db, {
      lines: [{ productId: rice.id, unitId: ctx.unitKgId, qtyMilli: 2000 }],
      giftCardCode: card.code,
      actor: ctx.actor,
    });
    expect(sale.computation.giftCardApplied).toBe(16_000);
    expect(sale.computation.due).toBe(0);
    const after = getGiftCardByCode(ctx.db, card.code)!;
    expect(after.balance_paisa).toBe(84_000);
    expect(after.status).toBe('active');
    const saleRow = ctx.db.prepare('SELECT gift_card_paisa, paid_paisa FROM sales WHERE id = ?').get(sale.saleId) as any;
    expect(saleRow.gift_card_paisa).toBe(16_000);
    expect(saleRow.paid_paisa).toBe(16_000);
    // No cash tender may exist for a card-only sale.
    expect(cashTenderTotal(ctx.db, ctx.cashMethodId)).toBe(0);
    expect(giftCardTransactions(ctx.db, card.id).length).toBe(2);
    expectCleanBooks(ctx.db);
    ctx.cleanup();
  });

  it('caps the tender at the remaining balance, then marks the card used', () => {
    const ctx = makeTestDb();
    const { soap } = seedProducts(ctx);
    stockUp(ctx.db, soap, 100_000, ctx);
    const card = issueGiftCard(ctx.db, { amountPaisa: 5000, methodId: ctx.cashMethodId }, ctx.actor);
    const buyer = createCustomer(ctx.db, { name: 'নাসিম', phone: '01944444444' }, ctx.actor);
    const sale = createSale(ctx.db, {
      customerId: buyer.id,
      lines: [{ productId: soap.id, unitId: ctx.unitPieceId, qtyMilli: 4000 }],
      giftCardCode: card.code,
      actor: ctx.actor,
    });
    // 4 × 45tk = 180tk bill, card only had 50tk
    expect(sale.computation.giftCardApplied).toBe(5000);
    expect(sale.computation.due).toBe(13_000);
    const used = getGiftCardByCode(ctx.db, card.code)!;
    expect(used.balance_paisa).toBe(0);
    expect(used.status).toBe('used');
    expect(() =>
      createSale(ctx.db, {
        customerId: buyer.id,
        lines: [{ productId: soap.id, unitId: ctx.unitPieceId, qtyMilli: 1000 }],
        giftCardCode: card.code,
        actor: ctx.actor,
      }),
    ).toThrow(/ব্যালেন্স শেষ|কার্ড/);
    ctx.cleanup();
  });

  it('refunds to a card, adjusts with a reason, voids with accounting and expires on time', () => {
    const ctx = makeTestDb();
    const card = issueGiftCard(ctx.db, { amountPaisa: 20_000, methodId: ctx.cashMethodId }, ctx.actor);
    const refunded = refundToGiftCard(ctx.db, { cardId: card.id, amountPaisa: 3000, note: 'ফেরত' });
    expect(refunded.balance_paisa).toBe(23_000);
    const adjusted = adjustGiftCard(ctx.db, { cardId: card.id, deltaPaisa: -3000, reason: 'ভুল ইস্যু', userId: ctx.actor.id });
    expect(adjusted.balance_paisa).toBe(20_000);
    expect(() => adjustGiftCard(ctx.db, { cardId: card.id, deltaPaisa: -99_999, reason: 'x', userId: ctx.actor.id })).toThrow(/ঋণাত্মক/);
    expect(() => adjustGiftCard(ctx.db, { cardId: card.id, deltaPaisa: 100, reason: '  ', userId: ctx.actor.id })).toThrow(/কারণ/);

    const voided = voidGiftCard(ctx.db, { cardId: card.id, reason: 'হারানো', actor: ctx.actor });
    expect(voided.status).toBe('void');
    expect(voided.balance_paisa).toBe(0);
    expect(checkGiftCard(ctx.db, { code: card.code, amountPaisa: 1000 }).ok).toBe(false);
    const liability = ctx.db
      .prepare(`SELECT SUM(jl.credit_paisa - jl.debit_paisa) AS v FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE a.code='2150'`)
      .get() as any;
    expect(liability.v).toBe(0);
    expectCleanBooks(ctx.db);

    const expiring = issueGiftCard(ctx.db, { amountPaisa: 1000, methodId: ctx.cashMethodId, expiresAt: '2000-01-01 00:00:00' }, ctx.actor);
    expect(expireGiftCards(ctx.db)).toBe(1);
    expect((ctx.db.prepare('SELECT status FROM gift_cards WHERE id = ?').get(expiring.id) as any).status).toBe('expired');
    ctx.cleanup();
  });

  it('issues vouchers as single-use stored value with their own prefix', () => {
    const ctx = makeTestDb();
    const voucher = issueGiftCard(ctx.db, { amountPaisa: 25_000, kind: 'voucher', note: 'প্রোমো ভাউচার' }, ctx.actor);
    expect(voucher.code.startsWith('VC-')).toBe(true);
    expect(voucher.kind).toBe('voucher');
    // A complimentary voucher is an expense, never free money.
    const bs = balanceSheet(ctx.db, '2999-12-31');
    expect(bs.balanced).toBe(true);
    expect(voucher.balance_paisa).toBe(25_000);
    expectCleanBooks(ctx.db);
    ctx.cleanup();
  });
});
