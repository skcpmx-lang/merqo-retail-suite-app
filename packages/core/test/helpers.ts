import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createCategory,
  createProduct,
  createSupplier,
  createCustomer,
  createUnit,
  getSettings,
  initializeApp,
  listPaymentMethods,
  listUnits,
  openDatabase,
  updateSettings,
  type Db,
} from '../src/index.js';

export interface TestContext {
  db: Db;
  dir: string;
  dbPath: string;
  actor: { id: number; username: string };
  unitPieceId: number;
  unitKgId: number;
  cashMethodId: number;
  bkashMethodId: number;
  cleanup: () => void;
}

export function makeTestDb(options: { file?: boolean } = {}): TestContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-test-'));
  const dbPath = path.join(dir, 'test.db');
  const db = openDatabase({ file: options.file ? dbPath : ':memory:', appVersion: '1.0.0' });
  const { userId } = initializeApp(db, {
    businessName: 'টেস্ট মার্ট',
    businessAddress: 'ঢাকা',
    businessPhone: '01700000000',
    adminFullName: 'টেস্ট অ্যাডমিন',
    adminUsername: 'admin',
    adminPassword: 'admin123',
  });
  const units = listUnits(db);
  const piece = units.find((u) => u.name === 'পিস')!;
  const kg = units.find((u) => u.name === 'কেজি')!;
  const methods = listPaymentMethods(db);
  const cash = methods.find((m) => m.is_cash === 1)!;
  const bkash = methods.find((m) => m.name === 'বিকাশ')!;
  return {
    db,
    dir,
    dbPath,
    actor: { id: userId, username: 'admin' },
    unitPieceId: piece.id,
    unitKgId: kg.id,
    cashMethodId: cash.id,
    bkashMethodId: bkash.id,
    cleanup: () => {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function seedProducts(ctx: TestContext) {
  const cat = createCategory(ctx.db, 'মুদি', null, ctx.actor);
  const rice = createProduct(
    ctx.db,
    {
      name: 'মিনিকেট চাল',
      sku: 'RICE-01',
      categoryId: cat.id,
      unitId: ctx.unitKgId,
      primaryUnitId: ctx.unitKgId,
      purchasePrice: 7000,
      salePrice: 8000,
      minStockMilli: 5000,
      barcodes: [{ code: '8901234567890' }],
    },
    ctx.actor,
  );
  const soap = createProduct(
    ctx.db,
    {
      name: 'সাবান',
      sku: 'SOAP-01',
      categoryId: cat.id,
      unitId: ctx.unitPieceId,
      primaryUnitId: ctx.unitPieceId,
      purchasePrice: 3000,
      salePrice: 4500,
      minStockMilli: 10000,
    },
    ctx.actor,
  );
  const supplier = createSupplier(ctx.db, { name: 'রহিম ট্রেডার্স', phone: '01811111111' }, ctx.actor);
  const customer = createCustomer(ctx.db, { name: 'করিম সাহেব', phone: '01922222222' }, ctx.actor);
  return { cat, rice, soap, supplier, customer };
}

export function ensureSettings(db: Db, patch: Record<string, unknown>) {
  void getSettings(db);
  updateSettings(db, patch as never, null);
}

export function newUnit(ctx: TestContext, name: string, factorMilli: number, baseUnitId: number | null) {
  return createUnit(ctx.db, { name, shortName: name, baseUnitId, factorMilli }, ctx.actor);
}
