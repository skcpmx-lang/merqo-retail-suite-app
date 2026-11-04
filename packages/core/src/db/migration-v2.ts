import type { Database as SqliteDb } from 'better-sqlite3';
import { nowLocal } from '../domain/datetime.js';
import { SCHEMA_V2 } from './schema.js';

type Db = SqliteDb;

export function hasColumn(db: Db, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[];
  return rows.some((r) => r.name === column);
}

/**
 * Additive column helper. Idempotent: a second run (or a database created by a
 * build that already had the column) is a no-op instead of an error.
 */
export function addColumn(db: Db, table: string, column: string, definition: string): void {
  if (hasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE "${table}" ADD COLUMN ${column} ${definition}`);
}

export const DEFAULT_LOCATION_NAME = 'প্রধান দোকান';

/**
 * Migration 2 — "Advanced Retail & Business Edition".
 *
 * Everything here is additive and safe to run on a live shop database:
 *  - new tables (accounting, locations, holds, loyalty, serials, bundles…)
 *  - new columns with defaults
 *  - a default location, with every existing stock figure mirrored into it
 *    so `sum(stock_levels) == products.stock_base_milli` from the first second
 *  - the chart of accounts
 */
export function migrateToV2(db: Db, log?: (msg: string) => void): void {
  db.exec(SCHEMA_V2);

  /* ---------- columns ---------- */
  addColumn(db, 'customers', 'credit_limit_paisa', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'customers', 'group_name', 'TEXT');
  addColumn(db, 'customers', 'birthday', 'TEXT');
  addColumn(db, 'customers', 'loyalty_points', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'customers', 'visit_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'customers', 'total_spent_paisa', 'INTEGER NOT NULL DEFAULT 0');

  addColumn(db, 'products', 'min_sale_price', 'INTEGER');
  addColumn(db, 'products', 'max_discount_percent_x100', 'INTEGER');
  addColumn(db, 'products', 'is_service', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'products', 'reorder_qty_base_milli', 'INTEGER NOT NULL DEFAULT 0');

  addColumn(db, 'suppliers', 'advance_paisa', 'INTEGER NOT NULL DEFAULT 0');

  addColumn(db, 'users', 'role_template_id', 'INTEGER REFERENCES role_templates(id)');
  addColumn(db, 'users', 'pin_hash', 'TEXT');
  addColumn(db, 'users', 'pin_salt', 'TEXT');

  addColumn(db, 'sales', 'location_id', 'INTEGER REFERENCES locations(id)');
  addColumn(db, 'sales', 'tender_summary', 'TEXT');
  addColumn(db, 'purchases', 'location_id', 'INTEGER REFERENCES locations(id)');
  addColumn(db, 'expense_categories', 'account_id', 'INTEGER REFERENCES accounts(id)');
  addColumn(db, 'stock_movements', 'location_id', 'INTEGER REFERENCES locations(id)');

  /* ---------- default location + stock mirror ---------- */
  const existing = db.prepare('SELECT id FROM locations WHERE is_default = 1').get() as
    | { id: number }
    | undefined;
  let locationId = existing?.id;
  if (!locationId) {
    const res = db
      .prepare('INSERT INTO locations (name, kind, is_default, created_at) VALUES (?, ?, 1, ?)')
      .run(DEFAULT_LOCATION_NAME, 'shop', nowLocal());
    locationId = Number(res.lastInsertRowid);
    log?.(`migration v2: default location created (${locationId})`);
  }

  // Mirror the existing global stock into the default location. Uses a
  // set-based upsert so a database with 50k products migrates in milliseconds.
  db.prepare(
    `INSERT INTO stock_levels (product_id, location_id, qty_base_milli)
     SELECT p.id, ?, p.stock_base_milli FROM products p
     WHERE p.stock_base_milli <> 0
     ON CONFLICT(product_id, location_id) DO UPDATE SET qty_base_milli = excluded.qty_base_milli`,
  ).run(locationId);

  db.prepare("INSERT INTO meta (key, value) VALUES ('default_location_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(String(locationId));

  /* ---------- chart of accounts ---------- */
  const now = nowLocal();
  const accounts: [string, string, string, string, number, number][] = [
    // code, name(en), name_bn, type, is_cash, is_bank
    ['1000', 'Cash in Hand', 'নগদ', 'asset', 1, 0],
    ['1010', 'Bank', 'ব্যাংক', 'asset', 0, 1],
    ['1100', 'Accounts Receivable', 'কাস্টমার বাকি', 'asset', 0, 0],
    ['1200', 'Inventory', 'স্টক', 'asset', 0, 0],
    ['1300', 'Supplier Advance', 'সাপ্লায়ার অগ্রিম', 'asset', 0, 0],
    ['1400', 'Fixed Assets', 'স্থায়ী সম্পদ', 'asset', 0, 0],
    ['2000', 'Accounts Payable', 'সাপ্লায়ার পাওনা', 'liability', 0, 0],
    ['2100', 'Customer Advance', 'কাস্টমার অগ্রিম', 'liability', 0, 0],
    ['2200', 'VAT / Tax Payable', 'ভ্যাট / কর', 'liability', 0, 0],
    ['3000', "Owner's Equity", 'মালিকের মূলধন', 'equity', 0, 0],
    ['3100', 'Opening Balance Equity', 'প্রারম্ভিক ব্যালেন্স', 'equity', 0, 0],
    ['3200', "Owner's Drawings", 'মালিকের উত্তোলন', 'equity', 0, 0],
    ['4000', 'Sales Revenue', 'বিক্রয় আয়', 'income', 0, 0],
    ['4050', 'Sales Returns', 'বিক্রয় ফেরত', 'income', 0, 0],
    ['4100', 'Sales Discount', 'বিক্রয় ডিসকাউন্ট', 'income', 0, 0],
    ['4200', 'Other Income', 'অন্যান্য আয়', 'income', 0, 0],
    ['4300', 'Inventory Gain', 'স্টক উদ্বৃত্ত', 'income', 0, 0],
    ['5000', 'Cost of Goods Sold', 'বিক্রীত পণ্যের ক্রয়মূল্য', 'expense', 0, 0],
    ['5100', 'Operating Expenses', 'পরিচালন ব্যয়', 'expense', 0, 0],
    ['5200', 'Purchase Returns', 'ক্রয় ফেরত', 'expense', 0, 0],
    ['5300', 'Inventory Loss', 'স্টক ঘাটতি', 'expense', 0, 0],
    ['5900', 'Miscellaneous Expense', 'বিবিধ ব্যয়', 'expense', 0, 0],
  ];
  const insert = db.prepare(
    `INSERT INTO accounts (code, name, name_bn, type, is_cash, is_bank, is_system, created_at)
     VALUES (?,?,?,?,?,?,1,?)
     ON CONFLICT(code) DO NOTHING`,
  );
  for (const [code, name, nameBn, type, isCash, isBank] of accounts) {
    insert.run(code, name, nameBn, type, isCash, isBank, now);
  }

  // New settings keys live in DEFAULT_SETTINGS (db/seed.ts) so the normal
  // seeding path inserts them with the correct serialisation on every open.
}
