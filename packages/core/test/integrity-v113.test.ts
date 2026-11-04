/**
 * v1.1.3 business-integrity regressions.
 *
 * Three defects that a shop would only notice weeks later:
 *   - a voided invoice burnt a limited coupon's usage forever;
 *   - a serial/IMEI sold by a voided (or returned) invoice stayed "sold" forever,
 *     so the same phone could never be sold again;
 *   - "automatic backup" only ran at startup, so a till left open never backed up.
 */
import { describe, expect, it } from 'vitest';
import {
  createCoupon,
  createPurchase,
  createSale,
  createSaleReturn,
  createBackup,
  getCoupon,
  getProduct,
  getSale,
  registerSerials,
  shouldAutoBackup,
  voidSale,
} from '../src/index.js';
import { makeTestDb, seedProducts } from './helpers.js';

type Ctx = ReturnType<typeof makeTestDb>;

/** seedProducts only creates the catalogue row; every sale needs real stock. */
function stockUp(ctx: Ctx, productId: number, kg = 10) {
  const supplier = ctx.db.prepare('SELECT id FROM suppliers LIMIT 1').get() as { id: number };
  createPurchase(ctx.db, {
    supplierId: supplier.id,
    lines: [{ productId, unitId: ctx.unitKgId, qtyMilli: kg * 1000, unitPricePaisa: 7000 }],
    paidPaisa: kg * 7000,
    defaultMethodId: ctx.cashMethodId,
    actor: ctx.actor,
  });
}

function couponUses(ctx: Ctx, id: number) {
  const row = ctx.db.prepare('SELECT used_count FROM coupons WHERE id = ?').get(id) as { used_count: number };
  const redemptions = ctx.db.prepare('SELECT COUNT(*) c FROM coupon_redemptions WHERE coupon_id = ?').get(id) as {
    c: number;
  };
  return { used: row.used_count, redemptions: redemptions.c };
}

describe('voiding a sale gives the coupon back', () => {
  it('restores the global usage limit exactly once', () => {
    const ctx = makeTestDb();
    const { rice, customer } = seedProducts(ctx);
    stockUp(ctx, rice.id);
    const coupon = createCoupon(
      ctx.db,
      { code: 'ONCE10', kind: 'percent', value: 1000, usageLimit: 1, perCustomerLimit: 0 },
      ctx.actor,
    );

    const sale = createSale(ctx.db, {
      customerId: customer.id,
      couponCode: 'ONCE10',
      lines: [{ productId: rice.id, unitId: ctx.unitKgId, qtyMilli: 1000 }],
      paidPaisa: 0,
      actor: ctx.actor,
    });
    expect(couponUses(ctx, coupon.id)).toEqual({ used: 1, redemptions: 1 });

    // A second sale with the same coupon must be refused while the first stands.
    expect(() =>
      createSale(ctx.db, {
        customerId: customer.id,
        couponCode: 'ONCE10',
        lines: [{ productId: rice.id, unitId: ctx.unitKgId, qtyMilli: 1000 }],
        paidPaisa: 0,
        actor: ctx.actor,
      }),
    ).toThrow(/সীমা শেষ/);

    voidSale(ctx.db, sale.saleId, 'কাস্টমার বাতিল করল', ctx.actor);
    expect(couponUses(ctx, coupon.id)).toEqual({ used: 0, redemptions: 0 });

    // The coupon is genuinely reusable again.
    const again = createSale(ctx.db, {
      customerId: customer.id,
      couponCode: 'ONCE10',
      lines: [{ productId: rice.id, unitId: ctx.unitKgId, qtyMilli: 1000 }],
      paidPaisa: 0,
      actor: ctx.actor,
    });
    expect(again.saleId).toBeGreaterThan(sale.saleId);
    expect(couponUses(ctx, coupon.id)).toEqual({ used: 1, redemptions: 1 });

    // A repeated void on the already-voided invoice cannot decrement twice.
    expect(() => voidSale(ctx.db, sale.saleId, 'আবার', ctx.actor)).toThrow();
    expect(couponUses(ctx, coupon.id)).toEqual({ used: 1, redemptions: 1 });
    expect(getCoupon(ctx.db, coupon.id)!.used_count).toBe(1);
    ctx.cleanup();
  });

  it('restores the per-customer allowance', () => {
    const ctx = makeTestDb();
    const { rice, customer } = seedProducts(ctx);
    stockUp(ctx, rice.id);
    const coupon = createCoupon(
      ctx.db,
      { code: 'CUST1', kind: 'fixed', value: 5000, usageLimit: 0, perCustomerLimit: 1 },
      ctx.actor,
    );
    const sale = createSale(ctx.db, {
      customerId: customer.id,
      couponCode: 'CUST1',
      lines: [{ productId: rice.id, unitId: ctx.unitKgId, qtyMilli: 1000 }],
      paidPaisa: 0,
      actor: ctx.actor,
    });
    expect(() =>
      createSale(ctx.db, {
        customerId: customer.id,
        couponCode: 'CUST1',
        lines: [{ productId: rice.id, unitId: ctx.unitKgId, qtyMilli: 1000 }],
        paidPaisa: 0,
        actor: ctx.actor,
      }),
    ).toThrow(/সর্বোচ্চ বার/);

    voidSale(ctx.db, sale.saleId, 'বাতিল', ctx.actor);
    const second = createSale(ctx.db, {
      customerId: customer.id,
      couponCode: 'CUST1',
      lines: [{ productId: rice.id, unitId: ctx.unitKgId, qtyMilli: 1000 }],
      paidPaisa: 0,
      actor: ctx.actor,
    });
    expect(second.saleId).toBeGreaterThan(sale.saleId);
    expect(couponUses(ctx, coupon.id).used).toBe(1);
    ctx.cleanup();
  });
});

