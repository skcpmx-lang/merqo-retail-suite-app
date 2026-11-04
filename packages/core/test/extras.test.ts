import { describe, expect, it } from 'vitest';
import {
  createProduct,
  getProduct,
  listProductLabels,
  productPriceBreakdown,
  searchEverything,
  updateProduct,
} from '../src/index.js';
import { makeTestDb, seedProducts } from './helpers.js';

/** Build a full edit form from the stored row, then apply the fields under test. */
function editProduct(ctx: ReturnType<typeof makeTestDb>, id: number, patch: Record<string, unknown>) {
  const row = getProduct(ctx.db, id)!;
  return updateProduct(
    ctx.db,
    id,
    {
      name: row.name,
      sku: row.sku ?? undefined,
      categoryId: row.category_id ?? undefined,
      unitId: row.unit_id,
      primaryUnitId: row.primary_unit_id ?? row.unit_id,
      purchasePrice: row.purchase_price,
      salePrice: row.sale_price,
      minStockMilli: row.min_stock_base_milli,
      ...patch,
    } as never,
    ctx.actor,
  );
}

describe('effective selling price', () => {
  it('applies a product-level percentage offer on the retail level', () => {
    const ctx = makeTestDb();
    const { soap } = seedProducts(ctx);
    editProduct(ctx, soap.id, { retailPrice: 10000, discountType: 'percent', discountValue: 1000 });
    const row = getProduct(ctx.db, soap.id)!;
    expect(row.base_price_paisa).toBe(10000);
    expect(row.final_price_paisa).toBe(9000);
    expect(row.offer_active).toBe(1);
    ctx.cleanup();
  });

  it('never discounts below zero for a fixed offer larger than the price', () => {
    const ctx = makeTestDb();
    const { soap } = seedProducts(ctx);
    editProduct(ctx, soap.id, { retailPrice: 4500, discountType: 'fixed', discountValue: 4000 });
    const row = getProduct(ctx.db, soap.id)!;
    expect(row.final_price_paisa).toBe(500);
    const breakdown = productPriceBreakdown(
      { sale_price: 100, retail_price: null, wholesale_price: null, special_price: null, discount_type: 'fixed', discount_value: 999 } as never,
      'retail',
    );
    expect(breakdown.final).toBe(0);
    ctx.cleanup();
  });

  it('reports the plain sale price when no offer is configured', () => {
    const ctx = makeTestDb();
    const { rice } = seedProducts(ctx);
    const row = getProduct(ctx.db, rice.id)!;
    expect(row.base_price_paisa).toBe(row.final_price_paisa);
    expect(row.offer_active).toBe(0);
    ctx.cleanup();
  });
});

describe('price labels', () => {
  it('prefers the primary barcode and falls back to SKU, with a SAUDA QR payload', () => {
    const ctx = makeTestDb();
    const { rice, soap } = seedProducts(ctx);
    const labels = listProductLabels(ctx.db, [rice.id, soap.id]);
    const riceLabel = labels.find((l) => l.id === rice.id)!;
    const soapLabel = labels.find((l) => l.id === soap.id)!;
    expect(riceLabel.code).toBe('8901234567890');
    expect(riceLabel.unit).toBe('কেজি');
    expect(riceLabel.price_paisa).toBe(8000);
    expect(soapLabel.code).toBe('SOAP-01');
    expect(soapLabel.qr_code).toBe(`SAUDA:${soap.id}`);
    expect(listProductLabels(ctx.db, [])).toEqual([]);
    ctx.cleanup();
  });

  it('reflects the offer price on the label of a discounted product', () => {
    const ctx = makeTestDb();
    const { soap } = seedProducts(ctx);
    editProduct(ctx, soap.id, { retailPrice: 5000, discountType: 'percent', discountValue: 2000 });
    const [label] = listProductLabels(ctx.db, [soap.id]);
    expect(label.price_paisa).toBe(5000);
    ctx.cleanup();
  });
});

describe('global search', () => {
  it('finds products by Bengali name, SKU, barcode and customers by phone', () => {
    const ctx = makeTestDb();
    const { rice } = seedProducts(ctx);

    const byName = searchEverything(ctx.db, 'চাল');
    expect(byName.some((h) => h.kind === 'product' && h.id === rice.id)).toBe(true);

    const bySku = searchEverything(ctx.db, 'RICE');
    expect(bySku.some((h) => h.kind === 'product' && h.id === rice.id)).toBe(true);

    const byBarcode = searchEverything(ctx.db, '8901234567890');
    expect(byBarcode.some((h) => h.kind === 'product' && h.id === rice.id)).toBe(true);

    const byPhone = searchEverything(ctx.db, '01922');
    expect(byPhone.some((h) => h.kind === 'customer' && h.title === 'করিম সাহেব')).toBe(true);
  });

  it('returns nothing for an empty term and no hits for a bogus term', () => {
    const ctx = makeTestDb();
    seedProducts(ctx);
    expect(searchEverything(ctx.db, '   ')).toEqual([]);
    expect(searchEverything(ctx.db, 'zzz-not-a-thing')).toEqual([]);
    ctx.cleanup();
  });

  it('caps hits per kind', () => {
    const ctx = makeTestDb();
    for (let i = 0; i < 5; i++) {
      createProduct(
        ctx.db,
        { name: `আইটেম ${i}`, sku: `ITEM-${i}`, unitId: ctx.unitPieceId, primaryUnitId: ctx.unitPieceId, purchasePrice: 1000, salePrice: 1500 },
        ctx.actor,
      );
    }
    const hits = searchEverything(ctx.db, 'আইটেম', 3);
    expect(hits.filter((h) => h.kind === 'product')).toHaveLength(3);
    ctx.cleanup();
  });
});
