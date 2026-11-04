import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * On GitHub Actions the plain console reporter is not enough: the runner log is often not
 * reachable (large logs are served from blob storage) while check-run annotations are. The
 * `github-actions` reporter turns every failed test into a `::error file=…,line=…` annotation,
 * so a platform-specific failure can be diagnosed from the API alone.
 */
const reporters = process.env.GITHUB_ACTIONS ? ['default', 'github-actions'] : ['default'];

export default defineConfig({
  resolve: {
    alias: {
      '@sauda/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    // Fails a test file that leaves a file-backed SQLite connection open (Windows EBUSY class).
    setupFiles: ['test-setup/database-leak-guard.ts'],
    include: [
      'packages/core/test/**/*.test.ts',
      'packages/license-generator/test/**/*.test.{ts,tsx}',
      'packages/app/test/**/*.test.{ts,tsx}',
      'scripts/tests/**/*.test.mjs',
    ],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    reporters,
  },
});
