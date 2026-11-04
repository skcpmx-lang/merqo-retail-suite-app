import type { Database as SqliteDb } from 'better-sqlite3';
import { SCHEMA_V6 } from './schema-v6.js';

type Db = SqliteDb;

/**
 * Migration 6 — restart-safe replay protection and rotation journal (v1.1.4).
 *
 * Additive only: two new tables. No customer, product, sales, stock, accounting,
 * user or licence row is read, written or moved. The caller wraps this in a
 * transaction together with the `user_version` bump, and `migrate()` has already
 * written a `.pre-migration-*` copy of the file.
 */
export function migrateToV6(db: Db, log?: (msg: string) => void): void {
  db.exec(SCHEMA_V6);
  log?.('migration 6: replay protection and rotation journal ready');
}
