// Classification of every path from its unlocking bytecode, and a show's
// ledger read from the Escrow address's history: seats, states, counts,
// latest txids, and "My tickets" for a wallet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { binToHex } from '@bitauth/libauth';
import {
  classifyShowTransaction,
  createFulcrumPool,
  discoverTickets,
  fetchLedgers,
  fetchShowLedger,
  findTicketCoins,
  liveEscrowUtxos,
  listUnspent,
  readContractUnlock,
  summariseLedgers,
} from '../../src/chain/index.js';
import { buildSettle, p2pkhLockingBytecode } from '../../src/tx/index.js';
import { freshKey } from '../helpers.js';
import { makeFakeNetwork, makeMiniChain } from '../support/fake-fulcrum.js';
import { makeScenario } from '../support/scenario.js';

const URL_A = 'wss://a.example:50004';
const poolOver = (chain) => {
  const net = makeFakeNetwork();
  net.addServer(URL_A, chain.handler);
  return createFulcrumPool({ network: 'simnet', servers: [URL_A], WebSocketImpl: net.WebSocketImpl, pingIntervalMs: 0 });
};

test('readContractUnlock: selector and arguments of every Escrow path', () => {
  const chain = makeMiniChain();
  const s = makeScenario(assert, chain);
  const sale = s.buy();
  const unlock = (tx, i = 0) => readContractUnlock(tx.inputs[i].unlockingBytecode);

  const buy = unlock(sale.built.transaction);
  assert.deepEqual(buy.redeemScript, s.contracts.boxOffice.redeemScript);
  assert.equal(buy.selector, 0);
  assert.deepEqual(buy.args[0], sale.buyerPkh);

  const hb = unlock(s.handBack(sale).built.transaction);
  assert.equal(hb.selector, 0);
  assert.deepEqual(hb.redeemScript, s.contracts.escrow.redeemScript);
  assert.equal(readContractUnlock(new Uint8Array()), undefined);
  assert.equal(readContractUnlock(Uint8Array.of(0x76, 0xa9)), undefined, 'not push-only');
});

test('classify: buy, handBack, checkIn, settle, refund (R and C), each from its own bytes', () => {
  const chain = makeMiniChain();
  const s = makeScenario(assert, chain, { shards: 2 });
  const classify = (tx) => classifyShowTransaction({ transaction: tx, show: s.show, contracts: s.contracts });
  const sales = [s.buy(), s.buy({ shard: 1 }), s.buy(), s.buy(), s.buy({ shard: 1 })];

  const buy = classify(sales[0].built.transaction);
  assert.equal(buy.path, 'buy');
  assert.equal(buy.created.length, 1);
  assert.equal(buy.created[0].vout, 2);
  assert.equal(buy.created[0].seatHex, sales[0].seatHex);
  assert.deepEqual(buy.created[0].buyerPkh, sales[0].buyerPkh);
  assert.deepEqual(buy.buyerPkh, sales[0].buyerPkh);

  const hb = classify(s.handBack(sales[0]).built.transaction);
  assert.equal(hb.path, 'handBack');
  assert.equal(hb.spends[0].ticketInputIndex, 1);
  assert.deepEqual(hb.spends[0].outpoint, { txid: sales[0].txid, vout: 2 });

  const ci = classify(s.checkIn(sales[1]).built.transaction);
  assert.equal(ci.path, 'checkIn');
  assert.equal(ci.created.length, 0, 'a check-in makes no escrow coin');

  const settle = classify(s.settle([sales[2], sales[3]]).built.transaction);
  assert.equal(settle.path, 'settle');
  assert.equal(settle.spends.length, 2);

  const refundR = classify(s.refund([sales[4]]).built.transaction);
  assert.equal(refundR.path, 'refund');
  assert.equal(refundR.spends[0].scope, 'R');

  const other = makeScenario(assert, chain, { id: 'other' });
  const otherSale = other.buy();
  const refundC = other.refund([otherSale], [other.notice('C')]).built.transaction;
  assert.equal(classifyShowTransaction({ transaction: refundC, show: other.show, contracts: other.contracts }).spends[0].scope, 'C');
  assert.equal(classify(refundC).path, null, 'another show\'s refund touches nothing of this show');
  assert.deepEqual(classify(otherSale.built.transaction).created, [], 'markers of another category do not count');
});

