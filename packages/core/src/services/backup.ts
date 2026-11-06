import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Db } from '../db/connection.js';
import { closeDatabase, checkpoint, integrityCheck, openDatabase } from '../db/connection.js';
import { SCHEMA_VERSION } from '../db/schema.js';
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

/**
 * A backup file name that is not already taken (v1.1.5, A-15).
 *
 * The name used to be `sauda-<stamp>.saudabak` with a one-second stamp, so two backups inside the
 * same second wrote to the same path: the second silently replaced the first, *and its manifest*.
 * The worst case is not theoretical — a restore immediately creates a `pre_restore` safety backup,
 * so restoring a backup taken one second earlier overwrote the very file being restored and the
 * shop "restored" its current state instead of the backup. Names now carry a counter when needed.
 */
function uniqueBackupPath(dir: string, stamp: string): string {
  let candidate = path.join(dir, `sauda-${stamp}${BACKUP_EXTENSION}`);
  for (let n = 1; n <= 999 && (fs.existsSync(candidate) || fs.existsSync(`${candidate}.json`)); n += 1) {
    candidate = path.join(dir, `sauda-${stamp}-${n}${BACKUP_EXTENSION}`);
  }
  if (fs.existsSync(candidate) || fs.existsSync(`${candidate}.json`)) {
    throw new Error('ব্যাকআপ ফাইলের একটি অনন্য নাম তৈরি করা যায়নি — পুরোনো ব্যাকআপ সরিয়ে আবার চেষ্টা করুন।');
  }
  return candidate;
}

