// Simnet broadcast: every honest Doorstub path built by src/tx with test keys
// is accepted (including 0-conf chains), and invalid ones are refused with the
// VM's own error text in Fulcrum's error shape. Keys are fresh; simnet only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { binToHex, encodeTransaction, hexToBin } from '@bitauth/libauth';
import {
  SEQUENCE_FINAL,
  buildBuy,
  buildCheckIn,
  buildHandBack,
  buildRefund,
  buildSettle,
  encodeRefundNoticeMessage,
  p2pkhLockingBytecode,
} from '../../src/tx/index.js';
import { signDataMessage, signP2pkhInputs } from '../../src/tx/sign.js';
import { scripthashOf } from '../../simnet/chain.js';
import { freshKey, signWallet, utxoAt } from '../helpers.js';
import { coinsAt, fundKey, openSimnet, refused, showOnSimnet, toHex } from './support.js';

const REJECTED = /^the transaction was rejected by network rules\.\n\n/;

const tipOf = async (rpc) => (await rpc.request('blockchain.headers.subscribe', [])).height;

/** Buy a seat on `shard` with a funded fresh buyer; returns the signed buy and its coins. */
const buy = async (rpc, ctx, shard, buyer = freshKey(), { fund = 50_000 } = {}) => {
  const coin = await fundKey(rpc, buyer, fund);
  const built = buildBuy({ show: ctx.show, boxOfficeUtxo: shard, fundingUtxos: [coin], buyerPkh: buyer.pkh, currentHeight: await tipOf(rpc) });
  const signed = signWallet(built, buyer.privateKey);
  return {
    buyer,
    built,
    signed,
    hex: toHex(signed),
    nextShard: utxoAt(signed.transaction, 0),
    ticket: utxoAt(signed.transaction, 1),
    escrowCoin: utxoAt(signed.transaction, 2),
  };
};

test('honest buy, hand-back and check-in are accepted; coins move as the contracts say', async (t) => {
  const { rpc } = await openSimnet(t);
  const ctx = await showOnSimnet(rpc);
  assert.equal(ctx.shardUtxos.length, 4);

  const a = await buy(rpc, ctx, ctx.shardUtxos[0]);
  assert.equal(await rpc.request('blockchain.transaction.broadcast', [a.hex]), binToHex(utxoAt(a.signed.transaction, 0).txid));
  const escrowCoins = await coinsAt(rpc, ctx.contracts.escrow.lockingBytecode);
  assert.equal(escrowCoins.length, 1);
  assert.equal(escrowCoins[0].height, 0, 'the escrow coin is in the mempool');
  assert.equal(escrowCoins[0].output.valueSatoshis, ctx.show.price + 1000n);
  assert.equal(escrowCoins[0].output.token.nft.capability, 'none');

  // Hand back at 0-conf: the ticket and escrow coin come straight from the mempool.
  const handBack = signWallet(buildHandBack({ show: ctx.show, escrowUtxo: a.escrowCoin, ticketUtxo: a.ticket }), a.buyer.privateKey);
  await rpc.request('blockchain.transaction.broadcast', [toHex(handBack)]);
  assert.equal((await coinsAt(rpc, ctx.contracts.escrow.lockingBytecode)).length, 0);
  const refundsToBuyer = (await coinsAt(rpc, p2pkhLockingBytecode(a.buyer.pkh))).filter((c) => c.output.token === undefined);
  assert.ok(refundsToBuyer.some((c) => c.output.valueSatoshis === handBack.transaction.outputs[0].valueSatoshis));

  // Check in on another shard: organiser paid, keepsake back to the holder.
  const b = await buy(rpc, ctx, ctx.shardUtxos[1]);
  await rpc.request('blockchain.transaction.broadcast', [b.hex]);
  const checkIn = signWallet(buildCheckIn({ show: ctx.show, escrowUtxo: b.escrowCoin, ticketUtxo: b.ticket }), b.buyer.privateKey);
  await rpc.request('blockchain.transaction.broadcast', [toHex(checkIn)]);
  const organiserCoins = await coinsAt(rpc, p2pkhLockingBytecode(ctx.organiser.pkh));
  assert.ok(organiserCoins.some((c) => c.output.valueSatoshis === checkIn.transaction.outputs[0].valueSatoshis));
  const keepsake = (await coinsAt(rpc, p2pkhLockingBytecode(b.buyer.pkh))).find((c) => c.output.token !== undefined);
  assert.equal(binToHex(keepsake.output.token.nft.commitment), binToHex(b.ticket.output.token.nft.commitment));

  // Funding b's buyer mined a block (buy a and the hand-back); b's buy and the check-in wait.
  const mined = await rpc.request('simnet.mine', { blocks: 1 });
  assert.deepEqual(mined.mined, [binToHex(b.nextShard.txid), binToHex(utxoAt(checkIn.transaction, 0).txid)]);
});

