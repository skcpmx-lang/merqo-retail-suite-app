/**
 * Packages the Sauda POS app with electron-builder (NSIS installer for Windows).
 * Requires the app to be built first (scripts/build-app.mjs).
 *
 * Release builds are **signed or refused** (D-1): if no Authenticode method is configured the
 * script stops before electron-builder runs, so an unsigned installer can never be produced by
 * accident. See docs/V1.1.4_WINDOWS_BUILD_SIGNING_HANDOFF.md §3.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSigningConfigured, describeSigning } from './lib/signing.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDir = path.join(root, 'packages', 'app');

if (!fs.existsSync(path.join(appDir, 'dist', 'renderer', 'index.html'))) {
  console.error('[package-app] dist/renderer is missing — run `npm run build:app` first.');
  process.exit(1);
}

const builderBin = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
if (!fs.existsSync(builderBin)) {
  console.error('[package-app] electron-builder is not installed.');
  process.exit(1);
}

let signing;
try {
  signing = assertSigningConfigured(process.env, { label: 'package-app' });
} catch (err) {
  console.error(`[package-app] ${err.message}`);
  process.exit(1);
}
console.log(`[package-app] signing: ${describeSigning(signing)}`);

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
const result = spawnSync(process.execPath, args, { cwd: appDir, stdio: 'inherit' });
if (result.status !== 0) {
  console.error('[package-app] electron-builder failed.');
  process.exit(result.status ?? 1);
}
console.log('[package-app] installer written to packages/app/release');
console.log('[package-app] run `node scripts/verify-installer.mjs --dir artifacts` before uploading anything');
