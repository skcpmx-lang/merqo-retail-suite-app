/**
 * Cross-module invariants.
 *
 * Every other test checks one module in isolation. These check the promises that
 * span modules, because that is where a retail system actually breaks:
 *
 *   - the ledger always balances and always agrees with the operational tables;
 *   - returning goods never loses money, stock or points;
 *   - voiding an invoice undoes *everything* it did (stock, cash, stored value,
 *     loyalty, journal);
 *   - the balance sheet balances after every kind of document;
 *   - reports agree with the tables they claim to summarise.
 *
 * A failure here is a data-integrity bug, not a style issue.
 */
import { describe, expect, it } from 'vitest';
import {
  balanceSheet,
  cashInHandPaisa,
  createBackup,
  checkGiftCard,
  closeCashSession,
  createExchange,
  createExpense,
  createPurchase,
  createPurchaseOrder,
  createPurchaseReturn,
  createSale,
  createSaleReturn,
  earnLoyaltyForSale,
  getCustomer,
  getGiftCardByCode,
  getProduct,
  getPurchase,
  getSale,
  getSettings,
  giftCardSummary,
  issueGiftCard,
  profitAndLoss,
  reconcile,
  redeemLoyalty,
  receivePurchaseOrder,
  openDatabase,
  restoreBackup,
  runReport,
  trialBalance,
  unbalancedEntries,
  updateSettings,
  verifyLicense,
  voidSale,
} from '@sauda/core';
import { ensureSettings, makeTestDb, seedProducts } from './helpers.js';

const RANGE_ALL = { from: '2000-01-01', to: '2999-12-31' };

function assertLedgerHealthy(db: Parameters<typeof reconcile>[0]) {
  expect(unbalancedEntries(db)).toEqual([]);
  const checks = reconcile(db);
  const broken = checks.filter((c) => !c.ok);
  expect(broken, `reconciliation broke: ${JSON.stringify(broken)}`).toEqual([]);
  const trial = trialBalance(db);
  expect(trial.rows.reduce((s, r) => s + r.debit, 0)).toBe(trial.rows.reduce((s, r) => s + r.credit, 0));
  const sheet = balanceSheet(db, '2999-12-31');
  expect(sheet.balanced, `balance sheet off by ${sheet.difference}`).toBe(true);
  return checks;
}

