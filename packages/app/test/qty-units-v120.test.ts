import { beforeEach, describe, expect, it, vi } from 'vitest';
import { baseToPrimaryMilli, primaryFactorOf, primaryToBaseMilli, unitFactor } from '../src/lib/qty-units.js';

/**
 * F-INV-01 (v1.2.0, Phase 2 module 2): the product form, the stock screen and the transfer dialog
 * ask for quantities in the shop's **primary unit** ("10 কেজি"), while the core stores **base-unit
 * milli** (10 000 000). The scales coincide only when factor_milli === 1000 — পিস, গ্রাম, লিটার — which
 * is why the mismatch survived: a shop that works only in pieces never sees it, and one that buys
 * rice by the কেজি ends up with 10 ग्ram of opening stock.
 */
describe('primary <-> base quantity conversion (F-INV-01)', () => {
  it('is the identity for units whose factor is 1000 (পিস, গ্রাম, লিটার)', () => {
    expect(primaryToBaseMilli(10_000, 1_000)).toBe(10_000);
    expect(baseToPrimaryMilli(10_000, 1_000)).toBe(10_000);
  });

  it('converts কেজি (factor 1 000 000) — the rice case', () => {
    // "10 কেজি" typed on the product form
    expect(primaryToBaseMilli(10_000, 1_000_000)).toBe(10_000_000);
    // and back again for display
    expect(baseToPrimaryMilli(10_000_000, 1_000_000)).toBe(10_000);
  });

  it('converts মিলিলিটার (factor 1) — a 500 ml bottle of oil', () => {
    expect(primaryToBaseMilli(500_000, 1)).toBe(500);
    expect(baseToPrimaryMilli(500, 1)).toBe(500_000);
  });

  it('converts ডজন (factor 12 000) and বস্তা (factor 50 000 000)', () => {
    expect(primaryToBaseMilli(2_000, 12_000)).toBe(24_000);
    expect(primaryToBaseMilli(1_000, 50_000_000)).toBe(50_000_000);
  });

  it('round-trips without drift', () => {
    for (const [primary, factor] of [
      [1_000, 1_000_000],
      [250, 1_000_000],
      [333, 12_000],
      [1_000, 50_000_000],
    ] as const) {
      expect(baseToPrimaryMilli(primaryToBaseMilli(primary, factor), factor)).toBe(primary);
    }
  });

  it('treats a missing or unusable factor as the identity instead of dividing by zero', () => {
    expect(unitFactor(undefined)).toBe(1_000);
    expect(unitFactor(0)).toBe(1_000);
    expect(unitFactor(-5)).toBe(1_000);
    expect(primaryToBaseMilli(1_000, null)).toBe(1_000);
    expect(baseToPrimaryMilli(1_000, Number.NaN)).toBe(1_000);
    expect(primaryToBaseMilli(Number.NaN, 1_000_000)).toBe(0);
  });

  it('keeps integer precision at the edges the shops actually reach', () => {
    // 999.995 kg: no float drift, still an exact integer of base milli
    expect(primaryToBaseMilli(999_995, 1_000_000)).toBe(999_995_000);
    // with factor 1 (মিলিলিটার) the conversion is a division by 1000, so precision stops at the
    // milli: 500 milli-units is exactly half a base unit and rounds up once, 499 does not.
    expect(primaryToBaseMilli(500, 1)).toBe(1);
    expect(primaryToBaseMilli(499, 1)).toBe(0);
    expect(primaryToBaseMilli(5, 1)).toBe(0);
    // the largest quantity the input can carry stays a safe integer
    const big = primaryToBaseMilli(Number.MAX_SAFE_INTEGER, 1_000);
    expect(Number.isSafeInteger(big)).toBe(true);
    expect(big).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('reads the primary unit factor from the loaded unit list', () => {
    const units = [
      { id: 1, factor_milli: 1_000 },
      { id: 5, factor_milli: 1_000_000 },
    ];
    expect(primaryFactorOf(units, 5, 1)).toBe(1_000_000);
    expect(primaryFactorOf(units, null, 1)).toBe(1_000);
    expect(primaryFactorOf([], 5, 1)).toBe(1_000);
  });
});

/**
 * The same rule, end-to-end: a কেজি product created with the converted opening stock must be
 * sellable in গ্রাম. Before the fix the product was created with 1000× too little stock and every
 * gram sale after it was refused with "পর্যাপ্ত স্টক নেই" — the shop could not sell rice at all.
 */
vi.mock('electron', () => ({
  app: { getPath: () => process.env.TEMP || process.env.TMPDIR || '/tmp', isPackaged: false, getVersion: () => '0.0.0-test', on: () => undefined, whenReady: () => Promise.resolve(), quit: () => undefined },
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

describe('opening stock entered in কেজি becomes base-unit stock', () => {
  let ctx: any;
  let db: any;

  beforeEach(() => {
    const t = makeTestDb();
    db = t.db;
    ctx = { db, mode: 'server', user: { id: 1, username: 'admin', role: 'admin', permissions: [] }, openDb: () => db, reopenDb: () => db };
  });

  it('a 10 কেজি opening stock supports a 250 গ্রাম sale', async () => {
    const kg = 5;
    const gram = 2;
    const created: any = await invokeRoute(ctx, 'products.create', [
      { name: 'মিনিকেট চাল', unitId: kg, salePrice: 12_000, openingStockMilli: primaryToBaseMilli(10_000, 1_000_000) },
    ]);
    expect(created.ok).toBe(true);
    const productId = created.data.id;
    expect((db.prepare('SELECT stock_base_milli q FROM products WHERE id = ?').get(productId) as any).q).toBe(10_000_000);

    const sale: any = await invokeRoute(ctx, 'pos.createSale', [
      { lines: [{ productId, unitId: gram, qtyMilli: 250 }], payments: [{ methodId: 1, amount: 30 }] },
    ]);
    expect(sale.ok, JSON.stringify(sale.error)).toBe(true);
    expect((db.prepare('SELECT stock_base_milli q FROM products WHERE id = ?').get(productId) as any).q).toBe(9_999_750);
  });
});