describe('serial / IMEI lifecycle follows the invoice', () => {
  const serialRow = (db: ReturnType<typeof makeTestDb>['db'], serial: string) =>
    db.prepare('SELECT status, sale_id FROM serial_numbers WHERE serial = ?').get(serial) as {
      status: string;
      sale_id: number | null;
    };

  it('frees the serial when a sale is voided and allows selling it again', () => {
    const ctx = makeTestDb();
    const { rice, customer } = seedProducts(ctx);
    stockUp(ctx, rice.id);
    registerSerials(ctx.db, { productId: rice.id, serials: ['IMEI-0001'], actor: ctx.actor });

    const sale = createSale(ctx.db, {
      customerId: customer.id,
      lines: [{ productId: rice.id, unitId: ctx.unitKgId, qtyMilli: 1000, serials: ['IMEI-0001'] }],
      paidPaisa: 0,
      actor: ctx.actor,
    });
    expect(serialRow(ctx.db, 'IMEI-0001')).toEqual({ status: 'sold', sale_id: sale.saleId });

    voidSale(ctx.db, sale.saleId, 'ভুল ইনভয়েস', ctx.actor);
    expect(serialRow(ctx.db, 'IMEI-0001')).toEqual({ status: 'in_stock', sale_id: sale.saleId });

    // Voiding twice must not touch it again, and it can be sold on a new invoice.
    expect(() => voidSale(ctx.db, sale.saleId, 'আবার', ctx.actor)).toThrow();
    const resold = createSale(ctx.db, {
      customerId: customer.id,
      lines: [{ productId: rice.id, unitId: ctx.unitKgId, qtyMilli: 1000, serials: ['IMEI-0001'] }],
      paidPaisa: 0,
      actor: ctx.actor,
    });
    expect(serialRow(ctx.db, 'IMEI-0001')).toEqual({ status: 'sold', sale_id: resold.saleId });
    ctx.cleanup();
  });

  it('puts a returned good unit back on sale and quarantines a damaged one', () => {
    const ctx = makeTestDb();
    const { rice, customer } = seedProducts(ctx);
    stockUp(ctx, rice.id);
    registerSerials(ctx.db, { productId: rice.id, serials: ['IMEI-0002', 'IMEI-0003'], actor: ctx.actor });
    const sale = createSale(ctx.db, {
      customerId: customer.id,
      lines: [
        {
          productId: rice.id,
          unitId: ctx.unitKgId,
          qtyMilli: 2000,
          serials: ['IMEI-0002', 'IMEI-0003'],
        },
      ],
      paidPaisa: 0,
      actor: ctx.actor,
    });
    const line = getSale(ctx.db, sale.saleId)!.items![0]!;

    createSaleReturn(ctx.db, {
      saleId: sale.saleId,
      items: [{ lineId: line.id, qtyMilli: 1000, condition: 'good', serials: ['IMEI-0002'] }],
      refundPaisa: 0,
      actor: ctx.actor,
    });
    expect(serialRow(ctx.db, 'IMEI-0002').status).toBe('in_stock');

    createSaleReturn(ctx.db, {
      saleId: sale.saleId,
      items: [{ lineId: line.id, qtyMilli: 1000, condition: 'damaged', serials: ['IMEI-0003'] }],
      refundPaisa: 0,
      actor: ctx.actor,
    });
    expect(serialRow(ctx.db, 'IMEI-0003').status).toBe('damaged');

    // A serial can only be returned once, and only against the invoice that sold it.
    expect(() =>
      createSaleReturn(ctx.db, {
        saleId: sale.saleId,
        items: [{ lineId: line.id, qtyMilli: 1000, condition: 'good', serials: ['IMEI-0002'] }],
        refundPaisa: 0,
        actor: ctx.actor,
      }),
    ).toThrow();
    ctx.cleanup();
  });

  it('rejects a serial that this invoice never sold', () => {
    const ctx = makeTestDb();
    const { rice, soap, customer } = seedProducts(ctx);
    stockUp(ctx, rice.id);
    // The soap serial exists but belongs to a different product than the invoice line.
    stockUp(ctx, soap.id, 1);
    registerSerials(ctx.db, { productId: soap.id, serials: ['SOAP-S1'], actor: ctx.actor });
    const sale = createSale(ctx.db, {
      customerId: customer.id,
      lines: [{ productId: rice.id, unitId: ctx.unitKgId, qtyMilli: 1000 }],
      paidPaisa: 0,
      actor: ctx.actor,
    });
    const line = getSale(ctx.db, sale.saleId)!.items![0]!;
    expect(() =>
      createSaleReturn(ctx.db, {
        saleId: sale.saleId,
        items: [{ lineId: line.id, qtyMilli: 1000, condition: 'good', serials: ['SOAP-S1'] }],
        refundPaisa: 0,
        actor: ctx.actor,
      }),
    ).toThrow(/এই লাইনের পণ্য নয়|এই ইনভয়েসের বিক্রীত তালিকায় নেই/);
    expect(serialRow(ctx.db, 'SOAP-S1').status).toBe('in_stock');
    ctx.cleanup();
  });
});

