import { describe, expect, it } from 'vitest';
import { makeTestDb } from './helpers.js';
import * as core from '../src/index.js';

/**
 * F-INV-01 follow-up: the fix changes the renderer, so any shop that entered opening stock before
 * v1.2.0 keeps whatever number it stored. These tests pin that the review is (a) read-only, (b)
 * limited to products where the mistake is possible, and (c) honest about a mixed history instead
 * of offering an automatic correction.
 */
describe('stock scale review (F-INV-01 legacy data)', () => {
  const legacy = (t: any, opts: { name: string; unitId: number; base: number; type?: string; when: string }) => {
    const p = core.createProduct(
      t.db,
      { name: opts.name, unitId: opts.unitId, salePrice: 120_000, openingStockMilli: opts.base },
      t.actor,
    );
    t.db
      .prepare('UPDATE stock_movements SET created_at = ? WHERE product_id = ?')
      .run(opts.when, p.id);
    return p;
  };

  it('lists কেজি products whose stock predates the fix, with the ratio that would explain it', () => {
    const t = makeTestDb();
    const rice = legacy(t, { name: 'চাল', unitId: t.unitKgId, base: 10_000, when: '2026-03-01T10:00:00' });
    core.createProduct(t.db, { name: 'কলম', unitId: t.unitPieceId, salePrice: 1_000, openingStockMilli: 5_000 }, t.actor);

    const review = core.stockScaleSuspects(t.db, { fixedFromIso: '2026-11-07' });
    expect(review.suspects.map((s) => s.productId)).toContain(rice.id);
    // a পিস product has factor 1000, so no scale mistake is possible in either direction
    expect(review.suspects.map((s) => s.name)).not.toContain('কলম');
    const row = review.suspects.find((s) => s.productId === rice.id)!;
    expect(row.scaleRatio).toBe(1_000);
    expect(row.asPrimaryMilli).toBe(10); // "10" — the number the shop typed
    expect(row.reason).toMatch(/whole quantity is suspect/);
    t.cleanup();
  });

  it('does not report stock written after the fix, and never writes to the database', () => {
    const t = makeTestDb();
    const fixed = legacy(t, { name: 'ডাল', unitId: t.unitKgId, base: 10_000_000, when: '2026-12-01T10:00:00' });
    const before = t.db.prepare('SELECT stock_base_milli q FROM products WHERE id=?').get(fixed.id);
    const review = core.stockScaleSuspects(t.db, { fixedFromIso: '2026-11-07' });
    expect(review.suspects.map((s) => s.productId)).not.toContain(fixed.id);
    const after = t.db.prepare('SELECT stock_base_milli q FROM products WHERE id=?').get(fixed.id);
    expect(after).toEqual(before);
    t.cleanup();
  });

  it('flags a mixed history (opening from the old form + purchases) for human reconciliation', () => {
    const t = makeTestDb();
    const sugar = legacy(t, { name: 'চিনি', unitId: t.unitKgId, base: 10_000, when: '2026-03-01T10:00:00' });
    t.db
      .prepare("INSERT INTO stock_movements (product_id, type, qty_base_milli, balance_after_milli, created_at) VALUES (?,?,?,?,?)")
      .run(sugar.id, 'purchase', 10_000_000, 10_010_000, '2026-03-02T10:00:00');
    const review = core.stockScaleSuspects(t.db, { fixedFromIso: '2026-11-07' });
    const row = review.suspects.find((s) => s.productId === sugar.id)!;
    expect(row.purchaseMovements).toBe(1);
    expect(row.reason).toMatch(/mixed with correctly converted purchases/);
    t.cleanup();
  });

  it('reports nothing on a clean database', () => {
    const t = makeTestDb();
    core.createProduct(t.db, { name: 'চাল', unitId: t.unitKgId, salePrice: 120_000, openingStockMilli: 10_000_000 }, t.actor);
    expect(core.stockScaleSuspects(t.db).suspects).toHaveLength(0);
    t.cleanup();
  });
});
