import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const coreIndex = fileURLToPath(new URL('../core/src/index.ts', import.meta.url));

/**
 * Renderer build for the License Generator window. Kept deliberately minimal
 * (vite + esbuild, no react plugin) so the pinned toolchain never drifts — the
 * same choice the retail app made.
 */
export default defineConfig({
  root: fileURLToPath(new URL('./renderer-src', import.meta.url)),
  base: './',
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  resolve: { alias: { '@sauda/core': coreIndex } },
  server: {
    host: '0.0.0.0',
    port: 5274,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] },
  },
  build: {
    outDir: fileURLToPath(new URL('./dist/renderer', import.meta.url)),
    emptyOutDir: true,
    target: 'chrome120',
    sourcemap: false,
    chunkSizeWarningLimit: 1600,
  },
});
