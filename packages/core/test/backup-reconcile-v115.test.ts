/**
 * A backup is a file, a row and an audit line — and the file cannot join a transaction (v1.1.5, A-28).
 *
 * `createBackup` was listed as a documented exception: it copies the database with `VACUUM INTO`,
 * verifies the copy, renames it into place and *then* records it. The audit line and the row could be
 * made atomic; the file cannot be, because SQLite and the file system have no shared transaction.
 *
 * So the honest design is: write the file first (a file with no row loses nothing — it is still a
 * backup), commit the row and the audit line together, and reconcile on read, so a file whose row was
 * lost is registered instead of being invisible forever. `reconcileBackups` does that, verifying the
 * file against its manifest's size and SHA-256 before blessing it.
 *
 * These tests cover the window from every side: success, a folder that cannot be written, a row that
 * cannot be inserted, an interrupted run (file + manifest, no row), a corrupt file, and a second run
 * that must not duplicate anything.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createBackup,
  defaultBackupDir,
  assertRestorablePath,
  reconcileBackups,
  listBackups,
  sha256File,
  type BackupManifest,
} from '../src/index.js';
import { makeTestDb } from './helpers.js';
import { closeTrackedDatabases, removeTempDirs } from '../../../test-setup/temp-resources.js';

const dirs: string[] = [];
afterAll(() => {
  closeTrackedDatabases();
  removeTempDirs(dirs);
});

const tmpDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-bk-'));
  dirs.push(dir);
  return dir;
};

const backupCount = (ctx: ReturnType<typeof makeTestDb>) =>
  (ctx.db.prepare('SELECT COUNT(*) c FROM backups').get() as { c: number }).c;
const auditCount = (ctx: ReturnType<typeof makeTestDb>, action: string) =>
  (ctx.db.prepare('SELECT COUNT(*) c FROM audit_logs WHERE action = ?').get(action) as { c: number }).c;

describe('a successful backup', () => {
  it('writes the file, the manifest, the row and the audit line', () => {
    const ctx = makeTestDb();
    const dir = tmpDir();
    const result = createBackup(ctx.db, { dataDir: dir, appVersion: '1.1.5', actor: ctx.actor });

    expect(fs.existsSync(result.filePath)).toBe(true);
    expect(fs.existsSync(`${result.filePath}.json`)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(`${result.filePath}.json`, 'utf8')) as BackupManifest;
    expect(manifest.sha256).toBe(sha256File(result.filePath));
    expect(manifest.size_bytes).toBe(fs.statSync(result.filePath).size);
    expect(backupCount(ctx)).toBe(1);
    expect(auditCount(ctx, 'backup.create')).toBe(1);
    ctx.cleanup();
  });
});

describe('when the file cannot be written', () => {
  it('leaves no row, no audit line and no half-written file', () => {
    const ctx = makeTestDb();
    const dir = tmpDir();
    const unreadable = path.join(dir, 'nope', 'deeper', 'x.saudabak');
    // A directory component that is a file: VACUUM INTO cannot create the target.
    fs.writeFileSync(path.join(dir, 'nope'), 'not a directory', 'utf8');
    expect(() => createBackup(ctx.db, { dataDir: dir, targetPath: unreadable, appVersion: '1.1.5' })).toThrow();
    expect(backupCount(ctx)).toBe(0);
    expect(auditCount(ctx, 'backup.create')).toBe(0);
    expect(fs.existsSync(`${unreadable}.tmp`)).toBe(false);
    ctx.cleanup();
  });
});

describe('when the row cannot be inserted', () => {
  it('keeps the backup file and registers it on the next reconcile, once', () => {
    const ctx = makeTestDb();
    const dir = tmpDir();
    ctx.db.exec(
      "CREATE TRIGGER refuse_backup_row BEFORE INSERT ON backups BEGIN SELECT RAISE(ABORT, 'forced failure'); END",
    );
    expect(() => createBackup(ctx.db, { dataDir: dir, appVersion: '1.1.5', actor: ctx.actor })).toThrow(/forced failure/);
    ctx.db.exec('DROP TRIGGER refuse_backup_row');

    // The file and its manifest are on disk — the owner's backup was not lost.
    const backupDir = defaultBackupDir(dir);
    const files = fs.readdirSync(backupDir).filter((n) => n.endsWith('.saudabak'));
    expect(files).toHaveLength(1);
    expect(backupCount(ctx)).toBe(0);
    expect(auditCount(ctx, 'backup.create')).toBe(0);

    const reconciled = reconcileBackups(ctx.db, { dataDir: dir });
    expect(reconciled).toMatchObject({ registered: 1, corrupt: 0 });
    expect(backupCount(ctx)).toBe(1);
    expect(auditCount(ctx, 'backup.reconcile')).toBe(1);

    const rows = listBackups(ctx.db);
    expect(rows[0].status).toBe('ok');
    expect(rows[0].file_path).toBe(path.join(backupDir, files[0]));

    // Idempotent: a second pass registers nothing and writes no second audit line.
    expect(reconcileBackups(ctx.db, { dataDir: dir })).toMatchObject({ registered: 0 });
    expect(backupCount(ctx)).toBe(1);
    expect(auditCount(ctx, 'backup.reconcile')).toBe(1);
    ctx.cleanup();
  });
});

describe('an interrupted run (file and manifest, no row)', () => {
  it('is picked up and marked ok', () => {
    const ctx = makeTestDb();
    const dir = tmpDir();
    const made = createBackup(ctx.db, { dataDir: dir, appVersion: '1.1.5' });
    // Simulate the crash window: the file is final, the row never happened.
    ctx.db.prepare('DELETE FROM backups').run();
    expect(backupCount(ctx)).toBe(0);

    expect(reconcileBackups(ctx.db, { dataDir: dir })).toMatchObject({ registered: 1 });
    const row = listBackups(ctx.db)[0];
    expect(row.file_path).toBe(made.filePath);
    expect(row.size_bytes).toBe(fs.statSync(made.filePath).size);
    expect(row.status).toBe('ok');
    ctx.cleanup();
  });

  it('refuses to bless a file that no longer matches its manifest', () => {
    const ctx = makeTestDb();
    const dir = tmpDir();
    const made = createBackup(ctx.db, { dataDir: dir, appVersion: '1.1.5' });
    ctx.db.prepare('DELETE FROM backups').run();
    // A byte appended after the fact — a truncated/corrupted copy must not be listed as healthy.
    fs.appendFileSync(made.filePath, Buffer.from('x'));

    expect(reconcileBackups(ctx.db, { dataDir: dir })).toMatchObject({ registered: 0, corrupt: 1 });
    const row = listBackups(ctx.db)[0];
    expect(row.status).toBe('corrupt');
    expect(row.note).toMatch(/যাচাই করা যায়নি/);
    ctx.cleanup();
  });
});

describe('reconciliation scope', () => {
  it('ignores JSON files that are not backup manifests', () => {
    const ctx = makeTestDb();
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ hello: 'world' }), 'utf8');
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json', 'utf8');
    expect(reconcileBackups(ctx.db, { dataDir: dir })).toMatchObject({ registered: 0, corrupt: 0 });
    expect(backupCount(ctx)).toBe(0);
    ctx.cleanup();
  });

  it('does not touch a file that already has a row', () => {
    const ctx = makeTestDb();
    const dir = tmpDir();
    createBackup(ctx.db, { dataDir: dir, appVersion: '1.1.5' });
    expect(reconcileBackups(ctx.db, { dataDir: dir })).toMatchObject({ registered: 0, corrupt: 0, skipped: 1 });
    expect(backupCount(ctx)).toBe(1);
    ctx.cleanup();
  });
});

/**
 * A-29: the restore route replaces the shop's database with whatever the renderer names. The role
 * check and the confirmation dialog were there; the path itself was not checked.
 */
