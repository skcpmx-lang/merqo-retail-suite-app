import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `stock.adjust` enforcement at the trust boundary (v1.2.0, Phase 2 module 2).
 *
 * Stock adjustments are the one inventory operation that can invent or destroy value with no
 * customer and no supplier involved, so the permission must be checked by the dispatcher — not by
 * hiding a button in a screen that a LAN terminal never renders.
 */
vi.mock('electron', () => ({
  app: {
    getPath: () => process.env.TEMP || process.env.TMPDIR || '/tmp',
    isPackaged: false,
    getVersion: () => '0.0.0-test',
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

process.env.SAUDA_SKIP_LICENSE = '1';
const { invokeRoute } = await import('../electron/ipc.js');
const { makeTestDb } = await import('../../core/test/helpers.js');
const core = await import('../../core/src/index.js');

describe('inventory.adjust requires stock.adjust', () => {
  let ctx: any;
  let productId: number;

  beforeEach(() => {
    const t = makeTestDb();
    productId = core.createProduct(
      t.db,
      { name: 'চাল', unitId: t.unitPieceId, salePrice: 1_000, openingStockMilli: 1_000 } as any,
      t.actor,
    ).id;
    const cashier = core.createUser(t.db, {
      username: 'cashier2',
      fullName: 'ক্যাশিয়ার',
      password: 'Cashier#12345',
      role: 'cashier',
      permissions: ['pos.sell'],
    } as any);
    ctx = { db: t.db, mode: 'server', user: cashier, openDb: () => t.db, reopenDb: () => t.db };
  });

  it('refuses an adjustment from a user without stock.adjust', async () => {
    const res: any = await invokeRoute(ctx, 'inventory.adjust', [
      { productId, newQtyBaseMilli: 9_000, reason: 'পরীক্ষা' },
    ]);
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/অনুমতি/);
    expect((ctx.db.prepare('SELECT stock_base_milli q FROM products WHERE id=?').get(productId) as any).q).toBe(1_000);
  });

  it('allows a manager who holds stock.adjust — and the reason still lands in the movement', async () => {
    const manager = core.createUser(ctx.db, {
      username: 'manager2',
      fullName: 'ম্যানেজার',
      password: 'Manager#12345',
      role: 'manager',
      permissions: ['stock.adjust'],
    } as any);
    ctx.user = manager;
    const res: any = await invokeRoute(ctx, 'inventory.adjust', [
      { productId, newQtyBaseMilli: 4_500, reason: 'মাসিক গণনা' },
    ]);
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect((ctx.db.prepare('SELECT stock_base_milli q FROM products WHERE id=?').get(productId) as any).q).toBe(4_500);
    const mv = ctx.db.prepare("SELECT reason FROM stock_movements WHERE product_id=? ORDER BY id DESC LIMIT 1").get(productId) as any;
    expect(mv.reason).toBe('মাসিক গণনা');
  });
});
