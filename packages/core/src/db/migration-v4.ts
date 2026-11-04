import type { Database as SqliteDb } from 'better-sqlite3';
import { SCHEMA_V4 } from './schema-v4.js';

type Db = SqliteDb;

/**
 * Migration 4 — login attempt protection.
 *
 * Additive: one small table. Run inside the caller's transaction together with
 * the `user_version` bump.
 */
export function migrateToV4(db: Db, log?: (msg: string) => void): void {
  db.exec(SCHEMA_V4);
  log?.('migration 4: login_attempts ready');
}
