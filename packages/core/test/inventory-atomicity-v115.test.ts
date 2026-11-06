/**
 * Stock adjustments are all-or-nothing (v1.1.5, audit finding A-01).
 *
 * `adjustStock` and `writeOffStock` write five things: the product balance, the per-location
 * mirror, the movement row, the audit entry and the accounting posting. Until v1.1.5 those
 * statements ran without a transaction, so a posting that failed left the stock moved and the
 * ledger untouched. Nothing in the app reports that divergence, and the shop's books stop matching
 * its shelves.
 *
 * The failure is injected through the real code path — the ledger account the posting needs is
 * gone, which is exactly what a damaged or half-restored chart of accounts looks like — rather than
 * by mocking the accounting module, so the test exercises the same statements the shop would run.
 */
import { describe, expect, it } from 'vitest';
import { adjustStock, writeOffStock } from '../src/services/inventory.js';
import { createProduct } from '../src/services/products.js';
import { ACCOUNT_CODES } from '../src/services/accounting.js';
import { makeTestDb } from './helpers.js';

function productWithStock() {
  const ctx = makeTestDb();
  const product = createProduct(
    ctx.db,
    { name: 'ময়দা', unitId: ctx.unitPieceId, salePrice: 6000, openingStockMilli: 10_000, openingCostMicro: 4_000_000_000 },
    ctx.actor,
  );
  const read = () =>
    ctx.db.prepare('SELECT stock_base_milli FROM products WHERE id = ?').get(product.id) as {
      stock_base_milli: number;
    };
  const movements = () =>
    (ctx.db.prepare('SELECT COUNT(*) AS n FROM stock_movements WHERE product_id = ?').get(product.id) as {
      n: number;
    }).n;
  const audits = () =>
    (ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action LIKE 'stock.%'").get() as {
      n: number;
    }).n;
  /** Removes the account a negative adjustment needs, so its posting throws. */
  const breakLedger = () => {
    const removed = ctx.db
      .prepare('DELETE FROM accounts WHERE code = ?')
      .run(ACCOUNT_CODES.inventoryLoss).changes;
    expect(removed).toBe(1);
  };
  return { ctx, product, read, movements, audits, breakLedger };
}

describe('adjustStock is atomic', () => {
  it('leaves the product, the movement ledger and the audit trail untouched when the posting fails', () => {
    const { ctx, product, read, movements, audits, breakLedger } = productWithStock();
    const before = { stock: read().stock_base_milli, movements: movements(), audits: audits() };
    breakLedger();

    expect(() =>
      adjustStock(ctx.db, {
        productId: product.id,
        newQtyBaseMilli: 6_000, // a shortfall: needs the inventory-loss account
        reason: 'স্টক গণনা',
        actor: ctx.actor,
      }),
    ).toThrow(/হিসাব খাত পাওয়া যায়নি/);

    // Before the fix the stock had already been written when the posting blew up.
    expect(read().stock_base_milli).toBe(before.stock);
    expect(movements()).toBe(before.movements);
    expect(audits()).toBe(before.audits);
  });

  it('applies the whole change when the posting succeeds', () => {
    const { ctx, product, read, movements } = productWithStock();
    const before = { stock: read().stock_base_milli, movements: movements() };

    adjustStock(ctx.db, {
      productId: product.id,
      newQtyBaseMilli: before.stock + 500,
      reason: 'স্টক গণনা',
      actor: ctx.actor,
    });

    expect(read().stock_base_milli).toBe(before.stock + 500);
    expect(movements()).toBe(before.movements + 1);
    const posted = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE source = 'stock_adjust'")
      .get() as { n: number };
    expect(posted.n).toBe(1);
  });

  it('records no partial write when the stock write itself is rejected', () => {
    const { ctx, product, movements } = productWithStock();
    const before = movements();
    expect(() =>
      adjustStock(ctx.db, { productId: product.id, newQtyBaseMilli: -1, reason: 'ভুল গণনা', actor: ctx.actor }),
    ).toThrow(/ঋণাত্মক/);
    expect(movements()).toBe(before);
  });
});

describe('writeOffStock is atomic', () => {
  it('keeps the stock when the write-off cannot be posted', () => {
    const { ctx, product, read, movements, audits, breakLedger } = productWithStock();
    const before = { stock: read().stock_base_milli, movements: movements(), audits: audits() };
    breakLedger();

    expect(() =>
      writeOffStock(ctx.db, {
        productId: product.id,
        qtyBaseMilli: 2_000,
        type: 'damage',
        reason: 'ভাঙা প্যাকেট',
        actor: ctx.actor,
      }),
    ).toThrow(/হিসাব খাত পাওয়া যায়নি/);

    expect(read().stock_base_milli).toBe(before.stock);
    expect(movements()).toBe(before.movements);
    expect(audits()).toBe(before.audits);
  });

  it('writes off the stock and posts it once when everything succeeds', () => {
    const { ctx, product, read, movements } = productWithStock();
    const before = { stock: read().stock_base_milli, movements: movements() };
    writeOffStock(ctx.db, {
      productId: product.id,
      qtyBaseMilli: 2_000,
      type: 'expiry',
      reason: 'মেয়াদ শেষ',
      actor: ctx.actor,
    });
    expect(read().stock_base_milli).toBe(before.stock - 2_000);
    expect(movements()).toBe(before.movements + 1);
    const posted = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE source = 'stock_adjust'")
      .get() as { n: number };
    expect(posted.n).toBe(1);
  });
});