describe('stock and money stay consistent through a mixed day', () => {
  it('purchase → sale → returns → expense → cash close keeps every invariant', () => {
    const ctx = makeTestDb();
    const { rice, soap, supplier, customer } = seedProducts(ctx);

    const purchase = createPurchase(ctx.db, {
      supplierId: supplier.id,
      lines: [
        { productId: rice.id, unitId: ctx.unitKgId, qtyMilli: 100_000, unitPricePaisa: 7000 },
        { productId: soap.id, unitId: ctx.unitPieceId, qtyMilli: 20_000, unitPricePaisa: 3000 },
      ],
      paidPaisa: 370_000,
      defaultMethodId: ctx.cashMethodId,
      actor: ctx.actor,
    });
    expect(purchase.computation.total).toBe(760_000);
    expect(purchase.computation.due).toBe(390_000);

    const sale = createSale(ctx.db, {
      customerId: customer.id,
      lines: [
        { productId: rice.id, unitId: ctx.unitKgId, qtyMilli: 3000 },
        { productId: soap.id, unitId: ctx.unitPieceId, qtyMilli: 2000 },
      ],
      orderDiscountType: 'percent',
      orderDiscountValue: 500,
      payments: [
        { methodId: ctx.cashMethodId, amount: 10_000 },
        { methodId: ctx.bkashMethodId, amount: 5000 },
      ],
      actor: ctx.actor,
    });
    const fullSale = getSale(ctx.db, sale.saleId)!;
    expect(fullSale.due_paisa).toBe(16_350);
    expect(getCustomer(ctx.db, customer.id)!.balance_paisa).toBe(16_350);

    // Returning part of an unpaid invoice reduces the due — it must be reported
    // as such (this used to report 0 while the books moved 8,000).
    const saleReturn = createSaleReturn(ctx.db, {
      saleId: sale.saleId,
      items: [{ lineId: fullSale.items[0].id, qtyMilli: 1000, condition: 'good' }],
      refundMethodId: ctx.cashMethodId,
      actor: ctx.actor,
    });
    expect(saleReturn.total).toBe(8000);
    expect(saleReturn.refund).toBe(0);
    expect(saleReturn.appliedToDue).toBe(8000);
    expect(getCustomer(ctx.db, customer.id)!.balance_paisa).toBe(8_350);

    const fullPurchase = getPurchase(ctx.db, purchase.purchaseId)!;
    const purchaseReturn = createPurchaseReturn(ctx.db, {
      purchaseId: purchase.purchaseId,
      items: [{ lineId: fullPurchase.items[0].id, qtyMilli: 5000, condition: 'good' }],
      refundMethodId: ctx.cashMethodId,
      actor: ctx.actor,
    });
    expect(purchaseReturn.total).toBe(35_000);
    expect(purchaseReturn.appliedToDue).toBe(35_000);
    expect(purchaseReturn.refund).toBe(0);

    createExpense(
      ctx.db,
      { categoryId: null, amountPaisa: 5000, description: 'চা', methodId: ctx.cashMethodId, expenseDate: undefined },
      ctx.actor,
    );

    // Stock: 100kg − 3kg (sold) + 1kg (returned) − 5kg (purchase return) = 93kg
    expect(getProduct(ctx.db, rice.id)!.stock_base_milli).toBe(93_000_000);
    // 20 pcs − 2 sold = 18
    expect(getProduct(ctx.db, soap.id)!.stock_base_milli).toBe(18_000);

    assertLedgerHealthy(ctx.db);
    ctx.cleanup();
  });

  it('a partial purchase order receive posts stock and payable once, and only once', () => {
    const ctx = makeTestDb();
    const { rice, supplier } = seedProducts(ctx);

    const po = createPurchaseOrder(ctx.db, {
      supplierId: supplier.id,
      lines: [{ productId: rice.id, unitId: ctx.unitKgId, qtyMilli: 50_000, unitCostPaisa: 7200 }],
      actor: ctx.actor,
    });
    const first = receivePurchaseOrder(ctx.db, {
      poId: po.id,
      items: [{ poItemId: po.items![0].id, qtyMilli: 20_000 }],
      paidPaisa: 0,
      actor: ctx.actor,
    });
    expect(first.status).toBe('partial');
    expect(first.remainingItems).toBe(1);

    const second = receivePurchaseOrder(ctx.db, {
      poId: po.id,
      items: [{ poItemId: po.items![0].id, qtyMilli: 30_000 }],
      paidPaisa: 0,
      actor: ctx.actor,
    });
    expect(second.status).toBe('received');
    expect(second.purchaseId).not.toBe(first.purchaseId);

    expect(getProduct(ctx.db, rice.id)!.stock_base_milli).toBe(50_000_000);
    // 50kg × 72.00 = 3,600.00
    expect(getSupplierBalance(ctx.db, supplier.id)).toBe(360_000);
    expect(() =>
      receivePurchaseOrder(ctx.db, {
        poId: po.id,
        items: [{ poItemId: po.items![0].id, qtyMilli: 1000 }],
        actor: ctx.actor,
      }),
    ).toThrow(/আগেই গ্রহণ/);
    assertLedgerHealthy(ctx.db);
    ctx.cleanup();
  });
});

