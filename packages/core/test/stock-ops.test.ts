import { describe, expect, it } from 'vitest';
import {
  assembleBundle,
  bundleCapacity,
  createLocation,
  createProduct,
  createSale,
  createStockCount,
  createTransfer,
  deadStock,
  defaultLocationId,
  inventoryValuation,
  listLocations,
  listMovements,
  listSerials,
  listTransfers,
  locationStock,
  markSerialsSold,
  postStockCount,
  reconcile,
  registerSerials,
  reorderSuggestions,
  setBundle,
  stockCountItems,
  setCountedQty,
  voidStockCount,
} from '../src/index.js';
import { makeTestDb } from './helpers.js';

const piece = (ctx: ReturnType<typeof makeTestDb>, name: string, stock = 0, cost = 4_000_000_000, salePrice = 6000) =>
  createProduct(
    ctx.db,
    {
      name,
      unitId: ctx.unitPieceId,
      salePrice,
      openingStockMilli: stock,
      openingCostMicro: cost,
    },
    ctx.actor,
  );

describe('locations', () => {
  it('always has a default shop and can add a godown', () => {
    const ctx = makeTestDb();
    const before = listLocations(ctx.db);
    expect(before.length).toBeGreaterThanOrEqual(1);
    const def = before.find((l) => l.is_default === 1);
    expect(def).toBeTruthy();
    expect(def!.id).toBe(defaultLocationId(ctx.db));

    const godown = createLocation(ctx.db, { name: 'গুদাম-১', kind: 'godown' }, ctx.actor);
    expect(godown.kind).toBe('godown');
    expect(() => createLocation(ctx.db, { name: 'গুদাম-১' }, ctx.actor)).toThrow(/আরেকটি লোকেশন/);
    ctx.cleanup();
  });
});

describe('stock transfers', () => {
  it('moves the location mirror without changing total stock', () => {
    const ctx = makeTestDb();
    const p = piece(ctx, 'চা-পাতা', 10_000);
    const godown = createLocation(ctx.db, { name: 'গুদাম-২', kind: 'godown' }, ctx.actor);
    const shop = defaultLocationId(ctx.db);

    const t = createTransfer(
      ctx.db,
      { fromLocationId: shop, toLocationId: godown.id, items: [{ productId: p.id, qtyBaseMilli: 4000 }], actor: ctx.actor },
    );
    expect(t.item_count).toBe(1);
    expect(t.total_qty).toBe(4000);

    const total = ctx.db.prepare('SELECT stock_base_milli AS q FROM products WHERE id = ?').get(p.id) as { q: number };
    expect(total.q).toBe(10_000); // total untouched

    const levels = locationStock(ctx.db, p.id);
    expect(levels.find((l) => l.location_id === shop)!.qty_base_milli).toBe(6000);
    expect(levels.find((l) => l.location_id === godown.id)!.qty_base_milli).toBe(4000);

    // Two mirror movements are recorded, one out and one in.
    const mv = listMovements(ctx.db, { productId: p.id, type: 'transfer' });
    expect(mv.total).toBe(2);
    expect(listTransfers(ctx.db).total).toBe(1);

    ctx.cleanup();
  });

  it('refuses to send more than the source location holds', () => {
    const ctx = makeTestDb();
    const p = piece(ctx, 'লবণ', 2000);
    const godown = createLocation(ctx.db, { name: 'গুদাম-৩', kind: 'godown' }, ctx.actor);
    expect(() =>
      createTransfer(ctx.db, {
        fromLocationId: defaultLocationId(ctx.db),
        toLocationId: godown.id,
        items: [{ productId: p.id, qtyBaseMilli: 5000 }],
        actor: ctx.actor,
      }),
    ).toThrow(/পাঠানো যাবে না/);
    // A rejected transfer must not leave a half-written document behind.
    expect(listTransfers(ctx.db).total).toBe(0);
    ctx.cleanup();
  });

  it('rejects transfers to the same location', () => {
    const ctx = makeTestDb();
    const p = piece(ctx, 'চিনি', 5000);
    const shop = defaultLocationId(ctx.db);
    expect(() =>
      createTransfer(ctx.db, { fromLocationId: shop, toLocationId: shop, items: [{ productId: p.id, qtyBaseMilli: 1000 }] }),
    ).toThrow(/একই লোকেশন/);
    ctx.cleanup();
  });
});