describe('automatic backups keep happening while the app stays open', () => {
  it('is due once per interval, not once per process start', () => {
    const ctx = makeTestDb();
    seedProducts(ctx);
    ctx.db.prepare("UPDATE settings SET value = '1' WHERE key = 'auto_backup_enabled'").run();
    ctx.db.prepare("UPDATE settings SET value = 'daily' WHERE key = 'auto_backup_interval'").run();
    expect(shouldAutoBackup(ctx.db)).toBe(true);

    const dir = `${ctx.dir}/backups`;
    createBackup(ctx.db, { dataDir: dir, kind: 'auto', appVersion: '1.1.3' });
    // A freshly written backup satisfies today's policy; the 15-minute timer in the
    // desktop shell re-checks this, which is what a long-running till needs.
    expect(shouldAutoBackup(ctx.db)).toBe(false);

    // Age the record by two days: due again without a restart.
    ctx.db.prepare("UPDATE backups SET created_at = datetime('now', '-2 days') WHERE kind = 'auto'").run();
    expect(shouldAutoBackup(ctx.db)).toBe(true);
    ctx.cleanup();
  });

  it('does not stay silent after the clock jumps backwards', () => {
    const ctx = makeTestDb();
    seedProducts(ctx);
    ctx.db.prepare("UPDATE settings SET value = '1' WHERE key = 'auto_backup_enabled'").run();
    ctx.db.prepare("UPDATE settings SET value = 'daily' WHERE key = 'auto_backup_interval'").run();
    createBackup(ctx.db, { dataDir: `${ctx.dir}/backups`, kind: 'auto', appVersion: '1.1.3' });
    // A backup stamped tomorrow (clock correction, timezone move) must not disable
    // backups until the wall clock catches up.
    ctx.db.prepare("UPDATE backups SET created_at = datetime('now', '+2 days') WHERE kind = 'auto'").run();
    expect(shouldAutoBackup(ctx.db)).toBe(true);
    ctx.cleanup();
  });
});
