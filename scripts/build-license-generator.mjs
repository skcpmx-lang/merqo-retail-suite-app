/**
 * Builds the private License Generator desktop app (main + preload bundles,
 * plus a straight copy of the static renderer).
 */
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

fs.cpSync(path.join(pkgDir, 'renderer'), path.join(outDir, 'renderer'), { recursive: true });

console.log('[build:license-generator] done → packages/license-generator/dist');