test('0-conf chain: a buy can spend the shard of a genesis still in the mempool; history marks it -1', async (t) => {
  const { rpc } = await openSimnet(t);
  const ctx = await showOnSimnet(rpc, { mine: false });
  assert.equal(ctx.shardUtxos[0].height, 0);
  const a = await buy(rpc, ctx, ctx.shardUtxos[0], freshKey());
  // fundKey mined a block, which confirmed the genesis; chain again on the new (mempool) buy instead.
  await rpc.request('blockchain.transaction.broadcast', [a.hex]);
  const second = await buy(rpc, ctx, a.nextShard, freshKey(), { fund: 60_000 });
  // fundKey mined again; build a third buy on the second's shard without mining in between.
  await rpc.request('blockchain.transaction.broadcast', [second.hex]);
  const buyer = freshKey();
  const coin = await fundKey(rpc, buyer, 50_000, { mine: false });
  const third = buildBuy({ show: ctx.show, boxOfficeUtxo: second.nextShard, fundingUtxos: [coin], buyerPkh: buyer.pkh, currentHeight: await tipOf(rpc) });
  const signedThird = signWallet(third, buyer.privateKey);
  await rpc.request('blockchain.transaction.broadcast', [toHex(signedThird)]);
  const history = await rpc.request('blockchain.scripthash.get_history', [scripthashOf(ctx.contracts.escrow.lockingBytecode)]);
  const thirdTxid = binToHex(utxoAt(signedThird.transaction, 0).txid);
  const entry = history.find((h) => h.tx_hash === thirdTxid);
  assert.equal(entry.height, -1, 'its inputs are unconfirmed');
  assert.ok(entry.fee > 0);
  await rpc.request('simnet.mine', { blocks: 1 });
  const after = await rpc.request('blockchain.scripthash.get_history', [scripthashOf(ctx.contracts.escrow.lockingBytecode)]);
  assert.ok(after.every((h) => h.height > 0));
  assert.equal(after.length, 3);
});

test('settle is non-final until the tip reaches startHeight + graceBlocks, then accepted', async (t) => {
  const { rpc } = await openSimnet(t);
  const ctx = await showOnSimnet(rpc);
  const a = await buy(rpc, ctx, ctx.shardUtxos[0]);
  const b = await buy(rpc, ctx, ctx.shardUtxos[1]);
  await rpc.request('blockchain.transaction.broadcast', [a.hex]);
  await rpc.request('blockchain.transaction.broadcast', [b.hex]);
  const settle = buildSettle({ show: ctx.show, escrowUtxos: [a.escrowCoin, b.escrowCoin] });
  const settleFrom = ctx.show.startHeight + ctx.show.graceBlocks;
  assert.equal(settle.transaction.locktime, settleFrom);

  const tip = await tipOf(rpc);
  await rpc.request('simnet.mine', { blocks: settleFrom - 1 - tip });
  assert.equal(await tipOf(rpc), settleFrom - 1);
  await refused(assert, rpc.request('blockchain.transaction.broadcast', [toHex(settle)]), /\n\nnon-final\n$/);

  await rpc.request('simnet.mine', { blocks: 1 });
  assert.equal(await tipOf(rpc), settleFrom);
  await rpc.request('blockchain.transaction.broadcast', [toHex(settle)]);
  for (const sale of [a, b]) {
    const coins = await coinsAt(rpc, p2pkhLockingBytecode(sale.buyer.pkh));
    assert.ok(coins.some((c) => c.height === 0 && c.output.token === undefined), 'refund is in the mempool');
  }
  const mined = await rpc.request('simnet.mine', { blocks: 1 });
  assert.equal(mined.height, settleFrom + 1, 'mined in the first block where locktime is final');
  assert.equal((await coinsAt(rpc, ctx.contracts.escrow.lockingBytecode)).length, 0);
});