describe('voiding an invoice undoes everything it did', () => {
  it('restores stock, cash, gift-card value and redeemed loyalty points', () => {
    const ctx = makeTestDb();
    const { rice, customer } = seedProducts(ctx);
    ensureSettings(ctx.db, {
      loyalty_enabled: 1,
      loyalty_points_per_100: 2,
      loyalty_min_redeem_points: 1,
      loyalty_redeem_value_paisa: 100,
    });
    createPurchase(ctx.db, {
      supplierId: null,
      lines: [{ productId: rice.id, unitId: ctx.unitKgId, qtyMilli: 10_000, unitPricePaisa: 7000 }],
      paidPaisa: 70_000,
      defaultMethodId: ctx.cashMethodId,
      actor: ctx.actor,
    });

    const card = issueGiftCard(
      ctx.db,
      { amountPaisa: 50_000, methodId: ctx.cashMethodId, code: 'GC-VOID-1' },
      ctx.actor,
    );
    // Seed loyalty points the customer can spend.
    const seedSale = createSale(ctx.db, {
      customerId: customer.id,
      lines: [{ productId: rice.id, unitId: ctx.unitKgId, qtyMilli: 2000 }],
      paidPaisa: 16_000,
      defaultMethodId: ctx.cashMethodId,
      actor: ctx.actor,
    });
    earnLoyaltyForSale(ctx.db, seedSale.saleId, ctx.actor);
    const pointsBefore = getCustomer(ctx.db, customer.id)!.loyalty_points;

    const sale = createSale(ctx.db, {
      customerId: customer.id,
      lines: [{ productId: rice.id, unitId: ctx.unitKgId, qtyMilli: 3000 }],
      giftCardCode: 'GC-VOID-1',
      actor: ctx.actor,
    });
    expect(sale.computation.giftCardApplied).toBe(24_000);
    const pointsAfterSale = getCustomer(ctx.db, customer.id)!.loyalty_points;
    expect(pointsAfterSale).toBeGreaterThanOrEqual(pointsBefore);

    // Spend some of the points on a third invoice, then void *that* invoice.
    const redeemed = redeemLoyalty(ctx.db, {
      customerId: customer.id,
      points: Math.min(2, pointsAfterSale),
      actor: ctx.actor,
    });
    expect(redeemed.points).toBeGreaterThan(0);
    const pointsAfterRedeem = getCustomer(ctx.db, customer.id)!.loyalty_points;
    const redeemSale = createSale(ctx.db, {
      customerId: customer.id,
      lines: [{ productId: rice.id, unitId: ctx.unitKgId, qtyMilli: 1000 }],
      paidPaisa: 8000,
      defaultMethodId: ctx.cashMethodId,
      actor: ctx.actor,
    });
    // Link the redemption and the earning to the same invoice, exactly how POS does it.
    ctx.db
      .prepare("UPDATE loyalty_ledger SET ref_type = 'sale', ref_id = ? WHERE type = 'redeem' AND customer_id = ? AND ref_id IS NULL")
      .run(redeemSale.saleId, customer.id);
    earnLoyaltyForSale(ctx.db, redeemSale.saleId, ctx.actor);
    const pointsAtVoid = getCustomer(ctx.db, customer.id)!.loyalty_points;

    const stockAtVoid = getProduct(ctx.db, rice.id)!.stock_base_milli;
    const cashAtVoid = cashInHandPaisa(ctx.db);
    const cardAtVoid = getGiftCardByCode(ctx.db, 'GC-VOID-1')!.balance_paisa;

    voidSale(ctx.db, redeemSale.saleId, 'ভুল ইনভয়েস', ctx.actor);

    // Stock and cash come back.
    expect(getProduct(ctx.db, rice.id)!.stock_base_milli).toBe(stockAtVoid + 1_000_000);
    expect(cashInHandPaisa(ctx.db)).toBe(cashAtVoid - 8000);
    // Points: the earn is taken back and the redemption is handed back.
    expect(getCustomer(ctx.db, customer.id)!.loyalty_points).toBeGreaterThan(pointsAtVoid);

    // Now void the gift-card sale: the card must be whole again.
    voidSale(ctx.db, sale.saleId, 'বাতিল', ctx.actor);
    expect(getGiftCardByCode(ctx.db, 'GC-VOID-1')!.balance_paisa).toBe(cardAtVoid + 24_000);
    expect(card.balance_paisa).toBe(50_000);
    // ...and the card is usable again at its full value.
    expect(checkGiftCard(ctx.db, { code: 'GC-VOID-1', amountPaisa: 10_000 }).ok).toBe(true);

    assertLedgerHealthy(ctx.db);
    ctx.cleanup();
  });

  it('a vaulted gift card is never resurrected by a void', () => {
    const ctx = makeTestDb();
    const { rice, customer } = seedProducts(ctx);
    createPurchase(ctx.db, {
      supplierId: null,
      lines: [{ productId: rice.id, unitId: ctx.unitKgId, qtyMilli: 10_000, unitPricePaisa: 7000 }],
      paidPaisa: 70_000,
      defaultMethodId: ctx.cashMethodId,
      actor: ctx.actor,
    });
    issueGiftCard(ctx.db, { amountPaisa: 20_000, methodId: ctx.cashMethodId, code: 'GC-DEAD-1' }, ctx.actor);
    const sale = createSale(ctx.db, {
      customerId: customer.id,
      lines: [{ productId: rice.id, unitId: ctx.unitKgId, qtyMilli: 1000 }],
      giftCardCode: 'GC-DEAD-1',
      actor: ctx.actor,
    });
    ctx.db.prepare("UPDATE gift_cards SET status = 'void' WHERE code = 'GC-DEAD-1'").run();
    voidSale(ctx.db, sale.saleId, 'বাতিল', ctx.actor);
    const card = getGiftCardByCode(ctx.db, 'GC-DEAD-1')!;
    expect(card.status).toBe('void');
    // The unspent 12,000 stays frozen on the voided card: a void must not add
    // money to a card the operator deliberately closed.
    expect(card.balance_paisa).toBe(12_000);
    ctx.cleanup();
  });
});