test('ledger: states, counts and latest txids from the Escrow history', async () => {
  const chain = makeMiniChain();
  const s = makeScenario(assert, chain, { shards: 2 });
  const [a, b, c, d, e] = [s.buy(), s.buy({ shard: 1 }), s.buy(), s.buy({ shard: 1 }), s.buy()];
  chain.mine(1);
  const hb = s.handBack(a);
  const ci = s.checkIn(b);
  const st = s.settle([c]);
  chain.mine(1);
  const rf = s.refund([d]);

  const pool = poolOver(chain);
  const ledger = await fetchShowLedger(pool, s.show, { contracts: s.contracts });
  assert.equal(ledger.coins.length, 5);
  const state = (sale) => ledger.bySeat.get(sale.seatHex).state;
  assert.equal(state(a), 'handedBack');
  assert.equal(state(b), 'walkedIn');
  assert.equal(state(c), 'refunded');
  assert.equal(state(d), 'refunded');
  assert.equal(state(e), 'held');
  assert.equal(ledger.bySeat.get(c.seatHex).spend.path, 'settle');
  assert.equal(ledger.bySeat.get(d.seatHex).spend.scope, 'R');
  assert.deepEqual(ledger.txCounts, { buy: 5, handBack: 1, checkIn: 1, settle: 1, refund: 1 });
  assert.deepEqual(ledger.seatCounts, { sold: 5, held: 1, handedBack: 1, walkedIn: 1, refunded: 2 });
  assert.equal(ledger.latest.refund.txid, rf.txid);
  assert.equal(ledger.latest.refund.height, 0, 'unconfirmed');
  assert.equal(ledger.latest.handBack.txid, hb.txid);
  assert.equal(ledger.latest.checkIn.txid, ci.txid);
  assert.equal(ledger.latest.settle.txid, st.txid);
  assert.equal(ledger.latest.buy.txid, e.txid);
  assert.equal(ledger.unknownSpends.length, 0);

  // The one live coin is what the keeper would settle; it rebuilds and passes the VM.
  const live = liveEscrowUtxos(ledger);
  assert.equal(live.length, 1);
  assert.deepEqual(live[0].output, e.escrowUtxo.output);
  assert.deepEqual(live[0].txid, e.escrowUtxo.txid);
  buildSettle({ show: s.show, escrowUtxos: live, contracts: s.contracts });

  const summary = summariseLedgers([ledger]);
  assert.equal(summary.txCounts.buy, 5);
  assert.equal(summary.latest.refund.showId, 'sample-a');
  pool.close();
});

test('ledger: look-alike markers of another category sent to the Escrow are ignored', async () => {
  const chain = makeMiniChain();
  const s = makeScenario(assert, chain);
  const real = s.buy();
  const fakeCategory = crypto.getRandomValues(new Uint8Array(32));
  chain.add({
    version: 2,
    inputs: [{ outpointTransactionHash: fakeCategory, outpointIndex: 0, sequenceNumber: 0, unlockingBytecode: new Uint8Array() }],
    outputs: [{ ...real.escrowUtxo.output, token: { ...real.escrowUtxo.output.token, category: fakeCategory } }],
    locktime: 0,
  });
  const pool = poolOver(chain);
  const ledger = await fetchShowLedger(pool, s.show, { contracts: s.contracts });
  assert.equal(ledger.coins.length, 1);
  assert.equal(ledger.txCounts.buy, 1);
  pool.close();
});

