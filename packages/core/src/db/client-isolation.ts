import fs from 'node:fs';
import { openDatabase, type Db } from './connection.js';

/**
 * Client-mode database isolation (v1.1.4 Phase 3, finding D-11).
 *
 * A Client PC must not be an authoritative database. Before this module the app opened
 * the same shop database on every machine and relied on the renderer to route business
 * calls to the Main PC — one missed route, one future feature, and a client would commit
 * a sale into its own private copy of the shop. That copy would then look like real data
 * on the next screen, and would later be restored over the real shop.
 *
 * Two independent controls now exist:
 *
 *  1. **The database is guarded in client mode.** Only the tables a client legitimately
 *     owns locally (`settings`, `meta`, `schema_migrations`) can be read or written.
 *     Anything else throws `ClientIsolationError` instead of silently succeeding.
 *  2. **Existing local data is never touched.** A client opens an existing database with
 *     migrations disabled — no seed, no schema change, no copy, no delete — so a
 *     v1.1.3 install keeps its business data byte-for-byte while it works as a client.
 *     There is no migration plan for client-local business data because it is never used.
 *
 * The guard is a runtime check, not documentation: tests drive the real `createSale`,
 * `adjustStock` and raw SQL paths through it.
 */

export type ClientIsolationCode =
  | 'CLIENT_LOCAL_WRITE_BLOCKED'
  | 'CLIENT_LOCAL_READ_BLOCKED'
  | 'CLIENT_LOCAL_SCHEMA_BLOCKED'
  | 'CLIENT_LOCAL_PRAGMA_BLOCKED'
  | 'CLIENT_LOCAL_OP_BLOCKED';

export class ClientIsolationError extends Error {
  code: ClientIsolationCode;
  table: string | null;
  sql: string;
  constructor(code: ClientIsolationCode, message: string, sql = '', table: string | null = null) {
    super(message);
    this.code = code;
    this.sql = sql;
    this.table = table;
    this.name = 'ClientIsolationError';
  }
}

/**
 * Tables a client may keep locally: its own settings, database meta, the schema
 * bookkeeping table and a local diagnostic log. Everything else in the shop schema —
 * sales, payments, products, stock, customers, suppliers, accounting, devices, outbox —
 * belongs to the Main Server and is unreachable through a guarded connection.
 */
export const CLIENT_LOCAL_TABLES: readonly string[] = [
  'settings',
  'meta',
  'schema_migrations',
  // A client keeps a local diagnostic log (why a setting changed, why pairing failed).
  // It is never authoritative and never contains shop transactions.
  'audit_logs',
];

/** Read-only pragmas that a client may still ask about. */
const ALLOWED_PRAGMAS = new Set(['user_version', 'journal_mode', 'synchronous', 'busy_timeout', 'foreign_keys', 'table_info', 'index_list']);

export interface SqlShape {
  kind: 'read' | 'write' | 'schema' | 'pragma' | 'unknown';
  tables: string[];
}

/** Removes comments and string literals so keyword matching cannot be spoofed. */
function sanitise(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      out += ' ';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 2;
      out += ' ';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          break;
        }
        i += 1;
      }
      i += 1;
      out += ' ';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Table names a statement touches. Writes carry exactly one target table; reads collect
 * every `FROM`/`JOIN` source (CTE aliases are recognised and skipped).
 */
export function tablesInSql(sql: string): string[] {
  const clean = sanitise(sql);
  const head = (clean.split(' ')[0] ?? '').toUpperCase();
  const tables = new Set<string>();
  const first = (re: RegExp): void => {
    const m = clean.match(re);
    if (m?.[1]) tables.add(m[1].toLowerCase());
  };
  if (head === 'INSERT') first(/^INSERT\s+(?:OR\s+\w+\s+)?INTO\s+([a-z_][a-z0-9_]*)/i);
  else if (head === 'REPLACE') first(/^REPLACE\s+INTO\s+([a-z_][a-z0-9_]*)/i);
  else if (head === 'UPDATE') first(/^UPDATE\s+(?:OR\s+\w+\s+)?([a-z_][a-z0-9_]*)/i);
  else if (head === 'DELETE') first(/^DELETE\s+FROM\s+([a-z_][a-z0-9_]*)/i);
  else if (['CREATE', 'DROP', 'ALTER', 'REINDEX'].includes(head)) {
    first(/^\w+\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|VIEW|TRIGGER)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?([a-z_][a-z0-9_]*)/i);
  } else {
    // CTE aliases: `WITH name AS (…)`, `, name AS (…)`
    const ctes = new Set<string>();
    for (const m of clean.matchAll(/(?:with|,)\s+([a-z_][a-z0-9_]*)\s+as\s*\(/gi)) ctes.add(m[1]!.toLowerCase());
    for (const m of clean.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)/gi)) {
      const name = m[1]!.toLowerCase();
      if (name === 'select' || ctes.has(name)) continue;
      tables.add(name);
    }
  }
  return [...tables];
}

