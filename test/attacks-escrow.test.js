// Attacks on Escrow (handBack, checkIn, settle, refund, and mixed paths). Each
// case asserts the 2026 VM rejects in standard AND consensus mode and names the
// input whose own rule stops it. Honest controls sit next to the attacks they
// bound; LIMIT cases pin documented limits (SPEC.md section 8) so a change in
// behaviour shows up here.
//
// Sample show: price 10,000 sats, so an escrow coin holds V = 11,000;
// minerFeeCap 5,000; settle opens at locktime 930,144.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenBinArray } from '@bitauth/libauth';
import {
  buildBuy,
  buildCheckIn,
  encodeMarkerCommitment,
  encodeRefundNoticeMessage,
  encodeTicketCommitment,
  scopeByte,
} from '../src/tx/index.js';
import { signDataMessage } from '../src/tx/sign.js';
import { fakeCoin, freshKey, makeShow, signWallet, utxoAt } from './helpers.js';
import {
  SEQUENCE_LOCKTIME,
  assemble,
  closeSalesUnlock,
  coin,
  coinValue,
  escrowCoin,
  escrowUnlock,
  expectAccept,
  expectReject,
  nftOut,
  notice,
  out,
  p2pkh,
  rawUnlock,
  seatOf,
  settleHeight,
  ticketCoin,
  why,
} from './kit.js';

const CAP = 5_000n;

/** A sold seat as made-up coins: the escrow coin and the matching ticket at the buyer's address. */
const sale = (ctx, { buyer = freshKey(), seat = seatOf(0, 1) } = {}) => ({
  buyer,
  seat,
  esc: escrowCoin(ctx, { seat, buyerPkh: buyer.pkh }),
  tkt: ticketCoin(ctx, { seat, buyerPkh: buyer.pkh }),
});

/** The ticket again as an output (keepsake) at `lock`. */
const keepsakeOut = (ctx, s, lock = p2pkh(s.buyer.pkh), commitment = encodeTicketCommitment(s.seat, s.buyer.pkh)) =>
  nftOut(lock, 1000, { category: ctx.show.category, commitment });

const settleInput = (ctx, esc) => ({ coin: esc, unlock: escrowUnlock(ctx).settle(), sequence: SEQUENCE_LOCKTIME });
const refundInput = (ctx, esc, signature, scope) => ({ coin: esc, unlock: escrowUnlock(ctx).refund(signature, scope) });

