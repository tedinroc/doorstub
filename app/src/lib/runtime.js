// Where the app talks to: the network, the Fulcrum servers, the worker origin
// and the show list.
//
// Production is ONE frozen constant: mainnet, the pinned server list from
// src/chain/servers.js, our own origin for /api/* and /shows.json. Nothing in
// the URL, storage or the page can change it.
//
// `resolveTestRuntime` exists for development and the simnet E2E only. It is
// called from app/src/env.js behind a build-time flag that is `false` in
// production builds, so the bundler drops it (scripts/check-app-dist.js
// greps app/dist to prove it).

export const PRODUCTION_RUNTIME = Object.freeze({
  network: 'mainnet',
  /** undefined: the pool uses MAINNET_SERVERS. */
  servers: undefined,
  /** '' means our own origin: /api/notice, /api/door. */
  apiOrigin: '',
  showsUrl: '/shows.json',
  testHooks: false,
});

const LOCAL_WS = /^wss?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}\/?$/;
const LOCAL_HTTP = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/;

/**
 * Test runtime from a query string such as
 * `?fulcrum=ws://127.0.0.1:50021&api=http://127.0.0.1:50022`.
 * Without `fulcrum` it returns production settings (with test hooks on, so
 * the dev panel can say how to start a simnet). Only local addresses are
 * accepted, so even a development build cannot be pointed at a remote chain
 * or API by a link.
 *
 * Two more switches for the E2E: `relay=ws://127.0.0.1:PORT` pairs over a
 * local WizardConnect relay (when the public ones are down), and
 * `pagekeeper=0` stops the page from pushing settles itself, so the run can
 * prove that the cron keeper does it.
 */
export const resolveTestRuntime = (search = '') => {
  const q = new URLSearchParams(search);
  const fulcrum = q.get('fulcrum');
  if (fulcrum === null) return Object.freeze({ ...PRODUCTION_RUNTIME, testHooks: true });
  if (!LOCAL_WS.test(fulcrum)) throw new Error(`fulcrum must be a local ws:// URL, got ${fulcrum}`);
  const api = q.get('api') ?? '';
  if (api !== '' && !LOCAL_HTTP.test(api)) throw new Error(`api must be a local http:// origin, got ${api}`);
  const shows = q.get('shows');
  if (shows !== null && !/^\/[\w./-]*$/.test(shows) && !(shows.startsWith(`${api}/`) && api !== '')) {
    throw new Error('shows must be a path on this origin or on the api origin');
  }
  const relay = q.get('relay');
  if (relay !== null && !LOCAL_WS.test(relay)) throw new Error(`relay must be a local ws:// URL, got ${relay}`);
  return Object.freeze({
    network: 'simnet',
    servers: [fulcrum.replace(/\/$/, '')],
    apiOrigin: api,
    showsUrl: shows ?? `${api}/shows.json`,
    testHooks: true,
    usd: q.has('usd') ? Number(q.get('usd')) : undefined,
    ...(relay !== null && { relayUrls: Object.freeze([relay.replace(/\/$/, '')]) }),
    ...(q.get('pagekeeper') === '0' && { pageKeeper: false }),
  });
};
