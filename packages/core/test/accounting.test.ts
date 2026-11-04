import { afterAll, describe, expect, it } from 'vitest';
import {
  ACCOUNT_CODES,
  balanceSheet,
  cashBook,
  createCustomer,
  createExpense,
  createProduct,
  createPurchase,
  createSale,
  createSupplier,
  generalLedger,
  getAccountByCode,
  getProduct,
  getSettings,
  journalEntries,
  listExpenseCategories,
  paySupplier,
  profitAndLoss,
  receiveCustomerPayment,
  reconcile,
  trialBalance,
  unbalancedEntries,
  voidSale,
  createSaleReturn,
  postSale,
  addCashMovement,
  listAccounts,
  createAccount,
  updateAccount,
  updateSettings,
  voidExpense,
  type Db,
} from '../src/index.js';
import { makeTestDb, type TestContext } from './helpers.js';

const contexts: TestContext[] = [];
afterAll(() => {
  for (const c of contexts) c.cleanup();
});

function ctx(): TestContext {
  const c = makeTestDb();
  contexts.push(c);
  return c;
}

interface Scenario {
  c: TestContext;
  riceId: number;
  soapId: number;
  customerId: number;
  supplierId: number;
  day: string;
}

/** A realistic trading day that exercises every posting rule at once. */
function tradeDay(c: TestContext): Scenario {
  const db = c.db;
  const day = '2026-02-10';
  const supplier = createSupplier(db, { name: 'রহমান ট্রেডার্স' }, c.actor);
  const customer = createCustomer(db, { name: 'করিম স্টোর', phone: '01711111111' }, c.actor);
  const rice = createProduct(
    db,
    { name: 'মিনিকেট চাল', unitId: c.unitKgId, salePrice: 8000, purchasePrice: 7000, openingStockMilli: 50_000_000, openingCostMicro: 7_000_000 },
    c.actor,
  );
  const soap = createProduct(db, { name: 'সাবান', unitId: c.unitPieceId, salePrice: 4500, purchasePrice: 3000 }, c.actor);

  // purchase on credit, then part payment
  createPurchase(db, {
    supplierId: supplier.id,
    lines: [{ productId: soap.id, unitId: c.unitPieceId, qtyMilli: 50_000, unitPricePaisa: 3000 }],
    paidPaisa: 50_000,
    defaultMethodId: c.cashMethodId,
    purchaseDate: `${day} 10:00:00`,
    actor: c.actor,
  });
  // cash sale
  createSale(db, {
    lines: [{ productId: rice.id, unitId: c.unitKgId, qtyMilli: 2000, unitPricePaisa: 8000 }],
    payments: [{ methodId: c.cashMethodId, amount: 16000 }],
    saleDate: `${day} 11:00:00`,
    actor: c.actor,
  });
  // credit sale
  createSale(db, {
    customerId: customer.id,
    lines: [{ productId: soap.id, unitId: c.unitPieceId, qtyMilli: 10_000, unitPricePaisa: 4500 }],
    paidPaisa: 10_000,
    defaultMethodId: c.cashMethodId,
    saleDate: `${day} 12:00:00`,
    actor: c.actor,
  });
  // collect part of the due
  receiveCustomerPayment(db, { customerId: customer.id, amount: 20_000, methodId: c.cashMethodId }, c.actor);
  // expense
  const cat = listExpenseCategories(db)[0]!;
  createExpense(
    db,
    { categoryId: cat.id, amountPaisa: 1500, methodId: c.cashMethodId, description: 'দোকান ভাড়া', expenseDate: `${day} 13:00:00` },
    c.actor,
  );
  // pay the supplier
  paySupplier(db, { supplierId: supplier.id, amount: 40_000, methodId: c.cashMethodId }, c.actor);
  // owner puts cash in
  addCashMovement(db, { userId: c.actor.id, direction: 'in', amount: 5000, source: 'manual_in', note: 'মালিকের পুঁজি' });

  return { c, riceId: rice.id, soapId: soap.id, customerId: customer.id, supplierId: supplier.id, day };
}