describe('cash session close', () => {
  it('reports the expected drawer and the difference it actually found', () => {
    const ctx = makeTestDb();
    const { rice, customer } = seedProducts(ctx);
    createPurchase(ctx.db, {
      supplierId: null,
      lines: [{ productId: rice.id, unitId: ctx.unitKgId, qtyMilli: 5000, unitPricePaisa: 7000 }],
      payments: [{ methodId: ctx.bkashMethodId, amount: 35_000 }],
      actor: ctx.actor,
    });
    createSale(ctx.db, {
      customerId: customer.id,
      lines: [{ productId: rice.id, unitId: ctx.unitKgId, qtyMilli: 1000 }],
      paidPaisa: 8000,
      defaultMethodId: ctx.cashMethodId,
      actor: ctx.actor,
    });
    const closed = closeCashSession(ctx.db, { userId: ctx.actor.id, countedCash: 7900, actor: ctx.actor });
    expect(closed.expected_cash_paisa).toBe(8000);
    expect(closed.difference_paisa).toBe(-100);
    ctx.cleanup();
  });
});

describe('an exchange is a return and a sale that never lose money', () => {
  it('moves the customer balance by exactly the difference and keeps the drawer untouched', () => {
    const ctx = makeTestDb();
    const { rice, soap, supplier, customer } = seedProducts(ctx);
    createPurchase(ctx.db, {
      supplierId: supplier.id,
      lines: [
        { productId: rice.id, unitId: ctx.unitKgId, qtyMilli: 20_000, unitPricePaisa: 7000 },
        { productId: soap.id, unitId: ctx.unitPieceId, qtyMilli: 20_000, unitPricePaisa: 3000 },
      ],
      paidPaisa: 200_000,
      defaultMethodId: ctx.cashMethodId,
      actor: ctx.actor,
    });
    const sale = createSale(ctx.db, {
      customerId: customer.id,
      lines: [
        { productId: rice.id, unitId: ctx.unitKgId, qtyMilli: 2000 },
        { productId: soap.id, unitId: ctx.unitPieceId, qtyMilli: 2000 },
      ],
      actor: ctx.actor,
    });
    const dueAfterSale = getCustomer(ctx.db, customer.id)!.balance_paisa;
    expect(dueAfterSale).toBe(sale.computation.total);
    const cashAfterSale = cashInHandPaisa(ctx.db);
    const riceStock = getProduct(ctx.db, rice.id)!.stock_base_milli;

    const persisted = getSale(ctx.db, sale.saleId)!;
    const riceLine = persisted.items!.find((l) => l.product_id === rice.id)!;
    const ex = createExchange(ctx.db, {
      saleId: sale.saleId,
      returnItems: [{ lineId: riceLine.id, qtyMilli: 1000, condition: 'good' as const }],
      newLines: [{ productId: soap.id, unitId: ctx.unitPieceId, qtyMilli: 4000 }],
      customerId: customer.id,
      actor: ctx.actor,
    });

    // The new bill took over the returned value: the account moved by the net only.
    const expected = dueAfterSale - ex.returnedTotal + ex.newTotal;
    expect(getCustomer(ctx.db, customer.id)!.balance_paisa).toBe(expected);
    expect(ex.differencePaisa).toBe(Math.max(0, ex.newTotal - ex.returnedTotal));
    // No cash moved for a credit customer, and the returned rice came back into stock.
    expect(cashInHandPaisa(ctx.db)).toBe(cashAfterSale);
    // 1.000 kg back in stock = 1_000_000 base-milli (kg is the base unit here).
    expect(getProduct(ctx.db, rice.id)!.stock_base_milli).toBe(riceStock + 1_000_000);
    assertLedgerHealthy(ctx.db);

    const report = runReport(ctx.db, 'exchange_report', RANGE_ALL);
    expect(report.rows.length).toBeGreaterThan(0);
    ctx.cleanup();
  });
});

