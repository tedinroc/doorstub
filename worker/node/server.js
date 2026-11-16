// Node adapter: serve the worker's /api/* over node:http with the same
// handlers as Pages Functions, against any Fulcrum URL (the simnet in tests
// and E2E). Adds the libauth 2026 VM check that workerd cannot run.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createShowsCache, handleApi } from '../lib/api.js';
import { createWorkerChain } from '../lib/chain.js';
import { workerConfig } from '../lib/config.js';
import { createMemoryClaims, createRateLimiter } from '../lib/limits.js';
import { libauthVmCheck } from './vm.js';

/**
 * @param {object} o
 * @param {object} o.env worker environment (STUDIO_DATA_KEY, DOOR_LINKS, DOORSTUB_NETWORK, DOORSTUB_FULCRUM)
 * @param {string} [o.showsPath] shows.json on disk (re-read when it changes)
 * @param {string} [o.showsUrl] or its URL
 * @param {number} [o.port] 0 picks a free port
 * @param {string} [o.host]
 * @param {object} [o.limits] rate limits (worker/lib/limits.js DEFAULT_LIMITS)
 * @param {number} [o.markerWaitMs]
 * @param {boolean} [o.vm] run the libauth VM (default true)
 * @param {Function} [o.WebSocketImpl]
 */
export const startWorkerServer = async ({
  env = {},
  showsPath,
  showsUrl,
  port = 8788,
  host = '127.0.0.1',
  limits,
  markerWaitMs = 6_000,
  pollMs,
  vm = true,
  WebSocketImpl,
  log = () => {},
} = {}) => {
  if ((showsPath === undefined) === (showsUrl === undefined)) throw new Error('give exactly one of showsPath or showsUrl');
  const config = workerConfig(env);
  const cache = createShowsCache({ network: config.network });
  const limiter = createRateLimiter(limits === undefined ? {} : { limits });
  const claims = createMemoryClaims();
  const fetchText = showsPath !== undefined ? () => readFile(showsPath, 'utf8') : async () => (await fetch(showsUrl)).text();

  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 64 * 1024) break;
        chunks.push(chunk);
      }
      const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks);
      const request = new Request(`http://${req.headers.host ?? `${host}:${port}`}${req.url}`, { method: req.method, headers: req.headers, body });
      const response = await handleApi(request, {
        network: config.network,
        configErrors: config.errors,
        dataKey: config.dataKey,
        doorLinks: config.doorLinks,
        loadShows: () => cache(fetchText),
        openChain: () => createWorkerChain({ network: config.network, servers: config.servers, ...(WebSocketImpl && { WebSocketImpl }) }),
        claims,
        limiter,
        clientIp: req.socket.remoteAddress ?? 'unknown',
        vmCheck: vm ? libauthVmCheck : undefined,
        markerWaitMs,
        pollMs,
        runtime: 'node',
        log,
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (e) {
      log(`worker server: ${e?.stack ?? e}`);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'internal', message: 'the worker failed', retryable: true } }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actual = server.address().port;
  return {
    url: `http://${host}:${actual}`,
    port: actual,
    config,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
};
