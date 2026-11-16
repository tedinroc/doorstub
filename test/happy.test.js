// Happy paths for every contract path, each evaluated in the libauth 2026 VM
// in standard and consensus mode. Keys are fresh and never funded; every
// outpoint is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_COMMITMENT_BYTES,
  buildBuy,
  buildCheckIn,
  buildCloseSales,
  buildHandBack,
  buildRefund,
  buildSettle,
  decodeBoxOfficeCommitment,
  decodeSeat,
  decodeTaggedCommitment,
  encodeRefundNoticeMessage,
  p2pkhLockingBytecode,
  sameBytes,
} from '../src/tx/index.js';
import { signDataMessage, signDigest } from '../src/tx/sign.js';
import { assertValid, fakeCoin, freshKey, makeShow, saleHeight, signWallet, utxoAt } from './helpers.js';

/** Buy one seat on `shardUtxo` with a fresh buyer; returns the signed buy and its coins. */
const buyOne = (ctx, shardUtxo, buyer = freshKey(), coinValue = 50_000) => {
  const built = buildBuy({
    show: ctx.show,
    boxOfficeUtxo: shardUtxo,
    fundingUtxos: [fakeCoin(buyer.pkh, coinValue)],
    buyerPkh: buyer.pkh,
    currentHeight: saleHeight(ctx.show),
  });
  const signed = signWallet(built, buyer.privateKey);
  assertValid(assert, signed, 'buy');
  return {
    buyer,
    built,
    signed,
    nextShard: utxoAt(signed.transaction, 0),
    ticket: utxoAt(signed.transaction, 1),
    escrowCoin: utxoAt(signed.transaction, 2),
  };
};

test('genesis mints one open minting NFT per shard at the BoxOffice', (t) => {
  const ctx = makeShow(assert, { shards: 4 });
  const outputs = ctx.signedGenesis.transaction.outputs;
  for (let shard = 0; shard < 4; shard += 1) {
    const out = outputs[shard];
    assert.ok(sameBytes(out.lockingBytecode, ctx.contracts.boxOffice.lockingBytecode));
    assert.ok(sameBytes(out.token.category, ctx.show.category));
    assert.equal(out.token.nft.capability, 'minting');
    assert.deepEqual(decodeBoxOfficeCommitment(out.token.nft.commitment), { open: true, shard, sold: 0 });
  }
  // Only the shards carry the new category; the rest is change.
  assert.equal(outputs.filter((o) => o.token !== undefined).length, 4);
  assert.ok(ctx.contracts.boxOffice.address().startsWith('bitcoincash:r'));
  t.diagnostic(`BoxOffice redeem script ${ctx.contracts.boxOffice.redeemScript.length} B, Escrow ${ctx.contracts.escrow.redeemScript.length} B`);
});

test('buy: ticket to the buyer, money to escrow, shard counts the sale', () => {
  const ctx = makeShow(assert);
  const first = buyOne(ctx, ctx.shardUtxos[2]);
  const outs = first.signed.transaction.outputs;
  assert.deepEqual(decodeBoxOfficeCommitment(outs[0].token.nft.commitment), { open: true, shard: 2, sold: 1 });
  assert.deepEqual(decodeSeat(first.built.seat), { shard: 2, sold: 1 });
  assert.ok(sameBytes(outs[1].lockingBytecode, p2pkhLockingBytecode(first.buyer.pkh)));
  assert.equal(outs[1].token.nft.capability, 'none');
  assert.equal(decodeTaggedCommitment(outs[1].token.nft.commitment).kind, 'ticket');
  assert.ok(sameBytes(outs[2].lockingBytecode, ctx.contracts.escrow.lockingBytecode));
  assert.equal(outs[2].valueSatoshis, ctx.show.price + 1000n);
  assert.equal(decodeTaggedCommitment(outs[2].token.nft.commitment).kind, 'marker');
  for (const out of outs) {
    if (out.token?.nft) assert.ok(out.token.nft.commitment.length <= MAX_COMMITMENT_BYTES);
  }
  // A second sale chains on the new shard coin.
  const second = buyOne(ctx, first.nextShard);
  assert.deepEqual(decodeSeat(second.built.seat), { shard: 2, sold: 2 });
});

