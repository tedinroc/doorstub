// The Cloudflare adapters, run in Node against the simnet with Cloudflare's
// calling conventions: the Pages Functions route (context.request, env with
// ASSETS serving shows.json) and the cron Worker's pass (SHOWS_URL fetched).
// Neither has the libauth VM (as in workerd); the worker's rule check guards
// what they build, and the simnet runs the VM on every broadcast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hexToBin } from '@bitauth/libauth';
import { verifyRefundNotice } from '../../src/tx/index.js';
import { onRequest } from '../../functions/api/[[route]].js';
import cron, { runCron } from '../../worker/cron.js';
import { buyTicket, unspentAt, workerSimnet } from './support.js';

test('Pages Functions route and cron Worker, on simnet', async (t) => {
  const ctx = await workerSimnet(t, { name: 'adapters' });
  const [showB] = ctx.byKind('sample-refund-seat');
  const env = {
    DOORSTUB_NETWORK: 'simnet',
    DOORSTUB_FULCRUM: ctx.simnet.url,
    STUDIO_DATA_KEY: ctx.dataKeyHex,
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

  const ticket = await buyTicket(ctx.rpc, showB);
  const notice = await call('/api/notice', { method: 'POST', body: JSON.stringify({ category: showB.categoryHex, seat: ticket.seatHex, txid: ticket.txid }), headers: { 'cf-connecting-ip': '203.0.113.7' } });
  assert.equal(notice.status, 200, JSON.stringify(notice.body));
  assert.equal(verifyRefundNotice({ show: showB, notice: { scope: 'R', seat: ticket.seat, signature: hexToBin(notice.body.signature) } }), true);

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
