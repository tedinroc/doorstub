// Genesis is the one thing the contracts cannot see. verifyGenesis is the
// client-side check that covers it (SPEC.md section 7). The LIMIT case shows,
// in the 2026 VM, what a malformed genesis would let through if no client
// checked it: seat ids repeat. A shard of another category can no longer
// sell at all: BoxOffice commits to the show's category (TOK-1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { binToHex, encodeTransaction } from '@bitauth/libauth';
import {
  DoorstubError,
  buildBuy,
  buildGenesis,
  encodeBoxOfficeCommitment,
  encodeMarkerCommitment,
  encodeTicketCommitment,
  verifyGenesis,
} from '../src/tx/index.js';
import { fakeCoin, freshKey, makeShow, randomTxid, saleHeight, sampleShowParams, signWallet, txidOf, utxoAt } from './helpers.js';
import {
  assemble,
  expectAccept,
  expectReject,
  honestBuy,
  nftOut,
  out,
  p2pkh,
  seatOf,
  shardCoin,
  why,
} from './kit.js';

const o2 = (ctx) => ctx.signedGenesis.transaction.outputs[2];
const genesisOf = (ctx) => ({ show: ctx.show, transaction: ctx.signedGenesis.transaction });

/** The genesis with its outputs (and optionally inputs) changed. */
const tampered = (ctx, editOutputs, editInputs = (inputs) => inputs) => {
  const tx = ctx.signedGenesis.transaction;
  return { show: ctx.show, transaction: { ...tx, outputs: editOutputs(tx.outputs.slice()), inputs: editInputs(tx.inputs.slice()) } };
};

const refused = (input, code) =>
  assert.throws(
    () => verifyGenesis(input),
    (error) => error instanceof DoorstubError && error.code === code,
    `expected ${code}`,
  );

const shardOut = (ctx, { open = true, shard, sold = 0, lockingBytecode = ctx.contracts.boxOffice.lockingBytecode, amount = 0n }) => ({
  lockingBytecode,
  valueSatoshis: 1000n,
  token: { amount, category: ctx.show.category, nft: { capability: 'minting', commitment: encodeBoxOfficeCommitment({ open, shard, sold }) } },
});

test('control: an honest 4-shard genesis verifies', () => {
  const ctx = makeShow(assert, { shards: 4 });
  const { shards, txid } = verifyGenesis(genesisOf(ctx));
  assert.deepEqual(shards.map((s) => s.shard), [0, 1, 2, 3]);
  assert.deepEqual(shards.map((s) => s.vout), [0, 1, 2, 3]);
  assert.deepEqual(txid, txidOf(ctx.signedGenesis.transaction));
});

test('REJECT genesis with duplicate shard bytes (seat ids would repeat across shards)', () => {
  const ctx = makeShow(assert);
  refused(tampered(ctx, (o) => { o[1] = shardOut(ctx, { shard: 0 }); return o; }), 'genesis-duplicate-shard');
});

test('REJECT genesis that pre-mints a ticket', () => {
  const ctx = makeShow(assert);
  const friend = freshKey();
  const ticket = nftOut(p2pkh(friend.pkh), 1000, { category: ctx.show.category, commitment: encodeTicketCommitment(seatOf(0, 1), friend.pkh) });
  refused(tampered(ctx, (o) => [...o, ticket]), 'genesis-pre-minted');
});

test('REJECT genesis that pre-mints a marker into the Escrow', () => {
  const ctx = makeShow(assert);
  const marker = nftOut(ctx.contracts.escrow.lockingBytecode, 1000, {
    category: ctx.show.category,
    commitment: encodeMarkerCommitment(seatOf(0, 1), ctx.organiser.pkh),
  });
  refused(tampered(ctx, (o) => [...o, marker]), 'genesis-pre-minted');
});

