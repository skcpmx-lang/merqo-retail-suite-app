import crypto from 'node:crypto';
import type { Database as SqliteDb } from 'better-sqlite3';
import { SCHEMA_V5 } from './schema-v5.js';

type Db = SqliteDb;

/**
 * Migration 5 — multi-PC foundation (v1.1.4).
 *
 * Additive only: nine new tables, no ALTER, no UPDATE, no DELETE. The caller
 * wraps this in a transaction together with the `user_version` bump, and
 * `migrate()` has already written a `.pre-migration-*` copy of the file.
 *
 * After the tables exist we seed the single `store_servers` row when it is
 * missing so the store identity is stable from the first v1.1.4 launch.
 */
export function migrateToV5(db: Db, log?: (msg: string) => void): void {
  db.exec(SCHEMA_V5);

  const row = db.prepare('SELECT COUNT(*) AS n FROM store_servers').get() as { n: number };
  if (!row || row.n === 0) {
    const now = new Date().toISOString();
    const id = () => randomId();
    db.prepare(
      `INSERT INTO store_servers (id, store_id, server_id, server_name, created_at, updated_at)
       VALUES (1, ?, ?, '', ?, ?)`,
    ).run(`STORE-${id()}`, `SRV-${id()}`, now, now);
    log?.('migration 5: store identity created');
  }
  log?.('migration 5: multi-PC tables ready');
}

function randomId(): string {
  // 8 bytes of CSPRNG, upper-case base36 — readable in a QR and unique enough
  // for a single-store identity (collisions are also prevented by UNIQUE).
  const bytes = crypto.randomBytes(8);
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) | BigInt(byte);
  return n.toString(36).toUpperCase().padStart(13, '0');
}
