// Which runtime this build uses. __DOORSTUB_TEST_HOOKS__ is a build-time
// constant (vite.config.js): true only for the dev server and the simnet
// build, `false` in production, where the bundler drops the test resolver
// and every URL override with it (npm run app:build checks the bundle).
import { PRODUCTION_RUNTIME, resolveTestRuntime } from './lib/runtime.js';

// eslint-disable-next-line no-undef
export const TEST_HOOKS = __DOORSTUB_TEST_HOOKS__;

const pick = () => {
  if (!TEST_HOOKS) return PRODUCTION_RUNTIME;
  try {
    return resolveTestRuntime(globalThis.location?.search ?? '');
  } catch (e) {
    // A bad test URL falls back to production settings, read-only in spirit.
    console.warn(`[doorstub] ${e.message}; using the production settings`);
    return PRODUCTION_RUNTIME;
  }
};

export const runtime = pick();
