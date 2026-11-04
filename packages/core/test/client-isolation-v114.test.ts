/**
 * v1.1.4 Phase 3 — D-11 client database isolation.
 *
 * A Client PC must never be able to commit shop data locally, and must never present a
 * stale local copy as the shop. These tests drive the real services through a guarded
 * connection rather than trusting routing conventions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ClientIsolationError,
  adjustStock,
  classifySql,
  createBackup,
  createExpense,
  createSale,
  dashboardStats,
  receiveCustomerPayment,
  runReport,
  getMeta,
  guardClientDatabase,
  isClientGuarded,
  openClientDatabase,
  openDatabase,
  setMeta,
  tablesInSql,
  updateSettings,
  type Db,
} from '../src/index.js';
import { makeTestDb, seedProducts, type TestContext } from './helpers.js';

const contexts: TestContext[] = [];
const tempFiles: string[] = [];

function shop(): TestContext {
  const ctx = makeTestDb({ file: true });
  contexts.push(ctx);
  seedProducts(ctx);
  return ctx;
}

function counts(db: Db): Record<string, number> {
  const tables = ['sales', 'sale_items', 'payments', 'products', 'customers', 'stock_movements', 'journal_entries'];
  const out: Record<string, number> = {};
  for (const table of tables) {
    try {
      out[table] = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    } catch {
      out[table] = -1;
    }
  }
  return out;
}

afterEach(() => {
  for (const ctx of contexts.splice(0)) ctx.cleanup();
  for (const file of tempFiles.splice(0)) fs.rmSync(file, { force: true });
});

describe('SQL classification', () => {
  it('finds the target table for writes and reads', () => {
    expect(classifySql('INSERT INTO sales (id) VALUES (1)')).toEqual({ kind: 'write', tables: ['sales'] });
    expect(classifySql('INSERT OR REPLACE INTO customers (id) VALUES (1)')).toEqual({ kind: 'write', tables: ['customers'] });
    expect(classifySql('DELETE FROM stock_movements WHERE id = 1')).toEqual({ kind: 'write', tables: ['stock_movements'] });
    expect(classifySql('UPDATE settings SET value = ? WHERE key = ?')).toEqual({ kind: 'write', tables: ['settings'] });
    expect(classifySql('SELECT id FROM sale_items').tables).toContain('sale_items');
    expect(classifySql('DROP TABLE sales')).toEqual({ kind: 'schema', tables: ['sales'] });
    expect(classifySql('PRAGMA user_version')).toEqual({ kind: 'pragma', tables: [] });
  });

  it('cannot be fooled by comments or string literals', () => {
    expect(tablesInSql("SELECT 'INSERT INTO sales' AS note FROM settings")).toEqual(['settings']);
    expect(tablesInSql('/* SELECT * FROM sales */ SELECT key FROM settings')).toEqual(['settings']);
    expect(tablesInSql('-- FROM sales\nSELECT 1 FROM meta')).toEqual(['meta']);
  });
});

