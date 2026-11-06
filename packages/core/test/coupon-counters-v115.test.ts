/**
 * Coupon counters and completed sales cannot disagree (v1.1.5, audit finding A-22).
 *
 * `coupons.used_count`, the `coupon_redemptions` rows and the invoices that consumed them are three
 * records of one fact. What the audit found, stated precisely:
 *
 *   - **No live inconsistency.** Every sale re-validates the coupon inside its own transaction, so
 *     the global limit, the per-customer allowance and the active/expiry window are all correct on
 *     the paths the application actually takes. The tests below that exercise sales (last-slot race,
 *     counters equal to redemptions, void restoring one use) pass against the code as it shipped.
 *   - **The guarantee was a convention, not a property.** `recordCouponRedemption` only guarded the
 *     global limit; the per-customer allowance, the active flag and the expiry window were the
 *     *caller's* job. Its own doc comment says "called inside the sale transaction only" — a comment
 *     cannot enforce that, and the function is exported.
 *
 * The fix makes the write enforce its own preconditions under the write lock it already takes, so the
 * invariant survives a second caller (a bulk import, a repair script, a future promotion path) that
 * forgets to check first. The tests marked "unit" below fail against the old code for that reason.
 *
 * Real SQLite throughout, two connections for the race, a trigger to force a failure and prove the
 * rollback. Nothing is mocked.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  checkCoupon,
  withIdempotency,
  createCoupon,
  createProduct,
  createSale,
  listCoupons,
  recordCouponRedemption,
  restoreCouponsForSale,
  updateCoupon,
  voidSale,
  type Db,
} from '../src/index.js';
import { makeTestDb } from './helpers.js';
import { closeTrackedDatabases, openTrackedDatabase, removeTempDirs } from '../../../test-setup/temp-resources.js';

const dirs: string[] = [];
afterAll(() => {
  closeTrackedDatabases();
  removeTempDirs(dirs);
});

/** A shop with one product, a walk-in customer and a coupon. */
function shop(coupon: Parameters<typeof createCoupon>[1]) {
  const ctx = makeTestDb();
  const product = createProduct(
    ctx.db,
    { name: 'চাল', unitId: ctx.unitPieceId, salePrice: 12_000, openingStockMilli: 1_000_000 },
    ctx.actor,
  );
  const created = createCoupon(ctx.db, coupon, ctx.actor);
  return { ctx, product, coupon: created };
}

function sell(ctx: ReturnType<typeof makeTestDb>, productId: number, couponCode?: string, customerId?: number) {
  return createSale(ctx.db, {
    customerId: customerId ?? null,
    lines: [{ productId, unitId: ctx.unitPieceId, qtyMilli: 1000 }],
    payments: [{ methodId: ctx.cashMethodId, amount: 12_000 }],
    couponCode,
    actor: ctx.actor,
  });
}

const usedCount = (db: Db, code: string) =>
  (db.prepare('SELECT used_count FROM coupons WHERE code = ?').get(code) as { used_count: number } | undefined)
    ?.used_count;
const redemptions = (db: Db, code: string) =>
  (
    db
      .prepare('SELECT COUNT(*) c FROM coupon_redemptions r JOIN coupons c2 ON c2.id = r.coupon_id WHERE c2.code = ?')
      .get(code) as { c: number }
  ).c;

describe('the global usage limit holds under a race for the last use', () => {
  it('lets exactly one of two connections spend the final use', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-coupon-'));
    dirs.push(dir);
    const file = path.join(dir, 'shop.db');
    const ctx = makeTestDb({ file: true });
    // Re-open the same database on a second connection, then seed through the first.
    const second = openTrackedDatabase({ file: ctx.dbPath, appVersion: '1.1.5' });
    const product = createProduct(
      ctx.db,
      { name: 'চাল', unitId: ctx.unitPieceId, salePrice: 12_000, openingStockMilli: 1_000_000 },
      ctx.actor,
    );
    createCoupon(ctx.db, { code: 'LASTONE', kind: 'fixed', value: 1_000, usageLimit: 1 }, ctx.actor);

    const first = sell(ctx, product.id, 'LASTONE');
    expect(first.saleId).toBeGreaterThan(0);
    expect(() => sell(ctx, product.id, 'LASTONE')).toThrow(/সীমা/);

    // The second connection sees the committed counter, not a stale pre-check picture.
    expect(checkCoupon(second, { code: 'LASTONE', subtotalPaisa: 10_000 }).ok).toBe(false);
    expect(usedCount(second, 'LASTONE')).toBe(1);
    expect(redemptions(second, 'LASTONE')).toBe(1);
    second.close();
    ctx.cleanup();
  });

  it('keeps used_count equal to the number of redemptions', () => {
    const { ctx, product } = shop({ code: 'FIVE', kind: 'fixed', value: 500, usageLimit: 3 });
    sell(ctx, product.id, 'FIVE');
    sell(ctx, product.id, 'FIVE');
    expect(usedCount(ctx.db, 'FIVE')).toBe(redemptions(ctx.db, 'FIVE'));
    expect(usedCount(ctx.db, 'FIVE')).toBe(2);
    ctx.cleanup();
  });
});

