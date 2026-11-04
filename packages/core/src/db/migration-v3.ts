import type { Database as SqliteDb } from 'better-sqlite3';
import { nowLocal } from '../domain/datetime.js';
import { SCHEMA_V3 } from './schema-v3.js';
import { addColumn } from './migration-v2.js';

type Db = SqliteDb;

export const GIFT_CARD_METHOD_NAME = 'গিফট কার্ড';
export const GIFT_CARD_ACCOUNT_CODE = '2150';

/**
 * Migration 3 — v1.1.
 *
 * Purely additive: new tables for purchase orders, coupons and stored value,
 * four new columns on existing documents, three new settings and one new
 * liability account for gift-card balances plus its payment method.
 */
export function migrateToV3(db: Db, log?: (msg: string) => void): void {
  db.exec(SCHEMA_V3);

  /* ---------- columns: link a received purchase back to its order ---------- */
  addColumn(db, 'purchases', 'purchase_order_id', 'INTEGER REFERENCES purchase_orders(id)');
  addColumn(db, 'sales', 'coupon_code', 'TEXT');
  addColumn(db, 'sales', 'coupon_discount_paisa', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'sales', 'gift_card_paisa', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'sales', 'exchange_of_sale_id', 'INTEGER REFERENCES sales(id)');

  /* ---------- gift-card liability account ---------- */
  const now = nowLocal();
  const existing = db
    .prepare('SELECT id FROM accounts WHERE code = ?')
    .get(GIFT_CARD_ACCOUNT_CODE) as { id: number } | undefined;
  let accountId = existing?.id ?? 0;
  if (!accountId) {
    const res = db
      .prepare(
        `INSERT INTO accounts (code, name, name_bn, type, parent_id, is_system, is_active, note, created_at)
         VALUES (?,?,?,'liability',NULL,1,1,?,?)`,
      )
      .run(
        GIFT_CARD_ACCOUNT_CODE,
        'Gift cards & vouchers payable',
        'গিফট কার্ড ও ভাউচার (দায়)',
        'Stored-value balances owed to customers',
        now,
      );
    accountId = Number(res.lastInsertRowid);
  }

  /* ---------- payment method that settles through that liability ---------- */
  const method = db.prepare('SELECT id, account_id FROM payment_methods WHERE name = ?').get(GIFT_CARD_METHOD_NAME) as
    | { id: number; account_id: number | null }
    | undefined;
  if (!method) {
    db.prepare(
      `INSERT INTO payment_methods (name, is_cash, is_active, is_system, sort_order, account_id)
       VALUES (?,0,1,1,?,?)`,
    ).run(GIFT_CARD_METHOD_NAME, 9, accountId);
    log?.('v3: gift card payment method created');
  } else if (!method.account_id) {
    db.prepare('UPDATE payment_methods SET account_id = ? WHERE id = ?').run(accountId, method.id);
  }

  /* ---------- new settings (INSERT OR IGNORE keeps shop values intact) ---------- */
  const defaults: [string, string][] = [
    ['language', 'bn'],
    ['login_lock_enabled', '1'],
    ['customer_display_enabled', '0'],
    ['gift_card_expiry_days', '0'],
    ['lan_mode', 'off'],
    ['lan_port', '4747'],
    ['lan_token', ''],
    ['lan_host_url', ''],
    ['receipt_show_qr', '1'],
  ];
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?,?,?)');
  for (const [k, v] of defaults) insert.run(k, v, now);

  log?.('v3: purchase orders, promotions and notifications ready');
}
