import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export interface AppPaths {
  dataDir: string;
  dbPath: string;
  logsDir: string;
  backupsDir: string;
  exportsDir: string;
  imagesDir: string;
  licenseDir: string;
}

let cached: AppPaths | null = null;

/**
 * All business data lives under %APPDATA%/Sauda Retail Suite so that an
 * uninstall (which only removes the program files) can never delete a
 * shopkeeper's database or backups.
 */
export function appPaths(): AppPaths {
  if (cached) return cached;
  const base = app.getPath('userData');
  const dataDir = path.join(base, 'data');
  const paths: AppPaths = {
    dataDir,
    dbPath: path.join(dataDir, 'sauda.db'),
    logsDir: path.join(base, 'logs'),
    backupsDir: path.join(base, 'backups'),
    exportsDir: path.join(app.getPath('documents'), 'Sauda Exports'),
    imagesDir: path.join(base, 'images'),
    licenseDir: path.join(base, 'license'),
  };
  for (const dir of [dataDir, paths.logsDir, paths.backupsDir, paths.imagesDir, paths.licenseDir]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  cached = paths;
  return paths;
}

export function logFile(): string {
  const dir = appPaths().logsDir;
  const day = new Date().toISOString().slice(0, 10);
  return path.join(dir, `sauda-${day}.log`);
}

export function writeLog(level: 'info' | 'warn' | 'error', message: string, meta?: unknown): void {
  try {
    const line = JSON.stringify({
      at: new Date().toISOString(),
      level,
      message,
      meta: meta === undefined ? undefined : safeMeta(meta),
    });
    fs.appendFileSync(logFile(), `${line}\n`, 'utf8');
  } catch {
    /* logging must never crash the app */
  }
}

function safeMeta(meta: unknown): unknown {
  try {
    if (meta instanceof Error) return { name: meta.name, message: meta.message, stack: meta.stack?.slice(0, 2000) };
    const text = JSON.stringify(meta);
    return text && text.length > 4000 ? JSON.parse(text.slice(0, 4000)) : meta;
  } catch {
    return '[unserialisable]';
  }
}

export function readRecentLogs(maxLines = 400): string {
  try {
    const file = logFile();
    if (!fs.existsSync(file)) return '';
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.trim().split('\n');
    return lines.slice(-maxLines).join('\n');
  } catch {
    return '';
  }
}

/** Reject any path that escapes the allowed roots (defence against traversal). */
export function assertInside(root: string, candidate: string): string {
  const resolved = path.resolve(candidate);
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new Error('অননুমোদিত ফাইল পথ।');
  }
  return resolved;
}