test('buy: wallet pays with two coins and gets change', () => {
  const ctx = makeShow(assert);
  const buyer = freshKey();
  const built = buildBuy({
    show: ctx.show,
    boxOfficeUtxo: ctx.shardUtxos[0],
    fundingUtxos: [fakeCoin(buyer.pkh, 8_000), fakeCoin(buyer.pkh, 9_000, 3)],
    buyerPkh: buyer.pkh,
    currentHeight: saleHeight(ctx.show),
  });
  assert.deepEqual(built.walletInputIndexes, [1, 2]);
  assert.equal(built.transaction.outputs.length, 4);
  assertValid(assert, signWallet(built, buyer.privateKey), 'buy with two coins');
});

test('handBack: holder gets the money back, ticket and marker burned', () => {
  const ctx = makeShow(assert);
  const sale = buyOne(ctx, ctx.shardUtxos[0]);
  const built = buildHandBack({ show: ctx.show, escrowUtxo: sale.escrowCoin, ticketUtxo: sale.ticket });
  const signed = signWallet(built, sale.buyer.privateKey);
  assertValid(assert, signed, 'handBack');
  const outs = signed.transaction.outputs;
  assert.equal(outs.length, 1);
  assert.ok(sameBytes(outs[0].lockingBytecode, p2pkhLockingBytecode(sale.buyer.pkh)));
  assert.equal(outs[0].valueSatoshis, ctx.show.price + 2000n - built.fee);
  assert.ok(outs.every((o) => o.token === undefined));
});

test('handBack with a posted fee pays the organiser at index activeInputIndex + inputCount', () => {
  const ctx = makeShow(assert, { overrides: { price: 100_000n, handBackFeeBps: 500 } });
  const sale = buyOne(ctx, ctx.shardUtxos[1], freshKey(), 200_000);
  const built = buildHandBack({ show: ctx.show, escrowUtxo: sale.escrowCoin, ticketUtxo: sale.ticket });
  assert.equal(built.handBackFee, (101_000n * 500n) / 10_000n);
  const signed = signWallet(built, sale.buyer.privateKey);
  assertValid(assert, signed, 'handBack with fee');
  const outs = signed.transaction.outputs;
  assert.equal(outs.length, 3);
  assert.ok(sameBytes(outs[2].lockingBytecode, p2pkhLockingBytecode(ctx.organiser.pkh)));
  assert.equal(outs[2].valueSatoshis, built.handBackFee);
});

test('checkIn: organiser is paid, holder keeps the ticket as a stub', () => {
  const ctx = makeShow(assert);
  const sale = buyOne(ctx, ctx.shardUtxos[3]);
  const built = buildCheckIn({ show: ctx.show, escrowUtxo: sale.escrowCoin, ticketUtxo: sale.ticket });
  const signed = signWallet(built, sale.buyer.privateKey);
  assertValid(assert, signed, 'checkIn');
  const [payout, keepsake] = signed.transaction.outputs;
  assert.ok(sameBytes(payout.lockingBytecode, p2pkhLockingBytecode(ctx.organiser.pkh)));
  assert.equal(payout.valueSatoshis, ctx.show.price + 1000n - built.fee);
  assert.ok(sameBytes(keepsake.lockingBytecode, p2pkhLockingBytecode(sale.buyer.pkh)));
  assert.ok(sameBytes(keepsake.token.nft.commitment, sale.ticket.output.token.nft.commitment));
  assert.equal(keepsake.valueSatoshis, 1000n);
});

test('settle: after start + grace, each unused coin refunds its own buyer (batched)', () => {
  const ctx = makeShow(assert);
  const a = buyOne(ctx, ctx.shardUtxos[0]);
  const b = buyOne(ctx, ctx.shardUtxos[1]);
  const built = buildSettle({ show: ctx.show, escrowUtxos: [a.escrowCoin, b.escrowCoin] });
  assert.equal(built.transaction.locktime, 930_144);
  assertValid(assert, built, 'settle');
  const outs = built.transaction.outputs;
  assert.equal(outs.length, 2);
  assert.ok(sameBytes(outs[0].lockingBytecode, p2pkhLockingBytecode(a.buyer.pkh)));
  assert.ok(sameBytes(outs[1].lockingBytecode, p2pkhLockingBytecode(b.buyer.pkh)));
  assert.ok(outs.every((o) => o.token === undefined));
});