describe('Escrow.handBack attacks', () => {
  /** Honest hand-back: input 0 escrow, input 1 ticket; one refund output. */
  const honest = (ctx, s, outputs = [out(p2pkh(s.buyer.pkh), coinValue(ctx))]) =>
    assemble({
      inputs: [
        { coin: s.esc, unlock: escrowUnlock(ctx).handBack(1) },
        { coin: s.tkt, signer: s.buyer },
      ],
      outputs,
    });

  test('control: an honest hand-back passes', () => {
    const ctx = makeShow(assert);
    expectAccept(assert, honest(ctx, sale(ctx)));
  });

  test('REJECT hand-back by a non-holder: ticket moved to the attacker\'s address', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const thief = freshKey();
    const moved = ticketCoin(ctx, { seat: s.seat, buyerPkh: s.buyer.pkh, holderLock: p2pkh(thief.pkh) });
    const resolved = assemble({
      inputs: [
        { coin: s.esc, unlock: escrowUnlock(ctx).handBack(1) },
        { coin: moved, signer: thief },
      ],
      outputs: [out(p2pkh(s.buyer.pkh), coinValue(ctx))],
    });
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT hand-back forced by a non-holder: ticket at the buyer\'s address, signed by another key', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const thief = freshKey();
    const resolved = assemble({
      inputs: [
        { coin: s.esc, unlock: escrowUnlock(ctx).handBack(1) },
        { coin: s.tkt, signer: thief },
      ],
      outputs: [out(p2pkh(s.buyer.pkh), coinValue(ctx))],
    });
    // Escrow's own rules hold (refund goes to the buyer); only the holder's key can spend the ticket.
    t.diagnostic(why(expectReject(assert, resolved, { failing: 1 })));
  });

  test('REJECT ticket-marker mismatch: the buyer\'s ticket for another seat', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const otherSeat = ticketCoin(ctx, { seat: seatOf(0, 2), buyerPkh: s.buyer.pkh });
    t.diagnostic(why(expectReject(assert, honest(ctx, { ...s, tkt: otherSeat }), { failing: 0 })));
  });

  test('REJECT ticket-marker mismatch: same seat, ticket names another pkh', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const thief = freshKey();
    const forged = ticketCoin(ctx, { seat: s.seat, buyerPkh: thief.pkh });
    const resolved = assemble({
      inputs: [
        { coin: s.esc, unlock: escrowUnlock(ctx).handBack(1) },
        { coin: forged, signer: thief },
      ],
      outputs: [out(p2pkh(s.buyer.pkh), coinValue(ctx))],
    });
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT wrong category: a look-alike ticket of another token category', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const lookAlike = ticketCoin(ctx, { seat: s.seat, buyerPkh: s.buyer.pkh, category: crypto.getRandomValues(new Uint8Array(32)) });
    t.diagnostic(why(expectReject(assert, honest(ctx, { ...s, tkt: lookAlike }), { failing: 0 })));
  });

  test('REJECT a mutable NFT with the ticket\'s exact commitment', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const mutable = ticketCoin(ctx, { seat: s.seat, buyerPkh: s.buyer.pkh, capability: 'mutable' });
    t.diagnostic(why(expectReject(assert, honest(ctx, { ...s, tkt: mutable }), { failing: 0 })));
  });

  test('REJECT 41-byte ticket commitment (ticket bytes + 17 padding)', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const commitment = flattenBinArray([encodeTicketCommitment(s.seat, s.buyer.pkh), new Uint8Array(17)]);
    assert.equal(commitment.length, 41);
    const long = ticketCoin(ctx, { seat: s.seat, buyerPkh: s.buyer.pkh, commitment });
    t.diagnostic(why(expectReject(assert, honest(ctx, { ...s, tkt: long }), { failing: 0 })));
  });

  test('REJECT 41-byte marker commitment on the escrow coin', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const commitment = flattenBinArray([encodeMarkerCommitment(s.seat, s.buyer.pkh), new Uint8Array(17)]);
    const long = escrowCoin(ctx, { seat: s.seat, buyerPkh: s.buyer.pkh, commitment });
    t.diagnostic(why(expectReject(assert, honest(ctx, { ...s, esc: long }), { failing: 0 })));
  });

  test('REJECT ticketInputIndex pointing at the escrow coin itself, out of range, or negative', (t) => {
    const ctx = makeShow(assert);
    for (const index of [0, 5, -1]) {
      const s = sale(ctx);
      const resolved = assemble({
        inputs: [
          { coin: s.esc, unlock: escrowUnlock(ctx).handBack(index) },
          { coin: s.tkt, signer: s.buyer },
        ],
        outputs: [out(p2pkh(s.buyer.pkh), coinValue(ctx))],
      });
      t.diagnostic(`index ${index}: ${why(expectReject(assert, resolved, { failing: 0 }))}`);
    }
  });

  test('REJECT refund sent to another address (a dapp redirecting the hand-back)', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    t.diagnostic(why(expectReject(assert, honest(ctx, s, [out(p2pkh(freshKey().pkh), coinValue(ctx))]), { failing: 0 })));
  });

  test('control + REJECT fee drain: refund at V - cap passes, V - cap - 1 fails', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const skimmer = p2pkh(freshKey().pkh);
    const V = coinValue(ctx);
    expectAccept(assert, honest(ctx, s, [out(p2pkh(s.buyer.pkh), V - CAP), out(skimmer, CAP)]), 'at the cap');
    const resolved = honest(ctx, s, [out(p2pkh(s.buyer.pkh), V - CAP - 1n), out(skimmer, CAP + 1n)]);
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT the ticket survives the hand-back (sent back to the holder)', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const resolved = honest(ctx, s, [out(p2pkh(s.buyer.pkh), coinValue(ctx) - 1000n), keepsakeOut(ctx, s)]);
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT the marker survives the hand-back (coin kept alive with 1,000 sats)', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const marker = nftOut(ctx.contracts.escrow.lockingBytecode, 1000, {
      category: ctx.show.category,
      commitment: encodeMarkerCommitment(s.seat, s.buyer.pkh),
    });
    const resolved = honest(ctx, s, [out(p2pkh(s.buyer.pkh), coinValue(ctx) - 1000n), marker]);
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT double satisfaction: two coins of one buyer, one refund output', (t) => {
    const ctx = makeShow(assert);
    const buyer = freshKey();
    const a = sale(ctx, { buyer, seat: seatOf(0, 1) });
    const b = sale(ctx, { buyer, seat: seatOf(0, 2) });
    const V = coinValue(ctx);
    const resolved = assemble({
      inputs: [
        { coin: a.esc, unlock: escrowUnlock(ctx).handBack(2) },
        { coin: b.esc, unlock: escrowUnlock(ctx).handBack(3) },
        { coin: a.tkt, signer: buyer },
        { coin: b.tkt, signer: buyer },
      ],
      outputs: [out(p2pkh(buyer.pkh), V), out(p2pkh(freshKey().pkh), V)],
    });
    t.diagnostic(why(expectReject(assert, resolved, { failing: 1 })));
  });

  describe('with a posted hand-back fee (price 100,000, 500 bps: fee 5,050)', () => {
    const feeShow = () => makeShow(assert, { overrides: { price: 100_000n, handBackFeeBps: 500 } });
    const FEE = 5_050n;
    const twoOut = (ctx, s, refund, fee, feeLock) => [
      out(p2pkh(s.buyer.pkh), refund),
      out(p2pkh(s.buyer.pkh), 1000),
      out(feeLock ?? p2pkh(ctx.organiser.pkh), fee),
    ];

    test('control: refund V - fee - cap with the fee at index 0 + inputCount passes', () => {
      const ctx = feeShow();
      const s = sale(ctx);
      expectAccept(assert, honest(ctx, s, twoOut(ctx, s, coinValue(ctx) - FEE - CAP, FEE)));
    });

    test('REJECT fee above the posted bps (organiser over-paid out of the refund)', (t) => {
      const ctx = feeShow();
      const s = sale(ctx);
      const resolved = honest(ctx, s, twoOut(ctx, s, coinValue(ctx) - FEE - CAP - 1n, FEE + CAP));
      t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
    });

    test('REJECT fee output missing', (t) => {
      const ctx = feeShow();
      const s = sale(ctx);
      const resolved = honest(ctx, s, [out(p2pkh(s.buyer.pkh), coinValue(ctx) - FEE), out(p2pkh(s.buyer.pkh), 1000)]);
      t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
    });

    test('REJECT fee paid to someone other than the organiser payee', (t) => {
      const ctx = feeShow();
      const s = sale(ctx);
      const resolved = honest(ctx, s, twoOut(ctx, s, coinValue(ctx) - FEE - 1000n, FEE, p2pkh(freshKey().pkh)));
      t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
    });

    test('REJECT fee short by 1 sat', (t) => {
      const ctx = feeShow();
      const s = sale(ctx);
      const resolved = honest(ctx, s, twoOut(ctx, s, coinValue(ctx) - FEE, FEE - 1n));
      t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
    });

    test('REJECT fee double-counted: one fee output for two coins', (t) => {
      const ctx = feeShow();
      const buyer = freshKey();
      const a = sale(ctx, { buyer, seat: seatOf(0, 1) });
      const b = sale(ctx, { buyer, seat: seatOf(0, 2) });
      const V = coinValue(ctx);
      const org = p2pkh(ctx.organiser.pkh);
      const resolved = assemble({
        inputs: [
          { coin: a.esc, unlock: escrowUnlock(ctx).handBack(2) },
          { coin: b.esc, unlock: escrowUnlock(ctx).handBack(3) },
          { coin: a.tkt, signer: buyer },
          { coin: b.tkt, signer: buyer },
        ],
        // fee slots are 0 + 4 and 1 + 4; slot 5 is missing
        outputs: [out(p2pkh(buyer.pkh), V - FEE), out(p2pkh(buyer.pkh), V - FEE), out(p2pkh(buyer.pkh), 1000), out(p2pkh(buyer.pkh), 1000), out(org, FEE)],
      });
      t.diagnostic(why(expectReject(assert, resolved, { failing: 1 })));
    });
  });
});