export function sha256File(file: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

/**
 * Create a consistent backup using SQLite's online backup API, then wrap it with
 * a manifest so a restore can verify integrity + compatibility before touching
 * live data.
 */
/**
 * A Client PC's local file is not the shop, so it must never be backed up or restored as
 * if it were (D-11). `openClientDatabase` stamps `meta.db_role = 'client'`; every backup
 * and restore entry point checks it before touching anything.
 */
export function assertNotClientDatabase(db: Db): void {
  const role = getMeta(db, 'db_role');
  if (role === 'client') {
    const err = new Error(
      'এই ডেটাবেজ ক্লায়েন্ট পিসির — ব্যাকআপ/রিস্টোর মূল কম্পিউটার থেকে করতে হবে।',
    ) as Error & { code?: string };
    err.code = 'DB_ROLE_CLIENT';
    throw err;
  }
}

/** Reads the role marker without writing (used before a restore swaps files). */
export function fileDatabaseRole(filePath: string): 'client' | 'server' | 'missing' {
  if (!fs.existsSync(filePath)) return 'missing';
  let db: Db | null = null;
  try {
    db = openDatabase({ file: filePath, readonly: true });
    const row = db.prepare("SELECT value FROM meta WHERE key = 'db_role'").get() as { value: string } | undefined;
    return row?.value === 'client' ? 'client' : 'server';
  } catch {
    return 'server';
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
}

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
  assertNotClientDatabase(db);
  const settings = getSettings(db);
  const dir = opts.targetPath ? path.dirname(opts.targetPath) : defaultBackupDir(opts.dataDir);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const stamp = nowLocal().replace(/[: ]/g, '-');
  const finalPath = opts.targetPath ?? uniqueBackupPath(dir, stamp);
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

  // The file is finished and named by now; the row and its audit line are one step, so the books
  // never record a backup the audit trail does not know about (v1.1.5, A-28). The file itself cannot
  // join that transaction — that is what `reconcileBackups` is for.
  const record = db.transaction(() => {
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
    return Number(res.lastInsertRowid);
  });
  const id = record();
  return { filePath: finalPath, manifest, id };
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
const RESTORABLE_EXTENSIONS = ['.saudabak', '.db', '.sqlite', '.sqlite3'];

/**
 * Refuses a file that must never be used as a restore source (v1.1.5, A-29).
 *
 * The restore route is the one place where the renderer names a file and the app then *replaces the
 * live database* with it. The role check and the confirmation dialog were there; the path itself was
 * not checked at all, so the live database, a SQLite sidecar (`-wal`/`-shm`, which is not a database
 * on its own) or a half-written `.tmp` could be handed to `validateBackup` and, if it happened to
 * look valid, restored over the shop's data.
 *
 * The extension allowlist deliberately does not restrict the *directory*: restoring from a USB stick
 * is a real workflow and a directory allowlist would break it. What it forbids is the file being the
 * live database or one of its sidecars, and a file type this app never produces.
 */
export function assertRestorablePath(filePath: string, opts: { liveDbPath?: string } = {}): string {
  const resolved = path.resolve(String(filePath ?? ''));
  if (!filePath || !resolved) throw new Error('ব্যাকআপ ফাইল নির্বাচন করুন।');
  const lower = resolved.toLowerCase();
  if (lower.endsWith('-wal') || lower.endsWith('-shm') || lower.endsWith('.tmp')) {
    throw new Error('অসম্পূর্ণ বা সহায়ক ফাইল রিস্টোর করা যাবে না।');
  }
  const ext = path.extname(resolved).toLowerCase();
  if (!RESTORABLE_EXTENSIONS.includes(ext)) {
    throw new Error('শুধু Sauda ব্যাকআপ ফাইল (.saudabak) বা SQLite ডাটাবেজ রিস্টোর করা যায়।');
  }
  if (opts.liveDbPath && path.resolve(opts.liveDbPath) === resolved) {
    throw new Error('চলমান ডাটাবেজ নিজেই রিস্টোরের উৎস হতে পারে না।');
  }
  if (!fs.existsSync(resolved)) throw new Error('ব্যাকআপ ফাইলটি পাওয়া যায়নি।');
  return resolved;
}

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
    if (version > SCHEMA_VERSION) {
      return fail(
        `এই ব্যাকআপ নতুন ভার্সনের (${version}) — বর্তমান অ্যাপ্লিকেশন (${SCHEMA_VERSION}) এটি রিস্টোর করতে পারবে না। আগে অ্যাপ আপডেট করুন।`,
      );
    }
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
  // Never restore over a client database, and never restore a client's file into a shop.
  assertNotClientDatabase(db);
  if (fileDatabaseRole(opts.livePath) === 'client') {
    const err = new Error('লক্ষ্য ডেটাবেজ ক্লায়েন্ট পিসির — এখানে রিস্টোর করা যাবে না।') as Error & { code?: string };
    err.code = 'DB_ROLE_CLIENT';
    throw err;
  }
  const validation = validateBackup(opts.backupPath);
  if (!validation.ok) throw new Error(validation.message);

  const safety = createBackup(db, {
    dataDir: opts.dataDir,
    kind: 'pre_restore',
    note: 'রিস্টোরের আগের নিরাপত্তা ব্যাকআপ',
    actor: opts.actor,
  });
  // Belt and braces for A-15: the safety copy must never be the file being restored from.
  if (path.resolve(safety.filePath) === path.resolve(opts.backupPath)) {
    throw new Error('নিরাপত্তা ব্যাকআপ রিস্টোরের ফাইলকেই প্রতিস্থাপন করেছে — রিস্টোর বাতিল করা হয়েছে, ফাইলটি অক্ষত আছে।');
  }

  checkpoint(db);
  closeDatabase(db);

  const live = opts.livePath;
  const temp = `${live}.restoring`;
  if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
  fs.copyFileSync(opts.backupPath, temp);

  // Verify the copy *before* it replaces the live database: a failed restore
  // must leave the shop's real data untouched (the safety backup is a second
  // line of defence, not the first).
  try {
    const check = openDatabase({ file: temp, readonly: true });
    const integrity = integrityCheck(check);
    check.close();
    if (!integrity.ok) {
      throw new Error(`রিস্টোরের পরে ডাটাবেজ যাচাই ব্যর্থ: ${integrity.detail}`);
    }
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err instanceof Error ? err : new Error(String(err));
  }

  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(`${live}${suffix}`)) fs.rmSync(`${live}${suffix}`, { force: true });
  }

  // Swapping in the restored file must be reversible (v1.1.5, A-14). On Windows a rename over a
  // file that anything still holds open fails — antivirus, the search indexer, a backup agent — and
  // v1.1.4 then left the shop with *no* database at the live path: the data existed only in
  // `<live>.restoring` and the safety backup, recoverable by hand at best. Now the live file is
  // moved aside first and moved back if the swap fails, and the previous file is kept until the
  // restored database has been reopened and integrity-checked.
  const previous = `${live}.previous`;
  let movedAside = false;
  try {
    if (fs.existsSync(previous)) fs.rmSync(previous, { force: true });
    if (fs.existsSync(live)) {
      fs.renameSync(live, previous);
      movedAside = true;
    }
    fs.renameSync(temp, live);
  } catch (err) {
    if (movedAside && !fs.existsSync(live)) {
      try {
        fs.renameSync(previous, live);
        movedAside = false;
      } catch {
        /* the caller still has the safety backup path in the error below */
      }
    }
    if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `রিস্টোর সম্পন্ন করা যায়নি (${detail})। দোকানের ডেটাবেজ আগের অবস্থায় রাখা হয়েছে` +
        (movedAside ? `; ফাইলটি ${previous} এ আছে` : '') +
        `; নিরাপত্তা ব্যাকআপ: ${safety.filePath}`,
    );
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
    // The restored file opened and checked out, so the replaced file can go. It is deleted only
    // after that point, not before, so a failure here can never cost the shop its previous data.
    if (fs.existsSync(previous)) fs.rmSync(previous, { force: true });
  } catch {
    /* restore already succeeded; logging is best-effort. `.previous` stays on disk on purpose. */
  }

  return { safetyBackup: safety.filePath, restored: validation };
}

