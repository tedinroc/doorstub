// Genesis is the one thing the contracts cannot see. verifyGenesis is the
// client-side check that covers it (SPEC.md section 7). The LIMIT cases show,
// in the 2026 VM, what a malformed genesis would let through if no client
// checked it: seat ids repeat, or buyers' money locks up for good.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DoorstubError,
  buildBuy,
  encodeBoxOfficeCommitment,
  encodeMarkerCommitment,
  encodeTicketCommitment,
  verifyGenesis,
} from '../src/tx/index.js';
import { fakeCoin, freshKey, makeShow, randomTxid, utxoAt } from './helpers.js';
import {
  SEQUENCE_LOCKTIME,
  assemble,
  coinValue,
  escrowUnlock,
  expectAccept,
  expectReject,
  honestBuy,
  nftOut,
  notice,
  out,
  p2pkh,
  seatOf,
  settleHeight,
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
  const { shards } = verifyGenesis(genesisOf(ctx));
  assert.deepEqual(shards.map((s) => s.shard), [0, 1, 2, 3]);
  assert.deepEqual(shards.map((s) => s.vout), [0, 1, 2, 3]);
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
  refused({ ...genesisOf(ctx), show: { ...ctx.show, price: 5_000n } }, 'genesis-minting-elsewhere');
  refused({ ...genesisOf(ctx), show: { ...ctx.show, noShowFeeBps: 0, minerFeeCap: 1n } }, 'genesis-minting-elsewhere');
});

test('REJECT posted fees over 10,000 bps', () => {
  const ctx = makeShow(assert);
  refused({ ...genesisOf(ctx), show: { ...ctx.show, handBackFeeBps: 10_001 } }, 'bad-show');
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

test('LIMIT without client checks, a shard of another category sells into an Escrow that can never pay out', (t) => {
  const ctx = makeShow(assert);
  const otherCategory = randomTxid();
  const stray = shardCoin(ctx, { category: otherCategory });
  const buyer = freshKey();
  assert.throws(
    () => buildBuy({ show: ctx.show, boxOfficeUtxo: stray, fundingUtxos: [fakeCoin(buyer.pkh, 50_000)], buyerPkh: buyer.pkh }),
    (error) => error.code === 'wrong-category',
    'buildBuy refuses the shard',
  );
  // Hand-built, the buy itself passes: BoxOffice does not know the Escrow's category.
  const h = honestBuy(ctx, { buyer });
  const outputs = h.outputs.map((o, i) => (i <= 2 ? { ...o, token: { ...o.token, category: otherCategory } } : o));
  const bought = assemble({ inputs: [{ coin: stray, unlock: h.inputs[0].unlock }, h.inputs[1]], outputs });
  expectAccept(assert, bought, 'buy from a mis-categorised shard');
  // ...and the money is stuck: no Escrow path accepts a marker of another category.
  const esc = utxoAt(bought.transaction, 2);
  const tkt = utxoAt(bought.transaction, 1);
  const U = escrowUnlock(ctx);
  const V = coinValue(ctx);
  t.diagnostic(why(expectReject(assert, assemble({ inputs: [{ coin: esc, unlock: U.settle(), sequence: SEQUENCE_LOCKTIME }], outputs: [out(p2pkh(buyer.pkh), V - 500n)], locktime: settleHeight(ctx) }), { failing: 0 })));
  t.diagnostic(why(expectReject(assert, assemble({ inputs: [{ coin: esc, unlock: U.refund(notice(ctx, 'C'), 'C') }], outputs: [out(p2pkh(buyer.pkh), V - 500n)] }), { failing: 0 })));
  t.diagnostic(why(expectReject(assert, assemble({ inputs: [{ coin: esc, unlock: U.handBack(1) }, { coin: tkt, signer: buyer }], outputs: [out(p2pkh(buyer.pkh), V)] }), { failing: 0 })));
  // A genesis like this fails verifyGenesis: the BoxOffice address commits to the Escrow's category.
});
