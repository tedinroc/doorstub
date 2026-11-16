// The keeper on simnet: it refunds sample show B seats at once (fresh 'R'
// notices), settles nothing before startHeight + graceBlocks and everything
// after, batches more than 100 coins with fee-owing coins first, spends only
// the show's marker coins, and does nothing on a second pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { binToHex, decodeTransaction, hexToBin } from '@bitauth/libauth';
import { createFulcrumPool, fetchShowLedger } from '../../src/chain/index.js';
import { encodeMarkerCommitment, encodeSeat, p2pkhLockingBytecode, sameBytes } from '../../src/tx/index.js';
import { freshKey, randomTxid } from '../helpers.js';
import { createWorkerChain } from '../../worker/lib/chain.js';
import { runKeeper, summariseKeeperReport } from '../../worker/lib/keeper.js';
import { parseWorkerShows } from '../../worker/lib/shows.js';
import { libauthVmCheck } from '../../worker/node/vm.js';
import { buyTicket, tipOf, unspentAt, workerSimnet } from './support.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('keeper: B refunds now, A settles at start + grace (not before), 130 coins in two batches with fee coins first, idempotent', async (t) => {
  const ctx = await workerSimnet(t, {
    name: 'keeper',
    firstStart: '+20',
    schedule: [{ id: 'fee-show', kind: 'real', title: 'Fee show', card: 'A show with a no-show fee.', startHeight: '+30', price: 10_000, noShowFeeBps: 100, graceBlocks: 2 }],
  });
  const { shows } = parseWorkerShows(ctx.showsText, { network: 'simnet' });
  const [showA] = ctx.byKind('sample-settle');
  const [showB] = ctx.byKind('sample-refund-seat');
  const feeShow = ctx.shows.find((s) => s.id === 'fee-show');
  const dataKey = hexToBin(ctx.dataKeyHex);
  const keeper = async (options = {}) => {
    const chain = createWorkerChain({ network: 'simnet', servers: [ctx.simnet.url] });
    try {
      return await runKeeper({ shows, chain, dataKey, vmCheck: libauthVmCheck, ...options });
    } finally {
      chain.close();
    }
  };
  const entry = (report, show) => report.shows.find((s) => s.id === show.id);
  const sentTxids = [];
  const collect = (report) => {
    for (const s of report.shows) for (const a of s.actions) if (a.status === 'sent') sentTxids.push({ show: s.id, txid: a.txid, path: a.path });
    return report;
  };

  // Two A tickets and one B ticket, in the mempool.
  const a1 = await buyTicket(ctx.rpc, showA);
  const a2 = await buyTicket(ctx.rpc, showA, { shard: 2 });
  const b1 = await buyTicket(ctx.rpc, showB);
  // Things at A's Escrow that are not markers of A: a look-alike of another category, and a plain coin.
  const lookAlike = encodeMarkerCommitment(Uint8Array.of(0, 9, 0), freshKey().pkh);
  await ctx.rpc.request('simnet.fund', {
    lockingBytecode: binToHex(showA.contracts.escrow.lockingBytecode),
    sats: 101_000,
    token: { category: binToHex(randomTxid()), amount: '0', nft: { capability: 'none', commitment: binToHex(lookAlike) } },
  });
  await ctx.rpc.request('simnet.fund', { lockingBytecode: binToHex(showA.contracts.escrow.lockingBytecode), sats: 50_000 });
  // 130 marker coins at the fee show's Escrow; every fifth holds 100,000 sats and owes the 1% no-show fee (1,000 sats).
  const buyers = [];
  for (let i = 0; i < 130; i += 1) {
    const pkh = freshKey().pkh;
    buyers.push(pkh);
    await ctx.rpc.request('simnet.fund', {
      lockingBytecode: binToHex(feeShow.contracts.escrow.lockingBytecode),
      sats: i % 5 === 0 ? 100_000 : 11_000,
      token: { category: feeShow.categoryHex, amount: '0', nft: { capability: 'none', commitment: binToHex(encodeMarkerCommitment(encodeSeat({ shard: i % 4, sold: i + 1 }), pkh)) } },
    });
  }
  await ctx.rpc.request('simnet.mine', { blocks: 1 });

  // ---------------------------------------------------------------- pass 1: sales open
  const first = collect(await keeper());
  assert.deepEqual(first.errors, []);
  assert.deepEqual(entry(first, showB).actions.map((a) => [a.path, a.scope, a.coins, a.status, a.vm]), [['refund', 'R', 1, 'sent', 'ok']]);
  assert.equal(entry(first, showA).phase, 'on-sale');
  assert.equal(entry(first, showA).liveCoins, 2);
  assert.equal(entry(first, showA).ignored, 2, 'the look-alike and the plain coin are not A\'s');
  assert.equal(entry(first, showA).waiting, 'sales-open');
  assert.deepEqual(entry(first, showA).actions, []);
  assert.equal(entry(first, feeShow).liveCoins, 130);
  assert.deepEqual(await unspentAt(ctx.rpc, showB.contracts.escrow.lockingBytecode), [], 'B\'s seat was refunded');
  const refundTx = decodeTransaction(hexToBin(await ctx.rpc.request('blockchain.transaction.get', [entry(first, showB).actions[0].txid])));
  assert.ok(sameBytes(refundTx.outputs[0].lockingBytecode, p2pkhLockingBytecode(b1.key.pkh)), 'to B\'s buyer');

  const second = collect(await keeper());
  assert.equal(second.sent, 0, 'nothing left to do');
  assert.equal(entry(second, showB).liveCoins, 0);

  // ---------------------------------------------------------------- A: started, not yet settleable
  const opens = showA.startHeight + showA.graceBlocks;
  await ctx.rpc.request('simnet.mine', { blocks: opens - 1 - (await tipOf(ctx.rpc)) });
  const grace = collect(await keeper());
  assert.equal(entry(grace, showA).phase, 'started');
  assert.equal(entry(grace, showA).waiting, 'grace');
  assert.equal(grace.sent, 0);

  // A dry run at the opening block builds and checks but sends nothing.
  await ctx.rpc.request('simnet.mine', { blocks: 1 });
  assert.equal(await tipOf(ctx.rpc), opens);
  const dry = await keeper({ dryRun: true });
  assert.deepEqual(entry(dry, showA).actions.map((a) => [a.path, a.coins, a.status]), [['settle', 2, 'dry-run']]);
  assert.equal((await unspentAt(ctx.rpc, showA.contracts.escrow.lockingBytecode)).length, 4);

  const settle = collect(await keeper());
  assert.deepEqual(entry(settle, showA).actions.map((a) => [a.path, a.coins, a.status, a.vm]), [['settle', 2, 'sent', 'ok']]);
  assert.equal(entry(settle, showA).actions[0].txid, entry(dry, showA).actions[0].txid, 'the dry run built the same transaction');
  const leftAtA = await unspentAt(ctx.rpc, showA.contracts.escrow.lockingBytecode);
  assert.equal(leftAtA.length, 2, 'only the look-alike and the plain coin stay (no path can spend them)');
  assert.ok(leftAtA.every((u) => u.output.token === undefined || !sameBytes(u.output.token.category, showA.category)));
  const settleTx = decodeTransaction(hexToBin(await ctx.rpc.request('blockchain.transaction.get', [entry(settle, showA).actions[0].txid])));
  assert.deepEqual(
    settleTx.outputs.map((o) => binToHex(o.lockingBytecode)).sort(),
    [a1, a2].map((x) => binToHex(p2pkhLockingBytecode(x.key.pkh))).sort(),
    'each A buyer is paid back',
  );

  // ---------------------------------------------------------------- the fee show: 130 coins, two batches
  const feeOpens = feeShow.startHeight + feeShow.graceBlocks;
  await ctx.rpc.request('simnet.mine', { blocks: feeOpens - (await tipOf(ctx.rpc)) });
  const batches = collect(await keeper());
  assert.deepEqual(batches.errors, []);
  assert.deepEqual(entry(batches, feeShow).actions.map((a) => [a.path, a.coins, a.status]), [['settle', 100, 'sent'], ['settle', 30, 'sent']]);
  const payee = p2pkhLockingBytecode(feeShow.organiserPkh);
  let feesPaid = 0n;
  for (const action of entry(batches, feeShow).actions) {
    const tx = decodeTransaction(hexToBin(await ctx.rpc.request('blockchain.transaction.get', [action.txid])));
    const n = tx.inputs.length;
    const feeOutputs = tx.outputs.slice(n);
    assert.ok(feeOutputs.every((o) => sameBytes(o.lockingBytecode, payee) && o.valueSatoshis === 1_000n), 'every fee output is exactly the posted fee to the organiser');
    feesPaid += feeOutputs.reduce((sum, o) => sum + o.valueSatoshis, 0n);
  }
  assert.equal(feesPaid, 26_000n, '26 coins owed 1,000 sats each');
  assert.equal(entry(batches, feeShow).actions[0].seats.length, 100);

  await ctx.rpc.request('simnet.mine', { blocks: 1 });
  const pool = createFulcrumPool({ network: 'simnet', servers: [ctx.simnet.url], pingIntervalMs: 0 });
  t.after(() => pool.close());
  const ledger = await fetchShowLedger(pool, feeShow, { contracts: feeShow.contracts });
  assert.deepEqual(ledger.seatCounts, { sold: 130, held: 0, handedBack: 0, walkedIn: 0, refunded: 130 });
  assert.equal(ledger.txCounts.settle, 2);

  // Every keeper transaction spent only marker coins of its own show's Escrow.
  for (const { show: id, txid } of sentTxids) {
    const show = ctx.shows.find((s) => s.id === id);
    const tx = decodeTransaction(hexToBin(await ctx.rpc.request('blockchain.transaction.get', [txid])));
    for (const input of tx.inputs) {
      const parent = decodeTransaction(hexToBin(await ctx.rpc.request('blockchain.transaction.get', [binToHex(input.outpointTransactionHash)])));
      const spent = parent.outputs[input.outpointIndex];
      assert.ok(sameBytes(spent.lockingBytecode, show.contracts.escrow.lockingBytecode), `${txid} spends only ${id}'s Escrow`);
      assert.ok(sameBytes(spent.token.category, show.category));
    }
  }
  assert.equal(sentTxids.length, 4, 'B refund, A settle, two fee-show settles');

  // ---------------------------------------------------------------- the CLI, one more pass: nothing to do
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['worker/node/keeper-cli.js', '--fulcrum', ctx.simnet.url, '--shows', ctx.showsPath, '--studio', ctx.boot.secretsPath, '--once', '--json', '--dev-vars', ''],
    { cwd: root, timeout: 30_000 },
  );
  const last = JSON.parse(stdout);
  assert.equal(last.sent, 0);
  assert.deepEqual(last.errors, []);
  assert.ok(last.shows.every((s) => s.liveCoins === 0));
  assert.match(summariseKeeperReport(last), /0 transaction\(s\) sent/);
});
