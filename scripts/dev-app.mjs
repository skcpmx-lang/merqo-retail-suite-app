/**
 * Development loop for the POS app:
 *   1. start the vite dev server for the renderer
 *   2. bundle main + preload with esbuild (watch)
 *   3. launch electron pointing at the dev server
 *
 * Requires the electron binary (skipped in restricted environments, where
 * `npm run build:app` + the Windows CI pipeline are the supported path).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDir = path.join(root, 'packages', 'app');
const distMain = path.join(appDir, 'dist', 'main');
const DEV_URL = process.env.SAUDA_DEV_URL ?? 'http://localhost:5273';

const aliasCore = {
  name: 'sauda-core-alias',
  setup(build) {
    build.onResolve({ filter: /^@sauda\/core$/ }, () => ({
      path: path.join(root, 'packages', 'core', 'src', 'index.ts'),
    }));
  },
};

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['electron', 'better-sqlite3'],
  plugins: [aliasCore()],
  sourcemap: true,
  logLevel: 'warning',
};

fs.mkdirSync(distMain, { recursive: true });

const mainCtx = await esbuild.context({ ...shared, entryPoints: [path.join(appDir, 'electron', 'main.ts')], outfile: path.join(distMain, 'main.js') });
const preloadCtx = await esbuild.context({ ...shared, entryPoints: [path.join(appDir, 'electron', 'preload.ts')], outfile: path.join(distMain, 'preload.js') });
await mainCtx.watch();
await preloadCtx.watch();

const vite = spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--config', 'vite.config.ts'], {
  cwd: appDir,
  stdio: 'inherit',
});

const electronBin = path.join(root, 'node_modules', 'electron', 'cli.js');
let electron = null;

function launch() {
  if (!fs.existsSync(electronBin)) {
    console.warn('[dev:app] electron is not installed — renderer is available at', DEV_URL);
    return;
  }
  electron = spawn(process.execPath, [electronBin, appDir], {
    cwd: appDir,
    stdio: 'inherit',
    env: { ...process.env, SAUDA_DEV_URL: DEV_URL, NODE_ENV: 'development' },
  });
  electron.on('exit', cleanup);
}

setTimeout(launch, 1500);

function cleanup() {
  vite.kill();
  mainCtx.dispose().catch(() => undefined);
  preloadCtx.dispose().catch(() => undefined);
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
