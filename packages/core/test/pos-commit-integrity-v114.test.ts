/**
 * POS commit-time isolation (Phase A item 6, concurrency half).
 *
 * Two terminals can hold the same cart. Only one may sell the last unit, and a refused
 * sale must leave the shop exactly as it was: no sale row, no payment row, no stock move,
 * no invoice number consumed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { makeTestDb, seedProducts, type TestContext } from './helpers.js';
import { createSale, type SaleInput } from '../src/services/sales.js';
import { adjustStock } from '../src/services/inventory.js';
import { SaleConflictError } from '../src/services/sale-conflicts.js';

const ctxs: TestContext[] = [];

function open(): {
  ctx: TestContext;
  product: { id: number; name: string };
  soap: { id: number; name: string };
  unitId: number;
  cash: number;
  stock: () => number;
} {
  const ctx = makeTestDb();
  ctxs.push(ctx);
  const { rice, soap } = seedProducts(ctx);
  return {
    ctx,
    product: rice,
    soap,
    unitId: ctx.unitKgId,
    cash: ctx.cashMethodId,
    stock: () =>
      (ctx.db.prepare('SELECT stock_base_milli FROM products WHERE id = ?').get(rice.id) as
        | { stock_base_milli: number }
        | undefined)?.stock_base_milli ?? -1,
  };
}

afterEach(() => {
  for (const ctx of ctxs.splice(0)) ctx.cleanup();
});

function countRows(ctx: TestContext, table: string): number {
  return (ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe('the last unit cannot be sold twice', () => {
  it('lets one terminal win and refuses the other without a partial write', () => {
    const h = open();
    // Exactly one kilogram left, sold by the kilogram (1 kg = 1,000,000 base milli).
    adjustStock(h.ctx.db, {
      productId: h.product.id,
      newQtyBaseMilli: 1_000_000,
      reason: 'ওপেনিং স্টক',
      actor: h.ctx.actor,
    });
    expect(h.stock()).toBe(1_000_000);

    const cart = (paidPaisa: number): SaleInput => ({
      lines: [{ productId: h.product.id, unitId: h.unitId, qtyMilli: 1000 }],
      paidPaisa,
      defaultMethodId: h.cash,
      actor: h.ctx.actor,
    });

    // Terminal A commits first.
    const first = createSale(h.ctx.db, cart(8000));
    expect(first.saleId).toBeGreaterThan(0);
    const salesAfterFirst = countRows(h.ctx, 'sales');
    const paymentsAfterFirst = countRows(h.ctx, 'payments');
    const movesAfterFirst = countRows(h.ctx, 'stock_movements');

    // Terminal B scanned the same kilogram before A committed.
    expect(() => createSale(h.ctx.db, cart(8000))).toThrowError();

    // Nothing at all changed for B's attempt.
    expect(countRows(h.ctx, 'sales')).toBe(salesAfterFirst);
    expect(countRows(h.ctx, 'payments')).toBe(paymentsAfterFirst);
    expect(countRows(h.ctx, 'stock_movements')).toBe(movesAfterFirst);
    expect(h.stock()).toBe(0);
  });

  it('rolls the whole sale back when a later line fails', () => {
    const h = open();
    const second = h.ctx.db
      .prepare('SELECT id, name, stock_base_milli FROM products WHERE id != ? ORDER BY id LIMIT 1')
      .get(h.product.id) as { id: number; name: string; stock_base_milli: number };
    const secondUnit = h.ctx.unitPieceId;

    adjustStock(h.ctx.db, {
      productId: h.product.id,
      newQtyBaseMilli: 10_000_000,
      reason: 'ওপেনিং স্টক',
      actor: h.ctx.actor,
    });
    // 5 pieces on hand: a 2-piece second line would fit, so make it 10 to break it.
    adjustStock(h.ctx.db, {
      productId: second.id,
      newQtyBaseMilli: 5_000,
      reason: 'ওপেনিং স্টক',
      actor: h.ctx.actor,
    });

    const salesBefore = countRows(h.ctx, 'sales');
    const lastInvoiceBefore =
      (h.ctx.db.prepare('SELECT invoice_no FROM sales ORDER BY id DESC LIMIT 1').get() as { invoice_no: string } | undefined)
        ?.invoice_no ?? null;

    // The second line needs 10 pieces but only 5 are in the shop.
    expect(() =>
      createSale(h.ctx.db, {
        lines: [
          { productId: h.product.id, unitId: h.unitId, qtyMilli: 1000 },
          { productId: second.id, unitId: secondUnit, qtyMilli: 10_000 },
        ],
        paidPaisa: 50_000,
        defaultMethodId: h.cash,
        actor: h.ctx.actor,
      }),
    ).toThrowError();

    // The good line's stock move was rolled back with the header, and no invoice was consumed.
    expect(countRows(h.ctx, 'sales')).toBe(salesBefore);
    expect(countRows(h.ctx, 'payments')).toBe(0);
    expect(h.stock()).toBe(10_000_000);
    const secondStock = (
      h.ctx.db.prepare('SELECT stock_base_milli FROM products WHERE id = ?').get(second.id) as {
        stock_base_milli: number;
      }
    ).stock_base_milli;
    expect(secondStock).toBe(5_000);
    const lastInvoiceAfter =
      (h.ctx.db.prepare('SELECT invoice_no FROM sales ORDER BY id DESC LIMIT 1').get() as { invoice_no: string } | undefined)
        ?.invoice_no ?? null;
    expect(lastInvoiceAfter).toBe(lastInvoiceBefore);
  });

  it('refuses a deleted product at commit time', () => {
    const h = open();
    // A product that nothing else references, so it can really be deleted.
    const ins = h.ctx.db
      .prepare(
        `INSERT INTO products (name, unit_id, primary_unit_id, purchase_price, sale_price, stock_base_milli, is_active, created_at, updated_at)
         VALUES ('মুছে ফেলা পণ্য', ?, ?, 7000, 8000, 500000, 1, ?, ?)`,
      )
      .run(h.unitId, h.unitId, '2026-01-01 10:00:00', '2026-01-01 10:00:00');
    const goneId = Number(ins.lastInsertRowid);
    h.ctx.db.prepare('DELETE FROM products WHERE id = ?').run(goneId);

    expect(() =>
      createSale(h.ctx.db, {
        lines: [{ productId: goneId, unitId: h.unitId, qtyMilli: 1000 }],
        paidPaisa: 8000,
        defaultMethodId: h.cash,
        actor: h.ctx.actor,
      }),
    ).toThrowError();
    expect(countRows(h.ctx, 'sales')).toBe(0);
  });

  it('refuses an inactive product at commit time', () => {
    const h = open();
    adjustStock(h.ctx.db, {
      productId: h.product.id,
      newQtyBaseMilli: 10_000_000,
      reason: 'ওপেনিং স্টক',
      actor: h.ctx.actor,
    });
    h.ctx.db.prepare('UPDATE products SET is_active = 0 WHERE id = ?').run(h.product.id);

    expect(() =>
      createSale(h.ctx.db, {
        lines: [{ productId: h.product.id, unitId: h.unitId, qtyMilli: 1000 }],
        paidPaisa: 8000,
        defaultMethodId: h.cash,
        actor: h.ctx.actor,
      }),
    ).toThrowError();
    expect(countRows(h.ctx, 'sales')).toBe(0);
  });

  it('raises a structured conflict, not a generic error, for a stale expectation', () => {
    const h = open();
    adjustStock(h.ctx.db, {
      productId: h.product.id,
      newQtyBaseMilli: 10_000_000,
      reason: 'ওপেনিং স্টক',
      actor: h.ctx.actor,
    });
    const price = (
      h.ctx.db.prepare('SELECT sale_price FROM products WHERE id = ?').get(h.product.id) as { sale_price: number }
    ).sale_price;

    let caught: unknown = null;
    try {
      createSale(h.ctx.db, {
        lines: [{ productId: h.product.id, unitId: h.unitId, qtyMilli: 1000 }],
        paidPaisa: price,
        defaultMethodId: h.cash,
        actor: h.ctx.actor,
        expected: { lines: [{ productId: h.product.id, unitPricePaisa: price - 500, qtyBaseMilli: 1_000_000 }] },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SaleConflictError);
    const conflict = caught as SaleConflictError;
    expect(conflict.code).toBe('SALE_CONFLICT');
    // The cashier is told which line, at which index, and both prices.
    const first = (conflict.details as { conflicts: Array<Record<string, unknown>> }).conflicts[0]!;
    expect(first.kind).toBe('PRICE_CHANGED');
    expect(first.lineIndex).toBe(0);
    expect(first.productId).toBe(h.product.id);
    expect(first.expectedPaisa).toBe(price - 500);
    expect(first.currentPaisa).toBe(price);
    expect(countRows(h.ctx, 'sales')).toBe(0);
  });

  it('keeps money in integer minor units end to end', () => {
    const h = open();
    adjustStock(h.ctx.db, {
      productId: h.product.id,
      newQtyBaseMilli: 10_000_000,
      reason: 'ওপেনিং স্টক',
      actor: h.ctx.actor,
    });
    // 1.333 kg at a per-kg price: the line total must still be an integer number of paisa.
    const sale = createSale(h.ctx.db, {
      lines: [{ productId: h.product.id, unitId: h.unitId, qtyMilli: 1333 }],
      paidPaisa: 100_000,
      defaultMethodId: h.cash,
      actor: h.ctx.actor,
    });
    const row = h.ctx.db
      .prepare('SELECT total_paisa, paid_paisa, due_paisa, change_paisa FROM sales WHERE id = ?')
      .get(sale.saleId) as Record<string, number>;
    for (const value of Object.values(row)) expect(Number.isInteger(value)).toBe(true);
    const line = h.ctx.db
      .prepare('SELECT unit_price_paisa, qty_base_milli, line_total_paisa FROM sale_items WHERE sale_id = ?')
      .get(sale.saleId) as Record<string, number>;
    for (const value of Object.values(line)) expect(Number.isInteger(value)).toBe(true);
  });
});
