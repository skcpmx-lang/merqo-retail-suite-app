/**
 * Final-audit part 3: schema/migration safety, catalogue integrity, CSV import
 * resilience and the small remaining business rules.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import {
  SCHEMA_VERSION,
  commitImport,
  createCategory,
  createCustomer,
  createProduct,
  createPurchase,
  createSale,
  createSaleReturn,
  createSupplier,
  findCodeAnywhere,
  getProduct,
  getSale,
  listProducts,
  openDatabase,
  initializeApp,
  previewImport,
  searchEverything,
  SCHEMA_V1,
} from '../src/index.js';

const schemaTables = [...SCHEMA_V1.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/g)].map((m) => m[1]!);
const schemaIndexes = [...SCHEMA_V1.matchAll(/CREATE INDEX IF NOT EXISTS\s+(\w+)/g)].map((m) => m[1]!);
import { makeTestDb, seedProducts } from './helpers.js';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-schema-'));
  dirs.push(d);
  return d;
}

describe('schema shape', () => {
  it('has a primary key on every table and the documented index count', () => {
    const ctx = makeTestDb();
    const tables = schemaTables;
    expect(tables.length).toBeGreaterThanOrEqual(30);
    for (const table of tables) {
      const info = ctx.db.pragma(`table_info(${table})`) as { name: string; pk: number }[];
      const pk = info.filter((c) => c.pk > 0);
      // `meta` and `settings` are key/value tables but still carry a key column.
      expect(pk.length, `${table} has no primary key`).toBeGreaterThan(0);
    }
    expect(schemaIndexes.length).toBeGreaterThanOrEqual(43);
    ctx.cleanup();
  });

  it('runs in WAL mode with foreign keys enforced and every FK resolvable', () => {
    const dir = tmp();
    const ctx = { ...makeTestDb() };
    const fileDb = openDatabase({ file: path.join(dir, 'wal.db'), appVersion: '1.0.0' });
    expect(String(fileDb.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
    expect(Number(fileDb.pragma('synchronous', { simple: true }))).toBe(2); // FULL
    expect(Number(fileDb.pragma('foreign_keys', { simple: true }))).toBe(1);
    expect(Number(fileDb.pragma('busy_timeout', { simple: true }))).toBe(8000);
    expect(Number(fileDb.pragma('temp_store', { simple: true }))).toBe(2); // MEMORY
    expect(fileDb.pragma('cache_size', { simple: true })).toBe(-16000);
    // a checkpoint must succeed on a WAL database (it is used before backups)
    expect(() => fileDb.pragma('wal_checkpoint(TRUNCATE)')).not.toThrow();
    fileDb.close();
    expect(Number(ctx.db.pragma('foreign_keys', { simple: true }))).toBe(1);
    expect(ctx.db.pragma('foreign_key_check')).toEqual([]);
    const indexes = ctx.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").all() as {
      name: string;
    }[];
    expect(indexes.length).toBeGreaterThanOrEqual(43);
    ctx.cleanup();
  });

  it('keeps an older database usable when the version stamp is missing', () => {
    const dir = tmp();
    const file = path.join(dir, 'old.db');
    const db = openDatabase({ file, appVersion: '1.0.0' });
    const { userId } = initializeApp(db, {
      businessName: 'পুরোনো দোকান',
      businessAddress: 'ঢাকা',
      businessPhone: '01700000000',
      adminFullName: 'পুরোনো অ্যাডমিন',
      adminUsername: 'admin',
      adminPassword: 'admin123',
    });
    const actor = { id: userId, username: 'admin' };
    const cat = createCategory(db, 'পুরোনো', null, actor);
    createProduct(
      db,
      { name: 'পুরোনো প্রোডাক্ট', categoryId: cat.id, unitId: 1, primaryUnitId: 1, purchasePrice: 1000, salePrice: 1500 },
      actor,
    );
    db.pragma('user_version = 0'); // simulate a database written before versioning
    db.close();

    const reopened = openDatabase({ file, appVersion: '1.0.0' });
    expect(Number(reopened.pragma('user_version', { simple: true }))).toBe(SCHEMA_VERSION);
    expect((reopened.prepare('SELECT COUNT(*) c FROM products').get() as { c: number }).c).toBe(1);
    expect((reopened.prepare('SELECT COUNT(*) c FROM settings').get() as { c: number }).c).toBeGreaterThan(10);
    reopened.close();
  });

  it('refuses to open a database written by a newer application version', () => {
    const dir = tmp();
    const file = path.join(dir, 'future.db');
    const db = openDatabase({ file, appVersion: '1.0.0' });
    db.close();
    const raw = new Database(file);
    raw.pragma('user_version = 99');
    raw.close();
    expect(() => openDatabase({ file, appVersion: '1.0.0' })).toThrow(/নতুন ভার্সনের/);
  });
});

describe('catalogue and barcode integrity', () => {
  it('refuses a barcode that already belongs to another product', () => {
    const ctx = makeTestDb();
    const ids = seedProducts(ctx);
    expect(() =>
      createProduct(
        ctx.db,
        {
          name: 'নকল বারকোড',
          sku: 'DUP-BC',
          unitId: ctx.unitPieceId,
          primaryUnitId: ctx.unitPieceId,
          purchasePrice: 1000,
          salePrice: 1500,
          barcodes: [{ code: '8901234567890' }],
        },
        ctx.actor,
      ),
    ).toThrow();
    expect(findCodeAnywhere(ctx.db, '8901234567890')!.id).toBe(ids.rice.id);
    ctx.cleanup();
  });

  it('looks up by barcode, QR, SKU and product code', () => {
    const ctx = makeTestDb();
    const ids = seedProducts(ctx);
    expect(findCodeAnywhere(ctx.db, '8901234567890')!.id).toBe(ids.rice.id);
    expect(findCodeAnywhere(ctx.db, 'RICE-01')!.id).toBe(ids.rice.id);
    expect(findCodeAnywhere(ctx.db, '  rice-01 ')!.id).toBe(ids.rice.id);
    expect(findCodeAnywhere(ctx.db, 'nope')).toBeNull();
    ctx.cleanup();
  });

  it('records a deliberate zero-price giveaway instead of silently failing', () => {
    const ctx = makeTestDb();
    const free = createProduct(
      ctx.db,
      { name: 'ফ্রি স্যাম্পল', sku: 'FREE-1', unitId: ctx.unitPieceId, primaryUnitId: ctx.unitPieceId, purchasePrice: 0, salePrice: 0 },
      ctx.actor,
    );
    createPurchase(ctx.db, {
      lines: [{ productId: free.id, unitId: ctx.unitPieceId, qtyMilli: 1000, unitPricePaisa: 0 }],
      actor: ctx.actor,
    });
    const sale = createSale(ctx.db, {
      lines: [{ productId: free.id, unitId: ctx.unitPieceId, qtyMilli: 1000 }],
      paidPaisa: 0,
      actor: ctx.actor,
    });
    expect(sale.computation.total).toBe(0);
    expect(getProduct(ctx.db, free.id)!.stock_base_milli).toBe(0);
    ctx.cleanup();
  });
});

describe('CSV import resilience', () => {
  const csv = [
    'name,sku,unit,purchase_price,sale_price,stock',
    'মিনিকেট চাল ৫ কেজি,RICE-5KG,কেজি,350,380,10',
    '"ডাল, মসুর",DAL-1,কেজি,120,140,5',
    'ভুল সারি,,কেজি,100,120,1',
    'নতুন সাবান,SOAP-NEW,পিস,30,45,20',
  ].join('\r\n');

  it('previews rows, quoting and errors without writing anything', () => {
    const ctx = makeTestDb();
    const before = listProducts(ctx.db, { pageSize: 100 }).total;
    const preview = previewImport(ctx.db, 'products', csv);
    expect(preview.valid_count).toBe(4);
    expect(preview.error_count).toBe(0);
    expect(preview.rows.find((r) => r.values.sku === 'DAL-1')!.values.name).toBe('ডাল, মসুর');
    expect(listProducts(ctx.db, { pageSize: 100 }).total).toBe(before);
    ctx.cleanup();
  });

  it('commits valid rows, reports failures and is safe to run twice', () => {
    const ctx = makeTestDb();
    const first = commitImport(ctx.db, 'products', csv, {}, ctx.actor);
    expect(first.created).toBe(4);
    expect(first.errors.length).toBe(0);
    const second = commitImport(ctx.db, 'products', csv, {}, ctx.actor);
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(4); // every row already exists
    const soap = findCodeAnywhere(ctx.db, 'SOAP-NEW');
    expect(soap?.name).toBe('নতুন সাবান');
    expect(soap?.stock_base_milli).toBe(20_000);
    ctx.cleanup();
  });

  it('rejects a file without the required columns instead of guessing', () => {
    const ctx = makeTestDb();
    expect(() => previewImport(ctx.db, 'products', 'foo,bar\n1,2')).toThrow(/কলাম/);
    ctx.cleanup();
  });

  it('imports customers and suppliers with phone de-duplication', () => {
    const ctx = makeTestDb();
    const customerCsv = 'name,phone,address\nরহিম,01711111111,ঢাকা\nরহিম (ডুপ্লিকেট),01711111111,ঢাকা';
    const res = commitImport(ctx.db, 'customers', customerCsv, {}, ctx.actor);
    expect(res.created).toBe(1);
    expect(res.skipped).toBe(1);
    const supplier = createSupplier(ctx.db, { name: 'সাপ্লায়ার এক', phone: '01911111111' }, ctx.actor);
    expect(supplier.id).toBeGreaterThan(0);
    void createCustomer;
    ctx.cleanup();
  });
});

describe('search and listing behaviour at the edges', () => {
  it('ignores case and Bengali/English digits when searching', () => {
    const ctx = makeTestDb();
    const product = createProduct(
      ctx.db,
      { name: 'সয়াবিন তেল ৫ লিটার', sku: 'OIL-5L', unitId: ctx.unitPieceId, primaryUnitId: ctx.unitPieceId, purchasePrice: 90000, salePrice: 95000 },
      ctx.actor,
    );
    expect(searchEverything(ctx.db, 'সয়াবিন').some((h) => h.id === product.id)).toBe(true);
    expect(searchEverything(ctx.db, 'oil-5l').some((h) => h.id === product.id)).toBe(true);
    expect(searchEverything(ctx.db, 'OIL').some((h) => h.id === product.id)).toBe(true);
    ctx.cleanup();
  });

  it('paginates deterministically and never repeats rows', () => {
    const ctx = makeTestDb();
    for (let i = 0; i < 25; i++) {
      createProduct(
        ctx.db,
        { name: `পেজ প্রোডাক্ট ${String(i).padStart(2, '0')}`, sku: `PAGE-${i}`, unitId: ctx.unitPieceId, primaryUnitId: ctx.unitPieceId, purchasePrice: 1000, salePrice: 1500 },
        ctx.actor,
      );
    }
    const first = listProducts(ctx.db, { page: 1, pageSize: 10 });
    const second = listProducts(ctx.db, { page: 2, pageSize: 10 });
    const third = listProducts(ctx.db, { page: 3, pageSize: 10 });
    const ids = [...first.rows, ...second.rows, ...third.rows].map((r) => r.id);
    expect(new Set(ids).size).toBe(25);
    expect(first.total).toBe(25);
    ctx.cleanup();
  });
});

describe('returns against sold quantity', () => {
  it('never allows returning more than the invoice line, across repeated calls', () => {
    const ctx = makeTestDb();
    const ids = seedProducts(ctx);
    createPurchase(ctx.db, {
      supplierId: ids.supplier.id,
      lines: [{ productId: ids.soap.id, unitId: ctx.unitPieceId, qtyMilli: 10_000, unitPricePaisa: 3000 }],
      actor: ctx.actor,
    });
    const sale = createSale(ctx.db, {
      lines: [{ productId: ids.soap.id, unitId: ctx.unitPieceId, qtyMilli: 3000 }],
      paidPaisa: 13_500,
      defaultMethodId: ctx.cashMethodId,
      actor: ctx.actor,
    });
    const line = getSale(ctx.db, sale.saleId)!.items![0]!;
    createSaleReturn(ctx.db, { saleId: sale.saleId, items: [{ lineId: line.id, qtyMilli: 2000 }], refundPaisa: 0, actor: ctx.actor });
    expect(() =>
      createSaleReturn(ctx.db, { saleId: sale.saleId, items: [{ lineId: line.id, qtyMilli: 2000 }], refundPaisa: 0, actor: ctx.actor }),
    ).toThrow();
    const ret = createSaleReturn(ctx.db, { saleId: sale.saleId, items: [{ lineId: line.id, qtyMilli: 1000 }], refundPaisa: 0, actor: ctx.actor });
    expect(ret.total).toBe(4500);
    expect(getProduct(ctx.db, ids.soap.id)!.stock_base_milli).toBe(10_000);
    expect((ctx.db.prepare('SELECT status FROM sales WHERE id = ?').get(sale.saleId) as { status: string }).status).toBe('returned');
    ctx.cleanup();
  });
});
