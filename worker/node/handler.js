// The worker's handlers for Node, without a server: what `startWorkerServer`
// serves over HTTP, and a fetch-compatible function for in-process callers
// (for example the app's API client in tests: createApi({ fetchImpl: worker.fetch })).
// Same handlers as Pages Functions, plus the libauth 2026 VM check.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createShowsCache, handleApi } from '../lib/api.js';
import { createWorkerChain } from '../lib/chain.js';
import { workerConfig } from '../lib/config.js';
import { createMemoryClaims, createRateLimiter } from '../lib/limits.js';
import { createRoomShowsCache, roomMediaFolder } from '../lib/room.js';
import { libauthVmCheck } from './vm.js';

/** As the Pages adapter: under the page's 6 s request timeout. */
export const NODE_MARKER_WAIT_MS = 4_000;

/**
 * @param {object} o
 * @param {object} o.env worker environment (STUDIO_DATA_KEY, DOOR_LINKS, ROOM_KEY, DOORSTUB_NETWORK, DOORSTUB_FULCRUM;
 *   ROOM_REHEARSAL_LEAD_S on simnet)
 * @param {string} [o.showsPath] shows.json on disk (re-read on every request; parsed again only when it changed)
 * @param {string} [o.showsUrl] or its URL
 * @param {string|Function} [o.showsText] or its text (or a function returning it)
 * @param {object} [o.limits] rate limits (worker/lib/limits.js DEFAULT_LIMITS)
 * @param {number} [o.markerWaitMs]
 * @param {number} [o.pollMs]
 * @param {boolean} [o.vm] run the libauth VM (default true)
 * @param {Function} [o.WebSocketImpl]
 * @param {Function} [o.log]
 * @param {string} [o.staticRoot] the built site, for /api/health's room media check (room/media/<folder>/film.m3u8)
 * @param {() => Promise<boolean>} [o.roomMediaReady] or that check itself
 * @param {() => number} [o.now] the clock, in ms (tests)
 * @returns {{ config, handle(request, { clientIp }): Promise<Response>, fetch(input, init): Promise<Response>, readShows(): Promise<string> }}
 */
export const createNodeWorker = ({
  env = {},
  showsPath,
  showsUrl,
  showsText,
  limits,
  markerWaitMs = NODE_MARKER_WAIT_MS,
  pollMs,
  vm = true,
  WebSocketImpl,
  log = () => {},
  staticRoot,
  roomMediaReady,
  now,
} = {}) => {
  if ([showsPath, showsUrl, showsText].filter((x) => x !== undefined).length !== 1) throw new Error('give exactly one of showsPath, showsUrl or showsText');
  const config = workerConfig(env);
  const cache = createShowsCache({ network: config.network });
  const roomCache = createRoomShowsCache({ network: config.network });
  const limiter = createRateLimiter(limits === undefined ? {} : { limits });
  const claims = createMemoryClaims();
  const readShows =
    showsPath !== undefined
      ? () => readFile(showsPath, 'utf8')
      : showsUrl !== undefined
        ? async () => (await fetch(showsUrl)).text()
        : async () => (typeof showsText === 'function' ? showsText() : showsText);
  const mediaReady =
    roomMediaReady ??
    (staticRoot !== undefined && config.roomKey !== null
      ? async () => (await readFile(join(staticRoot, 'room', 'media', roomMediaFolder(config.roomKey), 'film.m3u8'), 'utf8').catch(() => '')).startsWith('#EXTM3U')
      : undefined);

  const handle = (request, { clientIp = 'unknown' } = {}) =>
    handleApi(request, {
      network: config.network,
      configErrors: config.errors,
      dataKey: config.dataKey,
      doorLinks: config.doorLinks,
      roomKey: config.roomKey,
      rehearsalLeadS: config.rehearsalLeadS,
      loadShows: () => cache(readShows),
      roomShows: () => roomCache(readShows),
      roomMediaReady: mediaReady,
      now,
      openChain: () => createWorkerChain({ network: config.network, servers: config.servers, ...(WebSocketImpl && { WebSocketImpl }) }),
      claims,
      limiter,
      clientIp,
      vmCheck: vm ? libauthVmCheck : undefined,
      markerWaitMs,
      pollMs,
      runtime: 'node',
      log,
    });

  return {
    config,
    handle,
    fetch: (input, init) => handle(new Request(input, init), { clientIp: '127.0.0.1' }),
    readShows,
  };
};
