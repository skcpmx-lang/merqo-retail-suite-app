/**
 * Leak guard for database connections (v1.1.4, Windows EBUSY regression).
 *
 * A test that opens a database file and never closes it is invisible on Linux — unlinking an open
 * file is allowed there — and fatal on Windows, where the file stays locked and the cleanup step
 * fails with `EBUSY: resource busy or locked`. That is exactly how the v1.1.4 release build failed:
 * Linux 687/687 green, `windows-latest` red at `tests: core`.
 *
 * This hook runs at the end of *every* test file, after that file's own `afterAll` cleanup, and
 * fails the file if a file-backed connection is still open. Memory databases are reported in the
 * failure message but do not fail on their own, because they hold no OS file handle; a file-backed
 * connection is the one that can block a shopkeeper's backup, restore or upgrade.
 *
 * Fix the test (close the database) — never relax this guard.
 */
import { afterAll } from 'vitest';
import { openDatabaseCount } from '../packages/core/src/index.js';

const describeFiles = (files: string[]): string => files.map((file) => `  - ${file}`).join('\n');

afterAll(() => {
  const { count, fileBacked, files } = openDatabaseCount();
  if (fileBacked > 0) {
    throw new Error(
      `${fileBacked} database connection(s) are still open at the end of this test file:\n` +
        `${describeFiles(files)}\n` +
        'On Windows an open connection makes the database file impossible to delete, move or replace ' +
        '(EBUSY), so the test cleanup fails there while Linux stays green. Close every database ' +
        '(closeDatabase(db) / db.close()) and stop every server/client before removing its directory.',
    );
  }
  if (count > 0) {
    // In-memory connections are harmless for file handles, but they still mean a test forgot its
    // cleanup; surface it in the run output without turning it into a failure.
    console.warn(
      `[leak-guard] ${count} in-memory database connection(s) left open (no file lock, but please close them)`,
    );
  }
});
