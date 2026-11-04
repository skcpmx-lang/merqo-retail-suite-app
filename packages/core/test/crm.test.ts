import { describe, expect, it } from 'vitest';
import {
  adjustLoyaltyPoints,
  assignCustomerGroup,
  createCustomer,
  createProduct,
  createSale,
  creditCheck,
  customerPriceLevel,
  customersToCsv,
  earnLoyaltyForSale,
  expireLoyaltyPoints,
  getCustomer,
  importCustomersCsv,
  listCustomerGroups,
  loyaltyHistory,
  loyaltySummary,
  redeemLoyalty,
  setCreditLimit,
  setCustomerPriceLevel,
  updateSettings,
  voidSale,
} from '../src/index.js';
import { makeTestDb } from './helpers.js';

function fixture(pointsPer100 = 1, redeemValue = 100) {
  const ctx = makeTestDb();
  updateSettings(ctx.db, {
    loyalty_enabled: 1,
    loyalty_points_per_100: pointsPer100,
    loyalty_redeem_value_paisa: redeemValue,
    loyalty_min_redeem_points: 10,
    credit_limit_enforced: 1,
  } as any);
  const product = createProduct(
    ctx.db,
    { name: 'চাল', unitId: ctx.unitKgId, primaryUnitId: ctx.unitKgId, salePrice: 8000, openingStockMilli: 100_000_000, openingCostMicro: 7_000_000 },
    ctx.actor,
  );
  const customer = createCustomer(ctx.db, { name: 'করিম স্টোর', phone: '01799999999' }, ctx.actor);
  return { ctx, product, customer };
}

const sell = (ctx: ReturnType<typeof fixture>, qtyGram: number, paid: boolean, customerId?: number) =>
  createSale(ctx.ctx.db, {
    customerId: customerId ?? ctx.customer.id,
    lines: [{ productId: ctx.product.id, unitId: ctx.ctx.unitKgId, qtyMilli: qtyGram, unitPricePaisa: 8000 }],
    payments: paid
      ? [{ methodId: ctx.ctx.cashMethodId, amount: Math.round((qtyGram / 1000) * 8000) }]
      : [],
    actor: ctx.ctx.actor,
  });

describe('loyalty points', () => {
  it('earns points per 100 taka and records the ledger', () => {
    const f = fixture();
    const sale = sell(f, 25_000, true); // 25 kg × 80 = 2000 taka
    expect(sale.computation.total).toBe(200_000);
    const s = loyaltySummary(f.ctx.db, f.customer.id);
    expect(s.points).toBe(20); // 2000 taka / 100 × 1 point
    expect(s.valuePaisa).toBe(2000); // 20 points × 1 taka
    expect(loyaltyHistory(f.ctx.db, f.customer.id)).toHaveLength(1);
    f.ctx.cleanup();
  });

  it('is idempotent and never double-credits a sale', () => {
    const f = fixture();
    const sale = sell(f, 25_000, true);
    earnLoyaltyForSale(f.ctx.db, sale.saleId, f.ctx.actor);
    earnLoyaltyForSale(f.ctx.db, sale.saleId, f.ctx.actor);
    expect(loyaltySummary(f.ctx.db, f.customer.id).points).toBe(20);
    f.ctx.cleanup();
  });

  it('redeems points with a minimum threshold and refuses to overspend', () => {
    const f = fixture();
    sell(f, 25_000, true);
    expect(() => redeemLoyalty(f.ctx.db, { customerId: f.customer.id, points: 5, actor: f.ctx.actor })).toThrow(/সর্বনিম্ন/);
    const res = redeemLoyalty(f.ctx.db, { customerId: f.customer.id, points: 15, actor: f.ctx.actor });
    expect(res.valuePaisa).toBe(1500);
    expect(loyaltySummary(f.ctx.db, f.customer.id).points).toBe(5);
    expect(() => redeemLoyalty(f.ctx.db, { customerId: f.customer.id, points: 99, actor: f.ctx.actor })).toThrow(/আছে মাত্র/);
    f.ctx.cleanup();
  });

  it('reverses points when an invoice is voided', () => {
    const f = fixture();
    const sale = sell(f, 25_000, true);
    expect(loyaltySummary(f.ctx.db, f.customer.id).points).toBe(20);
    voidSale(f.ctx.db, sale.saleId, 'ভুল ইনভয়েস', f.ctx.actor);
    expect(loyaltySummary(f.ctx.db, f.customer.id).points).toBe(0);
    const types = loyaltyHistory(f.ctx.db, f.customer.id).map((r) => r.type);
    expect(types).toContain('reverse');
    f.ctx.cleanup();
  });

  it('expires old points and audits a manual adjustment', () => {
    const f = fixture();
    const sale = sell(f, 25_000, true);
    // backdate the earn entry beyond the expiry window
    f.ctx.db.prepare("UPDATE loyalty_ledger SET created_at = '2020-01-01T10:00:00' WHERE ref_id = ?").run(sale.saleId);
    const out = expireLoyaltyPoints(f.ctx.db, 30, f.ctx.actor);
    expect(out.points).toBe(20);
    expect(loyaltySummary(f.ctx.db, f.customer.id).points).toBe(0);

    adjustLoyaltyPoints(f.ctx.db, { customerId: f.customer.id, points: 50, reason: 'গুডউইল', actor: f.ctx.actor });
    expect(loyaltySummary(f.ctx.db, f.customer.id).points).toBe(50);
    expect(() =>
      adjustLoyaltyPoints(f.ctx.db, { customerId: f.customer.id, points: -80, reason: 'পরীক্ষা', actor: f.ctx.actor }),
    ).toThrow(/শূন্যের নিচে/);
    f.ctx.cleanup();
  });

  it('does nothing when loyalty is switched off', () => {
    const ctx = makeTestDb();
    updateSettings(ctx.db, { loyalty_enabled: 0 } as any);
    const product = createProduct(
      ctx.db,
      { name: 'ডাল', unitId: ctx.unitKgId, primaryUnitId: ctx.unitKgId, salePrice: 5000, openingStockMilli: 50_000_000 },
      ctx.actor,
    );
    const customer = createCustomer(ctx.db, { name: 'হাসান', phone: '01788888888' }, ctx.actor);
    const sale = createSale(ctx.db, {
      customerId: customer.id,
      lines: [{ productId: product.id, unitId: ctx.unitKgId, qtyMilli: 20_000, unitPricePaisa: 5000 }],
      payments: [{ methodId: ctx.cashMethodId, amount: 100_000 }],
      actor: ctx.actor,
    });
    expect(sale.saleId).toBeGreaterThan(0);
    expect(getCustomer(ctx.db, customer.id)!.loyalty_points ?? 0).toBe(0);
    ctx.cleanup();
  });
});

