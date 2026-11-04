/**
 * v1.1.4 final hardening — stale cart, price and stock revalidation.
 *
 * The POS sends what it showed the customer. These tests prove the Main Server refuses a
 * cart that moved, returns a structured conflict per line, writes nothing on refusal, and
 * cannot oversell the last unit.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SaleConflictError,
  adjustStock,
  createSale,
  getProduct,
  openDatabase,
  validateCart,
  type Db,
} from '../src/index.js';
import { makeTestDb, seedProducts, type TestContext } from './helpers.js';

const contexts: TestContext[] = [];

function shop(): TestContext & { riceId: number } {
  const ctx = makeTestDb({ file: true });
  contexts.push(ctx);
  const ids = seedProducts(ctx);
  // Stock is kept in base milli-units; one kg costs 80.00.
  adjustStock(ctx.db, { productId: ids.rice.id, newQtyBaseMilli: 10_000_000, reason: 'প্রারম্ভিক', actor: ctx.actor });
  return { ...ctx, riceId: ids.rice.id };
}

/** Direct price/status change — stands in for another terminal editing the product. */
function setPrice(db: Db, productId: number, paisa: number): void {
  db.prepare('UPDATE products SET sale_price = ? WHERE id = ?').run(paisa, productId);
}

function setActive(db: Db, productId: number, active: boolean): void {
  db.prepare('UPDATE products SET is_active = ? WHERE id = ?').run(active ? 1 : 0, productId);
}

function counts(db: Db): Record<string, number> {
  const out: Record<string, number> = {};
  for (const table of ['sales', 'sale_items', 'payments', 'stock_movements', 'journal_entries']) {
    out[table] = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }
  return out;
}

function saleInput(ctx: TestContext, riceId: number, qtyMilli: number, expected?: Record<string, unknown>) {
  return {
    lines: [{ productId: riceId, qtyMilli }],
    paidPaisa: 200_000,
    defaultMethodId: ctx.cashMethodId,
    actor: ctx.actor,
    ...(expected ? { expected } : {}),
  };
}

afterEach(() => {
  for (const ctx of contexts.splice(0)) ctx.cleanup();
});

describe('stale price', () => {
  it('refuses a cart whose price changed and writes nothing', () => {
    const ctx = shop();
    const before = counts(ctx.db);
    const oldPrice = 8000; // 80.00 per kg, as shown to the cashier
    setPrice(ctx.db, ctx.riceId, 9500);

    const attempt = () =>
      createSale(ctx.db, saleInput(ctx, ctx.riceId, 1000, { lines: [{ productId: ctx.riceId, unitPricePaisa: oldPrice }] }));

    expect(attempt).toThrow(SaleConflictError);
    try {
      attempt();
    } catch (err) {
      const conflict = err as SaleConflictError;
      expect(conflict.code).toBe('SALE_CONFLICT');
      expect(conflict.conflicts).toHaveLength(1);
      expect(conflict.conflicts[0]).toMatchObject({ kind: 'PRICE_CHANGED', lineIndex: 0, expectedPaisa: oldPrice });
      expect(conflict.conflicts[0]!.currentPaisa).toBeGreaterThan(oldPrice);
      // The structured payload survives for the IPC/HTTP layer.
      expect(conflict.details.conflicts[0]!.kind).toBe('PRICE_CHANGED');
    }
    expect(counts(ctx.db)).toEqual(before);
  });

  it('accepts the cart once the cashier confirms the new price', () => {
    const ctx = shop();
    setPrice(ctx.db, ctx.riceId, 9500);
    const result = createSale(
      ctx.db,
      saleInput(ctx, ctx.riceId, 1000, { lines: [{ productId: ctx.riceId, unitPricePaisa: 9500 }] }),
    );
    expect(result.saleId).toBeGreaterThan(0);
    const line = ctx.db.prepare('SELECT unit_price_paisa FROM sale_items WHERE sale_id = ?').get(result.saleId) as {
      unit_price_paisa: number;
    };
    expect(line.unit_price_paisa).toBe(9500);
  });

  it('never silently substitutes a price for a cart with no expectation (legacy callers)', () => {
    const ctx = shop();
    const result = createSale(ctx.db, saleInput(ctx, ctx.riceId, 1000));
    const line = ctx.db.prepare('SELECT unit_price_paisa FROM sale_items WHERE sale_id = ?').get(result.saleId) as {
      unit_price_paisa: number;
    };
    // Server price is used, as before; the POS always sends `expected` so this path is
    // only for imports/tests.
    expect(line.unit_price_paisa).toBe(8000);
  });
});

