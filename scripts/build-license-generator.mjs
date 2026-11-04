/**
 * Builds the private License Generator desktop app:
 *   1. electron main + preload → packages/license-generator/dist/main/*.js
 *   2. React renderer          → packages/license-generator/dist/renderer (vite)
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = path.join(root, 'packages', 'license-generator');
const outDir = path.join(pkgDir, 'dist');

function aliasCore() {
  return {
    name: 'sauda-core-alias',
    setup(build) {
      build.onResolve({ filter: /^@sauda\/core$/ }, () => ({
        path: path.join(root, 'packages', 'core', 'src', 'index.ts'),
      }));
    },
  };
}

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['electron', 'better-sqlite3'],
  plugins: [aliasCore()],
  logLevel: 'info',
  sourcemap: false,
};

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, 'main'), { recursive: true });

await esbuild.build({
  ...shared,
  entryPoints: [path.join(pkgDir, 'src', 'main.ts')],
  outfile: path.join(outDir, 'main', 'main.js'),
});

await esbuild.build({
  ...shared,
  entryPoints: [path.join(pkgDir, 'src', 'preload.ts')],
  outfile: path.join(outDir, 'main', 'preload.js'),
});

// Renderer — vite build (React + TypeScript), same pipeline as the retail app.
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
if (!fs.existsSync(viteBin)) {
  console.error('[build:license-generator] vite is not installed — run `npm ci` at the repo root.');
  process.exit(1);
}
const vite = spawnSync(process.execPath, [viteBin, 'build', '--config', path.join(pkgDir, 'vite.config.ts')], {
  cwd: pkgDir,
  stdio: 'inherit',
});
if (vite.status !== 0) {
  console.error('[build:license-generator] renderer build failed.');
  process.exit(vite.status ?? 1);
}

console.log('[build:license-generator] done → packages/license-generator/dist');
