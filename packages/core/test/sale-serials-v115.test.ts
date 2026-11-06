/**
 * Serials sold on a sale belong to the product being sold (v1.1.5, audit finding A-13).
 *
 * `serial_numbers` is `UNIQUE(product_id, serial)`, so two products may legitimately carry the same
 * serial string (a supplier IMEI reused across models, a re-boxed handset, a shop's own stock tag).
 * v1.1.4 matched serials by string alone:
 *
 *  - selling one product marked **every** product's row with that serial as sold, silently removing
 *    a unit from another product's tracked stock;
 *  - a serial belonging to product A was accepted on a line for product B, so the warranty/IMEI
 *    registry pointed at the wrong item;
 *  - with a multi-line cart, the quantity guard used a cursor that only advanced for lines carrying
 *    serials, so the second product was checked against the first product's quantity.
 *
 * These tests pin the binding in both layers: the service call and the POS commit path.
 */
import { describe, expect, it } from 'vitest';
import { createProduct } from '../src/services/products.js';
import { createSale } from '../src/services/sales.js';
import { markSerialsSold, registerSerials } from '../src/services/stock-ops.js';
import { makeTestDb } from './helpers.js';

function shop() {
  const ctx = makeTestDb();
  const phone = createProduct(
    ctx.db,
    { name: 'মোবাইল ফোন', unitId: ctx.unitPieceId, salePrice: 1_500_000, openingStockMilli: 5_000 },
    ctx.actor,
  );
  const other = createProduct(
    ctx.db,
    { name: 'ইয়ারফোন', unitId: ctx.unitPieceId, salePrice: 200_000, openingStockMilli: 5_000 },
    ctx.actor,
  );
  return { ctx, phone, other };
}

const serialRow = (ctx: ReturnType<typeof shop>['ctx'], serial: string) =>
  ctx.db.prepare('SELECT product_id, status, sale_id FROM serial_numbers WHERE serial = ?').all(serial) as {
    product_id: number;
    status: string;
    sale_id: number | null;
  }[];

const sell = (ctx: ReturnType<typeof shop>['ctx'], lines: unknown[], paid = 100_000_000) =>
  createSale(ctx.db, {
    lines,
    payments: [{ methodId: ctx.cashMethodId, amount: paid }],
    actor: ctx.actor,
  } as never);

describe('a serial can only be sold for its own product', () => {
  it('refuses a serial registered against a different product', () => {
    const { ctx, phone, other } = shop();
    registerSerials(ctx.db, { productId: phone.id, serials: ['IMEI-1'], actor: ctx.actor });

    // The phone's serial must not be attachable to an earphone sale.
    expect(() =>
      sell(ctx, [{ productId: other.id, unitId: ctx.unitPieceId, qtyMilli: 1000, serials: ['IMEI-1'] }]),
    ).toThrow(/ইয়ারফোন|পাওয়া যায়নি/);

    expect(serialRow(ctx, 'IMEI-1')).toEqual([{ product_id: phone.id, status: 'in_stock', sale_id: null }]);
  });

  it('does not mark another product\'s row sold when the same serial string exists twice', () => {
    const { ctx, phone, other } = shop();
    // Two products, one supplier label reused — allowed by UNIQUE(product_id, serial).
    registerSerials(ctx.db, { productId: phone.id, serials: ['S-777'], actor: ctx.actor });
    registerSerials(ctx.db, { productId: other.id, serials: ['S-777'], actor: ctx.actor });
    expect(serialRow(ctx, 'S-777')).toHaveLength(2);

    const sale = sell(ctx, [{ productId: phone.id, unitId: ctx.unitPieceId, qtyMilli: 1000, serials: ['S-777'] }]);

    const rows = serialRow(ctx, 'S-777');
    const phoneRow = rows.find((r) => r.product_id === phone.id)!;
    const otherRow = rows.find((r) => r.product_id === other.id)!;
    expect(phoneRow).toMatchObject({ status: 'sold', sale_id: sale.saleId });
    // Before the fix this row was marked sold too, losing a tracked earphone.
    expect(otherRow).toEqual({ product_id: other.id, status: 'in_stock', sale_id: null });
  });

  it('uses the right line when only the second product carries serials', () => {
    const { ctx, phone, other } = shop();
    registerSerials(ctx.db, { productId: other.id, serials: ['EAR-1', 'EAR-2'], actor: ctx.actor });

    // Line 0 has no serials; line 1 sells two earphones with two serials. The old cursor compared
    // this against the phone's quantity (one piece) and refused a legal sale, naming the phone.
    const sale = sell(ctx, [
      { productId: phone.id, unitId: ctx.unitPieceId, qtyMilli: 1000 },
      { productId: other.id, unitId: ctx.unitPieceId, qtyMilli: 2000, serials: ['EAR-1', 'EAR-2'] },
    ]);
    expect(sale.computation.lines).toHaveLength(2);
    for (const serial of ['EAR-1', 'EAR-2']) {
      expect(serialRow(ctx, serial)).toEqual([{ product_id: other.id, status: 'sold', sale_id: sale.saleId }]);
    }
  });
});

describe('the guard itself', () => {
  it('refuses more serials than the quantity sold, per line', () => {
    const { ctx, phone, other } = shop();
    registerSerials(ctx.db, { productId: other.id, serials: ['EAR-1', 'EAR-2'], actor: ctx.actor });
    expect(() =>
      sell(ctx, [
        { productId: phone.id, unitId: ctx.unitPieceId, qtyMilli: 1000 },
        { productId: other.id, unitId: ctx.unitPieceId, qtyMilli: 1000, serials: ['EAR-1', 'EAR-2'] },
      ]),
    ).toThrow(/বিক্রির পরিমাণের চেয়ে বেশি সিরিয়াল/);
  });

  it('sells without a serial binding when the caller is not a sale line', () => {
    const { ctx, phone } = shop();
    registerSerials(ctx.db, { productId: phone.id, serials: ['IMEI-9'], actor: ctx.actor });
    const sale = sell(ctx, [{ productId: phone.id, unitId: ctx.unitPieceId, qtyMilli: 1000 }]);
    // Historical callers (legacy imports) stay usable: the product-scoped bound is opt-in.
    expect(markSerialsSold(ctx.db, ['IMEI-9'], sale.saleId, ctx.actor)).toBe(1);
    expect(serialRow(ctx, 'IMEI-9')[0]).toMatchObject({ status: 'sold', sale_id: sale.saleId });
  });

  it('fails loudly when a duplicate registration makes the update ambiguous', () => {
    const { ctx, phone, other } = shop();
    registerSerials(ctx.db, { productId: phone.id, serials: ['D-1'], actor: ctx.actor });
    registerSerials(ctx.db, { productId: other.id, serials: ['D-1'], actor: ctx.actor });
    const sale = sell(ctx, [{ productId: phone.id, unitId: ctx.unitPieceId, qtyMilli: 1000 }]);
    // Unscoped callers cannot know which product is meant; the ambiguity is reported, not guessed.
    expect(() => markSerialsSold(ctx.db, ['D-1'], sale.saleId, ctx.actor)).toThrow(/একাধিক প্রোডাক্ট/);
  });
});
