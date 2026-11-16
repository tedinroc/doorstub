// Cloudflare Pages Functions adapter: /api/* on the site's own origin.
// functions/api/[[route]].js re-exports `onRequest` from here.
//
// shows.json is read from the same deployment's static files (env.ASSETS),
// so the API always agrees with the page. Secrets and settings come from the
// Pages project's environment (worker/lib/config.js). workerd has no
// WebAssembly-from-bytes, so there is no libauth here: settle and refund are
// assembled and checked by worker/lib (see RUNTIME.md).
import { createShowsCache, handleApi } from './lib/api.js';
import { createWorkerChain } from './lib/chain.js';
import { workerConfig } from './lib/config.js';
import { createKvClaims, createMemoryClaims, createRateLimiter } from './lib/limits.js';

// Per isolate: rate-limit windows, the door record (unless KV is bound), the parsed catalogue.
const isolate = { limiter: createRateLimiter(), claims: createMemoryClaims(), shows: new Map() };

const showsLoader = (network) => {
  if (!isolate.shows.has(network)) isolate.shows.set(network, createShowsCache({ network }));
  return isolate.shows.get(network);
};

export const onRequest = async (context) => {
  const { request, env } = context;
  const config = workerConfig(env);
  const loadShows = showsLoader(config.network);
  return handleApi(request, {
    network: config.network,
    configErrors: config.errors,
    dataKey: config.dataKey,
    doorLinks: config.doorLinks,
    loadShows: () =>
      loadShows(async () => {
        const response = await env.ASSETS.fetch(new Request(new URL('/shows.json', request.url), { method: 'GET' }));
        if (!response.ok) throw new Error(`shows.json answered ${response.status}`);
        return response.text();
      }),
    openChain: () => createWorkerChain({ network: config.network, servers: config.servers }),
    claims: env.DOOR_CLAIMS ? createKvClaims(env.DOOR_CLAIMS) : isolate.claims,
    limiter: isolate.limiter,
    clientIp: request.headers.get('cf-connecting-ip') ?? 'unknown',
    // Under the page's 6 s request timeout (app/src/lib/api.js), so a seat whose
    // buy this server has not seen yet comes back as a retryable 404 in time.
    markerWaitMs: 4_000,
    runtime: 'workerd',
    log: (line) => console.log(line),
  });
};
