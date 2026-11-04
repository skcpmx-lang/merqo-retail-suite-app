import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_ROLE_PERMISSIONS,
  SCHEMA_V1,
  SCHEMA_VERSION,
  closeDatabase,
  createCustomer,
  createProduct,
  createSale,
  createSupplier,
  createUser,
  currentSchemaVersion,
  getSettings,
  initializeApp,
  listPaymentMethods,
  listUnits,
  openDatabase,
  seedReferenceData,
  setMeta,
  type Db,
} from '../src/index.js';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* windows lock safety */
    }
  }
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-mig-'));
  dirs.push(dir);
  return dir;
}

/**
 * Build a database exactly as v1.0.0 shipped it: schema v1 only, user_version 1,
 * reference data seeded, then real trading history on top.
 */
function buildV1Database(dbPath: string): { products: number; sales: number; stock: number } {
  const db = openDatabase({ file: dbPath, skipMigrate: true });
  db.exec(SCHEMA_V1);
  seedReferenceData(db);
  db.pragma('user_version = 1');
  setMeta(db, 'schema_version', '1');
  setMeta(db, 'app_version', '1.0.0');

  const now = '2026-01-05 10:00:00';
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('business_name','পুরাতন দোকান',?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(now);
  db.prepare(
    `INSERT INTO users (username, full_name, role, password_hash, password_salt, permissions, created_at, updated_at)
     VALUES ('admin','পুরাতন অ্যাডমিন','admin','x','y','[]',?,?)`,
  ).run(now, now);

  const piece = (db.prepare("SELECT id FROM units WHERE name = 'পিস'").get() as { id: number }).id;
  const method = (db.prepare('SELECT id FROM payment_methods LIMIT 1').get() as { id: number }).id;
  db.prepare(
    `INSERT INTO customers (name, balance_paisa, is_walkin, created_at, updated_at)
     VALUES ('পুরাতন কাস্টমার', 0, 0, ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO suppliers (name, balance_paisa, created_at, updated_at) VALUES ('পুরাতন সাপ্লায়ার', 0, ?, ?)`,
  ).run(now, now);

  for (let i = 1; i <= 3; i += 1) {
    db.prepare(
      `INSERT INTO products (name, sku, unit_id, purchase_price, sale_price, stock_base_milli, avg_cost_micro, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(`পুরাতন পণ্য ${i}`, `OLD-${i}`, piece, 10000, 15000, 10000 * i, 10000, now, now);
  }

  const product = db.prepare("SELECT id, sale_price, avg_cost_micro FROM products WHERE sku = 'OLD-1'").get() as {
    id: number;
    sale_price: number;
    avg_cost_micro: number;
  };
  const customer = (db.prepare('SELECT id FROM customers LIMIT 1').get() as { id: number }).id;
  for (let s = 1; s <= 4; s += 1) {
    const res = db
      .prepare(
        `INSERT INTO sales (invoice_no, customer_id, user_id, sale_date, subtotal_paisa, total_paisa, paid_paisa, due_paisa,
           cost_total_paisa, profit_paisa, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,'completed',?)`,
      )
      .run(`INV-OLD-${s}`, customer, 1, now, 30000, 30000, 30000, 0, 20000, 10000, now);
    db.prepare(
      `INSERT INTO sale_items (sale_id, product_id, product_name, unit_id, unit_label, qty_milli, factor_milli,
         qty_base_milli, unit_price_paisa, discount_paisa, line_total_paisa, cost_micro, cost_total_paisa, returned_qty_milli)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
    ).run(res.lastInsertRowid as number, product.id, 'পুরাতন পণ্য 1', piece, 'পিস', 1000, 1000, 1000, 15000, 0, 15000, 10000, 10000);
    methods: void method;
  }

  const stock = (db.prepare('SELECT SUM(stock_base_milli) AS s FROM products').get() as { s: number }).s;
  db.close();
  return { products: 3, sales: 4, stock };
}

describe('v1.0.0 → v2.0.0 migration', () => {
  it('upgrades a trading v1 database without losing a single row or poisa', () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, 'shop.db');
    const before = buildV1Database(dbPath);

    // Sanity: the fixture really is a v1 database.
    const pre = openDatabase({ file: dbPath, readonly: true, skipMigrate: true });
    expect(currentSchemaVersion(pre)).toBe(1);
    pre.close();

    const db: Db = openDatabase({ file: dbPath, appVersion: '1.0.1' });
    expect(currentSchemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(2);

    // 1. operational data untouched
    const products = db.prepare('SELECT COUNT(*) AS c FROM products').get() as { c: number };
    const sales = db.prepare('SELECT COUNT(*) AS c FROM sales').get() as { c: number };
    const saleTotal = db.prepare('SELECT SUM(total_paisa) AS s FROM sales').get() as { s: number };
    expect(products.c).toBe(before.products);
    expect(sales.c).toBe(before.sales);
    expect(saleTotal.s).toBe(120_000);
    expect((db.prepare('SELECT SUM(stock_base_milli) AS s FROM products').get() as { s: number }).s).toBe(before.stock);

    // 2. settings preserved, new keys seeded
    const settings = getSettings(db);
    expect(settings.business_name).toBe('পুরাতন দোকান');
    expect(settings.loyalty_enabled).toBe(1);
    expect(settings.theme).toBe('light');

    // 3. new capability tables exist and are usable
    const accounts = db.prepare('SELECT COUNT(*) AS c FROM accounts').get() as { c: number };
    expect(accounts.c).toBeGreaterThanOrEqual(20);
    const cashAccount = db.prepare("SELECT * FROM accounts WHERE code = '1000'").get() as { is_cash: number };
    expect(cashAccount.is_cash).toBe(1);

    // 4. default location created and every existing unit of stock mirrored
    const loc = db.prepare('SELECT * FROM locations WHERE is_default = 1').get() as { id: number };
    expect(loc.id).toBeGreaterThan(0);
    const levelSum = db
      .prepare('SELECT SUM(qty_base_milli) AS s FROM stock_levels WHERE location_id = ?')
      .get(loc.id) as { s: number };
    expect(levelSum.s).toBe(before.stock);
    expect(db.prepare('SELECT COUNT(*) AS c FROM stock_levels').get() as { c: number }).toEqual({ c: 3 });

    // 5. new columns exist with sane defaults
    const product = db.prepare("SELECT * FROM products WHERE sku = 'OLD-1'").get() as {
      is_service: number;
      reorder_qty_base_milli: number;
    };
    expect(product.is_service).toBe(0);
    expect(product.reorder_qty_base_milli).toBe(0);
    const cust = db.prepare('SELECT * FROM customers LIMIT 1').get() as {
      credit_limit_paisa: number;
      loyalty_points: number;
    };
    expect(cust.credit_limit_paisa).toBe(0);
    expect(cust.loyalty_points).toBe(0);

    // 6. integrity after migration
    expect(String(db.pragma('integrity_check', { simple: true }))).toBe('ok');
    expect(db.pragma('foreign_key_check')).toEqual([]);

    closeDatabase(db);
  });

  it('is idempotent and keeps working when opened repeatedly', () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, 'shop.db');
    buildV1Database(dbPath);

    let db = openDatabase({ file: dbPath, appVersion: '1.0.1' });
    const accounts1 = (db.prepare('SELECT COUNT(*) AS c FROM accounts').get() as { c: number }).c;
    const loc1 = (db.prepare('SELECT COUNT(*) AS c FROM locations').get() as { c: number }).c;
    closeDatabase(db);

    db = openDatabase({ file: dbPath, appVersion: '1.0.1' });
    expect((db.prepare('SELECT COUNT(*) AS c FROM accounts').get() as { c: number }).c).toBe(accounts1);
    expect((db.prepare('SELECT COUNT(*) AS c FROM locations').get() as { c: number }).c).toBe(loc1);
    expect(currentSchemaVersion(db)).toBe(2);
    closeDatabase(db);
  });

  it('refuses to open a database from a newer schema instead of damaging it', () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, 'future.db');
    const db = openDatabase({ file: dbPath });
    db.pragma('user_version = 99');
    closeDatabase(db);

    expect(() => openDatabase({ file: dbPath })).toThrow(/নতুন ভার্সনের/);
  });

  it('a fresh database is created directly at v2 with the chart of accounts', () => {
    const dir = tmpDir();
    const db = openDatabase({ file: path.join(dir, 'fresh.db') });
    expect(currentSchemaVersion(db)).toBe(2);
    const codes = db.prepare('SELECT code FROM accounts ORDER BY code').all() as { code: string }[];
    for (const expected of ['1000', '1100', '1200', '2000', '3000', '4000', '4100', '5000']) {
      expect(codes.map((c) => c.code)).toContain(expected);
    }
    closeDatabase(db);
  });

  it('existing helper-created databases still work with the new schema', () => {
    const dir = tmpDir();
    const db = openDatabase({ file: path.join(dir, 'helper.db') });
    const { userId } = initializeApp(db, {
      businessName: 'নতুন দোকান',
      adminFullName: 'অ্যাডমিন',
      adminUsername: 'admin',
      adminPassword: 'admin123',
    });
    const units = listUnits(db);
    const piece = units.find((u) => u.name === 'পিস')!;
    const cash = listPaymentMethods(db).find((m) => m.is_cash === 1)!;
    const product = createProduct(db, { name: 'চাল', unitId: piece.id, salePrice: 6000, openingStockMilli: 5000 }, { id: userId, username: 'admin' });
    const customer = createCustomer(db, { name: 'করিম' }, { id: userId, username: 'admin' });
    createSupplier(db, { name: 'সাপ্লায়ার' }, { id: userId, username: 'admin' });
    createUser(db, { username: 'cashier', fullName: 'ক্যাশিয়ার', role: 'cashier', password: 'cashier123', permissions: DEFAULT_ROLE_PERMISSIONS.cashier }, { id: userId, username: 'admin' });

    const sale = createSale(db, {
      customerId: customer.id,
      lines: [{ productId: product.id, qtyMilli: 1000, unitPricePaisa: 6000 }],
      payments: [{ methodId: cash.id, amount: 6000 }],
      actor: { id: userId, username: 'admin' },
    });
    expect(sale.computation.total).toBe(6000);
    expect(db.prepare('SELECT qty_base_milli FROM stock_levels WHERE product_id = ?').get(product.id)).toEqual({
      qty_base_milli: 4000,
    });
    closeDatabase(db);
  });
});
