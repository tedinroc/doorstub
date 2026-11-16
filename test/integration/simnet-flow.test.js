// The two halves together, on simnet, with no internet.
//
// The studio (keygen, plan, genesis with BCMR) makes a small catalogue and
// writes shows.json. src/shows loads it and verifies every genesis from the
// chain. The sim wallet pairs through the real WizardConnect dapp manager (in
// process), gets funded, and buys with src/wallet coin selection; its signed
// reply is checked and src/chain broadcasts it to the simnet. src/chain then
// finds the ticket. After that: a hand-back signed by the wallet, a second
// ticket settled by the keeper path once the show has started (refused one
// block early by the simnet's finality rule), a sample B seat refunded under
// an R notice signed with the studio's data key, and "My tickets" and the
// proof strip read back from the chain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { binToHex, hexToBin } from '@bitauth/libauth';
import { startSimnet } from '../../simnet/index.js';
import { bootstrapSimnet, status as studioStatus, validateShowsJson } from '../../studio/index.js';
import {
  BroadcastError,
  checkSignatureFree,
  createFulcrumPool,
  discoverTickets,
  fetchLedgers,
  fetchShowLedger,
  liveEscrowUtxos,
  listUnspent,
  summariseLedgers,
} from '../../src/chain/index.js';
import { addNotices, parseShowsFile, promptForBuilt, seatNotice, settleOpensAt, showPhase, showToJson, showsOnSale, verifyShows } from '../../src/shows/index.js';
import {
  assertSignedReply,
  buildBuyWithCoins,
  buildSignRequest,
  createWalletSession,
  memoryStorage,
  pathLookup,
  scanWallet,
} from '../../src/wallet/index.js';
import {
  buildHandBack,
  buildRefund,
  buildSettle,
  decodeBoxOfficeCommitment,
  decodeSeat,
  encodeRefundNoticeMessage,
  sameBytes,
} from '../../src/tx/index.js';
import { signDataMessage } from '../../src/tx/sign.js';
import { makeSimWallet } from '../support/sim-wallet.js';
import { scratchDir } from '../simnet/support.js';

