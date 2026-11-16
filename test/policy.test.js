// The app's off-chain rules (SPEC.md sections 6 and 8): show policy bounds in
// validateShow, the sales end and cancel guard in buildBuy, and the builders'
// refusal to return a transaction the network would not relay. Where a rule
// exists because BCH cannot enforce it, a LIMIT case shows the chain accepting
// what the builder refuses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeDataPush, flattenBinArray } from '@bitauth/libauth';
import {
  MAX_MINER_FEE_CAP,
  MAX_POSTED_FEE_BPS,
  MIN_MINER_FEE_CAP,
  MIN_PRICE,
  SEQUENCE_LOCKTIME,
  boxOfficeContract,
  buildBuy,
  buildCheckIn,
  buildGenesis,
  buildHandBack,
  buildRefund,
  buildSettle,
  escrowContract,
  validateShow,
} from '../src/tx/index.js';
import { fakeCoin, freshKey, makeShow, saleHeight, sampleShowParams, signWallet, utxoAt } from './helpers.js';
import { assemble, coinValue, escrowCoin, expectAccept, honestBuy, notice, p2pkh, seatOf, settleHeight, ticketCoin } from './kit.js';

const code = (expected) => (error) => error.code === expected;
const showWith = (overrides) => ({ ...sampleShowParams(freshKey(), freshKey(), overrides), category: crypto.getRandomValues(new Uint8Array(32)) });

test('policy constants: cap 1,200 to 2,000 sats and at most 20% of the price, fees at most 10%, price at least 6,000', () => {
  assert.equal(MIN_MINER_FEE_CAP, 1_200n);
  assert.equal(MAX_MINER_FEE_CAP, 2_000n);
  assert.equal(MAX_POSTED_FEE_BPS, 1_000n);
  assert.equal(MIN_PRICE, 6_000n);
});

test('validateShow accepts the bounds themselves', () => {
  validateShow(showWith({}));
  validateShow(showWith({ minerFeeCap: 2_000n }));
  validateShow(showWith({ price: 6_000n, minerFeeCap: 1_200n }));
  validateShow(showWith({ price: 100_000n, minerFeeCap: 2_000n, handBackFeeBps: 1_000, noShowFeeBps: 1_000 }));
});

test('REJECT validateShow: minerFeeCap over 2,000, over 20% of the price or under 1,200; fees over 1,000 bps; price under 6,000', () => {
  for (const overrides of [
    { minerFeeCap: 2_001n, price: 100_000n },
    { minerFeeCap: 5_000n },
    { minerFeeCap: 1_501n, price: 7_500n },
    { minerFeeCap: 1_199n },
    { minerFeeCap: 0n },
    { handBackFeeBps: 1_001 },
    { noShowFeeBps: 1_001 },
    { noShowFeeBps: 10_000 },
    { price: 5_999n, minerFeeCap: 1_200n },
    { price: 0n },
  ]) {
    assert.throws(() => validateShow(showWith(overrides)), code('bad-show'), JSON.stringify(overrides, (_, v) => (typeof v === 'bigint' ? `${v}` : v)));
  }
});

test('REJECT buildGenesis and buildBuy on a show outside the policy (a caller-supplied contracts object does not skip it)', () => {
  const organiser = freshKey();
  assert.throws(
    () => buildGenesis({ show: sampleShowParams(organiser, freshKey(), { minerFeeCap: 5_000n }), shards: 1, fundingUtxos: [fakeCoin(organiser.pkh, 50_000)] }),
    code('bad-show'),
  );
  const ctx = makeShow(assert);
  const wide = { ...ctx.show, minerFeeCap: 5_000n };
  const escrow = escrowContract(wide);
  const contracts = { escrow, boxOffice: boxOfficeContract(wide, escrow.lockingBytecode) };
  const buyer = freshKey();
  assert.throws(
    () => buildBuy({ show: wide, contracts, boxOfficeUtxo: ctx.shardUtxos[0], fundingUtxos: [fakeCoin(buyer.pkh, 50_000)], buyerPkh: buyer.pkh, currentHeight: saleHeight(ctx.show) }),
    code('bad-show'),
  );
});