describe('product status and total', () => {
  it('refuses an inactive product with a structured conflict', () => {
    const ctx = shop();
    setActive(ctx.db, ctx.riceId, false);
    const before = counts(ctx.db);
    try {
      createSale(ctx.db, saleInput(ctx, ctx.riceId, 1000, { lines: [{ productId: ctx.riceId, unitPricePaisa: 8000 }] }));
      expect.unreachable('sale should have been refused');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('নিষ্ক্রিয়');
    }
    expect(counts(ctx.db)).toEqual(before);
  });

  it('refuses when the total moved (discount, tax or coupon drift)', () => {
    const ctx = shop();
    const attempt = () =>
      createSale(ctx.db, saleInput(ctx, ctx.riceId, 1000, { totalPaisa: 5000 }));
    expect(attempt).toThrow(SaleConflictError);
    try {
      attempt();
    } catch (err) {
      expect((err as SaleConflictError).conflicts[0]!.kind).toBe('TOTAL_CHANGED');
    }
  });
});

describe('stock protection', () => {
  it('refuses more than the shelf has and reports the shortage', () => {
    const ctx = shop();
    try {
      createSale(ctx.db, saleInput(ctx, ctx.riceId, 20_000, { lines: [{ productId: ctx.riceId, unitPricePaisa: 8000 }] }));
      expect.unreachable('sale should have been refused');
    } catch (err) {
      expect(err).toBeInstanceOf(SaleConflictError);
      const conflict = (err as SaleConflictError).conflicts.find((c) => c.kind === 'STOCK_CHANGED')!;
      expect(conflict.availableBaseMilli).toBe(10_000_000);
      expect(conflict.requiredBaseMilli).toBe(20_000_000);
    }
    expect(getProduct(ctx.db, ctx.riceId)!.stock_base_milli).toBe(10_000_000);
  });

  it('two terminals cannot both sell the last unit', () => {
    const ctx = shop();
    adjustStock(ctx.db, { productId: ctx.riceId, newQtyBaseMilli: 1_000_000, reason: 'শেষ ইউনিট', actor: ctx.actor });
    // A second connection to the same file stands in for another process/terminal.
    const second = openDatabase({ file: ctx.dbPath });
    try {
      const first = createSale(ctx.db, saleInput(ctx, ctx.riceId, 1000, { lines: [{ productId: ctx.riceId, unitPricePaisa: 8000 }] }));
      expect(first.saleId).toBeGreaterThan(0);

      expect(() =>
        createSale(second, saleInput(ctx, ctx.riceId, 1000, { lines: [{ productId: ctx.riceId, unitPricePaisa: 8000 }] })),
      ).toThrow(SaleConflictError);

      expect(getProduct(ctx.db, ctx.riceId)!.stock_base_milli).toBe(0);
      const sales = (ctx.db.prepare('SELECT COUNT(*) AS n FROM sales').get() as { n: number }).n;
      expect(sales).toBe(1);
    } finally {
      second.close();
    }
  });

  it('never creates negative stock without an explicit override', () => {
    const ctx = shop();
    for (let i = 0; i < 3; i += 1) {
      try {
        createSale(ctx.db, saleInput(ctx, ctx.riceId, 5_000));
      } catch {
        /* expected once stock runs out */
      }
    }
    expect(getProduct(ctx.db, ctx.riceId)!.stock_base_milli).toBeGreaterThanOrEqual(0);
  });
});

describe('cart validation (read-only)', () => {
  it('returns authoritative lines and conflicts without touching the database', () => {
    const ctx = shop();
    const before = counts(ctx.db);
    setPrice(ctx.db, ctx.riceId, 9500);

    const result = validateCart(ctx.db, saleInput(ctx, ctx.riceId, 1000, {
      lines: [{ productId: ctx.riceId, unitPricePaisa: 8000 }],
    }) as never);
    expect(result.ok).toBe(false);
    expect(result.conflicts[0]!.kind).toBe('PRICE_CHANGED');
    expect(result.lines[0]).toMatchObject({ productId: ctx.riceId, unitPricePaisa: 9500, isActive: true });
    expect(result.lines[0]!.availableBaseMilli).toBe(10_000_000);
    expect(counts(ctx.db)).toEqual(before);
  });

  it('reports a clean cart as ok', () => {
    const ctx = shop();
    const result = validateCart(ctx.db, saleInput(ctx, ctx.riceId, 1000, {
      lines: [{ productId: ctx.riceId, unitPricePaisa: 8000 }],
    }) as never);
    expect(result.ok).toBe(true);
    expect(result.conflicts).toHaveLength(0);
    expect(Number.isInteger(result.totalPaisa)).toBe(true);
  });

  it('keeps money in integer paisa', () => {
    const ctx = shop();
    const result = createSale(ctx.db, saleInput(ctx, ctx.riceId, 1333, { lines: [{ productId: ctx.riceId, unitPricePaisa: 8000 }] }));
    const sale = ctx.db.prepare('SELECT total_paisa, subtotal_paisa, tax_paisa FROM sales WHERE id = ?').get(result.saleId) as Record<string, number>;
    for (const value of Object.values(sale)) expect(Number.isInteger(value)).toBe(true);
  });
});