const waitFor = async (predicate, what, ms = 5_000) => {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** Open shards of a show at its BoxOffice, read from the chain. */
const openShards = async (pool, show) =>
  (await listUnspent(pool, show.contracts.boxOffice.lockingBytecode))
    .filter((u) => u.output.token?.nft?.capability === 'minting' && sameBytes(u.output.token.category, show.category))
    .filter((u) => decodeBoxOfficeCommitment(u.output.token.nft.commitment).open)
    .sort((a, b) => a.output.token.nft.commitment[1] - b.output.token.nft.commitment[1]);

test('simnet: studio catalogue -> shows.json -> wallet buy -> ticket found -> hand back, settle, notice refund', async (t) => {
  const simnet = await startSimnet({ port: 0, seed: 'integration', height: 977_600 });
  t.after(() => simnet.close());
  const scratch = scratchDir('integration');
  t.after(scratch.cleanup);

  // ---------------------------------------------------------------- studio
  const boot = await bootstrapSimnet({ server: simnet.url, dir: scratch.dir, count: 2, firstStart: '+36', refundSeatStart: '+6500' });
  assert.equal(boot.genesis.sent.length, 6, 'three prep and three genesis transactions sent');

  // ---------------------------------------------------------------- src/shows reads what the studio wrote
  const file = parseShowsFile(readFileSync(boot.showsPath, 'utf8'), { network: 'simnet' });
  assert.deepEqual(file.rejected, [], 'every studio show passes the loader (derived fields recomputed and equal)');
  assert.equal(file.shows.length, 3);
  assert.equal(file.origin, 'https://doorstub.pages.dev');
  assert.throws(() => parseShowsFile(readFileSync(boot.showsPath, 'utf8'), { network: 'mainnet' }), (e) => e.code === 'wrong-network');
  // Both writers agree: src/shows' showToJson gives back the studio's entries byte for byte, and the studio's validator takes them.
  const written = JSON.parse(readFileSync(boot.showsPath, 'utf8'));
  const rewritten = file.shows.map((show) => showToJson(show, { network: 'simnet' }));
  assert.deepEqual(rewritten, written.shows);
  validateShowsJson({ ...written, shows: rewritten });

  const pool = createFulcrumPool({ network: 'simnet', servers: [simnet.url], allowBroadcast: true, pingIntervalMs: 0 });
  t.after(() => pool.close());
  const tips = [];
  pool.subscribeHeaders((header) => tips.push(header.height));

  const { verified, failed } = await verifyShows(pool, file.shows);
  assert.deepEqual(failed.map((f) => f.message), [], 'every genesis verifies from the chain');
  assert.equal(verified.length, 3);
  for (const show of verified) {
    assert.ok(show.genesis.height > 0, `${show.id}: genesis confirmed`);
    // The studio's genesis puts the BCMR identity coin at output 0, so the shards are outputs 1..N.
    assert.deepEqual(show.genesis.shards.map((s) => s.vout), [1, 2, 3, 4], `${show.id}: shards after the identity output`);
  }

  let tip = (await pool.tip()).height;
  const onSale = showsOnSale(verified, tip);
  assert.deepEqual(onSale.map((s) => s.kind), ['sample-settle', 'sample-refund-seat'], 'the next sample A instance and sample B are on sale');
  const [showA, showB] = onSale;
  assert.equal(showA.startHeight, Math.min(...verified.filter((s) => s.kind === 'sample-settle').map((s) => s.startHeight)));

  // ---------------------------------------------------------------- wallet: pair (real dapp manager, in process) and fund
  const wallet = makeSimWallet();
  const session = createWalletSession({ initiateRelay: wallet.inProcessRelay(), storage: memoryStorage(), dappIcon: 'https://doorstub.pages.dev/icon.png' });
  t.after(() => session.disconnect());
  await session.pair();
  await waitFor(() => session.state === 'connected', 'wallet_ready');
  const keys = session.wallet.keys;

  // A small coin at receive 0 and the coin that pays at change 2 (the scan must look past the gap).
  await pool.request('simnet.fund', { address: wallet.addressAt('receive', 0).address, sats: 30_000, mine: true });
  await pool.request('simnet.fund', { address: wallet.addressAt('change', 2).address, sats: 400_000, mine: true });
  const funded = 430_000n;

  let scan = await scanWallet({ pool, keys, network: 'simnet' });
  assert.equal(scan.balance, funded);
  assert.deepEqual([scan.receive.index, scan.change.index], [1, 3], 'first unused receive and change addresses');

  /** Ask the wallet to sign a builder result, check its reply, broadcast it through the pool. */
  const signCheckSend = async (show, built, addresses) => {
    const request = buildSignRequest(built, { pathOf: pathLookup(addresses), userPrompt: promptForBuilt(show, built) });
    const signedHex = await session.sign(request);
    const checked = assertSignedReply(built, signedHex);
    const sent = await pool.broadcastChecked(checked);
    assert.equal(sent.txid, checked.txid);
    assert.deepEqual(sent.acceptedBy, [simnet.url]);
    return { request, checked, sent };
  };

  /** Build and send a buy from the wallet's current coins on the given shard. */
  const buy = async (show, shardIndex) => {
    tip = (await pool.tip()).height;
    const shard = (await openShards(pool, show))[shardIndex];
    scan = await scanWallet({ pool, keys, network: 'simnet' });
    const { built, selected } = buildBuyWithCoins({
      show,
      boxOfficeUtxo: shard,
      coins: scan.utxos,
      buyerPkh: scan.receive.pkh,
      currentHeight: tip,
      notices: show.notices,
      changeLockingBytecode: scan.change.lockingBytecode,
      contracts: show.contracts,
    });
    const result = await signCheckSend(show, built, scan.addresses);
    return { ...result, built, selected, buyer: scan.receive };
  };

  // ---------------------------------------------------------------- buy sample A
  const escrowStatus = [];
  pool.subscribeScripthash(showA.derived.escrowScripthash, (status) => escrowStatus.push(status));
  await waitFor(() => escrowStatus.length === 1, 'escrow subscription');

  const first = await buy(showA, 0);
  assert.equal(first.selected.length, 1, 'one coin pays');
  assert.equal(first.selected[0].path, 'change');
  assert.equal(first.selected[0].index, 2, 'the 400,000-sat coin, not the 30,000-sat one');
  assert.deepEqual(first.request.inputPaths, [[1, 'change', 2]]);
  assert.equal(first.request.transaction.broadcast, false);
  assert.match(wallet.log.at(-1).userPrompt, /^Doorstub: buy seat A-0-1 for 0\.001 BCH\. The money waits in the show's contract\.$/);
  assert.equal(wallet.log.at(-1).outcome, 'signed');
  await waitFor(() => escrowStatus.length === 2 && escrowStatus[1] !== null, 'escrow status notification after the buy');

  // ---------------------------------------------------------------- the ticket, found from the chain at 0-conf
  scan = await scanWallet({ pool, keys, network: 'simnet' });
  let tickets = await discoverTickets({ pool, shows: verified, walletAddresses: scan.used });
  assert.equal(tickets.length, 1);
  const [held] = tickets;
  assert.equal(held.showId, showA.id);
  assert.equal(held.state, 'held');
  assert.equal(held.canAct, true, 'ticket at the buyer\'s own address next to a live escrow coin');
  assert.equal(held.seatHex, binToHex(first.built.seat));
  assert.deepEqual(decodeSeat(held.seat), { shard: 0, sold: 1 });
  assert.equal(held.buyerPkhHex, binToHex(first.buyer.pkh));
  assert.equal(held.buy.txid, first.sent.txid);
  assert.equal(held.buy.height, 0, 'still in the mempool');
  assert.equal(held.escrowUtxo.output.valueSatoshis, showA.price + 1_000n);
  assert.ok(sameBytes(held.ticketUtxo.output.lockingBytecode, first.buyer.lockingBytecode));

  // ---------------------------------------------------------------- hand it back (0-conf chain on the buy)
  const handBack = buildHandBack({ show: showA, escrowUtxo: held.escrowUtxo, ticketUtxo: held.ticketUtxo, contracts: showA.contracts });
  const back = await signCheckSend(showA, handBack, scan.addresses);
  assert.match(wallet.log.at(-1).userPrompt, /^Doorstub: hand back seat A-0-1\. 0\.00\d+ BCH comes back to this wallet\.$/);
  assert.deepEqual(back.request.inputPaths, [[1, 'receive', first.buyer.index]], 'the wallet signs only its ticket');

  // ---------------------------------------------------------------- a second sample A ticket (another shard) and a sample B ticket
  const second = await buy(showA, 1);
  assert.deepEqual(decodeSeat(second.built.seat), { shard: 1, sold: 1 });
  const third = await buy(showB, 0);
  assert.match(wallet.log.at(-1).userPrompt, /^Doorstub: buy seat B-0-1 /);

  // Sample B: the organiser refunds the seat with an 'R' notice signed by the studio data key (the worker's job).
  const studioSecrets = JSON.parse(readFileSync(boot.secretsPath, 'utf8'));
  const signature = signDataMessage(hexToBin(studioSecrets.data.privateKey), encodeRefundNoticeMessage({ scope: 'R', category: showB.category, seat: third.built.seat }));
  const { added, invalid } = addNotices(showB, [{ scope: 'R', seat: binToHex(third.built.seat), signature: binToHex(signature) }]);
  assert.deepEqual([added.length, invalid.length], [1, 0], 'the notice verifies against organiserDataPk from shows.json');
  assert.equal(showB.cancelled, false, 'an R notice does not close sales');
  const ledgerB = await fetchShowLedger(pool, showB, { contracts: showB.contracts });
  const coinB = ledgerB.bySeat.get(binToHex(third.built.seat));
  const refund = buildRefund({ show: showB, escrowUtxos: [coinB.utxo], notices: [seatNotice(showB, third.built.seat)], contracts: showB.contracts });
  const refundSent = await pool.broadcastChecked(checkSignatureFree(refund));

  // ---------------------------------------------------------------- the keeper settles sample A after its start
  tip = (await pool.tip()).height;
  const early = settleOpensAt(showA) - 2 - tip;
  assert.ok(early > 0);
  await pool.request('simnet.mine', { blocks: early });
  await waitFor(() => tips.at(-1) === tip + early, 'header notification');
  tip += early;
  assert.equal(showPhase(showA, tip), 'started');
  const ledgerA = await fetchShowLedger(pool, showA, { contracts: showA.contracts });
  assert.equal(ledgerA.live.length, 1, 'one live escrow coin: the hand-back burned the other');
  const settle = buildSettle({ show: showA, escrowUtxos: liveEscrowUtxos(ledgerA), contracts: showA.contracts });
  const settleChecked = checkSignatureFree(settle);
  await assert.rejects(
    pool.broadcastChecked(settleChecked),
    (e) => e instanceof BroadcastError && e.code === 'refused' && /non-final/.test(e.message) && e.conflict === false,
    'one block early the simnet refuses the settle as non-final, and the pool reports its words',
  );
  await pool.request('simnet.mine', { blocks: 1 });
  tip += 1;
  assert.equal(showPhase(showA, tip), 'settling');
  // A mainnet pool pointed at the simnet by mistake refuses to send anything there (and vice versa, see test/chain/pool.test.js).
  const misconfigured = createFulcrumPool({ network: 'mainnet', servers: [simnet.url], allowBroadcast: true, pingIntervalMs: 0 });
  await assert.rejects(misconfigured.broadcastChecked(settleChecked), (e) => e.code === 'wrong-chain');
  misconfigured.close();
  const settleSent = await pool.broadcastChecked(settleChecked);
  assert.deepEqual(settleSent.acceptedBy, [simnet.url]);

  // ---------------------------------------------------------------- My tickets and the proof strip, from the chain
  await pool.request('simnet.mine', { blocks: 1 });
  scan = await scanWallet({ pool, keys, network: 'simnet' });
  tickets = await discoverTickets({ pool, shows: verified, walletAddresses: scan.used });
  const byState = Object.fromEntries(tickets.map((x) => [`${x.showId}:${x.state}`, x]));
  assert.equal(tickets.length, 3);
  assert.equal(byState[`${showA.id}:handedBack`].spend.txid, back.sent.txid);
  assert.equal(byState[`${showA.id}:handedBack`].ticketUtxo, null, 'hand-back burned the ticket');
  assert.equal(byState[`${showA.id}:refunded`].refundPath, 'settle');
  assert.equal(byState[`${showA.id}:refunded`].spend.txid, settleSent.txid);
  assert.notEqual(byState[`${showA.id}:refunded`].ticketUtxo, null, 'a settled ticket stays in the wallet');
  assert.equal(byState[`${showB.id}:refunded`].refundPath, 'refund');
  assert.equal(byState[`${showB.id}:refunded`].spend.txid, refundSent.txid);
  for (const ticket of tickets) {
    assert.ok(ticket.buy.height > 0 && ticket.spend.height > 0, `${ticket.showId}: buy and spend confirmed`);
    assert.equal(ticket.canAct, false);
  }

  const strip = summariseLedgers([...(await fetchLedgers(pool, verified)).values()]);
  assert.deepEqual(strip.txCounts, { buy: 3, handBack: 1, checkIn: 0, settle: 1, refund: 1 });
  assert.deepEqual(strip.seatCounts, { sold: 3, held: 0, handedBack: 1, walkedIn: 0, refunded: 2 });
  assert.equal(strip.latest.settle.txid, settleSent.txid);
  assert.equal(strip.latest.refund.txid, refundSent.txid);

  // The studio's own status (its own classifier, input by input) agrees with the ledgers.
  const report = await studioStatus({ showsPath: boot.showsPath, network: 'simnet', server: simnet.url, print: () => {} });
  const rowOf = (show) => report.rows.find((r) => r.id === show.id);
  assert.deepEqual(
    [showA, showB].map((show) => {
      const r = rowOf(show);
      return [r.sold, r.buy, r.handBack, r.checkIn, r.settle + r.refund, r.escrowCoins, r.genesis.startsWith('confirmed')];
    }),
    [
      [2, 2, 1, 0, 1, 0, true],
      [1, 1, 0, 0, 1, 0, true],
    ],
  );

  // Every ticket's money came back, less miner fees and the 1,000 sats in each ticket NFT still in the wallet.
  const tokenSats = scan.tokenCoins.reduce((sum, u) => sum + u.output.valueSatoshis, 0n);
  assert.equal(scan.tokenCoins.length, 2, 'the settled and refunded tickets stay as keepsakes');
  const lost = funded - scan.balance - tokenSats;
  assert.ok(lost > 0n && lost <= 3n * BigInt(showA.minerFeeCap) + 3n * 1_000n, `lost only fees: ${lost} sats`);
});
