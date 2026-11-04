/**
 * v1.1.4 regression — Windows file-lock release (`EBUSY`) and connection accounting.
 *
 * The v1.1.4 release build failed on `windows-latest` at `tests: core` with
 *
 *   Error: EBUSY: resource busy or locked, unlink '…\\shop.db'
 *
 * while the same commit was 687/687 green on Linux. Linux happily unlinks a file that is still
 * open; Windows refuses, so any code path that forgets to close a database keeps the file locked —
 * which for a shopkeeper means a backup, restore or upgrade cannot replace the database.
 *
 * These tests pin the two behaviours that make that failure impossible to reintroduce silently:
 *   1. a closed database releases its file, so the directory can be removed *without retries*;
 *   2. every open database is counted, so a leaked connection is visible on Linux too — the
 *      platform where the leak used to be invisible (`test-setup/database-leak-guard.ts` asserts
 *      the file-backed count is zero at the end of every test file).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, initializeApp, openDatabase, openDatabaseCount } from '../src/index.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-lock-'));
  dirs.push(dir);
  return dir;
}

function openShop(file: string) {
  const db = openDatabase({ file, appVersion: '1.1.4' });
  initializeApp(db, {
    businessName: 'লক টেস্ট মার্ট',
    businessAddress: 'চট্টগ্রাম',
    businessPhone: '01800000000',
    adminFullName: 'মালিক',
    adminUsername: 'owner',
    adminPassword: 'owner123',
  });
  return db;
}

let baseline = 0;
beforeEach(() => {
  baseline = openDatabaseCount().fileBacked;
});

afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('a closed database releases its file lock', () => {
  it('lets the directory be removed immediately after close, with no retry', () => {
    const dir = tempDir();
    const file = path.join(dir, 'shop.db');
    const db = openShop(file);
    expect(fs.existsSync(file)).toBe(true);

    closeDatabase(db);

    // The exact failure mode from the Windows release run: unlink while a handle is open.
    // No maxRetries here on purpose — a leaked handle must fail this test.
    expect(() => fs.rmSync(dir, { recursive: true, force: true })).not.toThrow();
    expect(fs.existsSync(dir)).toBe(false);
    expect(openDatabaseCount().fileBacked).toBe(baseline);
  });

  it('lets the database file be replaced (upgrade / restore over an existing file)', () => {
    const dir = tempDir();
    const file = path.join(dir, 'shop.db');
    const db = openShop(file);

    closeDatabase(db);

    // Restoring a backup writes a new file over the old one; Windows refuses while it is open.
    const replacement = path.join(dir, 'restore.db');
    fs.copyFileSync(file, replacement);
    expect(() => fs.renameSync(replacement, file)).not.toThrow();
    expect(openDatabaseCount().fileBacked).toBe(baseline);
  });

  it('is idempotent: closing twice does not corrupt the accounting', () => {
    const dir = tempDir();
    const db = openShop(path.join(dir, 'shop.db'));
    expect(openDatabaseCount().fileBacked).toBe(baseline + 1);

    closeDatabase(db);
    closeDatabase(db);

    expect(openDatabaseCount().fileBacked).toBe(baseline);
  });
});

describe('connection accounting makes a leak visible on every platform', () => {
  it('counts a file-backed connection while it is open and reports its path', () => {
    const dir = tempDir();
    const file = path.join(dir, 'shop.db');
    const db = openShop(file);

    const open = openDatabaseCount();
    expect(open.fileBacked).toBe(baseline + 1);
    expect(open.files.some((f) => path.basename(f) === 'shop.db')).toBe(true);

    closeDatabase(db);
    expect(openDatabaseCount().fileBacked).toBe(baseline);
  });

  it('does not count in-memory databases as file locks', () => {
    const db = openDatabase({ file: ':memory:', appVersion: '1.1.4' });
    const open = openDatabaseCount();
    expect(open.fileBacked).toBe(baseline);
    expect(open.count).toBeGreaterThanOrEqual(1);
    db.close();
  });

  it('does not leak a connection when opening fails on a database from a newer version', () => {
    const dir = tempDir();
    const file = path.join(dir, 'future.db');

    // Write a database stamped with a schema version this build does not know.
    const original = openShop(file);
    original.pragma('user_version = 9999');
    closeDatabase(original);
    expect(openDatabaseCount().fileBacked).toBe(baseline);

    // The failed open must release the handle it created — otherwise the shopkeeper cannot even
    // move or back up the file after seeing the "newer version" error.
    expect(() => openDatabase({ file, appVersion: '1.1.4' })).toThrow();
    expect(openDatabaseCount().fileBacked).toBe(baseline);
    expect(() => fs.rmSync(dir, { recursive: true, force: true })).not.toThrow();
  });
});