test('REJECT genesis that mints fungible tokens of the category (on a shard or on their own)', () => {
  const ctx = makeShow(assert);
  refused(tampered(ctx, (o) => { o[0] = shardOut(ctx, { shard: 0, amount: 1000n }); return o; }), 'genesis-fungible');
  const fungibleOnly = { lockingBytecode: p2pkh(ctx.organiser.pkh), valueSatoshis: 1000n, token: { amount: 5n, category: ctx.show.category } };
  refused(tampered(ctx, (o) => [...o, fungibleOnly]), 'genesis-fungible');
});

test('REJECT genesis that keeps a minting NFT outside the BoxOffice', () => {
  const ctx = makeShow(assert);
  refused(tampered(ctx, (o) => [...o, shardOut(ctx, { shard: 9, lockingBytecode: p2pkh(ctx.organiser.pkh) })]), 'genesis-minting-elsewhere');
});

test('REJECT genesis whose shards start closed, with sold > 0, or with a 0x8000 counter', () => {
  const ctx = makeShow(assert);
  refused(tampered(ctx, (o) => { o[2] = shardOut(ctx, { shard: 2, open: false }); return o; }), 'genesis-bad-shard');
  refused(tampered(ctx, (o) => { o[2] = shardOut(ctx, { shard: 2, sold: 5 }); return o; }), 'genesis-bad-shard');
  const negativeZero = { ...o2(ctx), token: { ...o2(ctx).token, nft: { capability: 'minting', commitment: Uint8Array.of(1, 2, 0x00, 0x80) } } };
  refused(tampered(ctx, (o) => { o[2] = negativeZero; return o; }), 'genesis-bad-shard');
  const fiveBytes = { ...o2(ctx), token: { ...o2(ctx).token, nft: { capability: 'minting', commitment: Uint8Array.of(1, 2, 0, 0, 0) } } };
  refused(tampered(ctx, (o) => { o[2] = fiveBytes; return o; }), 'genesis-bad-shard');
});

test('REJECT a transaction that is not the category\'s genesis', () => {
  const ctx = makeShow(assert);
  refused(tampered(ctx, (o) => o, (inputs) => inputs.map((x) => ({ ...x, outpointTransactionHash: randomTxid() }))), 'genesis-not-here');
  refused(tampered(ctx, (o) => o, (inputs) => inputs.map((x) => ({ ...x, outpointIndex: 1 }))), 'genesis-not-here');
});

test('REJECT posted show parameters that differ from the ones the BoxOffice was built from', () => {
  const ctx = makeShow(assert);
  refused({ ...genesisOf(ctx), show: { ...ctx.show, price: 9_000n } }, 'genesis-minting-elsewhere');
  refused({ ...genesisOf(ctx), show: { ...ctx.show, noShowFeeBps: 0, minerFeeCap: 1_400n } }, 'genesis-minting-elsewhere');
});

test('REJECT posted fees over 1,000 bps (10%) (M4)', () => {
  const ctx = makeShow(assert);
  refused({ ...genesisOf(ctx), show: { ...ctx.show, handBackFeeBps: 1_001 } }, 'bad-show');
  refused({ ...genesisOf(ctx), show: { ...ctx.show, noShowFeeBps: 1_001 } }, 'bad-show');
  refused({ ...genesisOf(ctx), show: { ...ctx.show, noShowFeeBps: 10_000 } }, 'bad-show');
});

test('REJECT a posted minerFeeCap above 2,000 sats, above 20% of the price or below 1,200, and a price below 6,000 (M1, TOK-2)', () => {
  const ctx = makeShow(assert);
  for (const change of [
    { minerFeeCap: 2_001n, price: 100_000n },
    { minerFeeCap: 11_000n },
    { minerFeeCap: 1_000_000n },
    { minerFeeCap: 1_501n, price: 7_500n },
    { minerFeeCap: 1_199n },
    { minerFeeCap: 1_200n, price: 5_999n },
  ]) {
    refused({ ...genesisOf(ctx), show: { ...ctx.show, ...change } }, 'bad-show');
  }
});

test('REJECT genesis with no shard of the posted category', () => {
  const ctx = makeShow(assert);
  refused(tampered(ctx, (o) => o.filter((x) => x.token === undefined)), 'genesis-no-shards');
});

