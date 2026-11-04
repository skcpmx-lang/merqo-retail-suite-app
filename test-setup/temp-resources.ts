/**
 * Temporary-resource helpers for tests (v1.1.4, Windows EBUSY regression).
 *
 * The suite was green on Linux and failed on Windows at `tests: core` because several suites opened
 * a SQLite database, stopped their servers and then deleted the temporary directory while the
 * database connection was still open. Linux allows unlinking an open file; Windows does not, so the
 * cleanup failed with `EBUSY: resource busy or locked` and took the release build with it.
 *
 * The rule these helpers enforce is the same on every platform:
 *   open every database through `openTrackedDatabase()`,
 *   stop every server/client,
 *   then `closeTrackedDatabases()` and `removeTempDirs()`.
 *
 * Removal is retried a bounded number of times because Windows may hold a handle for a few
 * milliseconds after `close()` (antivirus scanning, the SQLite shim DLL). It still throws when a
 * directory cannot be removed, so a genuine leak fails the test instead of being hidden.
 */
import fs from 'node:fs';
import { closeDatabase, openDatabase, type Db, type OpenOptions } from '../packages/core/src/index.js';

const tracked: Db[] = [];

/** Opens a database and remembers it, so the file cannot outlive the test. */
export function openTrackedDatabase(opts: OpenOptions): Db {
  const db = openDatabase(opts);
  tracked.push(db);
  return db;
}

/** Closes every database opened through `openTrackedDatabase()` in this test file. */
export function closeTrackedDatabases(): void {
  for (const db of tracked.splice(0)) {
    try {
      closeDatabase(db);
    } catch {
      /* already closed — nothing to release */
    }
  }
}

/**
 * Removes temporary directories that test-owned resources have been released from.
 * `maxRetries`/`retryDelay` are the Node-native way to absorb a briefly-held Windows handle.
 */
export function removeTempDirs(dirs: readonly string[]): void {
  const failures: string[] = [];
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      failures.push(`${dir} — ${(error as NodeJS.ErrnoException).code ?? ''} ${(error as Error).message}`);
    }
  }
  if (failures.length) {
    throw new Error(
      `could not remove ${failures.length} temporary director(ies):\n${failures.join('\n')}\n` +
        'On Windows this means a database connection, server or file handle is still open.',
    );
  }
}