describe('Escrow.checkIn attacks', () => {
  /** Honest check-in: input 0 escrow, input 1 ticket; outputs organiser payout, keepsake. */
  const honest = (ctx, s, outputs) =>
    assemble({
      inputs: [
        { coin: s.esc, unlock: escrowUnlock(ctx).checkIn(1) },
        { coin: s.tkt, signer: s.buyer },
      ],
      outputs: outputs ?? [out(p2pkh(ctx.organiser.pkh), coinValue(ctx) - 1000n), keepsakeOut(ctx, s)],
    });

  test('control: an honest check-in passes', () => {
    const ctx = makeShow(assert);
    expectAccept(assert, honest(ctx, sale(ctx)));
  });

  test('REJECT check-in by a non-holder: ticket moved to the attacker\'s address', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const thief = freshKey();
    const moved = ticketCoin(ctx, { seat: s.seat, buyerPkh: s.buyer.pkh, holderLock: p2pkh(thief.pkh) });
    const resolved = assemble({
      inputs: [
        { coin: s.esc, unlock: escrowUnlock(ctx).checkIn(1) },
        { coin: moved, signer: thief },
      ],
      outputs: [out(p2pkh(ctx.organiser.pkh), coinValue(ctx) - 1000n), keepsakeOut(ctx, s, p2pkh(thief.pkh))],
    });
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT check-in forced by the organiser without the holder\'s signature', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const resolved = assemble({
      inputs: [
        { coin: s.esc, unlock: escrowUnlock(ctx).checkIn(1) },
        { coin: s.tkt, signer: ctx.organiser },
      ],
      outputs: [out(p2pkh(ctx.organiser.pkh), coinValue(ctx) - 1000n), keepsakeOut(ctx, s)],
    });
    // The escrow rules hold on their own; the ticket's P2PKH needs the holder's key.
    t.diagnostic(why(expectReject(assert, resolved, { failing: 1 })));
  });

  test('REJECT payout to the holder instead of the organiser', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const resolved = honest(ctx, s, [out(p2pkh(s.buyer.pkh), coinValue(ctx) - 1000n), keepsakeOut(ctx, s)]);
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('control + REJECT payout floor: organiser gets V - cap (passes), V - cap - 1 (fails)', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const V = coinValue(ctx);
    const holder = p2pkh(s.buyer.pkh);
    expectAccept(assert, honest(ctx, s, [out(p2pkh(ctx.organiser.pkh), V - CAP), keepsakeOut(ctx, s), out(holder, CAP - 1000n)]), 'LIMIT: holder keeps up to cap - miner fee');
    const resolved = honest(ctx, s, [out(p2pkh(ctx.organiser.pkh), V - CAP - 1n), keepsakeOut(ctx, s), out(holder, CAP - 999n)]);
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT keepsake sent somewhere other than the buyer\'s address', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const resolved = honest(ctx, s, [out(p2pkh(ctx.organiser.pkh), coinValue(ctx) - 1000n), keepsakeOut(ctx, s, p2pkh(freshKey().pkh))]);
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT keepsake missing (ticket burned instead)', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const resolved = honest(ctx, s, [out(p2pkh(ctx.organiser.pkh), coinValue(ctx) - 1000n), out(p2pkh(s.buyer.pkh), 1000)]);
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT keepsake at the wrong index', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const resolved = honest(ctx, s, [
      out(p2pkh(ctx.organiser.pkh), coinValue(ctx) - 2000n),
      out(p2pkh(s.buyer.pkh), 1000),
      keepsakeOut(ctx, s),
    ]);
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT keepsake re-labelled as a marker and parked at the Escrow', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const asMarker = keepsakeOut(ctx, s, ctx.contracts.escrow.lockingBytecode, encodeMarkerCommitment(s.seat, s.buyer.pkh));
    const resolved = honest(ctx, s, [out(p2pkh(ctx.organiser.pkh), coinValue(ctx) - 1000n), asMarker]);
    // The token rules also refuse (an immutable NFT cannot change its commitment).
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT the marker carried forward next to the keepsake (escrow coin kept alive)', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const marker = nftOut(ctx.contracts.escrow.lockingBytecode, 1000, {
      category: ctx.show.category,
      commitment: encodeMarkerCommitment(s.seat, s.buyer.pkh),
    });
    const resolved = honest(ctx, s, [out(p2pkh(ctx.organiser.pkh), coinValue(ctx) - 2000n), keepsakeOut(ctx, s), marker]);
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT ticket-marker mismatch: the holder\'s ticket for another seat', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const other = { ...s, seat: seatOf(1, 1), tkt: ticketCoin(ctx, { seat: seatOf(1, 1), buyerPkh: s.buyer.pkh }) };
    const resolved = assemble({
      inputs: [
        { coin: s.esc, unlock: escrowUnlock(ctx).checkIn(1) },
        { coin: other.tkt, signer: s.buyer },
      ],
      outputs: [out(p2pkh(ctx.organiser.pkh), coinValue(ctx) - 1000n), keepsakeOut(ctx, other)],
    });
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT replay: a checked-in keepsake used to check in the holder\'s other seat', (t) => {
    const ctx = makeShow(assert);
    const holder = freshKey();
    const buy = (shard) => {
      const built = buildBuy({ show: ctx.show, boxOfficeUtxo: shard, fundingUtxos: [fakeCoin(holder.pkh, 50_000)], buyerPkh: holder.pkh });
      const signed = signWallet(built, holder.privateKey);
      return { seat: built.seat, ticket: utxoAt(signed.transaction, 1), esc: utxoAt(signed.transaction, 2) };
    };
    const one = buy(ctx.shardUtxos[0]);
    const two = buy(ctx.shardUtxos[1]);
    const first = signWallet(buildCheckIn({ show: ctx.show, escrowUtxo: one.esc, ticketUtxo: one.ticket }), holder.privateKey);
    expectAccept(assert, first, 'first check-in');
    const keepsake = utxoAt(first.transaction, 1);
    const resolved = assemble({
      inputs: [
        { coin: two.esc, unlock: escrowUnlock(ctx).checkIn(1) },
        { coin: keepsake, signer: holder },
      ],
      outputs: [out(p2pkh(ctx.organiser.pkh), coinValue(ctx) - 1000n), { ...keepsake.output }],
    });
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT two check-ins in one transaction (each sees the other\'s keepsake)', (t) => {
    const ctx = makeShow(assert);
    const holder = freshKey();
    const a = sale(ctx, { buyer: holder, seat: seatOf(0, 1) });
    const b = sale(ctx, { buyer: holder, seat: seatOf(0, 2) });
    const org = p2pkh(ctx.organiser.pkh);
    const resolved = assemble({
      inputs: [
        { coin: a.esc, unlock: escrowUnlock(ctx).checkIn(2) },
        { coin: b.esc, unlock: escrowUnlock(ctx).checkIn(3) },
        { coin: a.tkt, signer: holder },
        { coin: b.tkt, signer: holder },
      ],
      outputs: [out(org, coinValue(ctx) - 1000n), out(org, coinValue(ctx) - 1000n), keepsakeOut(ctx, a), keepsakeOut(ctx, b)],
    });
    t.diagnostic(why(expectReject(assert, resolved, { failing: [0, 1] })));
  });

  test('REJECT double satisfaction: one organiser payout for two check-ins', (t) => {
    const ctx = makeShow(assert);
    const holder = freshKey();
    const a = sale(ctx, { buyer: holder, seat: seatOf(0, 1) });
    const b = sale(ctx, { buyer: holder, seat: seatOf(0, 2) });
    const resolved = assemble({
      inputs: [
        { coin: a.esc, unlock: escrowUnlock(ctx).checkIn(2) },
        { coin: b.esc, unlock: escrowUnlock(ctx).checkIn(3) },
        { coin: a.tkt, signer: holder },
        { coin: b.tkt, signer: holder },
      ],
      outputs: [out(p2pkh(ctx.organiser.pkh), coinValue(ctx)), out(p2pkh(holder.pkh), coinValue(ctx) - 1000n), keepsakeOut(ctx, a), keepsakeOut(ctx, b)],
    });
    t.diagnostic(why(expectReject(assert, resolved, { failing: [0, 1] })));
  });

  test('LIMIT check-in still works after the show starts (no expiry on BCH)', () => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const resolved = assemble({
      inputs: [
        { coin: s.esc, unlock: escrowUnlock(ctx).checkIn(1), sequence: SEQUENCE_LOCKTIME },
        { coin: s.tkt, signer: s.buyer },
      ],
      outputs: [out(p2pkh(ctx.organiser.pkh), coinValue(ctx) - 1000n), keepsakeOut(ctx, s)],
      locktime: settleHeight(ctx) + 10_000,
    });
    expectAccept(assert, resolved, 'late check-in');
  });
});

