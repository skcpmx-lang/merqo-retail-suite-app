/**
 * Packages the Sauda POS app with electron-builder (NSIS installer for
 * Windows). Requires the app to be built first (scripts/build-app.mjs).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const args = [builderBin, '--win', 'nsis', '--x64', '--publish', 'never', ...process.argv.slice(2)];
const result = spawnSync(process.execPath, args, { cwd: appDir, stdio: 'inherit' });
if (result.status !== 0) {
  console.error('[package-app] electron-builder failed.');
  process.exit(result.status ?? 1);
}
console.log('[package-app] installer written to packages/app/release');