describe('credit limits', () => {
  it('blocks a due sale that would cross the limit', () => {
    const f = fixture();
    setCreditLimit(f.ctx.db, f.customer.id, 100_000, f.ctx.actor); // 1000 taka
    expect(creditCheck(f.ctx.db, f.customer.id, 50_000).ok).toBe(true);
    expect(() => sell(f, 25_000, false)).toThrow(/বাকির সীমা/);
    expect(() => sell(f, 20_000, false)).toThrow(/বাকির সীমা/); // 1600 taka > 1000
    // exactly at the limit is allowed
    const ok = sell(f, 12_500, false); // 1000 taka
    expect(ok.saleId).toBeGreaterThan(0);
    expect(getCustomer(f.ctx.db, f.customer.id)!.balance_paisa).toBe(100_000);
    f.ctx.cleanup();
  });

  it('only warns when enforcement is off', () => {
    const f = fixture();
    updateSettings(f.ctx.db, { credit_limit_enforced: 0 } as any);
    setCreditLimit(f.ctx.db, f.customer.id, 100_000, f.ctx.actor);
    const sale = sell(f, 25_000, false);
    expect(sale.saleId).toBeGreaterThan(0);
    expect(creditCheck(f.ctx.db, f.customer.id, 0).ok).toBe(false); // still reported as over-limit
    f.ctx.cleanup();
  });

  it('treats a zero limit as unlimited', () => {
    const f = fixture();
    setCreditLimit(f.ctx.db, f.customer.id, 0, f.ctx.actor);
    expect(creditCheck(f.ctx.db, f.customer.id, 9_999_999).ok).toBe(true);
    f.ctx.cleanup();
  });
});

describe('groups, price levels and import/export', () => {
  it('groups customers and applies a price level', () => {
    const f = fixture();
    assignCustomerGroup(f.ctx.db, f.customer.id, 'পাইকারি', f.ctx.actor);
    const groups = listCustomerGroups(f.ctx.db);
    expect(groups.find((g) => g.group_name === 'পাইকারি')!.customers).toBe(1);

    expect(customerPriceLevel(f.ctx.db, f.customer.id)).toBe('retail');
    setCustomerPriceLevel(f.ctx.db, f.customer.id, 'wholesale', f.ctx.actor);
    expect(customerPriceLevel(f.ctx.db, f.customer.id)).toBe('wholesale');
    expect(customerPriceLevel(f.ctx.db, null)).toBe('retail');
    f.ctx.cleanup();
  });

  it('round-trips customers through CSV and updates by phone', () => {
    const f = fixture();
    assignCustomerGroup(f.ctx.db, f.customer.id, 'খুচরা', f.ctx.actor);
    const csv = customersToCsv(f.ctx.db);
    expect(csv.split('\n')[0]).toContain('name,phone');

    const other = makeTestDb();
    const res = importCustomersCsv(other.db, csv, other.actor);
    expect(res.created).toBeGreaterThanOrEqual(1);
    expect(res.skipped).toEqual([]);

    const again = importCustomersCsv(other.db, csv, other.actor);
    expect(again.updated).toBe(res.created);
    expect(again.created).toBe(0);

    // a bad row is reported, not silently dropped
    const bad = importCustomersCsv(other.db, 'name,phone\n,017\nনতুন,01812345678', other.actor);
    expect(bad.skipped.length).toBe(1);
    expect(bad.created).toBe(1);
    other.cleanup();
    f.ctx.cleanup();
  });
});