/** Classifies a statement for the guard (exported so tests can pin the rules). */
export function classifySql(sql: string): SqlShape {
  const clean = sanitise(sql);
  const head = clean.split(' ')[0]?.toUpperCase() ?? '';
  const tables = tablesInSql(sql);
  if (head === 'PRAGMA') return { kind: 'pragma', tables };
  if (['INSERT', 'UPDATE', 'DELETE', 'REPLACE'].includes(head)) return { kind: 'write', tables };
  if (['CREATE', 'DROP', 'ALTER', 'VACUUM', 'REINDEX', 'ATTACH', 'DETACH'].includes(head)) return { kind: 'schema', tables };
  if (head === 'SELECT' || head === 'WITH') return { kind: 'read', tables };
  if (['BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE'].includes(head)) return { kind: 'unknown', tables };
  return { kind: 'unknown', tables };
}

export interface GuardOptions {
  /** Table allowlist override (tests only). */
  allowedTables?: readonly string[];
  /** Called for each blocked attempt, so the app can log it. */
  onBlocked?: (error: ClientIsolationError) => void;
}

/**
 * Wraps a database handle so a client cannot read or write business tables.
 *
 * Everything the app calls on a `Db` goes through this proxy: `prepare`, `exec`,
 * `pragma`, `transaction`, `backup`. Unknown members fall through, so the object still
 * behaves like a database for settings-only code.
 */