export function listBackups(db: Db, limit = 100): BackupRecord[] {
  return db.prepare('SELECT * FROM backups ORDER BY id DESC LIMIT ?').all(limit) as BackupRecord[];
}

export interface ReconcileResult {
  scanned: number;
  registered: number;
  corrupt: number;
  skipped: number;
}

/**
 * Registers backup files that exist on disk but have no row (v1.1.5, A-28).
 *
 * A backup is a file plus a row plus an audit line, and only the last two can share a transaction.
 * If the process dies after the file is renamed into place, or the row cannot be written, the file is
 * still a perfectly good backup — but the app does not know it, so the owner cannot see it and
 * `pruneBackups` will never rotate it. This pass closes that gap: it walks the directories the app
 * actually uses for backups, reads each `<name>.json` manifest, and registers the file **only if its
 * size and SHA-256 still match the manifest**. A file that fails the check is registered as
 * `corrupt` rather than silently blessed.
 *
 * Idempotent: a file that already has a row is skipped, so running it on every startup costs one
 * directory listing and never duplicates an audit line.
 */
export function reconcileBackups(db: Db, opts: { dataDir: string; limit?: number }): ReconcileResult {
  assertNotClientDatabase(db);
  const result: ReconcileResult = { scanned: 0, registered: 0, corrupt: 0, skipped: 0 };
  const known = new Set(
    (db.prepare('SELECT file_path FROM backups').all() as { file_path: string }[]).map((r) => path.resolve(r.file_path)),
  );

  const dirs = new Set<string>([path.resolve(defaultBackupDir(opts.dataDir))]);
  for (const file of known) dirs.add(path.dirname(file));
  const settings = getSettings(db);
  if (settings.auto_backup_dir) dirs.add(path.resolve(settings.auto_backup_dir));

  const manifests: string[] = [];
  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue; // a directory that no longer exists is not an error here
    }
    for (const name of names) {
      if (name.endsWith('.json') && !name.endsWith('.manifest.json')) manifests.push(path.join(dir, name));
    }
  }

  for (const manifestPath of manifests.slice(0, opts.limit ?? 500)) {
    result.scanned += 1;
    const filePath = manifestPath.replace(/\.json$/, '');
    const resolved = path.resolve(filePath);
    if (known.has(resolved) || !fs.existsSync(filePath)) {
      result.skipped += 1;
      continue;
    }
    let manifest: BackupManifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as BackupManifest;
    } catch {
      result.skipped += 1;
      continue;
    }
    if (manifest?.app !== 'Sauda Retail Suite' || typeof manifest.sha256 !== 'string' || !manifest.sha256) {
      result.skipped += 1; // some other JSON file that happens to live in the folder
      continue;
    }

    const size = fs.statSync(filePath).size;
    const matches = size === manifest.size_bytes && sha256File(filePath) === manifest.sha256;
    const status = matches ? 'ok' : 'corrupt';
    const note = matches
      ? 'ফাইল থেকে পুনরুদ্ধার করা হয়েছে (রেকর্ড হারিয়ে গিয়েছিল)'
      : 'ম্যানিফেস্টের সাথে মেলে না — ফাইলটি যাচাই করা যায়নি';
    const write = db.transaction(() => {
      const res = db
        .prepare(
          `INSERT INTO backups (file_path, size_bytes, kind, app_version, db_version, status, note, created_at)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(
          filePath,
          size,
          'manual',
          manifest.app_version ?? getMeta(db, 'app_version') ?? '1.0.0',
          Number(manifest.db_version ?? 0),
          status,
          note,
          manifest.created_at ?? nowLocal(),
        );
      audit(db, {
        userId: null,
        username: 'system',
        action: 'backup.reconcile',
        entity: 'backup',
        entityId: Number(res.lastInsertRowid),
        details: { file: filePath, status, size },
      });
    });
    write();
    if (matches) result.registered += 1;
    else result.corrupt += 1;
  }
  return result;
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
  if (!Number.isFinite(lastDate)) return true;
  const gapDays = (Date.now() - lastDate) / 86_400_000;
  // A negative gap means the stored timestamp is in the future — a clock change, a
  // timezone move or a restored backup. Treat it as "due" instead of silently
  // disabling backups until the wall clock catches up (v1.1.3).
  if (gapDays < 0) return true;
  if (settings.auto_backup_interval === 'daily') return gapDays >= 1;
  if (settings.auto_backup_interval === 'weekly') return gapDays >= 7;
  return gapDays >= 30;
}
