import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Db } from '../db/connection.js';
import { closeDatabase, checkpoint, integrityCheck, openDatabase } from '../db/connection.js';
import { nowLocal } from '../domain/datetime.js';
import { getMeta, setMeta } from '../db/connection.js';
import type { BackupRecord } from '../domain/types.js';
import { audit } from './audit.js';
import { getSettings } from './settings.js';

export interface BackupManifest {
  app: 'Sauda Retail Suite';
  app_version: string;
  db_version: number;
  created_at: string;
  business_name: string;
  tables: Record<string, number>;
  sha256: string;
  size_bytes: number;
}

export interface BackupResult {
  filePath: string;
  manifest: BackupManifest;
  id: number;
}

export const BACKUP_EXTENSION = '.saudabak';

export function defaultBackupDir(dataDir: string): string {
  const dir = path.join(dataDir, 'backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sha256File(file: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

/**
 * Create a consistent backup using SQLite's online backup API, then wrap it with
 * a manifest so a restore can verify integrity + compatibility before touching
 * live data.
 */
export function createBackup(
  db: Db,
  opts: {
    dataDir: string;
    targetPath?: string;
    kind?: BackupRecord['kind'];
    appVersion?: string;
    note?: string;
    actor?: { id: number; username: string } | null;
  },
): BackupResult {
  const settings = getSettings(db);
  const dir = opts.targetPath ? path.dirname(opts.targetPath) : defaultBackupDir(opts.dataDir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const stamp = nowLocal().replace(/[: ]/g, '-');
  const finalPath = opts.targetPath ?? path.join(dir, `sauda-${stamp}${BACKUP_EXTENSION}`);
  const tmpPath = `${finalPath}.tmp`;

  checkpoint(db);
  if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { force: true });
  // VACUUM INTO produces a consistent, fully-checkpointed snapshot in one step.
  db.exec(`VACUUM INTO '${tmpPath.replace(/'/g, "''")}'`);
  if (!fs.existsSync(tmpPath)) throw new Error('ব্যাকআপ ফাইল তৈরি করা সম্ভব হয়নি।');

  const test = openDatabase({ file: tmpPath, readonly: true });
  const integrity = integrityCheck(test);
  const counts: Record<string, number> = {};
  const tables = test
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  for (const t of tables) {
    counts[t.name] = (test.prepare(`SELECT COUNT(*) c FROM "${t.name}"`).get() as { c: number }).c;
  }
  const dbVersion = Number(test.pragma('user_version', { simple: true }) ?? 0);
  test.close();
  if (!integrity.ok) {
    fs.rmSync(tmpPath, { force: true });
    throw new Error(`ব্যাকআপ তৈরি ব্যর্থ — ডাটাবেজে সমস্যা: ${integrity.detail}`);
  }

  const manifest: BackupManifest = {
    app: 'Sauda Retail Suite',
    app_version: opts.appVersion ?? getMeta(db, 'app_version') ?? '1.0.0',
    db_version: dbVersion,
    created_at: nowLocal(),
    business_name: settings.business_name,
    tables: counts,
    sha256: sha256File(tmpPath),
    size_bytes: fs.statSync(tmpPath).size,
  };
  const manifestPath = `${finalPath}.json`;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  fs.renameSync(tmpPath, finalPath);

  const res = db
    .prepare(
      `INSERT INTO backups (file_path, size_bytes, kind, app_version, db_version, status, note, created_at)
       VALUES (?,?,?,?,?,'ok',?,?)`,
    )
    .run(finalPath, manifest.size_bytes, opts.kind ?? 'manual', manifest.app_version, dbVersion, opts.note ?? null, nowLocal());
  audit(db, {
    userId: opts.actor?.id ?? null,
    username: opts.actor?.username ?? 'system',
    action: 'backup.create',
    entity: 'backup',
    entityId: Number(res.lastInsertRowid),
    details: { file: finalPath, size: manifest.size_bytes },
  });
  return { filePath: finalPath, manifest, id: Number(res.lastInsertRowid) };
}

export interface ValidationResult {
  ok: boolean
  message: string;
  manifest: BackupManifest | null;
  db_version: number;
  business_name: string;
  counts: Record<string, number>;
}

/** Validate a backup file without touching the live database. */
export function validateBackup(filePath: string): ValidationResult {
  const fail = (message: string): ValidationResult => ({
    ok: false,
    message,
    manifest: null,
    db_version: 0,
    business_name: '',
    counts: {},
  });
  if (!filePath || !fs.existsSync(filePath)) return fail('ব্যাকআপ ফাইল পাওয়া যায়নি।');
  const stat = fs.statSync(filePath);
  if (stat.size < 1024) return fail('ফাইলটি অনেক ছোট — সম্ভবত নষ্ট বা অসম্পূর্ণ।');

  let manifest: BackupManifest | null = null;
  const manifestPath = `${filePath}.json`;
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as BackupManifest;
    } catch {
      return fail('ব্যাকআপ ম্যানিফেস্ট পড়া যাচ্ছে না (ফাইল নষ্ট)।');
    }
    const actual = sha256File(filePath);
    if (manifest.sha256 && manifest.sha256 !== actual) {
      return fail('ব্যাকআপ ফাইলের চেকসাম মিলছে না — ফাইল পরিবর্তিত বা নষ্ট হয়েছে।');
    }
  }

  // A SQLite database always starts with the "SQLite format 3" header.
  const head = fs.readFileSync(filePath).subarray(0, 16).toString('binary');
  if (!head.startsWith('SQLite format 3')) {
    return fail('ফাইলটি বৈধ SQLite ব্যাকআপ নয়।');
  }

  let db;
  try {
    db = openDatabase({ file: filePath, readonly: true });
  } catch (err) {
    return fail(`ব্যাকআপ ডাটাবেজ খোলা যাচ্ছে না: ${(err as Error).message}`);
  }
  try {
    const integrity = integrityCheck(db);
    if (!integrity.ok) return fail(`ব্যাকআপ ডাটাবেজ ক্ষতিগ্রস্ত: ${integrity.detail}`);
    const hasMeta = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='meta'").get() as {
      c: number;
    };
    if (!hasMeta.c) return fail('এই ফাইলটি Sauda ব্যাকআপ নয় (meta টেবিল নেই)।');
    const version = Number(db.pragma('user_version', { simple: true }) ?? 0);
    const hasProducts = db
      .prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='products'")
      .get() as { c: number };
    if (!hasProducts.c) return fail('এটি Sauda ব্যাকআপ নয় — প্রয়োজনীয় টেবিল নেই।');
    const counts: Record<string, number> = {};
    for (const t of ['products', 'sales', 'purchases', 'customers', 'suppliers', 'payments', 'expenses']) {
      counts[t] = (db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get() as { c: number }).c;
    }
    let businessName = '';
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key='business_name'").get() as
        | { value: string }
        | undefined;
      businessName = row?.value ?? '';
    } catch {
      businessName = '';
    }
    return {
      ok: true,
      message: 'ব্যাকআপ ফাইল সঠিক ও ব্যবহারযোগ্য।',
      manifest,
      db_version: version,
      business_name: businessName,
      counts,
    };
  } finally {
    db.close();
  }
}