describe('Escrow.settle attacks', () => {
  const honest = (ctx, coins, outputs, { locktime = settleHeight(ctx) } = {}) =>
    assemble({ inputs: coins.map((s) => settleInput(ctx, s.esc)), outputs, locktime });
  const refundAll = (ctx, coins, less = 500n) => coins.map((s) => out(p2pkh(s.buyer.pkh), coinValue(ctx) - less));

  test('control: settle at exactly startHeight + grace passes, and later too', () => {
    const ctx = makeShow(assert);
    const coins = [sale(ctx), sale(ctx, { seat: seatOf(1, 1) })];
    expectAccept(assert, honest(ctx, coins, refundAll(ctx, coins)), 'at the threshold');
    expectAccept(assert, honest(ctx, coins, refundAll(ctx, coins), { locktime: settleHeight(ctx) + 50_000 }), 'later');
  });

  test('REJECT settle before startHeight + grace (locktime one block early)', (t) => {
    const ctx = makeShow(assert);
    const coins = [sale(ctx)];
    const resolved = honest(ctx, coins, refundAll(ctx, coins), { locktime: settleHeight(ctx) - 1 });
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT locktime trick: a timestamp locktime (>= 500,000,000) instead of a height', (t) => {
    const ctx = makeShow(assert);
    const coins = [sale(ctx)];
    const resolved = honest(ctx, coins, refundAll(ctx, coins), { locktime: 1_800_000_000 });
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT locktime trick: final sequence number (locktime switched off)', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const resolved = assemble({
      inputs: [{ coin: s.esc, unlock: escrowUnlock(ctx).settle() }], // sequence 0xffffffff
      outputs: refundAll(ctx, [s]),
      locktime: settleHeight(ctx),
    });
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT settle paying the pusher instead of the buyer', (t) => {
    const ctx = makeShow(assert);
    const coins = [sale(ctx)];
    const resolved = honest(ctx, coins, [out(p2pkh(freshKey().pkh), coinValue(ctx) - 500n)]);
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('LIMIT + REJECT pusher skim: up to minerFeeCap passes, one sat more fails', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const pusher = p2pkh(freshKey().pkh);
    const V = coinValue(ctx);
    expectAccept(assert, honest(ctx, [s], [out(p2pkh(s.buyer.pkh), V - CAP), out(pusher, CAP - 1000n)]), 'LIMIT: pusher keeps up to cap - miner fee');
    const resolved = honest(ctx, [s], [out(p2pkh(s.buyer.pkh), V - CAP - 1n), out(pusher, CAP - 999n)]);
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT double satisfaction: two coins of one buyer, one refund output', (t) => {
    const ctx = makeShow(assert);
    const buyer = freshKey();
    const coins = [sale(ctx, { buyer, seat: seatOf(0, 1) }), sale(ctx, { buyer, seat: seatOf(0, 2) })];
    const resolved = honest(ctx, coins, [out(p2pkh(buyer.pkh), coinValue(ctx)), out(p2pkh(freshKey().pkh), coinValue(ctx) - 1000n)]);
    t.diagnostic(why(expectReject(assert, resolved, { failing: 1 })));
  });

  test('REJECT settle that keeps the marker alive (1,000 sats left at the Escrow)', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const marker = nftOut(ctx.contracts.escrow.lockingBytecode, 1000, {
      category: ctx.show.category,
      commitment: encodeMarkerCommitment(s.seat, s.buyer.pkh),
    });
    const resolved = honest(ctx, [s], [out(p2pkh(s.buyer.pkh), coinValue(ctx) - 1500n), marker]);
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT settle that also mints (leaked minting NFT mints a fresh marker)', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const minter = freshKey();
    const leaked = coin(
      nftOut(p2pkh(minter.pkh), 20_000, { category: ctx.show.category, commitment: Uint8Array.of(1, 9, 0, 0), capability: 'minting' }),
    );
    const fresh = nftOut(ctx.contracts.escrow.lockingBytecode, 1000, {
      category: ctx.show.category,
      commitment: encodeMarkerCommitment(seatOf(9, 1), minter.pkh),
    });
    const resolved = assemble({
      inputs: [settleInput(ctx, s.esc), { coin: leaked, signer: minter }],
      outputs: [out(p2pkh(s.buyer.pkh), coinValue(ctx) - 500n), out(p2pkh(minter.pkh), 18_000), fresh],
      locktime: settleHeight(ctx),
    });
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT settle on a ticket parked at the Escrow address (tag T, not E)', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const parked = ticketCoin(ctx, { seat: s.seat, buyerPkh: s.buyer.pkh, holderLock: ctx.contracts.escrow.lockingBytecode, value: 11_000n });
    const resolved = assemble({ inputs: [settleInput(ctx, parked)], outputs: refundAll(ctx, [s]), locktime: settleHeight(ctx) });
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  describe('with a posted no-show fee (price 100,000, 1,000 bps: fee 10,100)', () => {
    const feeShow = () => makeShow(assert, { overrides: { price: 100_000n, noShowFeeBps: 1000 } });
    const FEE = 10_100n;

    test('control: refunds at 0..k-1, fees at k..2k-1 pass', () => {
      const ctx = feeShow();
      const coins = [sale(ctx), sale(ctx, { seat: seatOf(0, 2) })];
      const org = p2pkh(ctx.organiser.pkh);
      expectAccept(assert, honest(ctx, coins, [...refundAll(ctx, coins, FEE + 500n), out(org, FEE), out(org, FEE)]));
    });

    test('REJECT fee above the posted bps (organiser over-paid out of the refund)', (t) => {
      const ctx = feeShow();
      const s = sale(ctx);
      const resolved = honest(ctx, [s], [out(p2pkh(s.buyer.pkh), coinValue(ctx) - FEE - CAP - 1n), out(p2pkh(ctx.organiser.pkh), FEE + CAP)]);
      t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
    });

    test('REJECT fee double-counted: one doubled fee output, second slot missing', (t) => {
      const ctx = feeShow();
      const coins = [sale(ctx), sale(ctx, { seat: seatOf(0, 2) })];
      const resolved = honest(ctx, coins, [...refundAll(ctx, coins, FEE + 500n), out(p2pkh(ctx.organiser.pkh), 2n * FEE)]);
      t.diagnostic(why(expectReject(assert, resolved, { failing: 1 })));
    });

    test('REJECT fee double-counted: second fee slot paid to the pusher', (t) => {
      const ctx = feeShow();
      const coins = [sale(ctx), sale(ctx, { seat: seatOf(0, 2) })];
      const resolved = honest(ctx, coins, [
        ...refundAll(ctx, coins, FEE + 500n),
        out(p2pkh(ctx.organiser.pkh), 2n * FEE),
        out(p2pkh(freshKey().pkh), FEE),
      ]);
      t.diagnostic(why(expectReject(assert, resolved, { failing: 1 })));
    });

    test('REJECT fee skipped entirely (refund the full coin to the buyer)', (t) => {
      const ctx = feeShow();
      const s = sale(ctx);
      const resolved = honest(ctx, [s], [out(p2pkh(s.buyer.pkh), coinValue(ctx) - 500n)]);
      t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
    });
  });
});

