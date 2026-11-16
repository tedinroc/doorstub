// Size and budget limits (SPEC.md sections 6 and 9). Measured on a show with
// the largest constructor pushes the policy allows, so the numbers bound every
// valid show:
// - MIN_MINER_FEE_CAP covers the largest single-coin Escrow transaction at
//   1 sat/byte (settle and refund cannot take a fee coin from anyone else);
// - MAX_SETTLE_COINS and MAX_REFUND_COINS batches stay under 100,000 bytes and
//   pass the 2026 VM, standard and consensus, and one coin more is refused;
// - MAX_BUY_FUNDING_COINS keeps BoxOffice.buy inside its operation-cost budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVirtualMachineBch2026, encodeTransaction } from '@bitauth/libauth';
import {
  MAX_BUY_FUNDING_COINS,
  MAX_REFUND_COINS,
  MAX_SETTLE_COINS,
  MAX_STANDARD_TX_BYTES,
  MIN_MINER_FEE_CAP,
  buildBuy,
  buildCheckIn,
  buildHandBack,
  buildRefund,
  buildSettle,
} from '../src/tx/index.js';
import { fakeCoin, freshKey, makeShow, saleHeight, signWallet, utxoAt } from './helpers.js';
import { escrowCoin, expectAccept, notice, seatOf } from './kit.js';

/** Largest pushes the policy allows: 5-byte heights, 2-byte fees and cap. */
const LARGEST = { price: 100_000n, startHeight: 499_990_000, graceBlocks: 9_000, minerFeeCap: 2_000n, handBackFeeBps: 1_000, noShowFeeBps: 1_000 };
const ZERO_FEES = { ...LARGEST, handBackFeeBps: 0, noShowFeeBps: 0 };
const vm = createVirtualMachineBch2026(true);

/** k made-up escrow coins at vout 2, as buy creates them. */
const coins = (ctx, k) =>
  Array.from({ length: k }, (_, i) => ({ ...escrowCoin(ctx, { seat: seatOf(i % 256, 1 + Math.floor(i / 256)), buyerPkh: freshKey().pkh }), vout: 2 }));

const maxOperationCost = (built) => {
  let worst = { cost: 0, budget: 1 };
  built.transaction.inputs.forEach((input, inputIndex) => {
    const state = vm.evaluate({ inputIndex, sourceOutputs: built.sourceOutputs, transaction: built.transaction });
    const cost = state.metrics.operationCost;
    const budget = (41 + input.unlockingBytecode.length) * 800;
    if (cost / budget > worst.cost / worst.budget) worst = { cost, budget };
  });
  return worst;
};

test('MIN_MINER_FEE_CAP covers every single-coin Escrow transaction at 1 sat/byte', (t) => {
  for (const overrides of [{}, LARGEST, ZERO_FEES]) {
    const ctx = makeShow(assert, { overrides });
    const buyer = freshKey();
    const built = buildBuy({ show: ctx.show, boxOfficeUtxo: ctx.shardUtxos[0], fundingUtxos: [fakeCoin(buyer.pkh, 500_000)], buyerPkh: buyer.pkh, currentHeight: saleHeight(ctx.show) });
    const sale = signWallet(built, buyer.privateKey);
    const esc = utxoAt(sale.transaction, 2);
    const tkt = utxoAt(sale.transaction, 1);
    const fees = {
      checkIn: buildCheckIn({ show: ctx.show, escrowUtxo: esc, ticketUtxo: tkt }).fee,
      handBack: buildHandBack({ show: ctx.show, escrowUtxo: esc, ticketUtxo: tkt }).fee,
      settle: buildSettle({ show: ctx.show, escrowUtxos: [esc] }).fee,
      refund: buildRefund({ show: ctx.show, escrowUtxos: [esc], notices: [{ scope: 'C', signature: notice(ctx, 'C') }] }).fee,
    };
    for (const [path, fee] of Object.entries(fees)) assert.ok(fee <= MIN_MINER_FEE_CAP, `${path} needs ${fee} sats`);
    t.diagnostic(`fees at 1 sat/B: ${Object.entries(fees).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  }
});

for (const [label, overrides] of [['with a no-show fee', LARGEST], ['without fees', ZERO_FEES]]) {
  test(`settle batch ${label}: ${MAX_SETTLE_COINS} coins pass the VM under 100,000 bytes; one more is refused`, (t) => {
    const ctx = makeShow(assert, { overrides });
    const built = buildSettle({ show: ctx.show, escrowUtxos: coins(ctx, MAX_SETTLE_COINS) });
    const size = encodeTransaction(built.transaction).length;
    assert.ok(size <= MAX_STANDARD_TX_BYTES, `${size} bytes`);
    expectAccept(assert, built, `settle of ${MAX_SETTLE_COINS}`);
    const { cost, budget } = maxOperationCost(built);
    assert.ok(cost < budget / 2, `operation cost ${cost} of ${budget}`);
    t.diagnostic(`${size} bytes, worst input ${cost} of ${budget} operation cost (${((100 * cost) / budget).toFixed(1)}%)`);
    assert.throws(() => buildSettle({ show: ctx.show, escrowUtxos: coins(ctx, MAX_SETTLE_COINS + 1) }), (e) => e.code === 'batch-too-large');
  });
}

test(`refund batch: ${MAX_REFUND_COINS} coins pass the VM under 100,000 bytes; one more is refused`, (t) => {
  const ctx = makeShow(assert, { overrides: LARGEST });
  const notices = [{ scope: 'C', signature: notice(ctx, 'C') }];
  const built = buildRefund({ show: ctx.show, escrowUtxos: coins(ctx, MAX_REFUND_COINS), notices });
  const size = encodeTransaction(built.transaction).length;
  assert.ok(size <= MAX_STANDARD_TX_BYTES, `${size} bytes`);
  expectAccept(assert, built, `refund of ${MAX_REFUND_COINS}`);
  const { cost, budget } = maxOperationCost(built);
  assert.ok(cost < budget / 2, `operation cost ${cost} of ${budget}`);
  t.diagnostic(`${size} bytes, worst input ${cost} of ${budget} operation cost (${((100 * cost) / budget).toFixed(1)}%)`);
  assert.throws(() => buildRefund({ show: ctx.show, escrowUtxos: coins(ctx, MAX_REFUND_COINS + 1), notices }), (e) => e.code === 'batch-too-large');
});

test(`buy with ${MAX_BUY_FUNDING_COINS} funding coins passes the VM; one more is refused (F4)`, (t) => {
  const ctx = makeShow(assert, { overrides: LARGEST });
  const buyer = freshKey();
  const funding = (k) => Array.from({ length: k }, () => fakeCoin(buyer.pkh, 3_000));
  const args = { show: ctx.show, boxOfficeUtxo: ctx.shardUtxos[0], buyerPkh: buyer.pkh, currentHeight: saleHeight(ctx.show) };
  const built = buildBuy({ ...args, fundingUtxos: funding(MAX_BUY_FUNDING_COINS) });
  const signed = signWallet(built, buyer.privateKey);
  expectAccept(assert, signed, `buy with ${MAX_BUY_FUNDING_COINS} coins`);
  const { cost, budget } = maxOperationCost(signed);
  assert.ok(cost < budget * 0.5, `operation cost ${cost} of ${budget}`);
  t.diagnostic(`${encodeTransaction(signed.transaction).length} bytes, BoxOffice input ${cost} of ${budget} operation cost`);
  assert.throws(() => buildBuy({ ...args, fundingUtxos: funding(MAX_BUY_FUNDING_COINS + 1) }), (e) => e.code === 'too-many-inputs');
});
