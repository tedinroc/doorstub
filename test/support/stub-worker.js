// A stand-in for the worker's two page-facing endpoints, for app tests only
// (the real worker lives in worker/ and checks the chain before it signs or
// opens a door). It signs 'R' notices for seats of sample-refund-seat shows
// with the studio's data key, and answers the door for real shows with a
// link from a map. It never signs 'C'.
//
// The door speaks the reservation contract (SPEC.md section 12):
//   { category, txid, claim, reserve: true } -> 200 { reserved: true, again } for the first claim of a
//     check-in and the same claim again; 409 already-answered for any other claim. No chain lookup.
//   { category, txid, claim? }               -> 200 { link, again } for the claim on record (or the first
//     caller when there is none); 409 already-answered for any other claim or no claim.
// Errors have the worker's shape: { error: { code, message, retryable }, message }.
//
//   const api = stubApi({ shows, dataPrivateKey, doorLinks })   // in-process, same shape as app/src/lib/api.js
//   const server = await startStubServer({ root, showsPath, dataPrivateKey, doorLinks, port: 0 })
//                                         // static files + /shows.json + POST /api/notice, /api/door
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { binToHex, hexToBin } from '@bitauth/libauth';
import { encodeRefundNoticeMessage } from '../../src/tx/index.js';
import { signDataMessage } from '../../src/tx/sign.js';

const HEX = (n) => new RegExp(`^[0-9a-f]{${n}}$`, 'i');

export class StubError extends Error {
  constructor(status, message, code = 'error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** The worker's error body. */
export const stubErrorBody = (e) => ({ error: { code: e.code ?? 'internal', message: e.message, retryable: e.status === 404 || e.status >= 500 }, message: e.message });

/**
 * @param {object} options
 * @param {() => Array<{ id, kind, params: { category } }>} options.shows reads the current shows.json entries
 * @param {Uint8Array} options.dataPrivateKey studio data key
 * @param {Record<string, string>} [options.doorLinks] category hex -> https link
 * @param {{ down?: boolean, failTimes?: number }} [options.behaviour] make the notice endpoint fail (tests)
 */
export const stubApi = ({ shows, dataPrivateKey, doorLinks = {}, behaviour = {} }) => {
  const calls = [];
  /** `${show id}:${txid}` -> { claim: string|null, answered: boolean } */
  const doorRecords = new Map();
  let failures = 0;
  const find = (category) => shows().find((s) => s.params.category === String(category).toLowerCase());
  return {
    calls,
    behaviour,
    notice: async ({ category, seat }) => {
      calls.push({ endpoint: 'notice', category, seat });
      if (behaviour.down) throw new StubError(503, 'notice signer is down');
      if (behaviour.failTimes !== undefined && failures < behaviour.failTimes) {
        failures += 1;
        throw new StubError(404, 'no marker for that seat yet');
      }
      if (!HEX(64).test(category ?? '') || !HEX(6).test(seat ?? '')) throw new StubError(400, 'category and seat must be hex');
      const show = find(category);
      if (show === undefined || show.kind !== 'sample-refund-seat') throw new StubError(403, 'notices are signed only for the sample refund show');
      const message = encodeRefundNoticeMessage({ scope: 'R', category: hexToBin(category), seat: hexToBin(seat) });
      return { signature: binToHex(signDataMessage(dataPrivateKey, message)) };
    },
    door: async ({ category, txid, claim, reserve }) => {
      calls.push({ endpoint: reserve === true ? 'reserve' : 'door', category, txid, ...(claim !== undefined && { claim }) });
      if (behaviour.doorDown || (reserve === true && behaviour.reserveDown)) throw new StubError(503, 'door is down', 'chain-down');
      if (!HEX(64).test(category ?? '')) throw new StubError(400, 'category must be 64 hex characters', 'bad-request');
      const show = find(category);
      if (show === undefined) throw new StubError(404, 'no show in shows.json has this category', 'unknown-show');
      if (show.kind !== 'real') throw new StubError(403, 'only real shows have a door', 'not-a-real-show');
      if (!HEX(64).test(txid ?? '')) throw new StubError(400, 'txid must be hex', 'bad-request');
      if (claim !== undefined && !(typeof claim === 'string' && /^(?:[0-9a-f]{2}){16,64}$/i.test(claim))) throw new StubError(400, 'claim must be hex', 'bad-request');
      const key = `${show.id}:${txid.toLowerCase()}`;
      const mine = claim === undefined ? null : claim.toLowerCase();
      const record = doorRecords.get(key);
      if (reserve === true) {
        if (mine === null || !HEX(64).test(mine)) throw new StubError(400, 'a reservation needs a 64 hex character claim', 'bad-request');
        if (record === undefined) {
          doorRecords.set(key, { claim: mine, answered: false });
          return { reserved: true, again: false };
        }
        if (record.claim === mine) return { reserved: true, again: true };
        throw new StubError(409, 'this check-in already got its door answer; the page that checked in shows it', 'already-answered');
      }
      const link = doorLinks[show.params.category];
      if (link === undefined) throw new StubError(503, 'the door for this show is not set up yet', 'door-not-configured');
      if (record === undefined) {
        doorRecords.set(key, { claim: mine, answered: true });
        return { link, again: false };
      }
      if (record.claim !== mine) throw new StubError(409, 'this check-in already got its door answer; the page that checked in shows it', 'already-answered');
      const again = record.answered;
      record.answered = true;
      return { link, again };
    },
  };
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 10_000) reject(new StubError(413, 'too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });

/**
 * HTTP server: static files from `root` (a built app), `/shows.json` from
 * `showsPath`, and the two endpoints. CORS is open so a dev server on another
 * port can call it.
 */
export const startStubServer = async ({ root, showsPath, dataPrivateKey, doorLinks, behaviour, port = 0, host = '127.0.0.1', headers = {} }) => {
  const shows = () => JSON.parse(readFileSync(showsPath, 'utf8')).shows;
  const api = stubApi({ shows, dataPrivateKey, doorLinks, behaviour });
  const server = createServer(async (req, res) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
    const send = (status, body, type = 'application/json; charset=utf-8', extra = {}) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...cors, ...extra });
      res.end(body);
    };
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'OPTIONS') return send(204, '');
      if (req.method === 'POST' && (url.pathname === '/api/notice' || url.pathname === '/api/door')) {
        const body = JSON.parse((await readBody(req)) || '{}');
        const result = url.pathname === '/api/notice' ? await api.notice(body) : await api.door(body);
        return send(200, JSON.stringify(result));
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, JSON.stringify({ error: 'method not allowed' }));
      if (url.pathname === '/shows.json') return send(200, readFileSync(showsPath));
      if (root === undefined) return send(404, JSON.stringify({ error: 'not found' }));
      const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
      let file = join(root, rel);
      if (!file.startsWith(root)) return send(403, 'forbidden', 'text/plain');
      if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
      return send(200, readFileSync(file), TYPES[extname(file)] ?? 'application/octet-stream', extname(file) === '.html' ? headers : {});
    } catch (e) {
      return send(e instanceof StubError ? e.status : 500, JSON.stringify(stubErrorBody(e)));
    }
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  return {
    api,
    port: address.port,
    origin: `http://${host}:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
};
