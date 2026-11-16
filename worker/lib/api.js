// The worker's HTTP API, the same in every runtime (Pages Functions, Node).
//
//   GET  /api/health   what is configured, and the chain tip
//   POST /api/notice   { category, seat, txid? } -> { signature, ... }   (sample show B only)
//   POST /api/door     { category, txid, claim, reserve: true } -> { reserved, again }   (real shows, before the check-in is sent)
//   POST /api/door     { category, txid, claim? }               -> { link, ... }         (real shows, after it is sent)
//
// Errors are { error: { code, message, retryable } } with a fitting status.
import { equal, WorkerError } from './bytes.js';
import { publicKeyOf } from './crypto.js';
import { answerDoor } from './door.js';
import { signSeatNotice } from './notice.js';
import { parseWorkerShows } from './shows.js';

export const API_VERSION = 1;
const MAX_BODY_BYTES = 2_048;

const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

const json = (status, body, extra = {}) => new Response(JSON.stringify(body), { status, headers: { ...headers, ...extra } });

// The top-level `message` repeats error.message for clients that read only that.
const errorBody = (code, message, retryable) => ({ error: { code, message, retryable }, message });

const errorResponse = (e) => {
  if (e instanceof WorkerError) return json(e.status, errorBody(e.code, e.message, e.retryable));
  return json(500, errorBody('internal', 'the worker failed; the keeper will retry within minutes', true));
};

const readJson = async (request) => {
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > MAX_BODY_BYTES) throw new WorkerError('too-large', 'request body is too large', { status: 413 });
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new WorkerError('too-large', 'request body is too large', { status: 413 });
  try {
    return JSON.parse(text);
  } catch {
    throw new WorkerError('bad-request', 'send a JSON body');
  }
};

/**
 * Cache parsed shows.json by content: `fetchText()` gives the file's text;
 * parsing (and recomputing every contract) happens only when it changed.
 */
export const createShowsCache = ({ network }) => {
  let last = null;
  return async (fetchText) => {
    const text = await fetchText();
    if (last !== null && last.text === text) return last.parsed;
    const parsed = parseWorkerShows(text, { network });
    last = { text, parsed };
    return parsed;
  };
};

const ROUTES = {
  '/api/health': 'GET',
  '/api/notice': 'POST',
  '/api/door': 'POST',
};

/**
 * @param {Request} request
 * @param {object} deps
 * @param {'mainnet'|'simnet'} deps.network
 * @param {() => Promise<{ shows, rejected }>} deps.loadShows
 * @param {() => object} deps.openChain a fresh worker chain client (closed after the request)
 * @param {Uint8Array|null} deps.dataKey
 * @param {object|null} deps.doorLinks
 * @param {{ reserve, claim }} deps.claims the door's one-claimant-per-check-in record
 * @param {{ take }} deps.limiter
 * @param {string} deps.clientIp
 * @param {Function} [deps.vmCheck]
 * @param {number} [deps.markerWaitMs]
 * @param {string[]} [deps.configErrors]
 * @param {string} [deps.runtime] 'workerd' | 'node'
 */
const tooMany = (limited) => {
  const seconds = Math.max(1, Math.ceil(limited.retryAfterMs / 1000));
  return json(429, errorBody('rate-limited', `too many requests; try again in ${seconds} s`, true), { 'retry-after': String(seconds) });
};

export const handleApi = async (request, deps) => {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  const method = ROUTES[path];
  if (method === undefined) return json(404, errorBody('not-found', 'no such API endpoint', false));
  if (request.method !== method) return json(405, errorBody('method-not-allowed', `use ${method}`, false), { allow: method });
  const bucket = path.slice('/api/'.length);
  const limited = deps.limiter.take(bucket, deps.clientIp ?? 'unknown');
  if (!limited.ok) return tooMany(limited);
  let chain = null;
  const openChain = () => {
    chain ??= deps.openChain();
    return chain;
  };
  try {
    if (path === '/api/health') return json(200, await health(deps, openChain));
    const body = await readJson(request);
    if (path === '/api/door' && body?.reserve === true) {
      // A reservation is a KV write that needs no check-in: its own, tighter limit (one per walk-in is enough).
      const reserveLimited = deps.limiter.take('reserve', deps.clientIp ?? 'unknown');
      if (!reserveLimited.ok) return tooMany(reserveLimited);
    }
    const { shows } = await deps.loadShows();
    if (path === '/api/notice') {
      return json(200, await signSeatNotice({ shows, chain: openChain(), dataKey: deps.dataKey, body, markerWaitMs: deps.markerWaitMs ?? 0, pollMs: deps.pollMs }));
    }
    return json(200, await answerDoor({ shows, chain: openChain(), doorLinks: deps.doorLinks, claims: deps.claims, vmCheck: deps.vmCheck, body, clientIp: deps.clientIp }));
  } catch (e) {
    if (!(e instanceof WorkerError)) deps.log?.(`api ${path}: ${e?.stack ?? e}`);
    return errorResponse(e);
  } finally {
    chain?.close();
  }
};

const health = async (deps, openChain) => {
  const out = {
    ok: true,
    service: 'doorstub-worker',
    api: API_VERSION,
    network: deps.network,
    runtime: deps.runtime ?? 'unknown',
    vm: typeof deps.vmCheck === 'function' ? 'libauth 2026 VM and rule check' : 'rule check (the network runs the VM)',
    config: { errors: deps.configErrors ?? [] },
  };
  try {
    const { shows, rejected } = await deps.loadShows();
    const dataPk = deps.dataKey === null || deps.dataKey === undefined ? null : publicKeyOf(deps.dataKey);
    out.shows = { loaded: shows.length, rejected: rejected.length };
    out.signer = {
      configured: dataPk !== null,
      shows: shows.filter((s) => s.kind === 'sample-refund-seat').map((s) => ({ id: s.id, keyMatches: dataPk !== null && equal(dataPk, s.organiserDataPk) })),
      // Real shows whose refund notices this key could sign if it leaked (RUNTIME.md section 5): ideally none.
      alsoKeyOf: shows.filter((s) => s.kind === 'real' && dataPk !== null && equal(dataPk, s.organiserDataPk)).map((s) => s.id),
    };
    out.door = {
      shows: shows.filter((s) => s.kind === 'real' && s.door !== null).map((s) => ({ id: s.id, configured: typeof deps.doorLinks?.[s.id] === 'string' })),
      // Where the one-claimant record lives: 'kv+memory' once DOOR_CLAIMS is bound on Cloudflare, else 'memory' (RUNTIME.md section 4).
      record: deps.claims?.kind ?? 'none',
    };
  } catch (e) {
    out.ok = false;
    out.shows = { error: e.message };
  }
  try {
    out.chain = { tip: await openChain().tip() };
  } catch (e) {
    out.ok = false;
    out.chain = { error: e.message };
  }
  return out;
};
