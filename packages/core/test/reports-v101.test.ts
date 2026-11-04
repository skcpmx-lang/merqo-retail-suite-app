import { describe, expect, it } from 'vitest';
import {
  REPORT_CATALOG,
  createCustomer,
  createProduct,
  createSale,
  runReport,
  setCreditLimit,
  updateSettings,
} from '../src/index.js';
import { makeTestDb } from './helpers.js';

function fixture() {
  const ctx = makeTestDb();
  updateSettings(ctx.db, { loyalty_enabled: 1, loyalty_points_per_100: 1, loyalty_redeem_value_paisa: 100 } as any);
  const product = createProduct(
    ctx.db,
    { name: 'চাল', unitId: ctx.unitPieceId, salePrice: 10_000, openingStockMilli: 200_000, openingCostMicro: 6_000_000_000, minStockMilli: 250_000 },
    ctx.actor,
  );
  const customer = createCustomer(ctx.db, { name: 'রহিম', phone: '01712345678' }, ctx.actor);
  setCreditLimit(ctx.db, customer.id, 50_000, ctx.actor);
  createSale(ctx.db, {
    customerId: customer.id,
    lines: [{ productId: product.id, unitId: ctx.unitPieceId, qtyMilli: 10_000, unitPricePaisa: 10_000 }],
    payments: [{ methodId: ctx.cashMethodId, amount: 50_000 }],
    actor: ctx.actor,
  });
  createSale(ctx.db, {
    lines: [{ productId: product.id, unitId: ctx.unitPieceId, qtyMilli: 3000, unitPricePaisa: 10_000 }],
    payments: [{ methodId: ctx.cashMethodId, amount: 30_000 }],
    actor: ctx.actor,
  });
  return { ctx, product, customer };
}

describe('v1.0.1 report catalog', () => {
  it('exposes at least 45 reports', () => {
    expect(REPORT_CATALOG.length).toBeGreaterThanOrEqual(45);
    const ids = REPORT_CATALOG.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate ids
  });

  it('runs every catalog report without throwing', () => {
    const { ctx } = fixture();
    const from = '2000-01-01';
    const to = '2999-12-31';
    const failures: string[] = [];
    for (const meta of REPORT_CATALOG) {
      try {
        const res = runReport(ctx.db, meta.id, { from, to });
        expect(res.title.length).toBeGreaterThan(0);
        expect(Array.isArray(res.rows)).toBe(true);
      } catch (err) {
        failures.push(`${meta.id}: ${(err as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
    ctx.cleanup();
  });

  it('balances the accounting reports against each other', () => {
    const { ctx } = fixture();
    const from = '2000-01-01';
    const to = '2999-12-31';
    const tb = runReport(ctx.db, 'trial_balance', { from, to });
    expect(tb.totals.debit).toBe(tb.totals.credit);

    const bs = runReport(ctx.db, 'balance_sheet', { from, to });
    expect(bs.totals.balanced).toBe(1);
    expect(bs.totals.totalAssets).toBe(Number(bs.totals.totalLiabilities) + Number(bs.totals.totalEquity));

    const pl = runReport(ctx.db, 'ledger_pl', { from, to });
    expect(Number(pl.totals.netProfit)).toBeGreaterThan(0);

    const cf = runReport(ctx.db, 'cash_flow', { from, to });
    expect(Number(cf.totals.inflow)).toBeGreaterThan(0);
    ctx.cleanup();
  });

  it('reports loyalty, credit limits and reorder needs from live data', () => {
    const { ctx, customer } = fixture();
    const loyalty = runReport(ctx.db, 'loyalty_report', { from: '2000-01-01', to: '2999-12-31' });
    expect(loyalty.rows.some((r: any) => r.customer_name === 'রহিম' && Number(r.loyalty_points) > 0)).toBe(true);

    const limits = runReport(ctx.db, 'credit_limit_report', {});
    const row = limits.rows.find((r: any) => r.name === 'রহিম');
    expect(row).toBeTruthy();
    expect(row.credit_limit_paisa).toBe(50_000);
    // 500 taka due against a 500 taka limit → warn state (at/near the cap)
    expect(['সীমার কাছাকাছি', 'সীমা ছাড়িয়েছে']).toContain(row.status);
    expect(row.balance_paisa).toBe(50_000);

    const reorder = runReport(ctx.db, 'reorder_report', {});
    expect(reorder.rows.length).toBeGreaterThan(0);
    expect(String(reorder.rows[0].reason).length).toBeGreaterThan(3);

    expect(customer.id).toBeGreaterThan(0);
    ctx.cleanup();
  });

  it('summarises hourly sales, discounts and tax', () => {
    const { ctx } = fixture();
    const hourly = runReport(ctx.db, 'hourly_sales', { from: '2000-01-01', to: '2999-12-31' });
    expect(hourly.rows.length).toBeGreaterThan(0);
    const tax = runReport(ctx.db, 'tax_summary', { from: '2000-01-01', to: '2999-12-31' });
    expect(tax.rows.length).toBeGreaterThan(0);
    const disc = runReport(ctx.db, 'discount_report', { from: '2000-01-01', to: '2999-12-31' });
    expect(Array.isArray(disc.rows)).toBe(true);
    ctx.cleanup();
  });
});
