/**
 * v1.1.4 final hardening — single SQLite opening boundary.
 *
 * Client isolation is only as strong as the number of ways a process can open the
 * database. This test is an architecture guard: it scans the repository and fails if a
 * second connection factory appears, if production code imports `better-sqlite3`
 * directly, or if the Electron main process stops using the role-aware opener.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createBackup,
  fileDatabaseRole,
  openClientDatabase,
  openDatabase,
  restoreBackup,
  setMeta,
  type Db,
} from '../src/index.js';

const ROOT = path.resolve(__dirname, '../../..');

const SCAN_DIRS = ['packages/core/src', 'packages/app/electron', 'packages/app/src', 'packages/license-generator/src', 'scripts'];

interface Hit {
  file: string;
  line: number;
  text: string;
}

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'release') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function sources(): string[] {
  return SCAN_DIRS.flatMap((dir) => walk(path.join(ROOT, dir)));
}

function find(pattern: RegExp, filter: (file: string) => boolean = () => true): Hit[] {
  const hits: Hit[] = [];
  for (const file of sources()) {
    if (!filter(file)) continue;
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, index) => {
      if (pattern.test(text)) hits.push({ file: rel, line: index + 1, text: text.trim() });
    });
  }
  return hits;
}

/** Production source only (no tests): the rules that must hold in the shipped app. */
const isProduction = (file: string) => !/\.test\.[tj]sx?$/.test(file) && !file.includes(`${path.sep}test${path.sep}`);

const CONNECTION_MODULE = 'packages/core/src/db/connection.ts';
const CLIENT_ISOLATION_MODULE = 'packages/core/src/db/client-isolation.ts';

