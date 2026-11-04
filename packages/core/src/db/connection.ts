import Database from 'better-sqlite3';
import type { Database as SqliteDb } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_V1, SCHEMA_VERSION } from './schema.js';
import { seedReferenceData } from './seed.js';
import { migrateToV2 } from './migration-v2.js';
import { migrateToV3 } from './migration-v3.js';
import { migrateToV4 } from './migration-v4.js';
import { migrateToV5 } from './migration-v5.js';
import { migrateToV6 } from './migration-v6.js';

export type Db = SqliteDb;

export interface OpenOptions {
  /** Absolute path to the .db file, or ':memory:' for tests. */
  file: string;
  /** Application version written into meta on migration. */
  appVersion?: string;
  /** Read-only connections are used by the backup validator. */
  readonly?: boolean;
  /** Skip migrations (caller will run them). */
  skipMigrate?: boolean;
  /** Optional logger for migration diagnostics. */
  log?: (msg: string) => void;
}

export interface MigrationResult {
  from: number;
  to: number;
  applied: string[];
  backedUp: string | null;
}

/**
 * Pragmas are passed to better-sqlite3 *without* the `PRAGMA` keyword — the
 * driver adds it. Including it made every statement a syntax error, which the
 * old error handling swallowed: WAL was never actually enabled (audit F5).
 */
const PRAGMAS = [
  'journal_mode = WAL',
  'synchronous = FULL',
  'foreign_keys = ON',
  'busy_timeout = 8000',
  'temp_store = MEMORY',
  'cache_size = -16000',
  'wal_autocheckpoint = 512',
];