describe('Escrow.refund attacks', () => {
  const run = (ctx, coins, signature, scope, outputs) =>
    assemble({
      inputs: coins.map((s) => refundInput(ctx, s.esc, signature, scope)),
      outputs: outputs ?? coins.map((s) => out(p2pkh(s.buyer.pkh), coinValue(ctx) - 500n)),
    });

  test('control: C notice refunds two coins; R notice refunds its seat', () => {
    const ctx = makeShow(assert);
    const coins = [sale(ctx), sale(ctx, { seat: seatOf(2, 5) })];
    expectAccept(assert, run(ctx, coins, notice(ctx, 'C'), 'C'), 'C');
    expectAccept(assert, run(ctx, [coins[1]], notice(ctx, 'R', coins[1].seat), 'R'), 'R');
  });

  test('REJECT notice signed by a key that is not the organiser data key', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    t.diagnostic(why(expectReject(assert, run(ctx, [s], notice(ctx, 'C', undefined, freshKey()), 'C'), { failing: 0 })));
  });

  test('REJECT R notice for one seat used on another seat', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx, { seat: seatOf(0, 2) });
    t.diagnostic(why(expectReject(assert, run(ctx, [s], notice(ctx, 'R', seatOf(0, 1)), 'R'), { failing: 0 })));
  });

  test('REJECT R notice for seat (0,1) used on seat (1,1) (same counter, other shard)', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx, { seat: seatOf(1, 1) });
    t.diagnostic(why(expectReject(assert, run(ctx, [s], notice(ctx, 'R', seatOf(0, 1)), 'R'), { failing: 0 })));
  });

  test('REJECT wrong scope: an R notice presented as C (one-seat refund widened to the show)', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx, { seat: seatOf(0, 3) });
    const other = sale(ctx, { seat: seatOf(0, 4) });
    const sig = notice(ctx, 'R', s.seat);
    t.diagnostic(why(expectReject(assert, run(ctx, [other], sig, 'C'), { failing: 0 })));
    t.diagnostic(why(expectReject(assert, run(ctx, [s], sig, 'C'), { failing: 0 })));
  });

  test('REJECT wrong scope: a C notice presented as R', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    t.diagnostic(why(expectReject(assert, run(ctx, [s], notice(ctx, 'C'), 'R'), { failing: 0 })));
  });

  test('REJECT C notice replayed on another show signed by the same organiser key', (t) => {
    const showA = makeShow(assert);
    const showB = makeShow(assert, { organiser: showA.organiser, dataKey: showA.dataKey });
    const s = sale(showB);
    expectAccept(assert, run(showB, [s], notice(showB, 'C'), 'C'), 'show B with its own notice');
    t.diagnostic(why(expectReject(assert, run(showB, [s], notice(showA, 'C'), 'C'), { failing: 0 })));
  });

  test('REJECT R notice replayed on another show for the same seat id', (t) => {
    const showA = makeShow(assert);
    const showB = makeShow(assert, { organiser: showA.organiser, dataKey: showA.dataKey });
    const s = sale(showB, { seat: seatOf(0, 1) });
    t.diagnostic(why(expectReject(assert, run(showB, [s], notice(showA, 'R', seatOf(0, 1)), 'R'), { failing: 0 })));
  });

  test('REJECT notice signed over the category in display byte order', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const wrongOrder = flattenBinArray([Uint8Array.of(0x43), ctx.show.category]);
    assert.notDeepEqual(wrongOrder, encodeRefundNoticeMessage({ scope: 'C', category: ctx.show.category }));
    const sig = signDataMessage(ctx.dataKey.privateKey, wrongOrder);
    t.diagnostic(why(expectReject(assert, run(ctx, [s], sig, 'C'), { failing: 0 })));
  });

  test('REJECT unknown scope byte (X) and a 2-byte scope', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const sig = notice(ctx, 'C');
    for (const scope of [Uint8Array.of(0x58), Uint8Array.of(0x43, 0x43)]) {
      const unlock = rawUnlock(ctx.contracts.escrow, 3, [sig, scope]);
      const resolved = assemble({ inputs: [{ coin: s.esc, unlock }], outputs: [out(p2pkh(s.buyer.pkh), coinValue(ctx) - 500n)] });
      t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
    }
    // kit self-check: the raw encoder matches the normal one for a valid scope
    assert.deepEqual(rawUnlock(ctx.contracts.escrow, 3, [sig, scopeByte('C')]), escrowUnlock(ctx).refund(sig, 'C'));
  });

  test('REJECT empty data signature', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    t.diagnostic(why(expectReject(assert, run(ctx, [s], new Uint8Array(), 'C'), { failing: 0 })));
  });

  test('REJECT refund paid to the pusher (organiser cannot redirect)', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const resolved = run(ctx, [s], notice(ctx, 'C'), 'C', [out(p2pkh(ctx.organiser.pkh), coinValue(ctx) - 500n)]);
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('LIMIT + REJECT pusher skim: up to minerFeeCap passes, one sat more fails', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const V = coinValue(ctx);
    const pusher = p2pkh(freshKey().pkh);
    expectAccept(assert, run(ctx, [s], notice(ctx, 'C'), 'C', [out(p2pkh(s.buyer.pkh), V - CAP), out(pusher, CAP - 1000n)]), 'LIMIT');
    const resolved = run(ctx, [s], notice(ctx, 'C'), 'C', [out(p2pkh(s.buyer.pkh), V - CAP - 1n), out(pusher, CAP - 999n)]);
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT double satisfaction: two coins of one buyer, one refund output', (t) => {
    const ctx = makeShow(assert);
    const buyer = freshKey();
    const coins = [sale(ctx, { buyer, seat: seatOf(0, 1) }), sale(ctx, { buyer, seat: seatOf(0, 2) })];
    const resolved = run(ctx, coins, notice(ctx, 'C'), 'C', [out(p2pkh(buyer.pkh), coinValue(ctx)), out(p2pkh(freshKey().pkh), coinValue(ctx) - 1000n)]);
    t.diagnostic(why(expectReject(assert, resolved, { failing: 1 })));
  });
});