test('settle with a no-show fee puts each fee at index k + i', () => {
  const ctx = makeShow(assert, { overrides: { price: 100_000n, noShowFeeBps: 1000 } });
  const a = buyOne(ctx, ctx.shardUtxos[0], freshKey(), 200_000);
  const b = buyOne(ctx, ctx.shardUtxos[1], freshKey(), 200_000);
  const built = buildSettle({ show: ctx.show, escrowUtxos: [a.escrowCoin, b.escrowCoin], locktime: 931_000 });
  assertValid(assert, built, 'settle with fee');
  const outs = built.transaction.outputs;
  assert.equal(outs.length, 4);
  assert.ok(sameBytes(outs[2].lockingBytecode, p2pkhLockingBytecode(ctx.organiser.pkh)));
  assert.equal(outs[2].valueSatoshis, 10_100n);
  assert.equal(outs[3].valueSatoshis, 10_100n);
});

test('refund: whole-show notice (C) refunds every coin, anyone can push', () => {
  const ctx = makeShow(assert);
  const a = buyOne(ctx, ctx.shardUtxos[0]);
  const b = buyOne(ctx, ctx.shardUtxos[2]);
  const message = encodeRefundNoticeMessage({ scope: 'C', category: ctx.show.category });
  assert.equal(message.length, 33);
  const signature = signDataMessage(ctx.dataKey.privateKey, message);
  const built = buildRefund({ show: ctx.show, escrowUtxos: [a.escrowCoin, b.escrowCoin], notices: [{ scope: 'C', signature }] });
  assertValid(assert, built, 'refund C');
  assert.ok(sameBytes(built.transaction.outputs[0].lockingBytecode, p2pkhLockingBytecode(a.buyer.pkh)));
  assert.ok(sameBytes(built.transaction.outputs[1].lockingBytecode, p2pkhLockingBytecode(b.buyer.pkh)));
});

test('refund: one-seat notice (R) refunds that seat', () => {
  const ctx = makeShow(assert);
  const sale = buyOne(ctx, ctx.shardUtxos[1]);
  const message = encodeRefundNoticeMessage({ scope: 'R', category: ctx.show.category, seat: sale.built.seat });
  assert.equal(message.length, 36);
  const signature = signDataMessage(ctx.dataKey.privateKey, message);
  const built = buildRefund({
    show: ctx.show,
    escrowUtxos: [sale.escrowCoin],
    notices: [{ scope: 'R', seat: sale.built.seat, signature }],
  });
  assertValid(assert, built, 'refund R');
  assert.equal(built.transaction.outputs[0].valueSatoshis, ctx.show.price + 1000n - built.fee);
});

test('closeSales: organiser closes two shards in one transaction', () => {
  const ctx = makeShow(assert);
  const sale = buyOne(ctx, ctx.shardUtxos[0]);
  const built = buildCloseSales({
    show: ctx.show,
    shardUtxos: [sale.nextShard, ctx.shardUtxos[3]],
    fundingUtxos: [fakeCoin(ctx.organiser.pkh, 20_000)],
    changeLockingBytecode: p2pkhLockingBytecode(ctx.organiser.pkh),
    signShard: ({ digest }) => signDigest(ctx.organiser.privateKey, digest),
  });
  const signed = signWallet(built, ctx.organiser.privateKey);
  assertValid(assert, signed, 'closeSales');
  const outs = signed.transaction.outputs;
  assert.deepEqual(decodeBoxOfficeCommitment(outs[0].token.nft.commitment), { open: false, shard: 0, sold: 1 });
  assert.deepEqual(decodeBoxOfficeCommitment(outs[1].token.nft.commitment), { open: false, shard: 3, sold: 0 });
  assert.equal(outs[0].token.nft.capability, 'minting');
});