test('REJECT buildBuy at or after startHeight, without a height, or after a valid cancel notice (M3)', () => {
  const ctx = makeShow(assert);
  const buyer = freshKey();
  const buy = (extra) => buildBuy({ show: ctx.show, boxOfficeUtxo: ctx.shardUtxos[0], fundingUtxos: [fakeCoin(buyer.pkh, 50_000)], buyerPkh: buyer.pkh, ...extra });
  const start = Number(ctx.show.startHeight);
  buy({ currentHeight: start - 1 });
  assert.throws(() => buy({ currentHeight: start }), code('sales-ended'));
  assert.throws(() => buy({ currentHeight: settleHeight(ctx) + 5_000 }), code('sales-ended'));
  assert.throws(() => buy({}), code('no-height'));
  assert.throws(() => buy({ currentHeight: -1 }), code('no-height'));
  const cancel = { scope: 'C', signature: notice(ctx, 'C') };
  assert.throws(() => buy({ currentHeight: start - 1, notices: [cancel] }), code('sales-cancelled'));
  const forged = { scope: 'C', signature: notice(ctx, 'C', undefined, freshKey()) };
  assert.throws(() => buy({ currentHeight: start - 1, notices: [forged] }), code('bad-notice'));
  // A one-seat notice ('R') refunds one sold seat; it does not end sales.
  buy({ currentHeight: start - 1, notices: [{ scope: 'R', seat: seatOf(0, 1), signature: notice(ctx, 'R', seatOf(0, 1)) }] });
});

test('LIMIT buy has no deadline on chain: a late buy is valid and can be settled at once, so only the builder stops it (M3)', () => {
  const ctx = makeShow(assert);
  const h = honestBuy(ctx);
  const late = settleHeight(ctx) + 5_000;
  const bought = assemble({
    inputs: [{ ...h.inputs[0], sequence: SEQUENCE_LOCKTIME }, h.inputs[1]],
    outputs: h.outputs,
    locktime: late,
  });
  expectAccept(assert, bought, 'a buy locked to a height long after the show');
  const settled = buildSettle({ show: ctx.show, escrowUtxos: [utxoAt(bought.transaction, 2)], locktime: late });
  expectAccept(assert, settled, 'settled in the same block');
});

test('LIMIT a cancel notice also refunds seats sold after it was signed (M3)', () => {
  const ctx = makeShow(assert);
  const signedBefore = { scope: 'C', signature: notice(ctx, 'C') };
  const sale = assemble(honestBuy(ctx));
  expectAccept(assert, sale);
  expectAccept(assert, buildRefund({ show: ctx.show, escrowUtxos: [utxoAt(sale.transaction, 2)], notices: [signedBefore] }));
});

// The builders' dust guard. Inside the policy every honest output is far above
// dust (SPEC.md section 6), so these cases use a show deployed by hand with
// contracts the builders are handed directly, which skips validateShow.
const handDeployed = (overrides) => {
  const organiser = freshKey();
  const dataKey = freshKey();
  const show = { ...sampleShowParams(organiser, dataKey, overrides), category: crypto.getRandomValues(new Uint8Array(32)) };
  const escrow = escrowContract(show);
  return { organiser, dataKey, show, contracts: { escrow, boxOffice: boxOfficeContract(show, escrow.lockingBytecode) } };
};

