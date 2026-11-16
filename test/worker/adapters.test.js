// The Cloudflare adapters, run in Node against the simnet with Cloudflare's
// calling conventions: the Pages Functions route (context.request, env with
// ASSETS serving shows.json and a DOOR_CLAIMS KV namespace) and the cron
// Worker's pass (SHOWS_URL fetched).
// Neither has the libauth VM (as in workerd); the worker's rule check guards
// what they build, and the simnet runs the VM on every broadcast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeTransaction, hexToBin } from '@bitauth/libauth';
import { verifyRefundNotice } from '../../src/tx/index.js';
import { onRequest } from '../../functions/api/[[route]].js';
import cron, { runCron } from '../../worker/cron.js';
import { txidOf } from '../../worker/lib/crypto.js';
import { createNodeWorker } from '../../worker/node/handler.js';
import { buyTicket, send, signedCheckIn, startWorker, unspentAt, workerSimnet } from './support.js';

test('Pages Functions route and cron Worker, on simnet', async (t) => {
  const ctx = await workerSimnet(t, {
    name: 'adapters',
    schedule: [{ id: 'live-call', kind: 'real', title: 'Live call', card: 'A real show.', startHeight: '+300', eventAt: '2026-11-24T13:00:00Z', durationMin: 25, seatPrefix: 'L' }],
  });
  const [showB] = ctx.byKind('sample-refund-seat');
  const [real] = ctx.byKind('real');
  const kv = new Map();
  const env = {
    DOORSTUB_NETWORK: 'simnet',
    DOORSTUB_FULCRUM: ctx.simnet.url,
    STUDIO_DATA_KEY: ctx.dataKeyHex,
    DOOR_LINKS: JSON.stringify({ 'live-call': 'https://example.invalid/call?seat={seat}' }),
    DOOR_CLAIMS: {
      get: async (key) => kv.get(key) ?? null,
      put: async (key, value) => {
        kv.set(key, value);
      },
    },
    ASSETS: {
      fetch: async (request) => {
        assert.equal(new URL(request.url).pathname, '/shows.json');
        return new Response(ctx.showsText, { headers: { 'content-type': 'application/json' } });
      },
    },
  };
  const call = async (path, init) => {
    const response = await onRequest({ request: new Request(`https://doorstub.test${path}`, init), env });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };

  const health = await call('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.runtime, 'workerd');
  assert.match(health.body.vm, /rule check/);
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.deepEqual(health.body.signer.alsoKeyOf, [], 'the worker\'s key is not the real show\'s data key');
  assert.deepEqual(health.body.door, { shows: [{ id: 'live-call', configured: true }], record: 'kv+memory' }, 'DOOR_CLAIMS is bound');

  const ticket = await buyTicket(ctx.rpc, showB);
  const notice = await call('/api/notice', { method: 'POST', body: JSON.stringify({ category: showB.categoryHex, seat: ticket.seatHex, txid: ticket.txid }), headers: { 'cf-connecting-ip': '203.0.113.7' } });
  assert.equal(notice.status, 200, JSON.stringify(notice.body));
  assert.equal(verifyRefundNotice({ show: showB, notice: { scope: 'R', seat: ticket.seat, signature: hexToBin(notice.body.signature) } }), true);

  // The door of a real show, with the one-claimant record in the KV namespace.
  const seat = await buyTicket(ctx.rpc, real);
  const checkIn = await send(ctx.rpc, signedCheckIn(real, seat));
  const walkIn = (ip) => call('/api/door', { method: 'POST', body: JSON.stringify({ category: real.categoryHex, txid: checkIn }), headers: { 'cf-connecting-ip': ip } });
  const opened = await walkIn('203.0.113.8');
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.equal(opened.body.link, 'https://example.invalid/call?seat=L-0-1');
  assert.equal(opened.body.again, false);
  assert.equal((await walkIn('203.0.113.8')).body.again, true);
  assert.equal((await walkIn('203.0.113.9')).status, 409);
  assert.deepEqual([...kv.keys()], [`door:live-call:${checkIn}`]);
  assert.match(kv.get(`door:live-call:${checkIn}`), /^a:[0-9a-f]{64}$/);

  // Reserve, then send, then ask: the reservation lives in KV, so another isolate would see it too.
  const claim = 'c3'.repeat(32);
  const reserved = await buyTicket(ctx.rpc, real, { shard: 1 });
  const signed = signedCheckIn(real, reserved);
  const txid = txidOf(encodeTransaction(signed.transaction));
  const door = (body, ip = '203.0.113.8') => call('/api/door', { method: 'POST', body: JSON.stringify({ category: real.categoryHex, txid, ...body }), headers: { 'cf-connecting-ip': ip } });
  assert.deepEqual((await door({ claim, reserve: true })).body, { reserved: true, again: false });
  assert.match(kv.get(`door:live-call:${txid}`), /^r:[0-9a-f]{64}$/);
  assert.equal(await send(ctx.rpc, signed), txid);
  assert.equal((await door({}, '198.51.100.20')).status, 409, 'an observer without the claim');
  const mine = await door({ claim });
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.equal(mine.body.seatLabel, 'L-1-1');
  assert.equal(mine.body.again, false);

  // A mainnet deployment ignores the simnet URL and refuses a simnet catalogue.
  const mainnet = await onRequest({
    request: new Request('https://doorstub.test/api/notice', { method: 'POST', body: JSON.stringify({ category: showB.categoryHex, seat: ticket.seatHex }) }),
    env: { ...env, DOORSTUB_NETWORK: undefined },
  });
  assert.equal(mainnet.status, 500);
  assert.equal((await mainnet.json()).error.code, 'wrong-network');

  // The cron pass refunds the seat (the page did not), from shows.json at SHOWS_URL.
  const report = await runCron(
    { ...env, ASSETS: undefined, SHOWS_URL: 'https://doorstub.test/shows.json' },
    { fetchImpl: async (url) => (url === 'https://doorstub.test/shows.json' ? new Response(ctx.showsText) : new Response('', { status: 404 })), log: () => {} },
  );
  const b = report.shows.find((s) => s.id === showB.id);
  assert.deepEqual(b.actions.map((a) => [a.path, a.scope, a.status, a.vm]), [['refund', 'R', 'sent', 'not-available']]);
  assert.deepEqual(await unspentAt(ctx.rpc, showB.contracts.escrow.lockingBytecode), []);
  await assert.rejects(runCron({ ...env, SHOWS_URL: 'http://example.invalid/shows.json' }), /SHOWS_URL/);

  // The scheduled handler hands its work to waitUntil.
  const waited = [];
  t.mock.method(console, 'log', () => {});
  await cron.scheduled({}, { ...env, SHOWS_URL: 'not a url' }, { waitUntil: (p) => waited.push(p) });
  assert.equal(waited.length, 1);
  await waited[0];
});

test('Node adapter: the site, shows.json and /api/* on one origin (as Pages serves them), CORS only when asked', async (t) => {
  const ctx = await workerSimnet(t, { name: 'node-origin' });
  const [showB] = ctx.byKind('sample-refund-seat');
  const site = join(ctx.dir, 'site');
  mkdirSync(join(site, 'assets'), { recursive: true });
  writeFileSync(join(site, 'index.html'), '<!doctype html><title>Doorstub</title>');
  writeFileSync(join(site, 'assets', 'app.js'), 'export {};');
  writeFileSync(join(site, 'shows.json'), '{"stale":true}');
  const server = await startWorker(t, ctx, { staticRoot: site, cors: true, htmlHeaders: { 'content-security-policy': "default-src 'self'" } });

  const home = await fetch(`${server.url}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
  assert.equal(home.headers.get('content-security-policy'), "default-src 'self'");
  assert.match(await home.text(), /Doorstub/);
  const script = await fetch(`${server.url}/assets/app.js`);
  assert.match(script.headers.get('content-type'), /javascript/);
  assert.equal(script.headers.get('content-security-policy'), null);
  assert.match(await (await fetch(`${server.url}/tickets`)).text(), /Doorstub/, 'unknown paths fall back to the page');
  assert.equal((await fetch(`${server.url}/..%2f..%2fpackage.json`)).status, 403, 'nothing outside the site directory');
  assert.equal((await fetch(`${server.url}/`, { method: 'POST' })).status, 405);

  const shows = await fetch(`${server.url}/shows.json`);
  assert.equal(await shows.text(), ctx.showsText, 'shows.json is the catalogue the worker reads, not a stale copy in the site');

  const ticket = await buyTicket(ctx.rpc, showB);
  const notice = await fetch(`${server.url}/api/notice`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:5173' }, body: JSON.stringify({ category: showB.categoryHex, seat: ticket.seatHex }) });
  assert.equal(notice.status, 200);
  assert.equal(notice.headers.get('access-control-allow-origin'), '*');
  const preflight = await fetch(`${server.url}/api/notice`, { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);

  // In process, without a server: a fetch-compatible function (what an app test hands its API client).
  const inProcess = createNodeWorker({ env: { DOORSTUB_NETWORK: 'simnet', DOORSTUB_FULCRUM: ctx.simnet.url, STUDIO_DATA_KEY: ctx.dataKeyHex }, showsText: () => ctx.showsText, markerWaitMs: 0 });
  const direct = await inProcess.fetch('http://worker.test/api/notice', { method: 'POST', body: JSON.stringify({ category: showB.categoryHex, seat: ticket.seatHex }) });
  assert.equal(direct.status, 200);
  assert.equal((await direct.json()).signature, (await notice.clone().json()).signature, 'the same notice in process and over HTTP');

  const plain = await startWorker(t, ctx);
  const apiOnly = await fetch(`${plain.url}/`);
  assert.equal(apiOnly.status, 404);
  assert.equal((await fetch(`${plain.url}/api/health`)).headers.get('access-control-allow-origin'), null, 'no CORS unless asked');
});
