/**
 * Migration 7 (v1.1.5) — date indexes, and nothing else.
 *
 * The whole point of this migration is that it is *only* lookup structures: a shop that upgrades
 * must get faster reports and keep every row, column and constraint exactly as it was. These tests
 * prove that, and they prove the indexes are actually used — an index nobody queries is a cost with
 * no benefit.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  SCHEMA_VERSION,
  closeDatabase,
  createProduct,
  createSale,
  currentSchemaVersion,
  getMeta,
  initializeApp,
  listPaymentMethods,
  openDatabase,
  type Db,
} from '../src/index.js';
import { V7_INDEXES } from '../src/db/migration-v7.js';
import { closeTrackedDatabases, openTrackedDatabase, removeTempDirs } from '../../../test-setup/temp-resources.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-mig7-'));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  closeTrackedDatabases();
  removeTempDirs(dirs);
});

function tradingShop(dir: string) {
  const db = openTrackedDatabase({ file: path.join(dir, 'shop.db'), appVersion: '1.1.4' });
  initializeApp(db, {
    businessName: 'মাইগ্রেশন দোকান',
    businessAddress: 'ঢাকা',
    businessPhone: '01700000000',
    adminFullName: 'মালিক',
    adminUsername: 'owner',
    adminPassword: 'owner123',
  });
  const unit = (db.prepare('SELECT id FROM units LIMIT 1').get() as { id: number }).id;
  const product = createProduct(
    db,
    { name: 'চাল', unitId: unit, salePrice: 5_000, openingStockMilli: 20_000 },
    { id: 1, username: 'owner' },
  );
  const cash = listPaymentMethods(db).find((m) => m.is_cash === 1)!;
  createSale(db, {
    lines: [{ productId: product.id, unitId: unit, qtyMilli: 1000 }],
    payments: [{ methodId: cash.id, amount: 5_000 }],
    actor: { id: 1, username: 'owner' },
  });
  return db;
}

/** What a v6 database looks like: no v7 indexes, `user_version = 6`. */
function downgradeToV6(db: Db): void {
  for (const index of V7_INDEXES) db.exec(`DROP INDEX IF EXISTS ${index}`);
  db.pragma('user_version = 6');
}

const count = (db: Db, table: string) =>
  (db.prepare(`SELECT COUNT(*) c FROM "${table}"`).get() as { c: number }).c;

const indexes = (db: Db) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").all() as {
    name: string;
  }[]).map((r) => r.name);

const tableInventory = (db: Db) =>
  db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string; sql: string }[];

describe('v1.1.5 migration 7', () => {
  it('adds the date indexes to a v6 database without touching a single row', () => {
    const dir = tempDir();
    const db = tradingShop(dir);
    downgradeToV6(db);
    expect(currentSchemaVersion(db)).toBe(6);
    const before = { tables: tableInventory(db), sales: count(db, 'sales'), products: count(db, 'products'), meta: getMeta(db, 'store_id') };
    closeDatabase(db);

    const reopened = openTrackedDatabase({ file: path.join(dir, 'shop.db'), appVersion: '1.1.5' });

    expect(currentSchemaVersion(reopened)).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(7);
    const names = indexes(reopened);
    for (const index of V7_INDEXES) expect(names).toContain(index);
    // No table changed, no row moved, the store identity is the same shop.
    expect(tableInventory(reopened)).toEqual(before.tables);
    expect(count(reopened, 'sales')).toBe(before.sales);
    expect(count(reopened, 'products')).toBe(before.products);
    expect(getMeta(reopened, 'store_id')).toBe(before.meta);
  });

  it('is idempotent: opening again changes nothing and keeps working', () => {
    const dir = tempDir();
    const db = tradingShop(dir);
    const sales = count(db, 'sales');
    closeDatabase(db);

    const first = openTrackedDatabase({ file: path.join(dir, 'shop.db'), appVersion: '1.1.5' });
    const inventory = tableInventory(first);
    closeDatabase(first);
    const second = openTrackedDatabase({ file: path.join(dir, 'shop.db'), appVersion: '1.1.5' });

    expect(currentSchemaVersion(second)).toBe(7);
    expect(tableInventory(second)).toEqual(inventory);
    expect(count(second, 'sales')).toBe(sales);
  });

  it('creates a fresh database directly at v7', () => {
    const dir = tempDir();
    const db = tradingShop(dir);
    expect(currentSchemaVersion(db)).toBe(7);
    const names = indexes(db);
    for (const index of V7_INDEXES) expect(names).toContain(index);
  });

  it('leaves a pre-migration copy of the database next to it', () => {
    const dir = tempDir();
    const db = tradingShop(dir);
    downgradeToV6(db);
    const sales = count(db, 'sales');
    closeDatabase(db);

    const reopened = openTrackedDatabase({ file: path.join(dir, 'shop.db'), appVersion: '1.1.5' });
    closeDatabase(reopened);

    const backups = fs.readdirSync(dir).filter((f) => f.includes('pre-migration-v6-to-v7'));
    expect(backups.length).toBeGreaterThan(0);
    // The safety copy is a real database holding the shop as it was before the migration.
    const safety = openTrackedDatabase({ file: path.join(dir, backups[0]!), appVersion: '1.1.4' });
    expect(count(safety, 'sales')).toBe(sales);
    closeDatabase(safety);
  });

  it('makes the date-filtered report use the index instead of scanning', () => {
    const dir = tempDir();
    const db = tradingShop(dir);
    const plan = (
      db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT date(sale_date) d, SUM(total_paisa) FROM sales WHERE status <> 'voided' AND date(sale_date) BETWEEN date(?) AND date(?) GROUP BY date(sale_date)",
        )
        .all('2026-01-01', '2026-12-31') as { detail: string }[]
    )
      .map((r) => r.detail)
      .join(' | ');
    expect(plan).toContain('idx_sales_day');
    expect(plan).not.toMatch(/\bSCAN sales\b/);
  });

  it('keeps the sargable list query on the plain date index with no temporary sort', () => {
    const dir = tempDir();
    const db = tradingShop(dir);
    const plan = (
      db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT id FROM sales WHERE status <> 'voided' AND sale_date >= ? AND sale_date <= ? ORDER BY sale_date DESC, id DESC LIMIT 50",
        )
        .all('2026-01-01 00:00:00', '2026-01-31 23:59:59') as { detail: string }[]
    )
      .map((r) => r.detail)
      .join(' | ');
    expect(plan).toContain('idx_sales_date');
    expect(plan).not.toMatch(/TEMP B-TREE/);
  });
});
