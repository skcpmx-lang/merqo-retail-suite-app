import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const coreIndex = fileURLToPath(new URL('../core/src/index.ts', import.meta.url));

/**
 * Renderer build for the Sauda POS window.
 * Intentionally has no React fast-refresh plugin: the desktop window loads the
 * built bundle, and keeping the toolchain to vite + esbuild avoids version
 * drift between the pinned vite (7.x) and the react plugin.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  resolve: {
    alias: {
      '@sauda/core': coreIndex,
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5273,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] },
  },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    target: 'chrome120',
    sourcemap: false,
    chunkSizeWarningLimit: 1600,
  },
});
