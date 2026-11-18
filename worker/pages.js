// Cloudflare Pages Functions adapter: /api/* on the site's own origin.
// functions/api/[[route]].js re-exports `onRequest` from here.
//
// shows.json is read from the same deployment's static files (env.ASSETS),
// so the API always agrees with the page; so does /api/health's check that
// the screening room's film is deployed (a static read of its playlist).
// Secrets and settings come from the Pages project's environment
// (worker/lib/config.js). workerd has no
// WebAssembly-from-bytes, so there is no libauth here: settle and refund are
// assembled and checked by worker/lib (see RUNTIME.md).
import { createShowsCache, handleApi } from './lib/api.js';
import { createWorkerChain } from './lib/chain.js';
import { workerConfig } from './lib/config.js';
import { createKvClaims, createMemoryClaims, createRateLimiter, withFallback } from './lib/limits.js';
import { createRoomShowsCache, roomMediaFolder } from './lib/room.js';

// Per isolate: rate-limit windows, the door record (unless KV is bound), the parsed catalogue (full for the door, light for the room).
const isolate = { limiter: createRateLimiter(), claims: createMemoryClaims(), shows: new Map(), roomShows: new Map() };

const cached = (map, network, create) => {
  if (!map.has(network)) map.set(network, create({ network }));
  return map.get(network);
};

/** The film's master playlist is deployed: Pages answers unknown paths with the site's page, so check the body. */
const mediaReady = (env, request, roomKey) => async () => {
  const response = await env.ASSETS.fetch(new Request(new URL(`/room/media/${roomMediaFolder(roomKey)}/film.m3u8`, request.url), { method: 'GET' }));
  return response.status === 200 && (await response.text()).startsWith('#EXTM3U');
};

export const onRequest = async (context) => {
  const { request, env } = context;
  const config = workerConfig(env);
  const loadShows = cached(isolate.shows, config.network, createShowsCache);
  const loadRoomShows = cached(isolate.roomShows, config.network, createRoomShowsCache);
  const showsText = async () => {
    const response = await env.ASSETS.fetch(new Request(new URL('/shows.json', request.url), { method: 'GET' }));
    if (!response.ok) throw new Error(`shows.json answered ${response.status}`);
    return response.text();
  };
  return handleApi(request, {
    network: config.network,
    configErrors: config.errors,
    dataKey: config.dataKey,
    doorLinks: config.doorLinks,
    roomKey: config.roomKey,
    rehearsalLeadS: config.rehearsalLeadS,
    loadShows: () => loadShows(showsText),
    roomShows: () => loadRoomShows(showsText),
    roomMediaReady: config.roomKey === null ? undefined : mediaReady(env, request, config.roomKey),
    openChain: () => createWorkerChain({ network: config.network, servers: config.servers }),
    claims: env.DOOR_CLAIMS ? withFallback(createKvClaims(env.DOOR_CLAIMS), isolate.claims, (line) => console.log(line)) : isolate.claims,
    limiter: isolate.limiter,
    clientIp: request.headers.get('cf-connecting-ip') ?? 'unknown',
    // Under the page's 6 s request timeout (app/src/lib/api.js), so a seat whose
    // buy this server has not seen yet comes back as a retryable 404 in time.
    markerWaitMs: 4_000,
    runtime: 'workerd',
    log: (line) => console.log(line),
  });
};
