// Node adapter: serve the worker's /api/* over node:http with the same
// handlers as Pages Functions, against any Fulcrum URL (the simnet in tests
// and E2E). Adds the libauth 2026 VM check that workerd cannot run.
//
// Like a Pages deployment it can also serve the site on the same origin:
// `staticRoot` (a built app, unknown paths fall back to index.html) and
// /shows.json from `showsPath`. `cors: true` lets a dev server on another
// port call /api/* (local runs only; Pages Functions are same-origin).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { createNodeWorker, NODE_MARKER_WAIT_MS } from './handler.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/**
 * @param {object} o
 * @param {object} o.env worker environment (STUDIO_DATA_KEY, DOOR_LINKS, DOORSTUB_NETWORK, DOORSTUB_FULCRUM)
 * @param {string} [o.showsPath] shows.json on disk (re-read when it changes)
 * @param {string} [o.showsUrl] or its URL
 * @param {string|Function} [o.showsText] or its text
 * @param {number} [o.port] 0 picks a free port
 * @param {string} [o.host]
 * @param {object} [o.limits] rate limits (worker/lib/limits.js DEFAULT_LIMITS)
 * @param {number} [o.markerWaitMs]
 * @param {boolean} [o.vm] run the libauth VM (default true)
 * @param {Function} [o.WebSocketImpl]
 * @param {string} [o.staticRoot] serve this directory (a built app) on the same origin
 * @param {boolean} [o.cors] allow cross-origin calls to /api/* (local dev)
 * @param {object} [o.htmlHeaders] extra headers on HTML responses (for example a CSP)
 */
export const startWorkerServer = async ({
  env = {},
  showsPath,
  showsUrl,
  showsText,
  port = 8788,
  host = '127.0.0.1',
  limits,
  markerWaitMs = NODE_MARKER_WAIT_MS,
  pollMs,
  vm = true,
  WebSocketImpl,
  staticRoot,
  cors = false,
  htmlHeaders = {},
  log = () => {},
} = {}) => {
  const worker = createNodeWorker({ env, showsPath, showsUrl, showsText, limits, markerWaitMs, pollMs, vm, WebSocketImpl, log });
  const { config } = worker;

  const root = staticRoot === undefined ? undefined : resolve(staticRoot);
  const corsHeaders = cors ? { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' } : {};

  /** Static files and /shows.json, as Pages serves them next to the Functions. */
  const serveFile = async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://local').pathname);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'GET, HEAD' });
      return res.end(JSON.stringify({ error: { code: 'method-not-allowed', message: 'use GET', retryable: false } }));
    }
    if (pathname === '/shows.json' && showsUrl === undefined) {
      res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store', ...corsHeaders });
      return res.end(req.method === 'HEAD' ? undefined : await worker.readShows());
    }
    if (root === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { code: 'not-found', message: 'this worker serves only /api/*', retryable: false } }));
    }
    let file = resolve(root, `.${pathname}`);
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('forbidden');
    }
    const isFile = await stat(file).then((st) => st.isFile(), () => false);
    if (!isFile) file = resolve(root, 'index.html');
    const type = TYPES[extname(file)] ?? 'application/octet-stream';
    const body = await readFile(file).catch(() => null);
    if (body === null) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', ...(type.startsWith('text/html') ? htmlHeaders : {}) });
    return res.end(req.method === 'HEAD' ? undefined : body);
  };

  const server = createServer(async (req, res) => {
    try {
      if (cors && req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders);
        return res.end();
      }
      if (!req.url.startsWith('/api/') && req.url !== '/api') return await serveFile(req, res);
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 64 * 1024) break;
        chunks.push(chunk);
      }
      const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks);
      const request = new Request(`http://${req.headers.host ?? `${host}:${port}`}${req.url}`, { method: req.method, headers: req.headers, body });
      const response = await worker.handle(request, { clientIp: req.socket.remoteAddress ?? 'unknown' });
      res.writeHead(response.status, { ...Object.fromEntries(response.headers), ...corsHeaders });
      return res.end(Buffer.from(await response.arrayBuffer()));
    } catch (e) {
      log(`worker server: ${e?.stack ?? e}`);
      if (res.headersSent) return res.end();
      res.writeHead(500, { 'content-type': 'application/json', ...corsHeaders });
      return res.end(JSON.stringify({ error: { code: 'internal', message: 'the worker failed', retryable: true }, message: 'the worker failed' }));
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
    worker,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
};