describe('physical stock count', () => {
  it('posts the counted differences as adjustments and journal entries', () => {
    const ctx = makeTestDb();
    const p = piece(ctx, 'গুঁড়া দুধ', 12_000); // 12 pcs @ 40 taka
    const count = createStockCount(ctx.db, { note: 'মাসিক গণনা', actor: ctx.actor });
    expect(count.status).toBe('draft');
    expect(count.item_count).toBeGreaterThan(0);

    const items = stockCountItems(ctx.db, count.id);
    const line = items.find((i) => i.product_id === p.id)!;
    expect(line.system_qty_milli).toBe(12_000);

    // One piece short, one extra product untouched.
    setCountedQty(ctx.db, count.id, p.id, 11_000);
    const res = postStockCount(ctx.db, count.id, ctx.actor);
    expect(res.adjusted).toBe(1);

    const after = ctx.db.prepare('SELECT stock_base_milli AS q FROM products WHERE id = ?').get(p.id) as { q: number };
    expect(after.q).toBe(11_000);

    const posted = ctx.db.prepare('SELECT status FROM stock_counts WHERE id = ?').get(count.id) as { status: string };
    expect(posted.status).toBe('posted');
    expect(() => postStockCount(ctx.db, count.id, ctx.actor)).toThrow(/আগেই পোস্ট/);
    expect(() => setCountedQty(ctx.db, count.id, p.id, 5_000)).toThrow(/পোস্ট হওয়া/);

    // Shortage hits the inventory-loss account, so the books stay balanced.
    const loss = ctx.db
      .prepare(
        `SELECT COALESCE(SUM(l.debit_paisa - l.credit_paisa),0) AS v FROM journal_lines l
          JOIN accounts a ON a.id = l.account_id WHERE a.code = '5300'`,
      )
      .get() as { v: number };
    expect(loss.v).toBe(4000); // 1 pc × 40 taka
    const checks = reconcile(ctx.db, '2000-01-01', '2999-12-31');
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    ctx.cleanup();
  });

  it('cancels a draft count but never a posted one', () => {
    const ctx = makeTestDb();
    piece(ctx, 'মসলা', 3000);
    const c1 = createStockCount(ctx.db, { actor: ctx.actor });
    voidStockCount(ctx.db, c1.id, ctx.actor);
    const row = ctx.db.prepare('SELECT status FROM stock_counts WHERE id = ?').get(c1.id) as { status: string };
    expect(row.status).toBe('cancelled');

    const c2 = createStockCount(ctx.db, { actor: ctx.actor });
    postStockCount(ctx.db, c2.id, ctx.actor);
    expect(() => voidStockCount(ctx.db, c2.id, ctx.actor)).toThrow(/বাতিল করা যাবে না/);
    ctx.cleanup();
  });
});

