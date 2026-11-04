/** Type-checks every workspace package with its own tsconfig. */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const projects = ['packages/core/tsconfig.json', 'packages/app/tsconfig.json', 'packages/license-generator/tsconfig.json'];

let failed = false;
for (const project of projects) {
  process.stdout.write(`\n▶ tsc ${project}\n`);
  const result = spawnSync(process.execPath, [tsc, '-p', project, '--noEmit'], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) failed = true;
}
if (failed) {
  console.error('\n✖ typecheck failed');
  process.exit(1);
}
console.log('\n✔ typecheck passed');