describe('guarded client connection', () => {
  it('still allows the tables a client owns', () => {
    const ctx = shop();
    const client = guardClientDatabase(ctx.db);
    updateSettings(client, { business_name: 'ক্লায়েন্ট সেটিংস' }, null);
    setMeta(client, 'client_mode', '1');
    expect(getMeta(client, 'client_mode')).toBe('1');
    expect(Number(client.pragma('user_version', { simple: true }))).toBeGreaterThan(0);
  });

  it('refuses a real sale committed through the ordinary service', () => {
    const ctx = shop();
    const before = counts(ctx.db);
    const client = guardClientDatabase(ctx.db);

    expect(() =>
      createSale(client, {
        lines: [{ productId: 1, unitId: ctx.unitKgId, qtyMilli: 1000 }],
        paidPaisa: 10_000,
        defaultMethodId: ctx.cashMethodId,
        actor: ctx.actor,
      }),
    ).toThrow(ClientIsolationError);

    // Nothing reached the database — not even a draft line or a stock movement.
    expect(counts(ctx.db)).toEqual(before);
  });

  it('refuses a stock adjustment and a customer write', () => {
    const ctx = shop();
    const client = guardClientDatabase(ctx.db);
    const before = counts(ctx.db);

    expect(() =>
      adjustStock(client, { productId: 1, newQtyBaseMilli: 500_000, reason: 'ক্লায়েন্ট চেষ্টা', actor: ctx.actor }),
    ).toThrow(ClientIsolationError);
    expect(() => client.prepare('INSERT INTO customers (name) VALUES (?)').run('নতুন')).toThrow(ClientIsolationError);
    expect(() => client.prepare('DELETE FROM products').run()).toThrow(ClientIsolationError);
    expect(counts(ctx.db)).toEqual(before);
  });

  it('blocks payments, expenses, dashboards, reports and backups on a client', () => {
    const ctx = shop();
    const client = guardClientDatabase(ctx.db);
    const before = counts(ctx.db);

    expect(() => receiveCustomerPayment(client, { customerId: 1, amount: 1000, methodId: ctx.cashMethodId }, ctx.actor)).toThrow(
      ClientIsolationError,
    );
    expect(() =>
      createExpense(client, { categoryId: 1, amountPaisa: 500, methodId: ctx.cashMethodId, description: 'x' }, ctx.actor),
    ).toThrow(ClientIsolationError);
    expect(() => dashboardStats(client)).toThrow(ClientIsolationError);
    expect(() => runReport(client, 'stock_valuation', {})).toThrow(ClientIsolationError);
    expect(() =>
      createBackup(client, { dataDir: path.dirname(ctx.dbPath), kind: 'manual', appVersion: '1.1.4' }),
    ).toThrow(ClientIsolationError);

    expect(counts(ctx.db)).toEqual(before);
  });

  it('does not present a stale local copy as current shop data', () => {
    const ctx = shop();
    const client = guardClientDatabase(ctx.db);
    for (const sql of [
      'SELECT COUNT(*) AS n FROM sales',
      'SELECT name FROM products LIMIT 1',
      'SELECT * FROM customers',
      'SELECT * FROM stock_movements',
      'SELECT * FROM journal_entries',
    ]) {
      expect(() => client.prepare(sql).get()).toThrow(ClientIsolationError);
    }
    // Freshness-critical reads fail loudly instead of returning yesterday's numbers.
    try {
      client.prepare('SELECT COUNT(*) AS n FROM sales').get();
    } catch (err) {
      expect((err as ClientIsolationError).code).toBe('CLIENT_LOCAL_READ_BLOCKED');
      expect((err as ClientIsolationError).table).toBe('sales');
    }
  });

  it('blocks schema changes, pragma writes and backups', () => {
    const ctx = shop();
    const client = guardClientDatabase(ctx.db);
    expect(() => client.exec('DROP TABLE sales')).toThrow(ClientIsolationError);
    expect(() => client.pragma('journal_mode = DELETE')).toThrow(ClientIsolationError);
    expect(() => (client as unknown as { backup: (f: string) => void }).backup('x.bak')).toThrow(ClientIsolationError);
    // The table still exists afterwards.
    expect((ctx.db.prepare("SELECT name FROM sqlite_master WHERE name = 'sales'").get() as { name: string }).name).toBe('sales');
  });

  it('blocks writes inside a transaction but keeps settings transactions working', () => {
    const ctx = shop();
    const client = guardClientDatabase(ctx.db);
    const bad = client.transaction(() => {
      client.prepare('INSERT INTO sales (id) VALUES (1)').run();
    });
    expect(() => bad()).toThrow(ClientIsolationError);

    const good = client.transaction(() => {
      updateSettings(client, { receipt_footer: 'ক্লায়েন্ট' }, null);
    });
    good();
    expect((client.prepare("SELECT value FROM settings WHERE key = 'receipt_footer'").get() as { value: string }).value).toBeTruthy();
  });

  it('reports every blocked attempt to the caller for logging', () => {
    const ctx = shop();
    const blocked: string[] = [];
    const client = guardClientDatabase(ctx.db, { onBlocked: (err) => blocked.push(err.table ?? err.code) });
    expect(() => client.prepare('SELECT * FROM sales').get()).toThrow(ClientIsolationError);
    expect(blocked).toEqual(['sales']);
  });
});

describe('client role database opening', () => {
  it('never migrates, seeds or changes an existing shop database', () => {
    const ctx = shop();
    // Pretend this install is older: mark an older schema version and add shop data.
    ctx.db.pragma('user_version = 4');
    setMeta(ctx.db, 'schema_version', '4');
    const before = counts(ctx.db);
    const versionBefore = Number(ctx.db.pragma('user_version', { simple: true }));
    const settingsBefore = (ctx.db.prepare('SELECT COUNT(*) AS n FROM settings').get() as { n: number }).n;
    ctx.db.close();

    const client = openClientDatabase({ file: ctx.dbPath, appVersion: '1.1.4' });
    expect(isClientGuarded(client)).toBe(true);
    const raw = openDatabase({ file: ctx.dbPath, readonly: true });
    try {
      expect(Number(raw.pragma('user_version', { simple: true }))).toBe(versionBefore);
      expect((raw.prepare('SELECT COUNT(*) AS n FROM settings').get() as { n: number }).n).toBe(settingsBefore);
      expect(counts(raw)).toEqual(before);
      // No pre-migration backup copy was created either.
      expect(fs.readdirSync(path.dirname(ctx.dbPath)).filter((f) => f.endsWith('.bak'))).toHaveLength(0);
    } finally {
      raw.close();
      client.close();
    }
  });

  it('creates a fresh client database without fake reference data', () => {
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'sauda-client-'));
    const file = path.join(dir, 'client.db');
    tempFiles.push(file);
    const client = openClientDatabase({ file, appVersion: '1.1.4' });
    try {
      // Schema exists (settings can be read) …
      expect(() => client.prepare('SELECT key FROM settings LIMIT 1').all()).not.toThrow();
      // … but no products, categories or customers were invented locally.
      const raw = openDatabase({ file, readonly: true });
      try {
        for (const table of ['products', 'customers', 'sales']) {
          const row = raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
          expect(row.n).toBe(0);
        }
      } finally {
        raw.close();
      }
    } finally {
      client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
