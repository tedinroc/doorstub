// Vite config for the public site.
//   npm run app            dev server on http://localhost:5190 (test hooks on: ?fulcrum=ws://127.0.0.1:PORT&api=...)
//   npm run app:sim        local simnet + studio catalogue + stub worker + this dev server (see scripts/app-sim.js)
//   npm run app:build      production build to app/dist (mainnet, pinned servers, no overrides), then checks the bundle
//   vite build app --mode simnet   the same build with test hooks, for the E2E (.cache/app-simnet)
//
// __DOORSTUB_TEST_HOOKS__ is the only switch between the two: a literal
// `false` in production, so the bundler drops every override path.
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const appRoot = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
// node_modules may be a link to a shared install (a git worktree); the dev server must be allowed to read it.
const modules = (() => {
  try {
    return realpathSync(join(repoRoot, 'node_modules'));
  } catch {
    return join(repoRoot, 'node_modules');
  }
})();

export default defineConfig(({ command, mode }) => {
  const testHooks = command === 'serve' || mode === 'simnet';
  return {
    root: appRoot,
    base: '/',
    publicDir: 'public',
    logLevel: 'info',
    define: {
      __DOORSTUB_TEST_HOOKS__: JSON.stringify(testHooks),
    },
    esbuild: { jsx: 'automatic', jsxImportSource: 'preact', target: 'es2022' },
    optimizeDeps: { esbuildOptions: { target: 'es2022', jsx: 'automatic', jsxImportSource: 'preact' } },
    server: {
      host: 'localhost',
      port: 5190,
      strictPort: true,
      fs: { allow: [repoRoot, modules] },
    },
    preview: { host: 'localhost', port: 5191, strictPort: true },
    build: {
      outDir: mode === 'simnet' ? fileURLToPath(new URL('../.cache/app-simnet', import.meta.url)) : 'dist',
      emptyOutDir: true,
      target: 'es2022',
      sourcemap: false,
      reportCompressedSize: false,
      chunkSizeWarningLimit: 2_000,
      rollupOptions: {
        output: {
          // WizardConnect is LGPL: it ships as its own file holding only its own code, so anyone
          // can swap in their own build of it. libauth and the other libraries get files of their own.
          manualChunks: (id) => {
            if (id.includes('/node_modules/@wizardconnect/')) return 'wizardconnect';
            if (id.includes('/node_modules/@bitauth/libauth/')) return 'libauth';
            if (id.includes('/node_modules/')) return 'vendor';
            return undefined;
          },
        },
      },
    },
    plugins: [lgplNotice()],
  };
});

/** Put WizardConnect's copyright and licence notice at the top of its own file (minifying drops the original comments). */
function lgplNotice() {
  const notice =
    '/*! WizardConnect (@wizardconnect/core, @wizardconnect/dapp), Copyright (C) 2026 Whiterun LLC. Licensed under the GNU LGPL 3.0 or later; shipped unmodified. Source: https://gitlab.com/riftenlabs/lib/wizardconnect */\n';
  return {
    name: 'doorstub-lgpl-notice',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type === 'chunk' && file.name === 'wizardconnect') file.code = notice + file.code;
      }
    },
  };
}