test('LIMIT without verifyGenesis, duplicate shard bytes let two buys sell the same seat id', (t) => {
  const ctx = makeShow(assert);
  const twin = shardCoin(ctx, { shard: 0 }); // a second "shard 0" from a malformed genesis
  const a = honestBuy(ctx, { shard: ctx.shardUtxos[0] });
  const b = honestBuy(ctx, { shard: twin });
  expectAccept(assert, assemble(a), 'shard 0 sells seat (0,1)');
  expectAccept(assert, assemble(b), 'twin shard 0 sells seat (0,1) again');
  assert.deepEqual(a.seat, b.seat);
  t.diagnostic('the contracts cannot see genesis; verifyGenesis refuses it (genesis-duplicate-shard)');
});

test('REJECT a shard of another category at this BoxOffice: buildBuy refuses it, and a hand-built buy fails on chain (TOK-1)', (t) => {
  const ctx = makeShow(assert);
  const otherCategory = randomTxid();
  const stray = shardCoin(ctx, { category: otherCategory });
  const buyer = freshKey();
  assert.throws(
    () => buildBuy({ show: ctx.show, boxOfficeUtxo: stray, fundingUtxos: [fakeCoin(buyer.pkh, 50_000)], buyerPkh: buyer.pkh, currentHeight: saleHeight(ctx.show) }),
    (error) => error.code === 'wrong-category',
    'buildBuy refuses the shard',
  );
  // Hand-built: BoxOffice commits to the show's category, so the stray shard cannot sell.
  const h = honestBuy(ctx, { buyer });
  const outputs = h.outputs.map((o, i) => (i <= 2 ? { ...o, token: { ...o.token, category: otherCategory } } : o));
  const bought = assemble({ inputs: [{ coin: stray, unlock: h.inputs[0].unlock }, h.inputs[1]], outputs });
  t.diagnostic(why(expectReject(assert, bought, { failing: 0 })));
  // Labelling the outputs with the show's category does not help (the token rules refuse it too).
  const relabelled = assemble({ inputs: [{ coin: stray, unlock: h.inputs[0].unlock }, h.inputs[1]], outputs: h.outputs });
  t.diagnostic(why(expectReject(assert, relabelled, { failing: 0 })));
});

test('REJECT a stranger plants a shard of their own category at a live show\'s BoxOffice (TOK-1): the plant is valid, nothing can sell from it', (t) => {
  const ctx = makeShow(assert);
  const stranger = freshKey();
  const seed = fakeCoin(stranger.pkh, 10_000); // vout 0: its txid becomes the stranger's category
  const plant = assemble({
    inputs: [{ coin: seed, signer: stranger }],
    outputs: [
      nftOut(ctx.contracts.boxOffice.lockingBytecode, 1000, {
        category: seed.txid,
        commitment: encodeBoxOfficeCommitment({ open: true, shard: 0, sold: 0 }),
        capability: 'minting',
      }),
      out(p2pkh(stranger.pkh), 8_000),
    ],
  });
  expectAccept(assert, plant, 'anyone can send a look-alike shard to the public BoxOffice address');
  assert.equal(verifyGenesis(genesisOf(ctx)).shards.length, 4, 'the honest genesis still verifies');
  refused({ show: ctx.show, transaction: plant.transaction }, 'genesis-not-here');
  const planted = utxoAt(plant.transaction, 0);
  const buyer = freshKey();
  assert.throws(
    () => buildBuy({ show: ctx.show, boxOfficeUtxo: planted, fundingUtxos: [fakeCoin(buyer.pkh, 50_000)], buyerPkh: buyer.pkh, currentHeight: saleHeight(ctx.show) }),
    (error) => error.code === 'wrong-category',
  );
  const h = honestBuy(ctx, { buyer });
  const outputs = h.outputs.map((o, i) => (i <= 2 ? { ...o, token: { ...o.token, category: seed.txid } } : o));
  const bought = assemble({ inputs: [{ coin: planted, unlock: h.inputs[0].unlock }, h.inputs[1]], outputs });
  // Before TOK-1 this buy was valid and locked the buyer's money for good.
  t.diagnostic(why(expectReject(assert, bought, { failing: 0 })));
});