describe('lifted holder signatures', () => {
  test('REJECT a hand-back signature lifted into a check-in (organiser converts a refund into a payout)', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const handBack = assemble({
      inputs: [{ coin: s.esc, unlock: escrowUnlock(ctx).handBack(1) }, { coin: s.tkt, signer: s.buyer }],
      outputs: [out(p2pkh(s.buyer.pkh), coinValue(ctx))],
    });
    expectAccept(assert, handBack, 'the holder\'s hand-back');
    const lifted = assemble({
      inputs: [{ coin: s.esc, unlock: escrowUnlock(ctx).checkIn(1) }, { coin: s.tkt, unlock: handBack.transaction.inputs[1].unlockingBytecode }],
      outputs: [out(p2pkh(ctx.organiser.pkh), coinValue(ctx) - 1000n), keepsakeOut(ctx, s)],
    });
    // Escrow's rules hold; the holder's SIGHASH_ALL signature does not cover this transaction.
    t.diagnostic(why(expectReject(assert, lifted, { failing: 1 })));
  });

  test('LIMIT a wallet that signs the ticket with SIGHASH_NONE | ANYONECANPAY lets anyone reuse it', () => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const careless = assemble({
      inputs: [{ coin: s.esc, unlock: escrowUnlock(ctx).handBack(1) }, { coin: s.tkt, signer: s.buyer, sighash: 0xc2 }],
      outputs: [out(p2pkh(s.buyer.pkh), coinValue(ctx))],
    });
    expectAccept(assert, careless, 'hand-back signed NONE|ANYONECANPAY');
    const lifted = assemble({
      inputs: [{ coin: s.esc, unlock: escrowUnlock(ctx).checkIn(1) }, { coin: s.tkt, unlock: careless.transaction.inputs[1].unlockingBytecode }],
      outputs: [out(p2pkh(ctx.organiser.pkh), coinValue(ctx) - 1000n), keepsakeOut(ctx, s)],
    });
    // Clients must check that the wallet signed with SIGHASH_ALL (0x41 or 0x61).
    expectAccept(assert, lifted, 'lifted into a check-in');
  });
});

