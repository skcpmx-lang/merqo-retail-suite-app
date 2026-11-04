/**
 * One-shot local gate: type-check every package, run the core test suite,
 * build both apps and assert that no secret material is tracked by git.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

function step(name, command, args, cwd = root) {
  process.stdout.write(`\n▶ ${name}\n`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) failures.push(name);
}

const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const vitest = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');

step('typecheck: core', process.execPath, [tsc, '-p', 'packages/core/tsconfig.json', '--noEmit']);
step('typecheck: app', process.execPath, [tsc, '-p', 'packages/app/tsconfig.json', '--noEmit']);
step('typecheck: license generator', process.execPath, [tsc, '-p', 'packages/license-generator/tsconfig.json', '--noEmit']);
step('tests: core', process.execPath, [vitest, 'run']);
step('icons', process.execPath, ['scripts/make-icons.mjs']);
step('build: app', process.execPath, ['scripts/build-app.mjs']);
step('build: license generator', process.execPath, ['scripts/build-license-generator.mjs']);

process.stdout.write('\n▶ secrets scan\n');
const secretCheck = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
const tracked = (secretCheck.stdout || '').split('\n').filter(Boolean);
const offenders = tracked.filter((file) =>
  /(^|\/)(secrets?)\//i.test(file) ||
  /private[-_]?key|\.pem$|\.pfx$|\.p12$|id_ed25519/i.test(file),
);
if (offenders.length) {
  console.error('Tracked secret-like files:', offenders.join(', '));
  failures.push('secrets scan');
} else {
  console.log('no key material tracked by git ✔');
}

if (failures.length) {
  console.error(`\n✖ verify failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\n✔ verify passed');