test('settle with its locktime lowered below the show is refused by the VM (CLTV), not by finality', async (t) => {
  const { rpc } = await openSimnet(t);
  const ctx = await showOnSimnet(rpc);
  const a = await buy(rpc, ctx, ctx.shardUtxos[0]);
  await rpc.request('blockchain.transaction.broadcast', [a.hex]);
  const settle = buildSettle({ show: ctx.show, escrowUtxos: [a.escrowCoin] });
  const early = { ...settle, transaction: { ...settle.transaction, locktime: ctx.show.startHeight + ctx.show.graceBlocks - 1 } };
  await rpc.request('simnet.mine', { blocks: ctx.show.startHeight + ctx.show.graceBlocks - (await tipOf(rpc)) });
  const error = await refused(assert, rpc.request('blockchain.transaction.broadcast', [toHex(early)]), REJECTED);
  assert.match(error.message, /mandatory-script-verify-flag-failed \(Unable to verify transaction: error in evaluating input index 0: .+\)/);
  assert.match(error.message, /locktime/i);
});

test('refund with an organiser R notice is accepted; a notice from another key is refused with the VM text', async (t) => {
  const { rpc } = await openSimnet(t);
  const ctx = await showOnSimnet(rpc);
  const a = await buy(rpc, ctx, ctx.shardUtxos[2]);
  await rpc.request('blockchain.transaction.broadcast', [a.hex]);
  const message = encodeRefundNoticeMessage({ scope: 'R', category: ctx.show.category, seat: a.built.seat });

  const forged = buildRefund({ show: ctx.show, escrowUtxos: [a.escrowCoin], notices: [{ scope: 'R', seat: a.built.seat, signature: signDataMessage(freshKey().privateKey, message) }] });
  const error = await refused(assert, rpc.request('blockchain.transaction.broadcast', [toHex(forged)]), REJECTED);
  assert.match(error.message, /mandatory-script-verify-flag-failed \(.*evaluating input index 0/);

  const honest = buildRefund({ show: ctx.show, escrowUtxos: [a.escrowCoin], notices: [{ scope: 'R', seat: a.built.seat, signature: signDataMessage(ctx.dataKey.privateKey, message) }] });
  const txid = await rpc.request('blockchain.transaction.broadcast', [toHex(honest)]);
  assert.equal(await rpc.request('blockchain.transaction.get_height', [txid]), 0);
  const refund = (await coinsAt(rpc, p2pkhLockingBytecode(a.buyer.pkh))).find((c) => binToHex(c.txid) === txid);
  assert.equal(refund.output.valueSatoshis, honest.transaction.outputs[0].valueSatoshis);
});

test('a tampered buy (escrow 1 sat short, re-signed) is refused with the BoxOffice input\'s VM error', async (t) => {
  const { rpc } = await openSimnet(t);
  const ctx = await showOnSimnet(rpc);
  const buyer = freshKey();
  const coin = await fundKey(rpc, buyer, 50_000);
  const built = buildBuy({ show: ctx.show, boxOfficeUtxo: ctx.shardUtxos[0], fundingUtxos: [coin], buyerPkh: buyer.pkh, currentHeight: await tipOf(rpc) });
  const outputs = built.transaction.outputs.map((o, i) => (i === 2 ? { ...o, valueSatoshis: o.valueSatoshis - 1n } : i === 3 ? { ...o, valueSatoshis: o.valueSatoshis + 1n } : o));
  const tampered = signWallet({ ...built, transaction: { ...built.transaction, outputs } }, buyer.privateKey);
  const error = await refused(assert, rpc.request('blockchain.transaction.broadcast', [toHex(tampered)]), REJECTED);
  assert.match(error.message, /mandatory-script-verify-flag-failed \(Unable to verify transaction: error in evaluating input index 0: /);
  // Nothing changed: the shard is still unspent and the escrow is empty.
  assert.equal((await coinsAt(rpc, ctx.contracts.boxOffice.lockingBytecode)).length, 4);
  assert.equal((await coinsAt(rpc, ctx.contracts.escrow.lockingBytecode)).length, 0);
});

test('a wallet input signed by the wrong key is refused', async (t) => {
  const { rpc } = await openSimnet(t);
  const ctx = await showOnSimnet(rpc);
  const buyer = freshKey();
  const coin = await fundKey(rpc, buyer, 50_000);
  const built = buildBuy({ show: ctx.show, boxOfficeUtxo: ctx.shardUtxos[0], fundingUtxos: [coin], buyerPkh: buyer.pkh, currentHeight: await tipOf(rpc) });
  const wrong = signWallet(built, freshKey().privateKey);
  const error = await refused(assert, rpc.request('blockchain.transaction.broadcast', [toHex(wrong)]), REJECTED);
  assert.match(error.message, /evaluating input index 1/);
});

test('double spends: a second buy on the same shard conflicts in the mempool, and is missing inputs once mined', async (t) => {
  const { rpc } = await openSimnet(t);
  const ctx = await showOnSimnet(rpc);
  const first = await buy(rpc, ctx, ctx.shardUtxos[3]);
  const second = await buy(rpc, ctx, ctx.shardUtxos[3]);
  await rpc.request('blockchain.transaction.broadcast', [first.hex]);
  await refused(assert, rpc.request('blockchain.transaction.broadcast', [second.hex]), /\n\ntxn-mempool-conflict\n$/);
  // The same transaction again is fine while it waits in the mempool (BCHN answers with the txid).
  assert.equal(await rpc.request('blockchain.transaction.broadcast', [first.hex]), binToHex(first.nextShard.txid));
  await rpc.request('simnet.mine', { blocks: 1 });
  await refused(assert, rpc.request('blockchain.transaction.broadcast', [second.hex]), /\n\nMissing inputs\n$/);
  await refused(assert, rpc.request('blockchain.transaction.broadcast', [first.hex]), /\n\nTransaction already in block chain\n$/);
});

test('missing inputs, duplicate inputs, fee below 1 sat/byte, outputs above inputs and undecodable bytes are refused', async (t) => {
  const { rpc } = await openSimnet(t);
  const key = freshKey();
  const coin = await fundKey(rpc, key, 10_000);
  const lock = p2pkhLockingBytecode(key.pkh);
  const pay = (inputs, value) => {
    const transaction = {
      version: 2,
      inputs: inputs.map((c) => ({ outpointTransactionHash: c.txid, outpointIndex: c.vout, sequenceNumber: SEQUENCE_FINAL, unlockingBytecode: new Uint8Array() })),
      outputs: [{ lockingBytecode: lock, valueSatoshis: value }],
      locktime: 0,
    };
    const sourceOutputs = inputs.map((c) => c.output);
    return binToHex(encodeTransaction(signP2pkhInputs({ transaction, sourceOutputs, inputIndexes: inputs.map((_, i) => i), privateKey: key.privateKey })));
  };
  const madeUp = { ...coin, txid: crypto.getRandomValues(new Uint8Array(32)) };
  await refused(assert, rpc.request('blockchain.transaction.broadcast', [pay([madeUp], 9_000n)]), /\n\nMissing inputs\n$/);
  await refused(assert, rpc.request('blockchain.transaction.broadcast', [pay([coin, coin], 9_000n)]), /bad-txns-inputs-duplicate/);
  await refused(assert, rpc.request('blockchain.transaction.broadcast', [pay([coin], 9_990n)]), /min relay fee not met, 10 < \d+/);
  await refused(assert, rpc.request('blockchain.transaction.broadcast', [pay([coin], 10_001n)]), /bad-txns-in-belowout/);
  await refused(assert, rpc.request('blockchain.transaction.broadcast', ['02000000']), /TX decode failed/);
  await refused(assert, rpc.request('blockchain.transaction.broadcast', ['zz']), /TX decode failed/);
  assert.match(await rpc.request('blockchain.transaction.broadcast', [pay([coin], 9_700n)]), /^[0-9a-f]{64}$/);
});

test('token rules: inventing a token of an unrelated category is refused by the VM\'s token check', async (t) => {
  const { rpc } = await openSimnet(t);
  const key = freshKey();
  const coin = await fundKey(rpc, key, 10_000);
  const lock = p2pkhLockingBytecode(key.pkh);
  const transaction = {
    version: 2,
    inputs: [{ outpointTransactionHash: coin.txid, outpointIndex: 0, sequenceNumber: SEQUENCE_FINAL, unlockingBytecode: new Uint8Array() }],
    outputs: [{ lockingBytecode: lock, valueSatoshis: 9_000n, token: { amount: 0n, category: crypto.getRandomValues(new Uint8Array(32)), nft: { capability: 'none', commitment: new Uint8Array() } } }],
    locktime: 0,
  };
  const signed = signP2pkhInputs({ transaction, sourceOutputs: [coin.output], inputIndexes: [0], privateKey: key.privateKey });
  const error = await refused(assert, rpc.request('blockchain.transaction.broadcast', [binToHex(encodeTransaction(signed))]), REJECTED);
  assert.match(error.message, /bad-txns-consensus \(.*token/i);
  // A genesis of the input's own category (it spends output 0) is fine.
  const genesis = signP2pkhInputs({
    transaction: { ...transaction, outputs: [{ ...transaction.outputs[0], token: { ...transaction.outputs[0].token, category: coin.txid } }] },
    sourceOutputs: [coin.output],
    inputIndexes: [0],
    privateKey: key.privateKey,
  });
  assert.match(await rpc.request('blockchain.transaction.broadcast', [binToHex(encodeTransaction(genesis))]), /^[0-9a-f]{64}$/);
});

test('BIP68: a relative height lock opens only after the coin has enough confirmations', async (t) => {
  const { rpc } = await openSimnet(t);
  const key = freshKey();
  const coin = await fundKey(rpc, key, 10_000); // mined at the tip
  const coinHeight = await tipOf(rpc);
  const transaction = {
    version: 2,
    inputs: [{ outpointTransactionHash: coin.txid, outpointIndex: 0, sequenceNumber: 5, unlockingBytecode: new Uint8Array() }],
    outputs: [{ lockingBytecode: p2pkhLockingBytecode(key.pkh), valueSatoshis: 9_000n }],
    locktime: 0,
  };
  const hex = binToHex(encodeTransaction(signP2pkhInputs({ transaction, sourceOutputs: [coin.output], inputIndexes: [0], privateKey: key.privateKey })));
  await rpc.request('simnet.mine', { blocks: 3 });
  await refused(assert, rpc.request('blockchain.transaction.broadcast', [hex]), /non-BIP68-final/);
  await rpc.request('simnet.mine', { blocks: 1 });
  assert.equal(await tipOf(rpc), coinHeight + 4);
  assert.match(await rpc.request('blockchain.transaction.broadcast', [hex]), /^[0-9a-f]{64}$/, 'next block is coinHeight + 5');
});

test('mining advances height and median time past and confirms the mempool in order', async (t) => {
  const { rpc, chain } = await openSimnet(t);
  const start = chain.info();
  const mtpBefore = chain.medianTimePast(start.height);
  const key = freshKey();
  await fundKey(rpc, key, 5_000, { mine: false });
  await fundKey(rpc, key, 6_000, { mine: false });
  const mined = await rpc.request('simnet.mine', { blocks: 3 });
  assert.equal(mined.height, start.height + 3);
  assert.equal(mined.mined.length, 2);
  assert.ok(chain.medianTimePast(mined.height) > mtpBefore);
  const history = await rpc.request('blockchain.scripthash.get_history', [scripthashOf(p2pkhLockingBytecode(key.pkh))]);
  assert.deepEqual(history.map((h) => h.height), [start.height + 1, start.height + 1]);
  assert.deepEqual(history.map((h) => h.tx_hash), mined.mined, 'block order');
  // Headers link: each header's previous-hash field is the hash of the one before.
  const prev = hexToBin(await rpc.request('blockchain.block.header', [mined.height - 1]));
  const tipHeader = hexToBin(await rpc.request('blockchain.block.header', [mined.height]));
  const { hash256 } = await import('@bitauth/libauth');
  assert.equal(binToHex(tipHeader.slice(4, 36)), binToHex(hash256(prev)));
});