describe('accounting — posting integrity', () => {
  it('posts one balanced entry per document and never a duplicate', () => {
    const s = tradeDay(ctx());
    const db = s.c.db;
    expect(unbalancedEntries(db)).toEqual([]);
    const tb = trialBalance(db);
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit).toBe(tb.totalCredit);
    expect(tb.totalDebit).toBeGreaterThan(0);

    // one entry per sale, purchase, payment, expense, cash movement, opening stock
    const entries = journalEntries(db, { limit: 500 });
    const sources = entries.map((e) => e.source);
    expect(sources).toContain('sale');
    expect(sources).toContain('purchase');
    expect(sources).toContain('payment_in');
    expect(sources).toContain('payment_out');
    expect(sources).toContain('expense');
    expect(sources).toContain('cash_in');
    expect(sources).toContain('opening_stock');

    const sale = db.prepare("SELECT id FROM sales WHERE customer_id IS NULL LIMIT 1").get() as { id: number };
    expect(() => postSale(db, sale.id, { idempotent: false })).toThrow(/আগেই পোস্ট/);
  });

  it('every sale entry uses the right accounts and amounts', () => {
    const s = tradeDay(ctx());
    const db = s.c.db;
    const saleRow = db
      .prepare('SELECT * FROM sales WHERE customer_id IS NOT NULL LIMIT 1')
      .get() as { id: number; subtotal_paisa: number; total_paisa: number; paid_paisa: number; due_paisa: number; cost_total_paisa: number };
    const entry = db.prepare("SELECT * FROM journal_entries WHERE source = 'sale' AND source_id = ?").get(saleRow.id) as {
      id: number;
    };
    const lines = db
      .prepare('SELECT a.code, l.debit_paisa, l.credit_paisa FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = ?')
      .all(entry.id) as { code: string; debit_paisa: number; credit_paisa: number }[];
    const byCode = (code: string) =>
      lines.filter((l) => l.code === code).reduce((acc, l) => ({ debit: acc.debit + l.debit_paisa, credit: acc.credit + l.credit_paisa }), { debit: 0, credit: 0 });

    expect(byCode(ACCOUNT_CODES.revenue).credit).toBe(saleRow.subtotal_paisa);
    expect(byCode(ACCOUNT_CODES.receivable).debit).toBe(saleRow.due_paisa);
    expect(byCode(ACCOUNT_CODES.cash).debit).toBe(saleRow.paid_paisa);
    expect(byCode(ACCOUNT_CODES.cogs).debit).toBe(saleRow.cost_total_paisa);
    expect(byCode(ACCOUNT_CODES.inventory).credit).toBe(saleRow.cost_total_paisa);
  });

  it('reconciles ledger totals with the operational tables', () => {
    const s = tradeDay(ctx());
    const results = reconcile(s.c.db);
    for (const r of results) {
      expect(r, `${r.check}: ledger ${r.ledger} vs operational ${r.operational}`).toMatchObject({ ok: true });
    }
  });

  it('profit & loss agrees with the operational profit calculation', () => {
    const s = tradeDay(ctx());
    const db = s.c.db;
    const pl = profitAndLoss(db, { from: '2026-02-01 00:00:00', to: '2026-02-28 23:59:59' });
    const op = db
      .prepare(
        `SELECT COALESCE(SUM(total_paisa - tax_paisa - cost_total_paisa),0) AS gross
         FROM sales WHERE status <> 'voided' AND sale_date >= ? AND sale_date <= ?`,
      )
      .get('2026-02-01 00:00:00', '2026-02-28 23:59:59') as { gross: number };
    const expenses = db
      .prepare(`SELECT COALESCE(SUM(amount_paisa),0) AS v FROM expenses WHERE status = 'active'`)
      .get() as { v: number };
    expect(pl.grossProfit).toBe(op.gross);
    expect(pl.netProfit).toBe(op.gross - expenses.v);
    expect(pl.totalIncome - pl.totalExpense).toBe(pl.netProfit);
  });

  it('the balance sheet balances to the poisa', () => {
    const s = tradeDay(ctx());
    const bs = balanceSheet(s.c.db, '2026-12-31 23:59:59');
    expect(bs.difference).toBe(0);
    expect(bs.balanced).toBe(true);
    expect(bs.totalAssets).toBe(bs.totalLiabilities + bs.totalEquity);
  });

  it('cash book closing figures match the cash ledger account', () => {
    const s = tradeDay(ctx());
    const db = s.c.db;
    const book = cashBook(db, { from: '2026-02-01 00:00:00', to: '2026-02-28 23:59:59' });
    const cashAccount = getAccountByCode(db, ACCOUNT_CODES.cash);
    const ledger = generalLedger(db, cashAccount.id, { from: '2026-02-01 00:00:00', to: '2026-02-28 23:59:59' });
    const cashRow = book.accounts.find((a) => a.code === ACCOUNT_CODES.cash)!;
    expect(cashRow.closing).toBe(ledger.closing);
    expect(cashRow.in - cashRow.out).toBe(cashRow.closing - cashRow.opening);
    expect(book.total.closing).toBe(book.total.opening + book.total.in - book.total.out);
  });
});

