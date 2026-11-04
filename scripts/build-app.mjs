/**
 * Builds the Sauda POS desktop app:
 *   1. electron main + preload  → packages/app/dist/main/*.js (CJS bundles)
 *   2. renderer                 → packages/app/dist/renderer/* (vite)
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDir = path.join(root, 'packages', 'app');

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    console.error(`\n[build:app] command failed: ${command} ${args.join(' ')}`);
    process.exit(result.status ?? 1);
  }
}

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
  sourcemap: false,
  logLevel: 'info',
  // better-sqlite3 is a native module and must stay external; electron is
  // provided by the runtime.
  external: ['electron', 'better-sqlite3'],
  plugins: [aliasCore()],
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
};

fs.mkdirSync(path.join(appDir, 'dist', 'main'), { recursive: true });

await esbuild.build({
  ...shared,
  entryPoints: [path.join(appDir, 'electron', 'main.ts')],
  outfile: path.join(appDir, 'dist', 'main', 'main.js'),
});

await esbuild.build({
  ...shared,
  entryPoints: [path.join(appDir, 'electron', 'preload.ts')],
  outfile: path.join(appDir, 'dist', 'main', 'preload.js'),
});

run(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.config.ts'], appDir);

console.log('[build:app] done → packages/app/dist/{main,renderer}');
