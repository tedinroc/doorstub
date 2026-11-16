import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blocksUntil,
  callEnded,
  callEndsAt,
  estimateTimeOf,
  formatBch,
  formatSats,
  formatUsd,
  nextOpenInstance,
  priceLine,
  promptForBuilt,
  prompts,
  salesOpen,
  seatLabel,
  settleOpensAt,
  settleable,
  shortOutpoint,
  shortTxid,
  showPhase,
  showsOnSale,
} from '../../src/shows/index.js';
import { buildCheckIn, buildHandBack, encodeSeat } from '../../src/tx/index.js';
import { makeMiniChain } from '../support/fake-fulcrum.js';
import { makeScenario } from '../support/scenario.js';

const sample = (id, startHeight, extra = {}) => ({ id, kind: 'sample-settle', startHeight, graceBlocks: 2, cancelled: false, ...extra });

test('nextOpenInstance: the soonest sample-settle whose sales are open (tip < startHeight)', () => {
  const shows = [sample('a3', 978_100), sample('a1', 978_028), sample('a2', 978_064), { ...sample('b', 990_000), kind: 'sample-refund-seat' }];
  assert.equal(nextOpenInstance(shows, 978_000).id, 'a1');
  assert.equal(nextOpenInstance(shows, 978_027).id, 'a1', 'one block of sales left still counts');
  assert.equal(nextOpenInstance(shows, 978_028).id, 'a2', 'at startHeight sales end');
  assert.equal(nextOpenInstance(shows, 978_027, { minBlocksLeft: 6 }).id, 'a2');
  assert.equal(nextOpenInstance(shows, 978_200), null);
  assert.equal(nextOpenInstance([sample('c', 978_028, { cancelled: true })], 978_000), null);
  assert.deepEqual(showsOnSale(shows, 978_000).map((s) => s.id), ['a1', 'b']);
});

test('a real show sells until its call ends by the page\'s clock, and until its start block whatever the clock says', () => {
  const eventAtMs = Date.parse('2026-11-24T13:00:00Z');
  const real = { id: 's1', kind: 'real', startHeight: 978_855, graceBlocks: 144, cancelled: false, eventAtMs, durationMin: 25 };
  const end = eventAtMs + 25 * 60_000;
  assert.equal(callEndsAt(real), end);
  assert.equal(callEndsAt(sample('a', 1_000)), null, 'a sample has no call');
  assert.equal(callEnded(real, end - 1), false);
  assert.equal(callEnded(real, end), true);
  assert.equal(salesOpen(real, 978_700, { now: end - 60_000 }), true, 'during the call');
  assert.equal(salesOpen(real, 978_700, { now: end }), false, 'the call is over');
  assert.equal(salesOpen(real, 978_700), true, 'without a clock only the block counts (the worker, the studio)');
  assert.equal(salesOpen(real, 978_855, { now: eventAtMs }), false, 'blocks came early: the start block ends sales during the call');
  assert.equal(salesOpen(sample('a', 1_000), 999, { now: end + 1e9 }), true, 'a sample ignores the clock');
  const shows = [sample('a1', 978_900), real];
  assert.deepEqual(showsOnSale(shows, 978_700, { now: end - 1 }).map((s) => s.id), ['a1', 's1']);
  assert.deepEqual(showsOnSale(shows, 978_700, { now: end }).map((s) => s.id), ['a1']);
});

test('phases: on sale, started, settling (settle can be mined from start + grace + 1), cancelled', () => {
  const s = sample('a', 1_000);
  assert.equal(salesOpen(s, 999), true);
  assert.equal(showPhase(s, 999), 'on-sale');
  assert.equal(showPhase(s, 1_000), 'started');
  assert.equal(settleOpensAt(s), 1_003);
  assert.equal(settleable(s, 1_001), false);
  assert.equal(settleable(s, 1_002), true, 'tip 1,002: the next block (1,003) can include it');
  assert.equal(showPhase(s, 1_002), 'settling');
  assert.equal(showPhase({ ...s, cancelled: true }, 10), 'cancelled');
  assert.equal(blocksUntil(1_003, 1_000), 3);
  assert.equal(blocksUntil(1_000, 1_003), 0);
  assert.equal(estimateTimeOf(1_006, 1_000, { now: 0 }).getTime(), 6 * 600 * 1000);
});

test('BCH amounts, sats and the dollar estimate', () => {
  assert.equal(formatBch(100_000n), '0.001 BCH');
  assert.equal(formatBch(98_500n), '0.000985 BCH');
  assert.equal(formatBch(100_000_000n), '1 BCH');
  assert.equal(formatBch(123_456_789n), '1.23456789 BCH');
  assert.equal(formatBch(0n), '0 BCH');
  assert.equal(formatSats(100_000n), '100,000 sats');
  assert.equal(formatUsd(100_000n, 207), '$0.21');
  assert.equal(formatUsd(1_000n, 207), 'less than $0.01');
  assert.equal(formatUsd(100_000n, undefined), null);
  assert.equal(formatUsd(100_000n, NaN), null);
  assert.equal(priceLine(100_000n, 207), '0.001 BCH, about $0.21');
  assert.equal(priceLine(100_000n, null), '0.001 BCH');
});

test('seat labels and short ids', () => {
  assert.equal(seatLabel(encodeSeat({ shard: 0, sold: 12 }), 'A'), 'A-0-12');
  assert.equal(seatLabel(encodeSeat({ shard: 3, sold: 1 })), '3-1');
  assert.equal(shortTxid('a7adbe50b3d95734b9e62c30a6c42d086cb6951e6c62678697601616aad44eb3'), 'a7adbe...4eb3');
  assert.equal(shortOutpoint('a7adbe50b3d95734b9e62c30a6c42d086cb6951e6c62678697601616aad44eb3', 2), 'a7adbe...4eb3:2');
});

test('wallet prompts say what the signature does and where the money goes', () => {
  const show = { price: 100_000n, seatPrefix: 'A' };
  const seat = encodeSeat({ shard: 0, sold: 12 });
  assert.equal(prompts.buy(show, seat), "Doorstub: buy seat A-0-12 for 0.001 BCH. The money waits in the show's contract.");
  assert.equal(prompts.handBack(show, seat, 99_000n), 'Doorstub: hand back seat A-0-12. 0.00099 BCH comes back to this wallet.');
  assert.match(prompts.checkIn(show, seat, 99_000n), /pays the organiser 0\.00099 BCH/);
});

test('promptForBuilt: amounts come from the built transaction itself', () => {
  const s = makeScenario(assert, makeMiniChain());
  const sale = s.buy();
  assert.match(promptForBuilt(s.show, sale.built), /^Doorstub: buy seat A-0-1 for 0\.0001 BCH\./);
  const hb = buildHandBack({ show: s.show, escrowUtxo: sale.escrowUtxo, ticketUtxo: sale.ticketUtxo, contracts: s.contracts });
  const refund = hb.transaction.outputs[0].valueSatoshis;
  assert.equal(promptForBuilt(s.show, hb), `Doorstub: hand back seat A-0-1. ${formatBch(refund)} comes back to this wallet.`);
  const ci = buildCheckIn({ show: s.show, escrowUtxo: sale.escrowUtxo, ticketUtxo: sale.ticketUtxo, contracts: s.contracts });
  assert.match(promptForBuilt(s.show, ci), new RegExp(`pays the organiser ${formatBch(ci.transaction.outputs[0].valueSatoshis).replace('.', '\\.')}`));
  assert.throws(() => promptForBuilt(s.show, { kind: 'settle' }));
});