describe('single SQLite opening boundary', () => {
  it('constructs a better-sqlite3 Database in exactly one module', () => {
    const hits = find(/\bnew\s+Database\s*\(/, (f) => isProduction(f) && !f.endsWith('.mjs'));
    expect(hits.map((h) => h.file)).toEqual([CONNECTION_MODULE]);
  });

  it('never imports better-sqlite3 as a value outside the connection module', () => {
    const hits = find(/from\s+'better-sqlite3'/, (f) => isProduction(f) && !f.endsWith('.mjs')).filter(
      (h) => !/import\s+type\b/.test(h.text),
    );
    expect(hits.map((h) => h.file)).toEqual([CONNECTION_MODULE]);
  });

  it('opens databases through a documented allow-list of modules', () => {
    // Intentionally permitted call sites and why:
    //  - connection.ts      : defines the opener.
    //  - client-isolation.ts: role-aware client opener (guarded + no migration/seed).
    //  - services/backup.ts : read-only validation of a backup file, plus the restore
    //                         reopen, which now refuses client databases first.
    const allowed = new Set([
      CONNECTION_MODULE,
      CLIENT_ISOLATION_MODULE,
      'packages/core/src/services/backup.ts',
      // The Electron main process is the single role-aware entry point: it decides
      // client vs server, and in client mode it uses `openClientDatabase` (guarded)
      // instead of a plain open. Asserted separately below.
      'packages/app/electron/main.ts',
    ]);
    const hits = find(/\bopenDatabase\s*\(/, (f) => isProduction(f) && !f.endsWith('.mjs')).filter(
      (h) => !h.text.includes('export function openDatabase'),
    );
    const unexpected = hits.filter((h) => !allowed.has(h.file));
    expect(unexpected).toEqual([]);
  });

  it('never opens SQLite with better-sqlite3 anywhere in the Electron or renderer layers', () => {
    const hits = find(/better-sqlite3|new\s+Database\s*\(/, (f) =>
      isProduction(f) && (f.includes(`${path.sep}app${path.sep}electron`) || f.includes(`${path.sep}app${path.sep}src`)),
    );
    expect(hits).toEqual([]);
  });

  it('runs no SQL in the renderer', () => {
    const hits = find(/\.prepare\s*\(|\bCREATE TABLE\b|\bINSERT INTO\b|\bSELECT\b[^\n]{0,120}?\bFROM\b/, (f) =>
      isProduction(f) && f.includes(`${path.sep}app${path.sep}src`),
    );
    expect(hits).toEqual([]);
  });

  it('gives the Electron main process the role-aware opener', () => {
    const main = fs.readFileSync(path.join(ROOT, 'packages/app/electron/main.ts'), 'utf8');
    // Client role must be decided before the file is opened, and the client handle must
    // come from the guarded opener — not from a plain `openDatabase` call.
    expect(main).toMatch(/openClientDatabase\(/);
    expect(main).toMatch(/detectDatabaseRole\(/);
    expect(main).toMatch(/ctx\.mode\s*=\s*'client'/);
    expect(main).toMatch(/reopenDb:\s*\(\)\s*=>\s*\{[\s\S]*?bootstrapDatabase\(\)/);
  });

  it('keeps the guard inside the client opener so no raw handle escapes', () => {
    const source = fs.readFileSync(path.join(ROOT, CLIENT_ISOLATION_MODULE), 'utf8');
    expect(source).toMatch(/export function openClientDatabase/);
    expect(source).toMatch(/guardClientDatabase\(db/);
    expect(source).toMatch(/skipMigrate: true/);
    expect(source).toMatch(/seed: false/);
    expect(source).toMatch(/setMeta\(guarded, 'db_role', 'client'\)/);
  });
});

describe('backup, restore and maintenance respect database roles', () => {
  const dirs: string[] = [];
  const dbs: Db[] = [];
  function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sauda-role-'));
    dirs.push(dir);
    return dir;
  }
  afterAll(() => {
    for (const db of dbs.splice(0)) {
      try {
        db.close();
      } catch {
        /* closed */
      }
    }
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stamps a client database and refuses to back it up', () => {
    const dir = tempDir();
    const client = openClientDatabase({ file: path.join(dir, 'sauda.db'), appVersion: '1.1.4' });
    dbs.push(client);
    expect(fileDatabaseRole(path.join(dir, 'sauda.db'))).toBe('client');
    expect(() => createBackup(client, { dataDir: dir, kind: 'manual' })).toThrow(/ক্লায়েন্ট/);
    // Only the database file exists — no backups folder, no partial backup file.
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.saudabak') || f.endsWith('.tmp'))).toHaveLength(0);
  });

  it('refuses to restore over a client database even from a server handle', () => {
    const dir = tempDir();
    const server = openDatabase({ file: path.join(dir, 'server.db'), appVersion: '1.1.4' });
    dbs.push(server);
    setMeta(server, 'db_role', 'server');
    const clientPath = path.join(dir, 'client.db');
    const client = openClientDatabase({ file: clientPath, appVersion: '1.1.4' });
    dbs.push(client);

    const backupDir = tempDir();
    const made = createBackup(server, { dataDir: backupDir, kind: 'manual' });
    expect(fs.existsSync(made.filePath)).toBe(true);

    expect(() =>
      restoreBackup(server, {
        backupPath: made.filePath,
        dataDir: backupDir,
        livePath: clientPath,
        appVersion: '1.1.4',
      }),
    ).toThrow(/ক্লায়েন্ট/);
  });

  it('still backs up and validates a Main Server database', () => {
    const dir = tempDir();
    const server = openDatabase({ file: path.join(dir, 'shop.db'), appVersion: '1.1.4' });
    dbs.push(server);
    setMeta(server, 'db_role', 'server');
    const made = createBackup(server, { dataDir: dir, kind: 'manual' });
    expect(fs.existsSync(made.filePath)).toBe(true);
    expect(fileDatabaseRole(path.join(dir, 'shop.db'))).toBe('server');
    expect(fileDatabaseRole(made.filePath)).toBe('server');
  });
});