describe('reorder, valuation and dead stock', () => {
  it('suggests a purchase quantity with a stated reason', () => {
    const ctx = makeTestDb();
    const low = createProduct(
      ctx.db,
      { name: 'সাবান', unitId: ctx.unitPieceId, salePrice: 4000, openingStockMilli: 2000, openingCostMicro: 3_000_000_000, minStockMilli: 10_000 },
      ctx.actor,
    );
    piece(ctx, 'চাল', 200_000);
    const rows = reorderSuggestions(ctx.db, { pending: true } as never);
    const hit = rows.find((r: any) => r.id === low.id);
    expect(hit).toBeTruthy();
    expect(hit.suggested_base_milli).toBeGreaterThan(0);
    expect(String(hit.reason).length).toBeGreaterThan(5);
    ctx.cleanup();
  });

  it('values stock at weighted average cost and labels the method', () => {
    const ctx = makeTestDb();
    piece(ctx, 'বিস্কুট', 10_000, 4_000_000_000); // 10 pcs @ 40 taka
    const v = inventoryValuation(ctx.db, {});
    expect(v.method).toContain('WAC');
    expect(v.totals.value_paisa).toBe(40_000);
    ctx.cleanup();
  });

  it('lists stock that has not sold recently', () => {
    const ctx = makeTestDb();
    const slow = piece(ctx, 'পুরোনো মাল', 5000, 4_000_000_000);
    const dead = deadStock(ctx.db, 30);
    expect(dead.map((d: any) => d.id)).toContain(slow.id);
    ctx.cleanup();
  });
});

describe('serial numbers', () => {
  it('registers serials, sells them once and never twice', () => {
    const ctx = makeTestDb();
    const p = piece(ctx, 'মোবাইল', 3000, 800_000_000_000, 900_000);
    const reg = registerSerials(ctx.db, { productId: p.id, serials: ['IMEI-1', 'IMEI-2', 'IMEI-1'], actor: ctx.actor });
    expect(reg.added).toBe(2);
    expect(reg.skipped).toEqual(['IMEI-1']);

    const sale = createSale(ctx.db, {
      lines: [{ productId: p.id, unitId: ctx.unitPieceId, qtyMilli: 1000, unitPricePaisa: 900_000, serials: ['IMEI-1'] }],
      payments: [{ methodId: ctx.cashMethodId, amount: 900_000 }],
      actor: ctx.actor,
    });
    expect(sale.saleId).toBeGreaterThan(0);

    const sold = listSerials(ctx.db, { productId: p.id, status: 'sold' });
    expect(sold.total).toBe(1);
    expect(sold.rows[0].sale_id).toBe(sale.saleId);

    expect(() => markSerialsSold(ctx.db, ['IMEI-1'], sale.saleId + 1, ctx.actor)).toThrow(/পাওয়া যায়নি/);
    expect(listSerials(ctx.db, { productId: p.id, status: 'in_stock' }).total).toBe(1);
    ctx.cleanup();
  });
});

describe('bundles', () => {
  it('assembles a bundle without changing inventory value', () => {
    const ctx = makeTestDb();
    const a = piece(ctx, 'বান্ডল-ক', 10_000, 1_000_000_000); // 10 pcs @ 10 taka
    const b = piece(ctx, 'বান্ডল-খ', 10_000, 2_000_000_000); // 10 pcs @ 20 taka
    const gift = piece(ctx, 'গিফট প্যাক', 0, 0, 50_000);

    setBundle(ctx.db, gift.id, [{ childId: a.id, qtyBaseMilli: 1000 }, { childId: b.id, qtyBaseMilli: 1000 }], ctx.actor);
    expect(bundleCapacity(ctx.db, gift.id)).toBe(10);

    const before = inventoryValuation(ctx.db, {}).totals.value_paisa;
    assembleBundle(ctx.db, { parentId: gift.id, count: 1, actor: ctx.actor });

    const parent = ctx.db.prepare('SELECT stock_base_milli, avg_cost_micro FROM products WHERE id = ?').get(gift.id) as any;
    expect(parent.stock_base_milli).toBe(1000);
    const after = inventoryValuation(ctx.db, {}).totals.value_paisa;
    // 10 + 20 taka moved into the pack; value must be preserved (± rounding).
    expect(Math.abs(after - before)).toBeLessThanOrEqual(2);
    expect(parent.avg_cost_micro).toBeGreaterThan(2_000_000_000);

    expect(() => assembleBundle(ctx.db, { parentId: gift.id, count: 50, actor: ctx.actor })).toThrow(/স্টক যথেষ্ট নয়/);
    ctx.cleanup();
  });
});