export function guardClientDatabase(db: Db, opts: GuardOptions = {}): Db {
  const allowed = new Set(opts.allowedTables ?? CLIENT_LOCAL_TABLES);
  const blocked = (error: ClientIsolationError): never => {
    opts.onBlocked?.(error);
    throw error;
  };

  const checkTable = (table: string, sql: string, kind: 'read' | 'write'): void => {
    if (allowed.has(table)) return;
    blocked(
      new ClientIsolationError(
        kind === 'write' ? 'CLIENT_LOCAL_WRITE_BLOCKED' : 'CLIENT_LOCAL_READ_BLOCKED',
        kind === 'write'
          ? `ক্লায়েন্ট মোডে "${table}" টেবিলে লেখা যাবে না — সব ব্যবসায়িক ডেটা মূল কম্পিউটারে থাকে।`
          : `ক্লায়েন্ট মোডে "${table}" এর স্থানীয় কপি দেখানো হয় না — ডেটা মূল কম্পিউটার থেকে আনুন।`,
        sql,
        table,
      ),
    );
  };

  const inspect = (sql: string): void => {
    const shape = classifySql(sql);
    if (shape.kind === 'pragma') {
      const body = sanitise(sql).replace(/^PRAGMA\s+/i, '');
      const name = (body.split(/[\s=(]/)[0] ?? '').toLowerCase();
      // Assignments change the database file (journal mode, page size, …): never allowed
      // on a client. Read-only diagnostics are fine.
      const isAssignment = body.includes('=') || name === 'wal_checkpoint';
      const readable = ALLOWED_PRAGMAS.has(name) || name.startsWith('table_info') || name.startsWith('index_list');
      if (isAssignment || !readable) {
        blocked(new ClientIsolationError('CLIENT_LOCAL_PRAGMA_BLOCKED', `ক্লায়েন্ট মোডে pragma "${name}" অনুমোদিত নয়।`, sql));
      }
      return;
    }
    if (shape.kind === 'schema') {
      blocked(new ClientIsolationError('CLIENT_LOCAL_SCHEMA_BLOCKED', 'ক্লায়েন্ট মোডে স্কিমা পরিবর্তন করা যাবে না।', sql));
    }
    if (shape.kind === 'write') {
      if (!shape.tables.length) {
        blocked(new ClientIsolationError('CLIENT_LOCAL_OP_BLOCKED', 'ক্লায়েন্ট মোডে লেখা অনুমোদিত নয়।', sql));
      }
      for (const table of shape.tables) checkTable(table, sql, 'write');
      return;
    }
    if (shape.kind === 'read') {
      for (const table of shape.tables) checkTable(table, sql, 'read');
    }
  };

  const proxy = new Proxy(db as unknown as Record<string, unknown>, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      const method = String(prop);

      if (method === 'prepare') {
        return (sql: string, ...rest: unknown[]) => {
          inspect(String(sql));
          return (value as (...a: unknown[]) => unknown).call(target, sql, ...rest);
        };
      }
      if (method === 'exec') {
        return (sql: string) => {
          // `exec` can hold several statements; check each one.
          for (const part of String(sql).split(';')) {
            if (part.trim()) inspect(part);
          }
          return (value as (...a: unknown[]) => unknown).call(target, sql);
        };
      }
      if (method === 'pragma') {
        return (source: string, ...rest: unknown[]) => {
          inspect(`PRAGMA ${String(source)}`);
          return (value as (...a: unknown[]) => unknown).call(target, source, ...rest);
        };
      }
      if (method === 'backup' || method === 'serialize') {
        return () => blocked(new ClientIsolationError('CLIENT_LOCAL_OP_BLOCKED', 'ক্লায়েন্ট মোডে ব্যাকআপ তৈরি করা যায় না — মূল কম্পিউটার ব্যাকআপ রাখে।', method));
      }
      if (method === 'transaction') {
        return (...args: unknown[]) => {
          const fn = args[0] as (...a: unknown[]) => unknown;
          const wrapped = (...inner: unknown[]) => fn(...inner);
          return (value as (...a: unknown[]) => unknown).call(target, wrapped, ...args.slice(1));
        };
      }
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  });

  return proxy as unknown as Db;
}

/** True when this handle is a client-mode guard (used by tests and logging). */
export function isClientGuarded(db: Db): boolean {
  return Boolean((db as unknown as { __clientGuard?: boolean }).__clientGuard);
}

export interface OpenClientOptions {
  file: string;
  appVersion?: string;
  log?: (msg: string) => void;
  onBlocked?: (error: ClientIsolationError) => void;
}

/**
 * Opens the local database in client role.
 *
 * - existing file: opened **without** migrations, so no customer data is migrated,
 *   re-seeded, copied or deleted; the guard then blocks every business table;
 * - no file: a fresh schema is created **without** reference-data seeding, so a client
 *   never gets fake local products, categories or units that could look authoritative.
 */
export function openClientDatabase(opts: OpenClientOptions): Db {
  const exists = opts.file !== ':memory:' && fs.existsSync(opts.file);
  const db = exists
    ? openDatabase({ file: opts.file, skipMigrate: true, log: opts.log })
    : openDatabase({ file: opts.file, appVersion: opts.appVersion, seed: false, log: opts.log });
  const guarded = guardClientDatabase(db, { onBlocked: opts.onBlocked });
  Object.defineProperty(guarded, '__clientGuard', { value: true, enumerable: false });
  return guarded;
}

/**
 * Reads the role a local database was last used in, without writing to it.
 *
 * `settings.lan_mode = 'terminal'` marks a Client PC. The check opens the file read-only
 * and closes it immediately, so it cannot migrate, seed or create anything.
 */
export function detectDatabaseRole(file: string): 'client' | 'server' | 'missing' {
  if (!fs.existsSync(file)) return 'missing';
  let db: Db | null = null;
  try {
    db = openDatabase({ file, readonly: true });
    const row = db.prepare("SELECT value FROM settings WHERE key = 'lan_mode'").get() as { value: string } | undefined;
    return row?.value === 'terminal' ? 'client' : 'server';
  } catch {
    // A database we cannot read is not something to promote into a client role.
    return 'server';
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
}