describe('mixed paths and stray coins', () => {
  test('control: hand-back, settle and refund batched in one transaction pass', () => {
    const ctx = makeShow(assert);
    const a = sale(ctx, { seat: seatOf(0, 1) });
    const b = sale(ctx, { seat: seatOf(0, 2) });
    const c = sale(ctx, { seat: seatOf(0, 3) });
    const V = coinValue(ctx);
    const resolved = assemble({
      inputs: [
        { coin: a.esc, unlock: escrowUnlock(ctx).handBack(3) },
        settleInput(ctx, b.esc),
        refundInput(ctx, c.esc, notice(ctx, 'R', c.seat), 'R'),
        { coin: a.tkt, signer: a.buyer },
      ],
      outputs: [out(p2pkh(a.buyer.pkh), V + 200n), out(p2pkh(b.buyer.pkh), V - 800n), out(p2pkh(c.buyer.pkh), V - 800n)],
      locktime: settleHeight(ctx),
    });
    expectAccept(assert, resolved);
  });

  test('REJECT double satisfaction across paths: hand-back and settle of one buyer share an output', (t) => {
    const ctx = makeShow(assert);
    const buyer = freshKey();
    const a = sale(ctx, { buyer, seat: seatOf(0, 1) });
    const b = sale(ctx, { buyer, seat: seatOf(0, 2) });
    const resolved = assemble({
      inputs: [{ coin: a.esc, unlock: escrowUnlock(ctx).handBack(2) }, settleInput(ctx, b.esc), { coin: a.tkt, signer: buyer }],
      outputs: [out(p2pkh(buyer.pkh), coinValue(ctx)), out(p2pkh(freshKey().pkh), coinValue(ctx))],
      locktime: settleHeight(ctx),
    });
    t.diagnostic(why(expectReject(assert, resolved, { failing: 1 })));
  });

  test('REJECT double satisfaction across paths: refund and settle of one buyer share an output', (t) => {
    const ctx = makeShow(assert);
    const buyer = freshKey();
    const a = sale(ctx, { buyer, seat: seatOf(0, 1) });
    const b = sale(ctx, { buyer, seat: seatOf(0, 2) });
    const resolved = assemble({
      inputs: [refundInput(ctx, a.esc, notice(ctx, 'C'), 'C'), settleInput(ctx, b.esc)],
      outputs: [out(p2pkh(buyer.pkh), coinValue(ctx) + 5_000n), out(p2pkh(freshKey().pkh), coinValue(ctx) - 6_000n)],
      locktime: settleHeight(ctx),
    });
    t.diagnostic(why(expectReject(assert, resolved, { failing: 1 })));
  });

  test('REJECT check-in mixed with a hand-back (the hand-back sees the keepsake)', (t) => {
    const ctx = makeShow(assert);
    const holder = freshKey();
    const a = sale(ctx, { buyer: holder, seat: seatOf(0, 1) });
    const b = sale(ctx, { buyer: holder, seat: seatOf(0, 2) });
    const resolved = assemble({
      inputs: [
        { coin: a.esc, unlock: escrowUnlock(ctx).checkIn(2) },
        { coin: b.esc, unlock: escrowUnlock(ctx).handBack(3) },
        { coin: a.tkt, signer: holder },
        { coin: b.tkt, signer: holder },
      ],
      outputs: [out(p2pkh(ctx.organiser.pkh), coinValue(ctx) - 500n), out(p2pkh(holder.pkh), coinValue(ctx) - 500n), keepsakeOut(ctx, a)],
    });
    t.diagnostic(why(expectReject(assert, resolved, { failing: 1 })));
  });

  test('REJECT check-in mixed with a settle (the settle sees the keepsake)', (t) => {
    const ctx = makeShow(assert);
    const holder = freshKey();
    const a = sale(ctx, { buyer: holder, seat: seatOf(0, 1) });
    const b = sale(ctx, { seat: seatOf(0, 2) });
    const resolved = assemble({
      inputs: [{ coin: a.esc, unlock: escrowUnlock(ctx).checkIn(2), sequence: SEQUENCE_LOCKTIME }, settleInput(ctx, b.esc), { coin: a.tkt, signer: holder }],
      outputs: [out(p2pkh(ctx.organiser.pkh), coinValue(ctx) - 500n), out(p2pkh(b.buyer.pkh), coinValue(ctx) - 500n), keepsakeOut(ctx, a)],
      locktime: settleHeight(ctx),
    });
    t.diagnostic(why(expectReject(assert, resolved, { failing: 1 })));
  });

  test('REJECT buy and closeSales on a plain coin sent to the BoxOffice (stuck for good)', (t) => {
    const ctx = makeShow(assert);
    const buyer = freshKey();
    const stray = coin(out(ctx.contracts.boxOffice.lockingBytecode, 20_000));
    const buy = assemble({
      inputs: [{ coin: stray, unlock: ctx.contracts.boxOffice.unlock('buy', [buyer.pkh]) }],
      outputs: [out(p2pkh(buyer.pkh), 19_000)],
    });
    t.diagnostic(`buy: ${why(expectReject(assert, buy, { failing: 0 }))}`);
    const close = assemble({ inputs: [{ coin: stray, unlock: closeSalesUnlock(ctx) }], outputs: [out(p2pkh(ctx.organiser.pkh), 19_000)] });
    t.diagnostic(`closeSales: ${why(expectReject(assert, close, { failing: 0 }))}`);
  });

  test('REJECT every path on a plain coin sent to the Escrow without a marker (stuck for good)', (t) => {
    const ctx = makeShow(assert);
    const buyer = freshKey();
    const stray = coin(out(ctx.contracts.escrow.lockingBytecode, 50_000));
    const tkt = ticketCoin(ctx, { seat: seatOf(0, 1), buyerPkh: buyer.pkh });
    const U = escrowUnlock(ctx);
    const cases = {
      handBack: assemble({ inputs: [{ coin: stray, unlock: U.handBack(1) }, { coin: tkt, signer: buyer }], outputs: [out(p2pkh(buyer.pkh), 50_000)] }),
      checkIn: assemble({
        inputs: [{ coin: stray, unlock: U.checkIn(1) }, { coin: tkt, signer: buyer }],
        outputs: [out(p2pkh(ctx.organiser.pkh), 49_000), tkt.output],
      }),
      settle: assemble({ inputs: [settleInput(ctx, stray)], outputs: [out(p2pkh(buyer.pkh), 49_500)], locktime: settleHeight(ctx) }),
      refund: assemble({ inputs: [refundInput(ctx, stray, notice(ctx, 'C'), 'C')], outputs: [out(p2pkh(buyer.pkh), 49_500)] }),
    };
    for (const [path, resolved] of Object.entries(cases)) {
      t.diagnostic(`${path}: ${why(expectReject(assert, resolved, { failing: 0 }))}`);
    }
  });

  test('REJECT a marker of another category parked at this Escrow (settle and refund)', (t) => {
    const ctx = makeShow(assert);
    const buyer = freshKey();
    const foreign = escrowCoin(ctx, { buyerPkh: buyer.pkh, category: crypto.getRandomValues(new Uint8Array(32)) });
    t.diagnostic(why(expectReject(assert, assemble({ inputs: [settleInput(ctx, foreign)], outputs: [out(p2pkh(buyer.pkh), 10_500)], locktime: settleHeight(ctx) }), { failing: 0 })));
    t.diagnostic(why(expectReject(assert, assemble({ inputs: [refundInput(ctx, foreign, notice(ctx, 'C'), 'C')], outputs: [out(p2pkh(buyer.pkh), 10_500)] }), { failing: 0 })));
  });

  test('REJECT a mutable marker and a malformed marker body (22 bytes)', (t) => {
    const ctx = makeShow(assert);
    const buyer = freshKey();
    const mutable = escrowCoin(ctx, { buyerPkh: buyer.pkh, capability: 'mutable' });
    const short = escrowCoin(ctx, { buyerPkh: buyer.pkh, commitment: encodeMarkerCommitment(seatOf(0, 1), buyer.pkh).slice(0, 23) });
    for (const esc of [mutable, short]) {
      const resolved = assemble({ inputs: [settleInput(ctx, esc)], outputs: [out(p2pkh(buyer.pkh), 10_500)], locktime: settleHeight(ctx) });
      t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
    }
  });

  test('REJECT unknown function selector (4) on Escrow', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const resolved = assemble({ inputs: [{ coin: s.esc, unlock: rawUnlock(ctx.contracts.escrow, 4, []) }], outputs: [out(p2pkh(s.buyer.pkh), 10_500)] });
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('LIMIT a ticket carrying fungible tokens (only possible after a bad genesis) still only refunds its buyer', () => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const heavy = ticketCoin(ctx, { seat: s.seat, buyerPkh: s.buyer.pkh, amount: 500n });
    const resolved = assemble({
      inputs: [{ coin: s.esc, unlock: escrowUnlock(ctx).handBack(1) }, { coin: heavy, signer: s.buyer }],
      outputs: [out(p2pkh(s.buyer.pkh), coinValue(ctx))],
    });
    // The fungible amount is burned; nothing else changes. verifyGenesis refuses a genesis that mints fungible tokens.
    expectAccept(assert, resolved, 'fungible amount on a ticket burns');
  });

  test('LIMIT a ticket moved away from the buyer: settle still refunds the buyer', () => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const resolved = assemble({ inputs: [settleInput(ctx, s.esc)], outputs: [out(p2pkh(s.buyer.pkh), coinValue(ctx) - 500n)], locktime: settleHeight(ctx) });
    expectAccept(assert, resolved);
  });
});