describe('reports agree with the tables they summarise', () => {
  it('sales, dues, stock value and profit reconcile after a mixed day', () => {
    const ctx = makeTestDb();
    const { rice, soap, supplier, customer } = seedProducts(ctx);
    createPurchase(ctx.db, {
      supplierId: supplier.id,
      lines: [
        { productId: rice.id, unitId: ctx.unitKgId, qtyMilli: 50_000, unitPricePaisa: 7000 },
        { productId: soap.id, unitId: ctx.unitPieceId, qtyMilli: 10_000, unitPricePaisa: 3000 },
      ],
      paidPaisa: 100_000,
      defaultMethodId: ctx.cashMethodId,
      actor: ctx.actor,
    });
    createSale(ctx.db, {
      customerId: customer.id,
      lines: [
        { productId: rice.id, unitId: ctx.unitKgId, qtyMilli: 2000 },
        { productId: soap.id, unitId: ctx.unitPieceId, qtyMilli: 3000 },
      ],
      payments: [{ methodId: ctx.cashMethodId, amount: 10_000 }],
      actor: ctx.actor,
    });

    const due = runReport(ctx.db, 'customer_due', {});
    const dueSum = due.rows.reduce((s, r) => s + Number(r.due ?? 0), 0);
    expect(dueSum).toBe(getCustomer(ctx.db, customer.id)!.balance_paisa);

    const stock = runReport(ctx.db, 'stock_valuation', {});
    const stockValue = stock.rows.reduce((s, r) => s + Number(r.stock_value ?? 0), 0);
    const fromProducts = ctx.db
      .prepare('SELECT COALESCE(SUM(stock_base_milli * avg_cost_micro / 1000000000),0) v FROM products WHERE is_active = 1')
      .get() as { v: number };
    expect(Math.abs(stockValue - fromProducts.v)).toBeLessThanOrEqual(2);

    const pl = profitAndLoss(ctx.db, RANGE_ALL);
    const report = runReport(ctx.db, 'profit_loss', RANGE_ALL);
    expect(report.totals.amount).toBe(pl.netProfit);

    const trial = runReport(ctx.db, 'trial_balance', RANGE_ALL);
    expect(trial.totals.debit).toBe(trial.totals.credit);
    ctx.cleanup();
  });
});