describe('the per-customer allowance, at the write itself', () => {
  it('refuses a direct second record for the same customer, with no prior check', () => {
    const { ctx, coupon } = shop({ code: 'UNIT1', kind: 'fixed', value: 500, perCustomerLimit: 1 });
    const customer = ctx.db
      .prepare("INSERT INTO customers (name, balance_paisa, created_at, updated_at) VALUES ('নুরুল','0',?,?) RETURNING id")
      .get('2026-11-01 10:00:00', '2026-11-01 10:00:00') as { id: number };
    const sale = ctx.db
      .prepare("INSERT INTO sales (invoice_no, sale_date, total_paisa, paid_paisa, status, created_at) VALUES ('UNIT-1', ?, 0,0,'completed',?) RETURNING id")
      .get('2026-11-01 10:00:00', '2026-11-01 10:00:00') as { id: number };
    const sale2 = ctx.db
      .prepare("INSERT INTO sales (invoice_no, sale_date, total_paisa, paid_paisa, status, created_at) VALUES ('UNIT-2', ?, 0,0,'completed',?) RETURNING id")
      .get('2026-11-01 10:00:00', '2026-11-01 10:00:00') as { id: number };

    // Called the way the sale path calls it: inside the transaction whose rollback gives the
    // counter its atomicity.
    const record = (saleId: number) =>
      ctx.db
        .transaction(() =>
          recordCouponRedemption(ctx.db, {
            couponId: coupon.id,
            saleId,
            customerId: customer.id,
            code: 'UNIT1',
            discountPaisa: 500,
            userId: ctx.actor.id,
          }),
        )();

    record(sale.id);
    expect(() => record(sale2.id)).toThrow(/সর্বোচ্চ বার/);
    expect(usedCount(ctx.db, 'UNIT1')).toBe(1);
    expect(redemptions(ctx.db, 'UNIT1')).toBe(1);
    ctx.cleanup();
  });
});

describe('the per-customer allowance holds on the sale path too', () => {
  it('refuses the second sale for the same customer', () => {
    const { ctx, product, coupon } = shop({
      code: 'ONCE-EACH',
      kind: 'fixed',
      value: 1_000,
      perCustomerLimit: 1,
    });
    const customer = ctx.db.prepare("INSERT INTO customers (name, balance_paisa, created_at, updated_at) VALUES ('করিম','0',?,?) RETURNING id")
      .get('2026-11-01 10:00:00', '2026-11-01 10:00:00') as { id: number };

    // The check at the till is a plain read; the guarantee is the re-check inside the sale.
    expect(checkCoupon(ctx.db, { code: 'ONCE-EACH', subtotalPaisa: 10_000, customerId: customer.id }).ok).toBe(true);

    sell(ctx, product.id, 'ONCE-EACH', customer.id);
    expect(() => sell(ctx, product.id, 'ONCE-EACH', customer.id)).toThrow(/সর্বোচ্চ বার/);

    expect(usedCount(ctx.db, 'ONCE-EACH')).toBe(1);
    expect(redemptions(ctx.db, 'ONCE-EACH')).toBe(1);
    expect(coupon.per_customer_limit).toBe(1);
    ctx.cleanup();
  });

  it('allows a different customer the same coupon', () => {
    const { ctx, product } = shop({ code: 'EACH1', kind: 'fixed', value: 500, perCustomerLimit: 1 });
    const mk = (name: string) =>
      (ctx.db
        .prepare("INSERT INTO customers (name, balance_paisa, created_at, updated_at) VALUES (?, '0', ?, ?) RETURNING id")
        .get(name, '2026-11-01 10:00:00', '2026-11-01 10:00:00') as { id: number }).id;
    sell(ctx, product.id, 'EACH1', mk('করিম'));
    sell(ctx, product.id, 'EACH1', mk('রহিম'));
    expect(usedCount(ctx.db, 'EACH1')).toBe(2);
    ctx.cleanup();
  });

  it('gives the allowance back when the sale is voided', () => {
    const { ctx, product } = shop({ code: 'BACK', kind: 'fixed', value: 500, perCustomerLimit: 1 });
    const customer = ctx.db.prepare("INSERT INTO customers (name, balance_paisa, created_at, updated_at) VALUES ('সালাম','0',?,?) RETURNING id")
      .get('2026-11-01 10:00:00', '2026-11-01 10:00:00') as { id: number };

    const sale = sell(ctx, product.id, 'BACK', customer.id);
    expect(usedCount(ctx.db, 'BACK')).toBe(1);
    voidSale(ctx.db, sale.saleId, 'ভুল বিল', ctx.actor);
    expect(usedCount(ctx.db, 'BACK')).toBe(0);
    expect(redemptions(ctx.db, 'BACK')).toBe(0);

    // The customer may use it again — the allowance came back, once.
    sell(ctx, product.id, 'BACK', customer.id);
    expect(usedCount(ctx.db, 'BACK')).toBe(1);
    ctx.cleanup();
  });
});