test('myTickets / discoverTickets: every state for one wallet, from the chain', async () => {
  const chain = makeMiniChain();
  const s = makeScenario(assert, chain, { shards: 2 });
  const me = freshKey();
  const someoneElse = freshKey();
  const held = s.buy({ buyer: me });
  const handed = s.buy({ buyer: me, shard: 1 });
  const walked = s.buy({ buyer: me });
  const refunded = s.buy({ buyer: me, shard: 1 });
  const notMine = s.buy({ buyer: someoneElse });
  s.handBack(handed);
  s.checkIn(walked);
  s.settle([refunded]);
  chain.mine(1);

  const pool = poolOver(chain);
  const walletAddresses = [{ pkh: me.pkh, lockingBytecode: p2pkhLockingBytecode(me.pkh) }];
  const tickets = await discoverTickets({ pool, shows: [s.show], walletAddresses });
  const bySeat = new Map(tickets.map((t) => [t.seatHex, t]));
  assert.equal(tickets.length, 4, 'the other buyer\'s ticket is not mine');
  assert.equal(bySeat.has(notMine.seatHex), false);
  assert.equal(bySeat.get(held.seatHex).state, 'held');
  assert.equal(bySeat.get(held.seatHex).canAct, true, 'hand-back and check-in can be built');
  assert.ok(bySeat.get(held.seatHex).escrowUtxo);
  assert.ok(bySeat.get(held.seatHex).ticketUtxo);
  assert.equal(bySeat.get(handed.seatHex).state, 'handedBack');
  assert.equal(bySeat.get(handed.seatHex).ticketUtxo, null, 'ticket burned');
  assert.equal(bySeat.get(walked.seatHex).state, 'walkedIn');
  assert.ok(bySeat.get(walked.seatHex).ticketUtxo, 'keepsake stays in the wallet');
  assert.equal(bySeat.get(walked.seatHex).canAct, false);
  assert.equal(bySeat.get(refunded.seatHex).state, 'refunded');
  assert.equal(bySeat.get(refunded.seatHex).refundPath, 'settle');
  assert.ok(bySeat.get(refunded.seatHex).ticketUtxo, 'ticket still in the wallet after a settle');
  assert.equal(tickets[0].state, 'held', 'live tickets first');

  const coins = await listUnspent(pool, p2pkhLockingBytecode(me.pkh));
  const found = findTicketCoins({ utxos: coins, shows: [s.show] });
  assert.deepEqual(found.map((f) => f.seatHex).sort(), [held.seatHex, walked.seatHex, refunded.seatHex].sort());

  const ledgers = await fetchLedgers(pool, [s.show]);
  assert.equal(ledgers.errors.length, 0);
  assert.equal(ledgers.get('sample-a').coins.length, 5);
  pool.close();
});

test('myTickets: a ticket given to this wallet shows its state but cannot act', async () => {
  const chain = makeMiniChain();
  const s = makeScenario(assert, chain);
  const giver = freshKey();
  const me = freshKey();
  const sale = s.buy({ buyer: giver });
  // The giver sends the ticket NFT to me (plain transfer, no contract involved).
  chain.add({
    version: 2,
    inputs: [{ outpointTransactionHash: sale.ticketUtxo.txid, outpointIndex: 1, sequenceNumber: 0, unlockingBytecode: new Uint8Array() }],
    outputs: [{ ...sale.ticketUtxo.output, lockingBytecode: p2pkhLockingBytecode(me.pkh) }],
    locktime: 0,
  });
  const pool = poolOver(chain);
  const tickets = await discoverTickets({ pool, shows: [s.show], walletAddresses: [{ pkh: me.pkh, lockingBytecode: p2pkhLockingBytecode(me.pkh) }] });
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].state, 'held');
  assert.equal(tickets[0].boughtByThisWallet, false);
  assert.equal(tickets[0].canAct, false, 'a moved ticket cannot check in or hand back (SPEC 8)');
  assert.equal(tickets[0].buyerPkhHex, binToHex(giver.pkh));
  pool.close();
});
