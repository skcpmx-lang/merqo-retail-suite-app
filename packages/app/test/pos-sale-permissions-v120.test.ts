import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-POS-01, end-to-end at the trust boundary (v1.2.0, Phase 2 module 1).
 *
 * The regression is that a sale request can carry its own discount: a cashier without
 * `pos.discount` sends `discountPaisa` on a line (no order-level discount), the IPC gate looks
 * only at `orderDiscountValue`, and the sale commits at a price the shop never authorised.
 * These tests drive the real `invokeRoute()` — the same dispatcher the LAN transport uses — so
 * the check covers every client, not just the packaged POS screen.
 */
vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    isPackaged: false,
    getVersion: () => '0.0.0-test',
    setPath: () => undefined,
    on: () => undefined,
    whenReady: () => Promise.resolve(),
    quit: () => undefined,
  },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
    webContents = { send: () => undefined };
    isDestroyed() {
      return false;
    }
  },
  dialog: { showMessageBox: async () => ({ response: 1 }), showOpenDialog: async () => ({ canceled: true }), showSaveDialog: async () => ({ canceled: true }) },
  shell: { openPath: async () => '' },
  ipcMain: { handle: () => undefined, on: () => undefined, removeHandler: () => undefined },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  safeStorage: { isEncryptionAvailable: () => false },
}));

// The licence gate is a different concern; unpackaged runs skip it via the documented dev
// escape hatch so these tests exercise the permission gate itself.
process.env.SAUDA_SKIP_LICENSE = '1';

const { invokeRoute } = await import('../electron/ipc.js');
const { makeTestDb } = await import('../../core/test/helpers.js');
const core = await import('../../core/src/index.js');


function ctxFor(db: any, user: any) {
  return { db, mode: 'server' as const, user, openDb: () => db, reopenDb: () => db };
}

describe('pos.createSale permission enforcement (F-POS-01)', () => {
  let ctx: any;
  let productId: number;
  let unitId: number;
  let methodId: number;

  // Real user rows: sales record `created_by`, so a forged id would only prove that
  // SQLite rejects it. The permission question is what is under test.
  let cashier: any;
  let manager: any;

  beforeEach(() => {
    const t = makeTestDb();
    cashier = core.createUser(
      t.db,
      { username: 'cashier1', fullName: 'ক্যাশিয়ার', password: 'Cashier#12345', role: 'cashier', permissions: ['pos.sell'] } as any,
    );
    manager = core.createUser(
      t.db,
      { username: 'manager1', fullName: 'ম্যানেজার', password: 'Manager#12345', role: 'manager', permissions: ['pos.sell', 'pos.discount', 'pos.price_edit'] } as any,
    );
    ctx = ctxFor(t.db, cashier);
    productId = core.createProduct(
      t.db,
      { name: 'চাল', unitId: t.unitPieceId, salePrice: 10_000, costPrice: 8_000, openingStockMilli: 100_000 } as any,
      t.actor,
    ).id;
    unitId = t.unitPieceId;
    methodId = t.cashMethodId;
    ctx.__t = t;
  });

  const line = (extra: Record<string, unknown> = {}) => [
    { productId, unitId, qtyMilli: 1000, unitPricePaisa: null, discountPaisa: null, ...extra },
  ];
  const sale = (lines: any[], extra: Record<string, unknown> = {}) => ({
    lines,
    orderDiscountType: 'none',
    orderDiscountValue: 0,
    payments: [{ methodId, amount: 10000 }],
    actor: { id: 1, username: 'ui' },
    ...extra,
  });

  it('refuses a line-level discount for a cashier without pos.discount (the exploit)', async () => {
    const res: any = await invokeRoute(ctx, 'pos.createSale', [sale(line({ discountPaisa: 9500 }))]);
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('ডিসকাউন্ট');
    // nothing was written
    expect((ctx.db.prepare('SELECT COUNT(*) c FROM sales').get() as any).c).toBe(0);
  });

  it('refuses an order-level discount for a cashier without pos.discount', async () => {
    const res: any = await invokeRoute(ctx, 'pos.createSale', [sale(line(), { orderDiscountType: 'percent', orderDiscountValue: 1000 })]);
    expect(res.ok).toBe(false);
  });

  it('refuses a unit-price override for a cashier without pos.price_edit', async () => {
    const res: any = await invokeRoute(ctx, 'pos.createSale', [sale(line({ unitPricePaisa: 100 }))]);
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('দাম');
  });

  it('accepts a plain sale from the same cashier — the gate is not a blanket ban', async () => {
    const res: any = await invokeRoute(ctx, 'pos.createSale', [sale(line())]);
    expect(res.ok).toBe(true);
    expect((ctx.db.prepare('SELECT COUNT(*) c FROM sales').get() as any).c).toBe(1);
  });

  it('lets a user who holds the permissions discount — and grants overrides from the user, not the request', async () => {
    ctx.user = manager;
    const res: any = await invokeRoute(ctx, 'pos.createSale', [sale(line({ discountPaisa: 9500 }))]);
    expect(res.ok).toBe(true);
  });

  it('ignores override flags smuggled in the request body by an unauthorised caller', async () => {
    const res: any = await invokeRoute(ctx, 'pos.createSale', [sale(line({ discountPaisa: 9500, unitPricePaisa: 100 }), { allowBelowMinPrice: true, allowDiscountOverride: true })]);
    expect(res.ok).toBe(false);
    expect((ctx.db.prepare('SELECT COUNT(*) c FROM sales').get() as any).c).toBe(0);
  });
});
