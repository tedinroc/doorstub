// POST /api/notice on simnet, through the Node adapter (same handlers as
// Pages Functions): the signer signs 'R' | category | seat only for a live
// marker of sample show B, the signature verifies with src/tx, and the refund
// built from it is accepted by the simnet. Everything else is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { binToHex, hexToBin } from '@bitauth/libauth';
import { buildRefund, verifyRefundNotice } from '../../src/tx/index.js';
import { checkSignatureFree, createFulcrumPool } from '../../src/chain/index.js';
import { addNotices, seatNotice } from '../../src/shows/index.js';
import { freshKey } from '../helpers.js';
import { buyTicket, get, post, startWorker, tipOf, unspentAt, workerSimnet } from './support.js';

test('notice signer: live B seats only, verifiable, refund accepted by the simnet; every other request refused', async (t) => {
  const ctx = await workerSimnet(t, { name: 'notice', schedule: [{ id: 'real-show', kind: 'real', title: 'Real show', card: 'A real show.', startHeight: '+300', eventAt: '2026-11-24T13:00:00Z', durationMin: 25, seatPrefix: 'R' }] });
  const [showA] = ctx.byKind('sample-settle');
  const [showB] = ctx.byKind('sample-refund-seat');
  const [real] = ctx.byKind('real');
  const worker = await startWorker(t, ctx);

  // Health says what is configured.
  const health = await get(worker, '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.network, 'simnet');
  assert.equal(health.body.chain.tip, await tipOf(ctx.rpc));
  assert.deepEqual(health.body.signer, { configured: true, shows: [{ id: showB.id, keyMatches: true }], alsoKeyOf: [] }, 'a real show has its own data key, which the worker never holds');
  assert.notEqual(binToHex(real.organiserDataPk), binToHex(showB.organiserDataPk));
  assert.equal(health.body.runtime, 'node');

  // A buy of sample B, still in the mempool.
  const ticket = await buyTicket(ctx.rpc, showB);
  const ask = (body) => post(worker, '/api/notice', body);
  const first = await ask({ category: showB.categoryHex, seat: ticket.seatHex });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.scope, 'R');
  assert.equal(first.body.show, showB.id);
  assert.equal(first.body.seatLabel, 'B-0-1');
  assert.deepEqual(first.body.marker, { txid: ticket.txid, vout: 2, height: 0 });
  const again = await ask({ category: showB.categoryHex, seat: ticket.seatHex });
  assert.equal(again.body.signature, first.body.signature, 'idempotent: the same notice, the same signature');
  const viaTxid = await ask({ category: showB.categoryHex, seat: ticket.seatHex, txid: ticket.txid });
  assert.equal(viaTxid.body.signature, first.body.signature, 'found through the buy txid too');

  // The app side: src/shows takes the notice, src/tx verifies it and builds the refund, the simnet accepts it.
  const notice = { scope: 'R', seat: hexToBin(first.body.seat), signature: hexToBin(first.body.signature) };
  assert.equal(verifyRefundNotice({ show: showB, notice }), true);
  const { added } = addNotices(showB, [{ scope: 'R', seat: first.body.seat, signature: first.body.signature }]);
  assert.equal(added.length, 1);
  const refund = buildRefund({ show: showB, escrowUtxos: [ticket.escrowUtxo], notices: [seatNotice(showB, ticket.seat)], contracts: showB.contracts });
  const pool = createFulcrumPool({ network: 'simnet', servers: [ctx.simnet.url], allowBroadcast: true, pingIntervalMs: 0 });
  t.after(() => pool.close());
  const sent = await pool.broadcastChecked(checkSignatureFree(refund));
  assert.deepEqual(sent.acceptedBy, [ctx.simnet.url]);
  assert.deepEqual(await unspentAt(ctx.rpc, showB.contracts.escrow.lockingBytecode), [], 'the seat\'s money left the contract');
  const back = (await unspentAt(ctx.rpc, refund.transaction.outputs[0].lockingBytecode)).find((u) => u.output.token === undefined && binToHex(u.txid) === sent.txid);
  assert.ok(back.output.valueSatoshis >= showB.price + 1_000n - showB.minerFeeCap, 'the buyer got the price back less the network fee');

  // Once the coin is refunded the seat has no live marker: without the buy's txid the signer says so.
  const after = await ask({ category: showB.categoryHex, seat: ticket.seatHex });
  assert.equal(after.status, 404);
  assert.equal(after.body.error.code, 'no-live-marker');
  assert.equal(after.body.error.retryable, true);
  // With the buy's txid it signs from the buy alone (RUNTIME.md section 5: "a seat whose buy the network knows"),
  // the same notice as before; it opens nothing, since the coin is gone and seat numbers never repeat.
  const late = await ask({ category: showB.categoryHex, seat: ticket.seatHex, txid: ticket.txid });
  assert.equal(late.status, 200);
  assert.equal(late.body.signature, first.body.signature);

  // Refusals.
  const a = await buyTicket(ctx.rpc, showA);
  const r = await buyTicket(ctx.rpc, real);
  const cases = [
    [{ category: showA.categoryHex, seat: a.seatHex }, 403, 'not-a-refund-seat-show'],
    [{ category: real.categoryHex, seat: r.seatHex }, 403, 'not-a-refund-seat-show'],
    [{ category: '11'.repeat(32), seat: '000100' }, 404, 'unknown-show'],
    [{ category: showB.categoryHex, seat: '000900' }, 404, 'no-live-marker'],
    [{ category: showB.categoryHex, seat: a.seatHex, txid: a.txid }, 404, 'no-live-marker'],
    [{ category: showB.categoryHex, scope: 'C' }, 400, 'seat-notices-only'],
    [{ category: showB.categoryHex, seat: ticket.seatHex, scope: 'C' }, 400, 'seat-notices-only'],
    [{ category: showB.categoryHex, seat: '0001' }, 400, 'bad-request'],
    [{ category: 'zz', seat: '000100' }, 400, 'bad-request'],
    ['not json', 400, 'bad-request'],
    [{ category: showB.categoryHex, seat: '000100', pad: 'x'.repeat(3_000) }, 413, 'too-large'],
  ];
  for (const [body, status, code] of cases) {
    const res = await ask(body);
    assert.equal(res.status, status, `${JSON.stringify(body).slice(0, 80)} -> ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error.code, code);
  }
  assert.equal((await get(worker, '/api/notice')).status, 405);
  assert.equal((await get(worker, '/api/nope')).status, 404);

  // A seat bought by someone else is refunded to that buyer only: the notice cannot redirect money.
  const stranger = await buyTicket(ctx.rpc, showB, { key: freshKey() });
  const theirs = await ask({ category: showB.categoryHex, seat: stranger.seatHex });
  assert.equal(theirs.status, 200);
  const strangerRefund = buildRefund({ show: showB, escrowUtxos: [stranger.escrowUtxo], notices: [{ scope: 'R', seat: stranger.seat, signature: hexToBin(theirs.body.signature) }], contracts: showB.contracts });
  assert.equal(binToHex(strangerRefund.transaction.outputs[0].lockingBytecode.slice(3, 23)), binToHex(stranger.key.pkh));
  // ... and that seat's notice does not open any other seat's coin.
  const other = await buyTicket(ctx.rpc, showB);
  assert.throws(() =>
    checkSignatureFree(buildRefund({ show: showB, escrowUtxos: [other.escrowUtxo], notices: [{ scope: 'R', seat: other.seat, signature: hexToBin(theirs.body.signature) }], contracts: showB.contracts })),
  );
});

test('notice signer: missing or wrong key, and the per-IP rate limit', async (t) => {
  const ctx = await workerSimnet(t, { name: 'notice-config' });
  const [showB] = ctx.byKind('sample-refund-seat');
  const ticket = await buyTicket(ctx.rpc, showB);
  const body = { category: showB.categoryHex, seat: ticket.seatHex };

  const keyless = await startWorker(t, ctx, { env: { STUDIO_DATA_KEY: '' } });
  const none = await post(keyless, '/api/notice', body);
  assert.equal(none.status, 503);
  assert.equal(none.body.error.code, 'signer-not-configured');
  assert.equal((await get(keyless, '/api/health')).body.signer.configured, false);

  const wrong = await startWorker(t, ctx, { env: { STUDIO_DATA_KEY: binToHex(freshKey().privateKey) } });
  const mismatch = await post(wrong, '/api/notice', body);
  assert.equal(mismatch.status, 503);
  assert.equal(mismatch.body.error.code, 'signer-key-mismatch');

  const limited = await startWorker(t, ctx, { limits: { notice: { max: 3, windowMs: 60_000 } } });
  for (let i = 0; i < 3; i += 1) assert.equal((await post(limited, '/api/notice', body)).status, 200);
  const blocked = await post(limited, '/api/notice', body);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error.code, 'rate-limited');
});