test('REJECT builders return negative or sub-dust outputs (M5, F3)', () => {
  // price 0: a check-in would pay the organiser 1,000 - 1,066 sats; a settle refund 1,000 - 823.
  const cheap = handDeployed({ price: 0n, minerFeeCap: 2_000n });
  const buyer = freshKey();
  const seat = seatOf(0, 1);
  const esc = { ...escrowCoin(cheap, { seat, buyerPkh: buyer.pkh, value: 1_000n }), vout: 2 };
  const tkt = ticketCoin(cheap, { seat, buyerPkh: buyer.pkh });
  const args = { show: cheap.show, contracts: cheap.contracts };
  assert.throws(() => buildCheckIn({ ...args, escrowUtxo: esc, ticketUtxo: tkt }), code('negative-output'));
  assert.throws(() => buildSettle({ ...args, escrowUtxos: [esc] }), code('dust-output'));
  assert.throws(() => buildRefund({ ...args, escrowUtxos: [esc], notices: [{ scope: 'C', signature: notice(cheap, 'C') }] }), code('dust-output'));
  // 95% fees: the refund would be negative.
  const greedy = handDeployed({ handBackFeeBps: 9_500, noShowFeeBps: 9_500 });
  const gEsc = escrowCoin(greedy, { seat, buyerPkh: buyer.pkh });
  const gTkt = ticketCoin(greedy, { seat, buyerPkh: buyer.pkh });
  assert.throws(() => buildHandBack({ show: greedy.show, contracts: greedy.contracts, escrowUtxo: gEsc, ticketUtxo: gTkt }), code('negative-output'));
  assert.throws(() => buildSettle({ show: greedy.show, contracts: greedy.contracts, escrowUtxos: [gEsc] }), code('negative-output'));
});

test('REJECT a genesis data output that is not OP_RETURN + pushes, or longer than 222 bytes (F3)', () => {
  const organiser = freshKey();
  const genesis = (dataOutput) =>
    buildGenesis({ show: sampleShowParams(organiser, freshKey()), shards: 1, fundingUtxos: [fakeCoin(organiser.pkh, 50_000)], changeLockingBytecode: p2pkh(organiser.pkh), dataOutput });
  const opReturn = (n) => flattenBinArray([Uint8Array.of(0x6a), encodeDataPush(new Uint8Array(n))]);
  assert.equal(opReturn(219).length, 222);
  const ok = genesis(opReturn(219));
  expectAccept(assert, signWallet(ok, organiser.privateKey), '222-byte data output');
  assert.throws(() => genesis(opReturn(220)), code('bad-data-output'));
  assert.throws(() => genesis(p2pkh(organiser.pkh)), code('bad-data-output'));
  assert.throws(() => genesis(Uint8Array.of(0x6a, 0x76)), code('bad-data-output'), 'OP_RETURN followed by a non-push');
});

test('every honest output of a policy-valid show stays far above dust, even at the policy edges', () => {
  // price 6,000, cap 1,200, both fees 10%: the smallest payouts the policy allows.
  const ctx = makeShow(assert, { overrides: { price: 6_000n, minerFeeCap: 1_200n, handBackFeeBps: 1_000, noShowFeeBps: 1_000 } });
  const sale = honestBuy(ctx);
  const signed = assemble(sale);
  expectAccept(assert, signed);
  const esc = utxoAt(signed.transaction, 2);
  const tkt = utxoAt(signed.transaction, 1);
  const smallest = (built) => built.transaction.outputs.reduce((m, o) => (o.valueSatoshis < m ? o.valueSatoshis : m), 10n ** 15n);
  const built = [
    buildHandBack({ show: ctx.show, escrowUtxo: esc, ticketUtxo: tkt }),
    buildCheckIn({ show: ctx.show, escrowUtxo: esc, ticketUtxo: tkt }),
    buildSettle({ show: ctx.show, escrowUtxos: [esc] }),
    buildRefund({ show: ctx.show, escrowUtxos: [esc], notices: [{ scope: 'C', signature: notice(ctx, 'C') }] }),
  ];
  for (const b of built) {
    assert.ok(smallest(b) >= 546n, `${b.kind}: smallest output ${smallest(b)}`);
    const resolved = b.walletInputIndexes.length ? signWallet(b, sale.buyer.privateKey) : b;
    expectAccept(assert, resolved, b.kind);
  }
  assert.equal(coinValue(ctx), 7_000n);
});

test('settle and refund fail with a clear code when a coin is not this show\'s', () => {
  const ctx = makeShow(assert);
  const other = makeShow(assert);
  const stranger = escrowCoin(other, { buyerPkh: freshKey().pkh });
  assert.throws(() => buildSettle({ show: ctx.show, escrowUtxos: [stranger] }), code('wrong-escrow'));
  assert.throws(() => buildRefund({ show: ctx.show, escrowUtxos: [stranger], notices: [{ scope: 'C', signature: notice(ctx, 'C') }] }), code('wrong-escrow'));
});
