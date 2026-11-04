import { describe, expect, it } from 'vitest';
import {
  createProduct,
  createSale,
  createVariant,
  findByCode,
  listPriceHistory,
  listVariants,
  reorderSuggestions,
  updateProduct,
} from '../src/index.js';
import { makeTestDb } from './helpers.js';

describe('services (non-stock items)', () => {
  it('sells a service without touching inventory', () => {
    const ctx = makeTestDb();
    const service = createProduct(
      ctx.db,
      { name: 'ডেলিভারি চার্জ', unitId: ctx.unitPieceId, salePrice: 5000, isService: true },
      ctx.actor,
    );
    const sale = createSale(ctx.db, {
      lines: [{ productId: service.id, unitId: ctx.unitPieceId, qtyMilli: 2000, unitPricePaisa: 5000 }],
      payments: [{ methodId: ctx.cashMethodId, amount: 10_000 }],
      actor: ctx.actor,
    });
    expect(sale.computation.total).toBe(10_000);
    const stock = ctx.db.prepare('SELECT stock_base_milli AS s FROM products WHERE id = ?').get(service.id) as { s: number };
    expect(stock.s).toBe(0); // unchanged, never negative
    const moves = ctx.db.prepare('SELECT COUNT(*) c FROM stock_movements WHERE product_id = ?').get(service.id) as { c: number };
    expect(moves.c).toBe(0);
    ctx.cleanup();
  });
});

describe('price floor and discount cap', () => {
  it('blocks a below-floor price unless the override is granted', () => {
    const ctx = makeTestDb();
    const p = createProduct(
      ctx.db,
      {
        name: 'মোবাইল কভার',
        unitId: ctx.unitPieceId,
        salePrice: 20_000,
        minSalePricePaisa: 15_000,
        openingStockMilli: 10_000,
      },
      ctx.actor,
    );
    const line = { productId: p.id, unitId: ctx.unitPieceId, qtyMilli: 1000, unitPricePaisa: 12_000 };
    expect(() =>
      createSale(ctx.db, { lines: [line], payments: [{ methodId: ctx.cashMethodId, amount: 12_000 }], actor: ctx.actor }),
    ).toThrow(/সর্বনিম্ন বিক্রয়মূল্য/);

    const ok = createSale(ctx.db, {
      lines: [line],
      payments: [{ methodId: ctx.cashMethodId, amount: 12_000 }],
      allowBelowMinPrice: true,
      actor: ctx.actor,
    });
    expect(ok.saleId).toBeGreaterThan(0);
    ctx.cleanup();
  });

  it('caps the per-product discount percentage', () => {
    const ctx = makeTestDb();
    const p = createProduct(
      ctx.db,
      { name: 'শার্ট', unitId: ctx.unitPieceId, salePrice: 50_000, maxDiscountPercentX100: 1000, openingStockMilli: 10_000 },
      ctx.actor,
    );
    const base = { productId: p.id, unitId: ctx.unitPieceId, qtyMilli: 1000 };
    expect(() =>
      createSale(ctx.db, {
        lines: [{ ...base, discountPaisa: 20_000 }], // 40% > 10% cap
        payments: [{ methodId: ctx.cashMethodId, amount: 30_000 }],
        actor: ctx.actor,
      }),
    ).toThrow(/সর্বোচ্চ/);

    const ok = createSale(ctx.db, {
      lines: [{ ...base, discountPaisa: 5000 }], // exactly 10%
      payments: [{ methodId: ctx.cashMethodId, amount: 45_000 }],
      actor: ctx.actor,
    });
    expect(ok.computation.total).toBe(45_000);

    const override = createSale(ctx.db, {
      lines: [{ ...base, discountPaisa: 20_000 }],
      payments: [{ methodId: ctx.cashMethodId, amount: 30_000 }],
      allowDiscountOverride: true,
      actor: ctx.actor,
    });
    expect(override.computation.total).toBe(30_000);
    ctx.cleanup();
  });
});

describe('variants, barcodes and price history', () => {
  it('creates variants inheriting parent settings with their own stock', () => {
    const ctx = makeTestDb();
    const parent = createProduct(
      ctx.db,
      { name: 'টি-শার্ট', unitId: ctx.unitPieceId, salePrice: 30_000, purchasePrice: 20_000, openingStockMilli: 5000 },
      ctx.actor,
    );
    const variant = createVariant(ctx.db, parent.id, { name: 'টি-শার্ট (L)', attributes: { সাইজ: 'L' }, openingStockMilli: 2000 }, ctx.actor);
    expect(variant.variant_parent_id).toBe(parent.id);
    expect(variant.sale_price).toBe(30_000);
    expect(variant.stock_base_milli).toBe(2000);
    expect(listVariants(ctx.db, parent.id)).toHaveLength(1);
    expect(() => createVariant(ctx.db, variant.id, { attributes: { সাইজ: 'XL' } }, ctx.actor)).toThrow(/ভ্যারিয়েন্ট/);

    const parentStock = ctx.db.prepare('SELECT stock_base_milli s FROM products WHERE id = ?').get(parent.id) as { s: number };
    expect(parentStock.s).toBe(5000); // untouched by the variant
    ctx.cleanup();
  });

  it('finds a product by any of its barcodes and logs price changes', () => {
    const ctx = makeTestDb();
    const p = createProduct(
      ctx.db,
      { name: 'সাবান', unitId: ctx.unitPieceId, salePrice: 4000, barcodes: ['1112223334445', '9990001112'] },
      ctx.actor,
    );
    expect(findByCode(ctx.db, '1112223334445')!.id).toBe(p.id);
    expect(findByCode(ctx.db, '9990001112')!.id).toBe(p.id);

    updateProduct(ctx.db, p.id, { name: 'সাবান', salePrice: 4500, unitId: ctx.unitPieceId }, ctx.actor);
    const hist = listPriceHistory(ctx.db, p.id);
    expect(hist.some((h) => h.field === 'sale_price' && String(h.new_value) === '4500')).toBe(true);
    ctx.cleanup();
  });

  it('includes the configured reorder quantity in suggestions', () => {
    const ctx = makeTestDb();
    createProduct(
      ctx.db,
      {
        name: 'লবণ',
        unitId: ctx.unitPieceId,
        salePrice: 3000,
        minStockMilli: 20_000,
        openingStockMilli: 5000,
        reorderQtyMilli: 40_000,
      },
      ctx.actor,
    );
    const rows = reorderSuggestions(ctx.db, {});
    const hit = rows.find((r: any) => r.name === 'লবণ');
    expect(hit).toBeTruthy();
    expect(hit.suggested_base_milli).toBeGreaterThan(0);
    ctx.cleanup();
  });
});