export function ensureDirFor(file: string): void {
  const dir = path.dirname(file);
  if (dir && dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function openDatabase(opts: OpenOptions): Db {
  const { file, readonly = false } = opts;
  if (file !== ':memory:') ensureDirFor(file);
  const db = new Database(file, { readonly, fileMustExist: readonly });
  if (!readonly) {
    for (const p of PRAGMAS) {
      try {
        db.pragma(p);
      } catch (err) {
        opts.log?.(`pragma failed: ${p} — ${(err as Error).message}`);
      }
    }
    // Durability settings are not optional: verify the ones we rely on rather
    // than trusting that the statements were accepted.
    const journal = String(db.pragma('journal_mode', { simple: true }) ?? '').toLowerCase();
    if (journal !== 'wal') {
      opts.log?.(`journal_mode is ${journal || 'unknown'} (WAL unavailable for this database)`);
    }
    if (Number(db.pragma('synchronous', { simple: true })) !== 2) {
      db.pragma('synchronous = FULL');
    }
    if (Number(db.pragma('foreign_keys', { simple: true })) !== 1) {
      throw new Error('ডাটাবেজে foreign key প্রয়োগ করা যাচ্ছে না — অ্যাপ্লিকেশন চালু করা নিরাপদ নয়।');
    }
    if (Number(db.pragma('busy_timeout', { simple: true })) <= 0) {
      db.pragma('busy_timeout = 8000');
    }
  } else {
    db.pragma('busy_timeout = 8000');
  }
  if (!opts.skipMigrate && !readonly) {
    try {
      migrate(db, opts);
    } catch (err) {
      // A failed open (e.g. the database was written by a newer version) must
      // not leak the connection: on Windows the file stays locked and the
      // shopkeeper cannot retry, move or back up their data.
      try {
        db.close();
      } catch {
        /* already closed */
      }
      throw err;
    }
  }
  return db;
}

/* ------------------------------------------------------------------ */
/* Migrations                                                         */
/* ------------------------------------------------------------------ */

interface Migration {
  version: number;
  name: string;
  up: (db: Db) => void;
}

/**
 * Ordered, append-only migration list. NEVER edit an existing migration —
 * add a new one. Each entry runs inside its own transaction together with the
 * `user_version` bump, so a failed migration leaves the database untouched.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up: (db) => {
      db.exec(SCHEMA_V1);
    },
  },
  {
    version: 2,
    name: 'advanced_retail_and_accounting',
    up: (db) => {
      migrateToV2(db);
    },
  },
  {
    version: 3,
    name: 'purchase_orders_promotions_and_lan',
    up: (db) => {
      migrateToV3(db);
    },
  },
  {
    version: 4,
    name: 'login_attempt_protection',
    up: (db) => {
      migrateToV4(db);
    },
  },
  {
    version: 5,
    name: 'multi_pc_devices_sessions_events',
    up: (db) => {
      migrateToV5(db);
    },
  },
  {
    version: 6,
    name: 'replay_protection_and_rotation_journal',
    up: (db) => {
      migrateToV6(db);
    },
  },
];

export function currentSchemaVersion(db: Db): number {
  const row = db.pragma('user_version', { simple: true }) as number;
  return Number(row) || 0;
}

export function migrate(db: Db, opts: OpenOptions): MigrationResult {
  const from = currentSchemaVersion(db);
  const applied: string[] = [];
  let backedUp: string | null = null;

  if (from > SCHEMA_VERSION) {
    throw new Error(
      `এই ডাটাবেজ নতুন ভার্সনের (${from}) — অ্যাপ্লিকেশন ভার্সন ${SCHEMA_VERSION} এটি পড়তে পারবে না।`,
    );
  }
  if (from === SCHEMA_VERSION) {
    // Still make sure reference tables exist on databases created by a crash.
    seedReferenceData(db);
    return { from, to: from, applied, backedUp };
  }

  // Safety backup before touching an existing, non-empty database.
  if (from > 0 && opts.file !== ':memory:') {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const target = `${opts.file}.pre-migration-v${from}-to-v${SCHEMA_VERSION}-${stamp}.bak`;
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      fs.copyFileSync(opts.file, target);
      backedUp = target;
      opts.log?.(`migration: safety backup → ${target}`);
    } catch (err) {
      opts.log?.(`migration: backup failed — ${(err as Error).message}`);
    }
  }

  for (const m of MIGRATIONS) {
    if (m.version <= from) continue;
    const run = db.transaction(() => {
      m.up(db);
      db.pragma(`user_version = ${m.version}`);
    });
    try {
      run();
      applied.push(`${m.version}:${m.name}`);
      opts.log?.(`migration applied ${m.version}:${m.name}`);
    } catch (err) {
      throw new Error(`মাইগ্রেশন ব্যর্থ (${m.name}): ${(err as Error).message}`);
    }
  }

  seedReferenceData(db);
  const to = currentSchemaVersion(db);
  const now = new Date().toISOString();
  setMeta(db, 'schema_version', String(to));
  setMeta(db, 'app_version', opts.appVersion ?? '1.0.0');
  setMeta(db, 'migrated_at', now);

  // Quick post-migration verification.
  const check = db.pragma('quick_check', { simple: true });
  if (String(check).toLowerCase() !== 'ok') {
    throw new Error(`মাইগ্রেশনের পরে ডাটাবেজ চেক ব্যর্থ: ${String(check)}`);
  }
  return { from, to, applied, backedUp };
}

/* ------------------------------------------------------------------ */
/* Meta & helpers                                                     */
/* ------------------------------------------------------------------ */

export function getMeta(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

/** Run a unit of work atomically. Nested calls reuse the outer transaction. */
export function tx<T>(db: Db, fn: () => T): T {
  const wrapped = db.transaction(fn);
  return wrapped.immediate() as T;
}

export function integrityCheck(db: Db): { ok: boolean; detail: string } {
  try {
    const check = db.pragma('integrity_check', { simple: true });
    const fk = db.pragma('foreign_key_check') as unknown[];
    const ok = String(check).toLowerCase() === 'ok' && (!fk || fk.length === 0);
    return {
      ok,
      detail: ok ? 'ok' : `integrity: ${String(check)}; foreign_key issues: ${(fk ?? []).length}`,
    };
  } catch (err) {
    return { ok: false, detail: `ডাটাবেজ পড়া যাচ্ছে না: ${(err as Error).message}` };
  }
}

export function tableCounts(db: Db): Record<string, number> {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  const out: Record<string, number> = {};
  for (const t of tables) {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM "${t.name}"`).get() as { c: number };
    out[t.name] = row.c;
  }
  return out;
}

export function nextCounter(db: Db, key: string): number {
  const row = db.prepare('SELECT value FROM counters WHERE key = ?').get(key) as { value: number } | undefined;
  const next = (row?.value ?? 0) + 1;
  db.prepare(
    'INSERT INTO counters (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, next);
  return next;
}

export function checkpoint(db: Db): void {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    /* non-fatal */
  }
}

export function closeDatabase(db: Db): void {
  try {
    checkpoint(db);
  } catch {
    /* ignore */
  }
  try {
    db.close();
  } catch {
    /* ignore */
  }
}

/**
 * Best-effort repair for a database that failed the integrity check:
 * re-index, checkpoint and vacuum. Returns a human readable result.
 */
export function repairDatabase(db: Db): { ok: boolean; message: string } {
  try {
    db.exec('REINDEX');
    db.exec('VACUUM');
    const after = integrityCheck(db);
    return { ok: after.ok, message: after.ok ? 'ডাটাবেজ মেরামত সফল হয়েছে।' : after.detail };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}