describe('backup and restore protect customer data', () => {
  it('a restored snapshot comes back with an intact ledger and no lost money', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const ctx = makeTestDb({ file: true });
    const { rice, supplier, customer } = seedProducts(ctx);

    createPurchase(ctx.db, {
      supplierId: supplier.id,
      lines: [{ productId: rice.id, unitId: ctx.unitKgId, qtyMilli: 20_000, unitPricePaisa: 7000 }],
      paidPaisa: 140_000,
      defaultMethodId: ctx.cashMethodId,
      actor: ctx.actor,
    });
    const kept = createSale(ctx.db, {
      customerId: customer.id,
      lines: [{ productId: rice.id, unitId: ctx.unitKgId, qtyMilli: 3000 }],
      paidPaisa: 10_000,
      defaultMethodId: ctx.cashMethodId,
      actor: ctx.actor,
    });

    const cashBefore = cashInHandPaisa(ctx.db);
    const trialBefore = trialBalance(ctx.db);
    const dueBefore = getCustomer(ctx.db, customer.id)!.balance_paisa;
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-bak-'));
    const snapshot = createBackup(ctx.db, { dataDir: backupDir, appVersion: '1.1.2' });

    // Trading continues after the snapshot: a sale and an expense the restore must drop.
    createSale(ctx.db, {
      customerId: customer.id,
      lines: [{ productId: rice.id, unitId: ctx.unitKgId, qtyMilli: 1000 }],
      paidPaisa: 8000,
      defaultMethodId: ctx.cashMethodId,
      actor: ctx.actor,
    });
    expect(cashInHandPaisa(ctx.db)).not.toBe(cashBefore);

    const safetyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-safety-'));
    const result = restoreBackup(ctx.db, {
      backupPath: snapshot.filePath,
      dataDir: safetyDir,
      livePath: ctx.dbPath,
      appVersion: '1.1.2',
      actor: ctx.actor,
    });
    expect(fs.existsSync(result.safetyBackup)).toBe(true);
    expect(result.restored.ok).toBe(true);

    const db = openDatabase({ file: ctx.dbPath, appVersion: '1.1.2' });
    try {
      // The snapshot state is back, exactly once — not merged with later trading.
      expect(getSale(db, kept.saleId)).toBeTruthy();
      const sales = db.prepare('SELECT COUNT(*) c FROM sales').get() as { c: number };
      expect(sales.c).toBe(1);
      expect(cashInHandPaisa(db)).toBe(cashBefore);
      expect(getCustomer(db, customer.id)!.balance_paisa).toBe(dueBefore);
      const trialAfter = trialBalance(db);
      expect(trialAfter.rows.reduce((s, r) => s + r.debit, 0)).toBe(
        trialBefore.rows.reduce((s, r) => s + r.debit, 0),
      );
      assertLedgerHealthy(db);
      const integrity = db.pragma('integrity_check', { simple: true });
      expect(String(integrity).toLowerCase()).toBe('ok');
    } finally {
      db.close();
      fs.rmSync(backupDir, { recursive: true, force: true });
      fs.rmSync(safetyDir, { recursive: true, force: true });
    }
    ctx.cleanup();
  });
});

describe('license gate cannot be bypassed by the renderer', () => {
  it('returns not_activated for a database with no activation row', async () => {
    const ctx = makeTestDb();
    const { activate, getActivationState } = await import('@sauda/core');
    expect(getActivationState(ctx.db).activated).toBe(false);
    const bogus = await activate(ctx.db, { key: 'SAUDA1.eyJ4IjoxfQ==.AAAA' });
    expect(bogus.activated).toBe(false);
    expect(verifyLicense).toBeTypeOf('function');
    ctx.cleanup();
  });
});

function getSupplierBalance(db: Parameters<typeof reconcile>[0], id: number): number {
  const row = db.prepare('SELECT balance_paisa v FROM suppliers WHERE id = ?').get(id) as { v: number };
  return row.v;
}