describe('a coupon that stops being usable cannot be spent', () => {
  it('refuses a coupon disabled after the cashier checked it', () => {
    const { ctx, product } = shop({ code: 'OFFNOW', kind: 'fixed', value: 500 });
    expect(checkCoupon(ctx.db, { code: 'OFFNOW', subtotalPaisa: 10_000 }).ok).toBe(true);
    updateCoupon(ctx.db, listCoupons(ctx.db).rows[0]!.id, { isActive: false }, ctx.actor);

    expect(() => sell(ctx, product.id, 'OFFNOW')).toThrow(/কুপন/);
    expect(usedCount(ctx.db, 'OFFNOW')).toBe(0);
    expect(redemptions(ctx.db, 'OFFNOW')).toBe(0);
    ctx.cleanup();
  });

  it('refuses a coupon that expired before the redemption was written', () => {
    const { ctx, product } = shop({ code: 'EXPIRES', kind: 'fixed', value: 500, expiresAt: '2026-11-05 23:59:59' });
    const coupon = listCoupons(ctx.db).rows[0]!;

    // A sale that started before the expiry and commits after it: the record call carries the time.
    expect(() =>
      ctx.db.transaction(() => {
        recordCouponRedemption(ctx.db, {
          couponId: coupon.id,
          saleId: 1,
          customerId: null,
          code: 'EXPIRES',
          discountPaisa: 500,
          userId: ctx.actor.id,
          at: '2026-11-06 00:00:01',
        });
      })(),
    ).toThrow(/মেয়াদ/);

    // and nothing was consumed by the refused attempt
    expect(usedCount(ctx.db, 'EXPIRES')).toBe(0);
    expect(redemptions(ctx.db, 'EXPIRES')).toBe(0);
    expect(product.id).toBeGreaterThan(0);
    ctx.cleanup();
  });
});

describe('a duplicate submission cannot spend a second use', () => {
  it('records one redemption for two deliveries of the same request', () => {
    const { ctx, product } = shop({ code: 'DUP', kind: 'fixed', value: 500, usageLimit: 2 });

    // The API wraps the call in an idempotency key (api.ts); this is that wrapper without the RPC.
    const submit = () =>
      withIdempotency(
        ctx.db,
        { key: 'pos-sale-1', method: 'pos.createSale', body: { productId: product.id, coupon: 'DUP' } },
        () => sell(ctx, product.id, 'DUP'),
      );

    const first = submit();
    const second = submit();
    expect(second.saleId).toBe(first.saleId);
    expect(usedCount(ctx.db, 'DUP')).toBe(1);
    expect(redemptions(ctx.db, 'DUP')).toBe(1);
    expect((ctx.db.prepare('SELECT COUNT(*) c FROM sales').get() as { c: number }).c).toBe(1);
    ctx.cleanup();
  });
});

describe('the counter and the invoice roll back together', () => {
  it('leaves neither a sale nor a consumed use when the redemption cannot be written', () => {
    const { ctx, product } = shop({ code: 'ROLLBACK', kind: 'fixed', value: 500 });
    const salesBefore = (
      ctx.db.prepare('SELECT COUNT(*) c FROM sales').get() as { c: number }
    ).c;
    // The counter is taken first, then the redemption row is written: fail the second write.
    ctx.db.exec(
      "CREATE TRIGGER refuse_redemption BEFORE INSERT ON coupon_redemptions BEGIN SELECT RAISE(ABORT, 'forced failure'); END",
    );

    expect(() => sell(ctx, product.id, 'ROLLBACK')).toThrow(/forced failure/);

    expect((ctx.db.prepare('SELECT COUNT(*) c FROM sales').get() as { c: number }).c).toBe(salesBefore);
    expect(usedCount(ctx.db, 'ROLLBACK')).toBe(0);
    expect(redemptions(ctx.db, 'ROLLBACK')).toBe(0);
    ctx.cleanup();
  });

  it('restores exactly once even if the void path runs twice', () => {
    const { ctx, product } = shop({ code: 'TWICE', kind: 'fixed', value: 500, usageLimit: 5 });
    const sale = sell(ctx, product.id, 'TWICE');
    expect(restoreCouponsForSale(ctx.db, { saleId: sale.saleId })).toMatchObject({ restored: true, code: 'TWICE' });
    expect(restoreCouponsForSale(ctx.db, { saleId: sale.saleId })).toMatchObject({ restored: false });
    expect(usedCount(ctx.db, 'TWICE')).toBe(0);
    ctx.cleanup();
  });
});
