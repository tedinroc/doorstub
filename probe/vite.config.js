// Vite config for the probe page.
//   npm run probe        dev server on http://localhost:5180
//   npm run probe:build  one self-contained file: dist/doorstub-probe.html
// The contracts and builders in src/tx are bundled at build time, so a
// contract change only needs `npm run compile` and a rebuild.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const probeRoot = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const OUTPUT_NAME = 'doorstub-probe.html';

/** Rename the built index.html so dist/ says what it is. */
const renameHtml = () => ({
  name: 'doorstub-rename-html',
  enforce: 'post',
  generateBundle(_options, bundle) {
    const page = bundle['index.html'];
    if (page) {
      page.fileName = OUTPUT_NAME;
      delete bundle['index.html'];
      bundle[OUTPUT_NAME] = page;
    }
  },
});

export default defineConfig({
  root: probeRoot,
  base: './',
  logLevel: 'info',
  server: {
    host: 'localhost',
    port: 5180,
    strictPort: false,
    fs: { allow: [repoRoot] },
  },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
  esbuild: { target: 'es2022' },
  build: {
    outDir: fileURLToPath(new URL('../dist', import.meta.url)),
    emptyOutDir: false,
    target: 'es2022',
    reportCompressedSize: false,
  },
  plugins: [viteSingleFile(), renameHtml()],
});
