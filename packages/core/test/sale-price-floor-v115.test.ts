/**
 * The price floor must be compared in the unit being sold (v1.1.5, audit finding A-12).
 *
 * `products.min_sale_price` is per **primary** unit (৳100 per kg), while a sale line's price is per
 * **chosen** unit (৳0.10 per gram). v1.1.4 compared the two numbers directly, so any product with a
 * floor could not be sold in a smaller unit at all: 250 g of ৳120/kg rice was refused with
 * "সর্বনিম্ন বিক্রয়মূল্য 100.00 টাকা" even though the line was 25% above the floor. That is the
 * everyday case for a grocery — loose rice, sugar, oil, dal — so it is a sale-blocking defect, not
 * an edge case.
 *
 * These tests pin both directions: the converted floor still stops a genuinely too-low price, and it
 * no longer blocks a legal one. The all-integer conversion matters too — 1/3 of a unit must round
 * the same way in the price and in the floor, or a sale can be lost or allowed by a single poisa.
 */
import { describe, expect, it } from 'vitest';
import { createProduct } from '../src/services/products.js';
import { computeSale, createSale } from '../src/services/sales.js';
import { makeTestDb } from './helpers.js';

function setup(options: { floorPaisa: number; salePricePaisa: number; stockMilli?: number }) {
  const ctx = makeTestDb();
  const product = createProduct(
    ctx.db,
    {
      name: 'চিনি',
      unitId: ctx.unitKgId,
      salePrice: options.salePricePaisa,
      minSalePricePaisa: options.floorPaisa,
      openingStockMilli: options.stockMilli ?? 20_000_000,
    },
    ctx.actor,
  );
  const gramId = (
    ctx.db.prepare("SELECT id FROM units WHERE name = 'গ্রাম'").get() as { id: number }
  ).id;
  return { ctx, product, gramId };
}

const sell = (ctx: ReturnType<typeof setup>['ctx'], line: Record<string, unknown>, extra = {}) =>
  createSale(ctx.db, {
    lines: [line],
    payments: [{ methodId: ctx.cashMethodId, amount: 10_000_000 }],
    actor: ctx.actor,
    ...extra,
  } as never);

describe('a per-primary-unit floor does not block sales in a smaller unit', () => {
  it('sells 250 g of a ৳120/kg product whose floor is ৳100/kg', () => {
    const { ctx, product, gramId } = setup({ floorPaisa: 10_000, salePricePaisa: 12_000 });
    const sale = sell(ctx, { productId: product.id, unitId: gramId, qtyMilli: 250_000 });
    // ৳120/kg → ৳0.12/g → 250 g = ৳30.00 = 3000 poisa.
    expect(sale.computation.total).toBe(3_000);
    expect(sale.computation.lines[0]!.unitPrice).toBe(12);
    expect(sale.computation.lines[0]!.qtyBaseMilli).toBe(250_000);
  });

  it('still refuses a price below the converted floor', () => {
    const { ctx, product, gramId } = setup({ floorPaisa: 10_000, salePricePaisa: 12_000 });
    // ৳0.09/g is below the ৳0.10/g floor.
    expect(() =>
      sell(ctx, { productId: product.id, unitId: gramId, qtyMilli: 250_000, unitPricePaisa: 9 }),
    ).toThrow(/সর্বনিম্ন বিক্রয়মূল্য 0\.10 টাকা \(গ্রাম প্রতি\)/);
  });

  it('names the floor in the unit that was sold, so the cashier can act on it', () => {
    const { ctx, product, gramId } = setup({ floorPaisa: 10_000, salePricePaisa: 12_000 });
    let message = '';
    try {
      sell(ctx, { productId: product.id, unitId: gramId, qtyMilli: 250_000, unitPricePaisa: 9 });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('গ্রাম প্রতি');
    expect(message).toContain('0.10');
  });

  it('keeps the primary-unit behaviour unchanged', () => {
    const { ctx, product } = setup({ floorPaisa: 10_000, salePricePaisa: 12_000 });
    // 1 kg = 1000 milli-kilogram.
    const sale = sell(ctx, { productId: product.id, unitId: ctx.unitKgId, qtyMilli: 1_000 });
    expect(sale.computation.total).toBe(12_000);
    expect(() =>
      sell(ctx, { productId: product.id, unitId: ctx.unitKgId, qtyMilli: 1_000, unitPricePaisa: 9_000 }),
    ).toThrow(/সর্বনিম্ন বিক্রয়মূল্য 100\.00 টাকা/);
  });

  it('converts the floor for a larger unit too, instead of letting it through', () => {
    // 5 kg = 5 × 1 kg. Floor ৳100/kg → ৳500 per 5 kg bag.
    const ctx = makeTestDb();
    const product = createProduct(
      ctx.db,
      { name: 'চাল', unitId: ctx.unitKgId, salePrice: 12_000, minSalePricePaisa: 10_000, openingStockMilli: 100_000_000 },
      ctx.actor,
    );
    const bag = { id: 0, factorMilli: 5_000_000 };
    ctx.db
      .prepare("INSERT INTO units (name, short_name, factor_milli, is_active) VALUES ('৫ কেজি ব্যাগ','ব্যাগ',?,1)")
      .run(bag.factorMilli);
    const bagId = (ctx.db.prepare("SELECT id FROM units WHERE name = '৫ কেজি ব্যাগ'").get() as { id: number }).id;
    // ৳400 for the bag is ৳80/kg — under the floor, and it must be refused.
    expect(() =>
      sell(ctx, { productId: product.id, unitId: bagId, qtyMilli: 1000, unitPricePaisa: 40_000 }),
    ).toThrow(/সর্বনিম্ন বিক্রয়মূল্য 500\.00 টাকা/);
    // ৳600 for the bag is ৳120/kg — legal.
    const ok = sell(ctx, { productId: product.id, unitId: bagId, qtyMilli: 1000, unitPricePaisa: 60_000 });
    expect(ok.computation.total).toBe(60_000);
  });

  it('rounds price and floor the same way, so no sale turns on a single poisa', () => {
    // ৳10/kg floor, sold by the kilogram in a 3-decimal quantity.
    const { ctx, product } = setup({ floorPaisa: 1_000, salePricePaisa: 1_000 });
    const computed = computeSale(ctx.db, {
      lines: [{ productId: product.id, unitId: ctx.unitKgId, qtyMilli: 333 }],
      payments: [],
      actor: ctx.actor,
    });
    // Exactly at the floor: allowed, never rounded to "below".
    expect(computed.lines[0]!.unitPrice).toBe(1_000);
    expect(computed.total).toBe(333);
  });
});
