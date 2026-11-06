/**
 * Date filters are inclusive of both ends (v1.1.5).
 *
 * The list screens used `date(column) >= date(?) AND date(column) <= date(?)`, which is correct but
 * unindexable. They now compare the column against `YYYY-MM-DD 00:00:00` and `YYYY-MM-DD 23:59:59`,
 * which is the same range for the timestamps this application writes — but "the same" is a claim, so
 * it is tested at exactly the boundary where it could differ: the first second and the last second
 * of a day, and the seconds either side.
 */
import { describe, expect, it } from 'vitest';
import { dayEnd, dayStart } from '../src/domain/datetime.js';
import { createProduct } from '../src/services/products.js';
import { createSale, listSales } from '../src/services/sales.js';
import { listExpenses, createExpense } from '../src/services/expenses.js';
import { makeTestDb } from './helpers.js';

const sellAt = (ctx: ReturnType<typeof makeTestDb>, productId: number, when: string) =>
  createSale(ctx.db, {
    lines: [{ productId, unitId: ctx.unitPieceId, qtyMilli: 1000 }],
    payments: [{ methodId: ctx.cashMethodId, amount: 5_000 }],
    saleDate: when,
    actor: ctx.actor,
  });

function shop() {
  const ctx = makeTestDb();
  const product = createProduct(
    ctx.db,
    { name: 'সাবান', unitId: ctx.unitPieceId, salePrice: 5_000, openingStockMilli: 50_000 },
    ctx.actor,
  );
  return { ctx, product };
}

describe('day bounds', () => {
  it('builds the first and last instant of a day', () => {
    expect(dayStart('2026-11-06')).toBe('2026-11-06 00:00:00');
    expect(dayEnd('2026-11-06')).toBe('2026-11-06 23:59:59');
    // A timestamp passed by mistake is truncated to its date, never to something invalid.
    expect(dayStart('2026-11-06 12:30:00')).toBe('2026-11-06 00:00:00');
    expect(dayEnd('2026-11-06T12:30:00')).toBe('2026-11-06 23:59:59');
  });
});

describe('a one-day filter includes both boundary seconds', () => {
  it('includes 00:00:00 and 23:59:59 and excludes the seconds outside', () => {
    const { ctx, product } = shop();
    sellAt(ctx, product.id, '2026-11-05 23:59:59');
    sellAt(ctx, product.id, '2026-11-06 00:00:00');
    const middle = sellAt(ctx, product.id, '2026-11-06 12:00:00');
    sellAt(ctx, product.id, '2026-11-06 23:59:59');
    sellAt(ctx, product.id, '2026-11-07 00:00:00');

    const { rows, total } = listSales(ctx.db, { from: '2026-11-06', to: '2026-11-06' });
    expect(total).toBe(3);
    expect(rows.map((r) => r.id).sort((a, b) => a - b)).toEqual(
      [middle.saleId - 1, middle.saleId, middle.saleId + 1].sort((a, b) => a - b),
    );
  });

  it('works with only one end given', () => {
    const { ctx, product } = shop();
    sellAt(ctx, product.id, '2026-11-05 10:00:00');
    sellAt(ctx, product.id, '2026-11-06 10:00:00');
    sellAt(ctx, product.id, '2026-11-07 10:00:00');

    expect(listSales(ctx.db, { from: '2026-11-06' }).total).toBe(2);
    expect(listSales(ctx.db, { to: '2026-11-06' }).total).toBe(2);
    expect(listSales(ctx.db, { from: '2026-11-06', to: '2026-11-06' }).total).toBe(1);
  });

  it('applies the same range to expenses', () => {
    const { ctx } = shop();
    const category = ctx.db.prepare('SELECT id FROM expense_categories LIMIT 1').get() as { id: number };
    for (const [date, amount] of [
      ['2026-11-05 23:59:59', 100],
      ['2026-11-06 00:00:00', 200],
      ['2026-11-06 23:59:59', 300],
      ['2026-11-07 00:00:00', 400],
    ] as const) {
      createExpense(
        ctx.db,
        {
          categoryId: category.id,
          amountPaisa: amount,
          expenseDate: date,
          description: 'পরীক্ষা',
          methodId: ctx.cashMethodId,
        },
        ctx.actor,
      );
    }
    const { rows } = listExpenses(ctx.db, { from: '2026-11-06', to: '2026-11-06' });
    expect(rows.map((r) => r.amount_paisa).sort((a, b) => a - b)).toEqual([200, 300]);
  });
});