test('REJECT a genesis that also mints a "shard 0" of a second category at the BoxOffice (TOK-1)', (t) => {
  const organiser = freshKey();
  const dataKey = freshKey();
  const a = fakeCoin(organiser.pkh, 100_000);
  const b = fakeCoin(organiser.pkh, 50_000); // also vout 0, so it can create a second category
  const genesis = buildGenesis({
    show: sampleShowParams(organiser, dataKey),
    shards: 2,
    fundingUtxos: [a, b],
    changeLockingBytecode: p2pkh(organiser.pkh),
  });
  const outputs = genesis.transaction.outputs.slice();
  const change = outputs.pop();
  const second = nftOut(genesis.contracts.boxOffice.lockingBytecode, 1000, {
    category: b.txid,
    commitment: encodeBoxOfficeCommitment({ open: true, shard: 0, sold: 0 }),
    capability: 'minting',
  });
  outputs.push(second, { ...change, valueSatoshis: change.valueSatoshis - 1000n });
  const signed = signWallet({ ...genesis, transaction: { ...genesis.transaction, outputs } }, organiser.privateKey);
  expectAccept(assert, signed, 'a two-category genesis is a valid transaction');
  refused({ show: genesis.show, transaction: signed.transaction }, 'genesis-foreign-token');
  // A token of another category anywhere in the genesis is refused, not only at the BoxOffice.
  const elsewhere = outputs.map((o, i) => (i === 2 ? { ...o, lockingBytecode: p2pkh(organiser.pkh) } : o));
  refused({ show: genesis.show, transaction: { ...signed.transaction, outputs: elsewhere } }, 'genesis-foreign-token');
  // And on chain the second-category shard cannot sell.
  const ctx = { show: genesis.show, contracts: genesis.contracts, shardUtxos: [utxoAt(signed.transaction, 0)] };
  const buyer = freshKey();
  const h = honestBuy(ctx, { buyer });
  const relabelled = h.outputs.map((o, i) => (i <= 2 ? { ...o, token: { ...o.token, category: b.txid } } : o));
  const bought = assemble({ inputs: [{ coin: utxoAt(signed.transaction, 2), unlock: h.inputs[0].unlock }, h.inputs[1]], outputs: relabelled });
  t.diagnostic(why(expectReject(assert, bought, { failing: 0 })));
});

test('REJECT a look-alike genesis when the caller names the mined txid; verifyGenesis returns the txid it checked (TOK-4)', () => {
  const ctx = makeShow(assert);
  const mined = ctx.signedGenesis.transaction;
  const { txid } = verifyGenesis(genesisOf(ctx));
  // Raw bytes give the same answer, and a hex txid works too.
  const fromBytes = verifyGenesis({ show: ctx.show, transaction: encodeTransaction(mined), txid: binToHex(txid) });
  assert.deepEqual(fromBytes.txid, txid);
  assert.equal(fromBytes.shards.length, 4);
  // A different transaction spending the same parent outpoint (change one sat lower, re-signed).
  const outputs = mined.outputs.map((o, i) => (i === mined.outputs.length - 1 ? { ...o, valueSatoshis: o.valueSatoshis - 1n } : o));
  const lookAlike = signWallet({ ...ctx.genesis, transaction: { ...ctx.genesis.transaction, outputs } }, ctx.organiser.privateKey);
  expectAccept(assert, lookAlike, 'the look-alike is a valid transaction too (only one can ever be mined)');
  const own = verifyGenesis({ show: ctx.show, transaction: lookAlike.transaction });
  assert.notDeepEqual(own.txid, txid, 'on its own it verifies, under its own txid');
  refused({ show: ctx.show, transaction: lookAlike.transaction, txid }, 'genesis-txid-mismatch');
  refused({ show: ctx.show, transaction: Uint8Array.of(1, 2, 3) }, 'genesis-undecodable');
});