/**
 * Restore a validated backup. The current database is first copied to a safety
 * backup, then replaced atomically. The caller must close and reopen the
 * database handle afterwards (the app does this via `DatabaseManager`).
 */
export function restoreBackup(
  db: Db,
  opts: {
    backupPath: string;
    dataDir: string;
    livePath: string;
    appVersion?: string;
    actor?: { id: number; username: string } | null;
  },
): { safetyBackup: string; restored: ValidationResult } {
  const validation = validateBackup(opts.backupPath);
  if (!validation.ok) throw new Error(validation.message);

  const safety = createBackup(db, {
    dataDir: opts.dataDir,
    kind: 'pre_restore',
    note: 'রিস্টোরের আগের নিরাপত্তা ব্যাকআপ',
    actor: opts.actor,
  });

  checkpoint(db);
  closeDatabase(db);

  const live = opts.livePath;
  const temp = `${live}.restoring`;
  if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
  fs.copyFileSync(opts.backupPath, temp);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(`${live}${suffix}`)) fs.rmSync(`${live}${suffix}`, { force: true });
  }
  fs.renameSync(temp, live);

  const check = openDatabase({ file: live, readonly: true });
  const integrity = integrityCheck(check);
  check.close();
  if (!integrity.ok) {
    throw new Error(`রিস্টোরের পরে ডাটাবেজ যাচাই ব্যর্থ: ${integrity.detail}`);
  }

  try {
    const logged = openDatabase({ file: live, appVersion: opts.appVersion });
    logged
      .prepare('INSERT INTO restore_log (file_path, status, message, created_at) VALUES (?,?,?,?)')
      .run(opts.backupPath, 'ok', 'রিস্টোর সফল', nowLocal());
    setMeta(logged, 'restored_at', nowLocal());
    audit(logged, {
      userId: opts.actor?.id ?? null,
      username: opts.actor?.username ?? 'system',
      action: 'backup.restore',
      entity: 'backup',
      details: { file: opts.backupPath, safety: safety.filePath },
    });
    closeDatabase(logged);
  } catch {
    /* restore already succeeded; logging is best-effort */
  }

  return { safetyBackup: safety.filePath, restored: validation };
}

export function listBackups(db: Db, limit = 100): BackupRecord[] {
  return db.prepare('SELECT * FROM backups ORDER BY id DESC LIMIT ?').all(limit) as BackupRecord[];
}

export function pruneBackups(db: Db, keep: number): number {
  const rows = db.prepare("SELECT * FROM backups WHERE kind = 'auto' ORDER BY id DESC").all() as BackupRecord[];
  let removed = 0;
  for (const row of rows.slice(Math.max(0, keep))) {
    try {
      if (fs.existsSync(row.file_path)) fs.rmSync(row.file_path, { force: true });
      if (fs.existsSync(`${row.file_path}.json`)) fs.rmSync(`${row.file_path}.json`, { force: true });
    } catch {
      /* ignore */
    }
    db.prepare('DELETE FROM backups WHERE id = ?').run(row.id);
    removed++;
  }
  return removed;
}

export function shouldAutoBackup(db: Db): boolean {
  const settings = getSettings(db);
  if (!settings.auto_backup_enabled) return false;
  if (settings.auto_backup_interval === 'off') return false;
  const last = db.prepare("SELECT created_at FROM backups WHERE kind = 'auto' ORDER BY id DESC LIMIT 1").get() as
    | { created_at: string }
    | undefined;
  if (!last) return true;
  const lastDate = new Date(last.created_at.replace(' ', 'T')).getTime();
  const gapDays = (Date.now() - lastDate) / 86_400_000;
  if (settings.auto_backup_interval === 'daily') return gapDays >= 1;
  if (settings.auto_backup_interval === 'weekly') return gapDays >= 7;
  return gapDays >= 30;
}