describe('A-29 what may be restored', () => {
  it('accepts a real backup file, wherever it lives', () => {
    const ctx = makeTestDb();
    const dir = tmpDir();
    const made = createBackup(ctx.db, { dataDir: dir, appVersion: '1.1.5' });
    expect(assertRestorablePath(made.filePath)).toBe(path.resolve(made.filePath));
    ctx.cleanup();
  });

  it('refuses the live database, its sidecars and half-written files', () => {
    const ctx = makeTestDb();
    const dir = tmpDir();
    const live = path.join(dir, 'shop.db');
    fs.writeFileSync(live, 'x');
    for (const ext of ['-wal', '-shm']) fs.writeFileSync(`${live}${ext}`, 'x');
    fs.writeFileSync(path.join(dir, 'copy.db.tmp'), 'x');

    expect(() => assertRestorablePath(live, { liveDbPath: live })).toThrow(/চলমান ডাটাবেজ/);
    expect(() => assertRestorablePath(`${live}-wal`)).toThrow(/অসম্পূর্ণ/);
    expect(() => assertRestorablePath(`${live}-shm`)).toThrow(/অসম্পূর্ণ/);
    expect(() => assertRestorablePath(path.join(dir, 'copy.db.tmp'))).toThrow(/অসম্পূর্ণ/);
    ctx.cleanup();
  });

  it('refuses a file type this app never produces, and a file that is not there', () => {
    const ctx = makeTestDb();
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello');
    expect(() => assertRestorablePath(path.join(dir, 'notes.txt'))).toThrow(/শুধু Sauda ব্যাকআপ/);
    expect(() => assertRestorablePath(path.join(dir, 'missing.saudabak'))).toThrow(/পাওয়া যায়নি/);
    expect(() => assertRestorablePath('')).toThrow();
    ctx.cleanup();
  });
});
