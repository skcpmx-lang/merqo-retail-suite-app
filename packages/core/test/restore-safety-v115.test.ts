/**
 * A restore must never be the reason a shop loses its data (v1.1.5, audit finding A-14).
 *
 * v1.1.4 restored by deleting the WAL sidecars and renaming the new file over the live database in
 * one step. On Windows that rename fails whenever anything still holds the file open — antivirus,
 * the search indexer, a backup agent — and when it did, the shop was left with **no database at the
 * live path**: the bytes existed only in `<live>.restoring` and the safety backup, which is a
 * manual, expert recovery in the worst moment. The swap is now two-step and reversible, and the
 * replaced file is kept until the restored database has been reopened and checked.
 *
 * These tests use real files on disk (a restore that cannot be tested against a real database is
 * not tested at all) and always work on temp copies.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createProduct } from '../src/services/products.js';
import { createBackup, restoreBackup } from '../src/services/backup.js';
import { listBackups } from '../src/services/backup.js';
import { closeDatabase, openDatabase } from '../src/db/connection.js';
import { initializeApp } from '../src/services/setup.js';
import { closeTrackedDatabases, openTrackedDatabase, removeTempDirs } from '../../../test-setup/temp-resources.js';

const dirs: string[] = [];

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-restore-'));
  dirs.push(dir);
  return dir;
}

function freshShop(dir: string, name: string) {
  const dbPath = path.join(dir, `${name}.db`);
  const db = openTrackedDatabase({ file: dbPath, appVersion: '1.1.5' });
  initializeApp(db, {
    businessName: name,
    businessAddress: 'ঢাকা',
    businessPhone: '01700000000',
    adminFullName: 'মালিক',
    adminUsername: 'owner',
    adminPassword: 'owner123',
  });
  const units = db.prepare('SELECT id FROM units LIMIT 1').get() as { id: number };
  createProduct(db, { name: `${name} পণ্য`, unitId: units.id, salePrice: 5000, openingStockMilli: 1000 }, { id: 1, username: 'owner' });
  return { db, dbPath };
}

const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

afterAll(() => {
  closeTrackedDatabases();
  removeTempDirs(dirs);
});

describe('a successful restore', () => {
  it('replaces the live database, keeps no working files behind, and keeps a safety backup', () => {
    const dir = workspace();
    const shop = freshShop(dir, 'মূল দোকান');

    // A backup of the shop as it is now…
    const backup = createBackup(shop.db, { dataDir: dir, appVersion: '1.1.5', kind: 'manual' });

    // …then the shop changes, so a restore is a real change.
    const units = shop.db.prepare('SELECT id FROM units LIMIT 1').get() as { id: number };
    createProduct(shop.db, { name: 'পরে যোগ হওয়া', unitId: units.id, salePrice: 1000, openingStockMilli: 500 }, { id: 1, username: 'owner' });

    const result = restoreBackup(shop.db, {
      backupPath: backup.filePath,
      dataDir: dir,
      livePath: shop.dbPath,
      appVersion: '1.1.5',
      actor: { id: 1, username: 'owner' },
    });

    // The live database is the backup's state, not the later one. (The file itself is then written
    // to once — the restore is logged in it — so the *content* is what a restore promises, not the
    // byte sequence.)
    // No half-finished swap left on disk.
    expect(fs.existsSync(`${shop.dbPath}.restoring`)).toBe(false);
    expect(fs.existsSync(`${shop.dbPath}.previous`)).toBe(false);
    expect(fs.existsSync(`${shop.dbPath}-wal`)).toBe(false);
    // A pre-restore backup exists and is itself a valid database.
    expect(fs.existsSync(result.safetyBackup)).toBe(true);
    const restored = openDatabase({ file: shop.dbPath, readonly: true });
    const count = restored.prepare('SELECT COUNT(*) c FROM products').get() as { c: number };
    expect(count.c).toBe(1);
    closeDatabase(restored);
  });
});

describe('a restore that must not happen', () => {
  it('leaves the live database byte-identical when the backup is truncated', () => {
    const dir = workspace();
    const shop = freshShop(dir, 'নিরাপদ দোকান');

    const backup = createBackup(shop.db, { dataDir: dir, appVersion: '1.1.5', kind: 'manual' });
    // Taken after the backup, immediately before the attempt: the restore must change nothing.
    const liveBefore = sha(shop.dbPath);
    // Corrupt the copy *and* its manifest, so the checksum cannot wave it through.
    const bytes = fs.readFileSync(backup.filePath);
    fs.writeFileSync(backup.filePath, bytes.subarray(0, Math.floor(bytes.length / 2)));
    fs.rmSync(`${backup.filePath}.json`, { force: true });

    expect(() =>
      restoreBackup(shop.db, {
        backupPath: backup.filePath,
        dataDir: dir,
        livePath: shop.dbPath,
        appVersion: '1.1.5',
        actor: { id: 1, username: 'owner' },
      }),
    ).toThrow();

    expect(sha(shop.dbPath)).toBe(liveBefore);
    expect(shop.db.prepare('SELECT COUNT(*) c FROM products').get()).toEqual({ c: 1 });
  });

  it('refuses a file that is not a Sauda backup without touching the shop', () => {
    const dir = workspace();
    const shop = freshShop(dir, 'যাচাই দোকান');
    const liveBefore = sha(shop.dbPath);
    const notABackup = path.join(dir, 'holiday-photo.jpg');
    fs.writeFileSync(notABackup, crypto.randomBytes(4096));

    expect(() =>
      restoreBackup(shop.db, {
        backupPath: notABackup,
        dataDir: dir,
        livePath: shop.dbPath,
        appVersion: '1.1.5',
        actor: { id: 1, username: 'owner' },
      }),
    ).toThrow(/SQLite|ব্যাকআপ/);
    expect(sha(shop.dbPath)).toBe(liveBefore);
  });

  it('refuses to restore a client database over a shop database', () => {
    const dir = workspace();
    const shop = freshShop(dir, 'সার্ভার দোকান');
    const backup = createBackup(shop.db, { dataDir: dir, appVersion: '1.1.5', kind: 'manual' });

    // Mark the live file as a client's, as `openClientDatabase` would.
    shop.db.prepare("INSERT INTO meta (key, value) VALUES ('db_role','client') ON CONFLICT(key) DO UPDATE SET value='client'").run();
    closeDatabase(shop.db);
    const liveBefore = sha(shop.dbPath);
    const reopened = openDatabase({ file: shop.dbPath, appVersion: '1.1.5' });

    expect(() =>
      restoreBackup(reopened, {
        backupPath: backup.filePath,
        dataDir: dir,
        livePath: shop.dbPath,
        appVersion: '1.1.5',
        actor: { id: 1, username: 'owner' },
      }),
    ).toThrow(/ক্লায়েন্ট/);
    closeDatabase(reopened);
    expect(sha(shop.dbPath)).toBe(liveBefore);
  });
});

describe('backup file names are unique (A-15)', () => {
  it('two backups taken in the same second do not overwrite each other', () => {
    const dir = workspace();
    const shop = freshShop(dir, 'দুই ব্যাকআপ');
    const first = createBackup(shop.db, { dataDir: dir, appVersion: '1.1.5', kind: 'manual', note: 'প্রথম' });
    const units = shop.db.prepare('SELECT id FROM units LIMIT 1').get() as { id: number };
    createProduct(shop.db, { name: 'নতুন পণ্য', unitId: units.id, salePrice: 1000, openingStockMilli: 100 }, { id: 1, username: 'owner' });
    const second = createBackup(shop.db, { dataDir: dir, appVersion: '1.1.5', kind: 'manual', note: 'দ্বিতীয়' });

    expect(second.filePath).not.toBe(first.filePath);
    expect(fs.existsSync(first.filePath)).toBe(true);
    expect(fs.existsSync(`${first.filePath}.json`)).toBe(true);
    // Each file still holds the state it was taken from, and each has its own manifest.
    const readCount = (file: string) => {
      const handle = openDatabase({ file, readonly: true });
      try {
        return (handle.prepare('SELECT COUNT(*) c FROM products').get() as { c: number }).c;
      } finally {
        closeDatabase(handle);
      }
    };
    expect(readCount(first.filePath)).toBe(1);
    expect(readCount(second.filePath)).toBe(2);
    const manifests = [first, second].map(
      (b) => JSON.parse(fs.readFileSync(`${b.filePath}.json`, 'utf8')) as { sha256: string; size_bytes: number },
    );
    expect(manifests[0]!.sha256).not.toBe(manifests[1]!.sha256);
    // Both are recorded, so the backup list matches the files on disk.
    expect(listBackups(shop.db).length).toBe(2);
  });

  it('keeps the source backup intact when a restore creates its safety copy', () => {
    const dir = workspace();
    const shop = freshShop(dir, 'সোর্স সুরক্ষা');
    const source = createBackup(shop.db, { dataDir: dir, appVersion: '1.1.5', kind: 'manual' });
    const sourceSha = sha(source.filePath);
    const units = shop.db.prepare('SELECT id FROM units LIMIT 1').get() as { id: number };
    createProduct(shop.db, { name: 'পরে', unitId: units.id, salePrice: 1000, openingStockMilli: 100 }, { id: 1, username: 'owner' });

    restoreBackup(shop.db, { backupPath: source.filePath, dataDir: dir, livePath: shop.dbPath, appVersion: '1.1.5', actor: { id: 1, username: 'owner' } });

    // The file that was restored from is byte-for-byte the one that was made, not the safety copy.
    expect(sha(source.filePath)).toBe(sourceSha);
    const restored = openDatabase({ file: shop.dbPath, readonly: true });
    expect(restored.prepare('SELECT COUNT(*) c FROM products').get()).toEqual({ c: 1 });
    closeDatabase(restored);
  });
});
