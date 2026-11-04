/**
 * Emits the shared core's declaration files (type check + .d.ts).
 * The runtime code is consumed straight from source by the bundlers, and by
 * the test runner via the vitest alias.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');

const result = spawnSync(process.execPath, [tsc, '-p', 'packages/core/tsconfig.json', '--pretty'], {
  cwd: root,
  stdio: 'inherit',
});

if (result.status !== 0) {
  console.error('\n[build:core] TypeScript build failed.');
  process.exit(result.status ?? 1);
}
console.log('[build:core] declarations emitted to packages/core/dist');