describe('accounting — corrections', () => {
  it('voiding a sale posts a reversing entry instead of editing history', () => {
    const c = ctx();
    const product = createProduct(c.db, { name: 'চা', unitId: c.unitPieceId, salePrice: 5000, openingStockMilli: 10_000, openingCostMicro: 3_000_000 }, c.actor);
    const sale = createSale(c.db, {
      lines: [{ productId: product.id, unitId: c.unitPieceId, qtyMilli: 2000, unitPricePaisa: 5000 }],
      payments: [{ methodId: c.cashMethodId, amount: 10000 }],
      actor: c.actor,
    });
    const before = trialBalance(c.db);
    voidSale(c.db, sale.saleId, 'ভুল এন্ট্রি', c.actor);
    const after = trialBalance(c.db);

    const entries = journalEntries(c.db, { limit: 50 });
    const reversal = entries.find((e) => e.source === 'sale_void');
    expect(reversal).toBeTruthy();
    expect(reversal!.status).toBe('posted');

    // Revenue and COGS net to zero again; only the reversal rows remain.
    const rev = after.rows.find((r) => r.code === ACCOUNT_CODES.revenue)!;
    expect(rev.balance).toBe(0);
    const cogs = after.rows.find((r) => r.code === ACCOUNT_CODES.cogs);
    expect(cogs?.balance ?? 0).toBe(0);
    expect(after.balanced).toBe(true);
    expect(before.balanced).toBe(true);
  });

  it('a sale return reduces revenue and restores inventory value', () => {
    const c = ctx();
    const product = createProduct(c.db, { name: 'বিস্কুট', unitId: c.unitPieceId, salePrice: 6000, openingStockMilli: 20_000, openingCostMicro: 4_000_000_000 }, c.actor);
    const sale = createSale(c.db, {
      lines: [{ productId: product.id, unitId: c.unitPieceId, qtyMilli: 4000, unitPricePaisa: 6000 }],
      payments: [{ methodId: c.cashMethodId, amount: 24000 }],
      actor: c.actor,
    });
    const saleDetail = c.db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').get(sale.saleId) as { id: number };
    createSaleReturn(c.db, {
      saleId: sale.saleId,
      items: [{ lineId: saleDetail.id, qtyMilli: 1000, condition: 'good' }],
      refundMethodId: c.cashMethodId,
      actor: c.actor,
    });

    const pl = profitAndLoss(c.db, { from: '0000-01-01 00:00:00', to: '9999-12-31 23:59:59' });
    const returnsAccount = trialBalance(c.db).rows.find((r) => r.code === ACCOUNT_CODES.salesReturns)!;
    expect(returnsAccount.debit).toBe(6000);
    // 24 000 revenue − 6 000 return − (4 × 4 000) COGS + 4 000 back into stock
    expect(pl.netProfit).toBe(6000);
    expect(reconcile(c.db).every((r) => r.ok)).toBe(true);
  });

  it('an expense void reverses its entry and leaves the books balanced', () => {
    const c = ctx();
    const cat = listExpenseCategories(c.db)[0]!;
    const expense = createExpense(c.db, { categoryId: cat.id, amountPaisa: 2500, methodId: c.cashMethodId, description: 'পরিবহন', expenseDate: '2026-03-01 10:00:00' }, c.actor);
    const afterCreate = profitAndLoss(c.db, { from: '0000-01-01 00:00:00', to: '9999-12-31 23:59:59' });
    expect(afterCreate.totalExpense).toBe(2500);
    voidExpense(c.db, expense.id, 'ভুল এন্ট্রি', c.actor);
    const afterVoid = profitAndLoss(c.db, { from: '0000-01-01 00:00:00', to: '9999-12-31 23:59:59' });
    expect(afterVoid.totalExpense).toBe(0);
    expect(trialBalance(c.db).balanced).toBe(true);
  });
});

describe('accounting — chart of accounts', () => {
  it('seeds a usable system chart and allows custom accounts', () => {
    const c = ctx();
    const accounts = listAccounts(c.db);
    expect(accounts.length).toBeGreaterThanOrEqual(20);
    for (const code of ['1000', '1010', '1100', '1200', '2000', '3000', '4000', '5000']) {
      expect(accounts.map((a) => a.code)).toContain(code);
    }
    const created = createAccount(c.db, { code: '5400', name: 'Marketing', type: 'expense' }, c.actor);
    expect(created.code).toBe('5400');
    expect(() => createAccount(c.db, { code: '5400', name: 'Duplicate', type: 'expense' }, c.actor)).toThrow();
    const updated = updateAccount(c.db, created.id, { name: 'বিজ্ঞাপন', isActive: false }, c.actor);
    expect(updated.name).toBe('বিজ্ঞাপন');
    expect(updated.is_active).toBe(0);
    expect(() => updateAccount(c.db, getAccountByCode(c.db, '1000').id, { isActive: false }, c.actor)).toThrow(/সিস্টেম/);
  });

  it('can be switched off without touching operational data', () => {
    const c = ctx();
    updateSettings(c.db, { accounting_enabled: 0 });
    createProduct(c.db, { name: 'লবণ', unitId: c.unitPieceId, salePrice: 3000, openingStockMilli: 5000, openingCostMicro: 2000 }, c.actor);
    expect(c.db.prepare('SELECT COUNT(*) AS c FROM journal_entries').get()).toEqual({ c: 0 });
    updateSettings(c.db, { accounting_enabled: 1 });
    const product = getProduct(c.db, 1)!;
    expect(product.stock_base_milli).toBe(5000);
  });
});

describe('settings gate', () => {
  it('accounting is enabled by default for new shops', () => {
    const c = ctx();
    expect(getSettings(c.db).accounting_enabled).toBe(1);
  });
});
