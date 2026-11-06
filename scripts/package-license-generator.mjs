/**
 * Packages the private License Generator with electron-builder.
 * The private signing key is NEVER bundled: the tool loads it at runtime from
 * a file the operator selects (see packages/license-generator/src/main.ts).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prebuildsDirFor, pruneForeignPrebuilds } from './lib/native-artifacts.mjs';
import { describeSigning, signingConfig } from './lib/signing.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = path.join(root, 'packages', 'license-generator');

if (!fs.existsSync(path.join(pkgDir, 'dist', 'main', 'main.js'))) {
  console.error('[package-license-generator] dist is missing — run `npm run build:license-generator` first.');
  process.exit(1);
}

// Only the Windows x64 prebuild can ever be loaded by this installer; the rest are 14 MiB of
// binaries for platforms the product does not ship on (A-11). Refuses rather than shipping none.
const prune = pruneForeignPrebuilds(prebuildsDirFor(root));
console.log(
  `[package-license-generator] native: keeping ${prune.kept}, removed ${prune.removed.length} foreign prebuild(s)`,
);

const builderBin = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
if (!fs.existsSync(builderBin)) {
  console.error('[package-license-generator] electron-builder is not installed.');
  process.exit(1);
}

// Guard: make sure no key material sneaked into the build output.
const suspicious = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(pem|key)$/i.test(entry.name) || /private[-_]?key/i.test(entry.name)) suspicious.push(full);
  }
};
walk(pkgDir);
// node_modules and dist are build artefacts; only warn for tracked sources.
const realSuspicious = suspicious.filter((f) => !f.includes(`${path.sep}node_modules${path.sep}`) && !f.includes(`${path.sep}dist${path.sep}`));
if (realSuspicious.length) {
  console.error('[package-license-generator] refusing to package, key material found:', realSuspicious.join(', '));
  process.exit(1);
}

// Signed or refused (D-1) — the same rule as the main app.
// Code signing is optional (v1.1.4 policy: unsigned installers are accepted). When a
// certificate is available it is used automatically; otherwise the build is reported as unsigned.
const signing = signingConfig(process.env);
console.log(`[package-license-generator] signing: ${describeSigning(signing)}`);

const args = [
  builderBin,
  '--win',
  'nsis',
  '--x64',
  '--publish',
  'never',
  ...signing.builderArgs,
  ...process.argv.slice(2),
];
const result = spawnSync(process.execPath, args, { cwd: pkgDir, stdio: 'inherit' });
if (result.status !== 0) {
  console.error('[package-license-generator] electron-builder failed.');
  process.exit(result.status ?? 1);
}
console.log('[package-license-generator] installer written to packages/license-generator/release');
