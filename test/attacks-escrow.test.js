// Attacks on Escrow (handBack, checkIn, settle, refund, and mixed paths). Each
// case asserts the 2026 VM rejects in standard AND consensus mode and names the
// input whose own rule stops it. Honest controls sit next to the attacks they
// bound; LIMIT cases pin documented limits (SPEC.md section 8) so a change in
// behaviour shows up here.
//
// Sample show: price 10,000 sats, so an escrow coin holds V = 11,000;
// minerFeeCap 1,500; settle opens at locktime 930,144.
//
// Slot rule (SPEC.md 3.2): no path allows an output outside its slots, so a
// payout may fall short of the coin's due by at most minerFeeCap, and that
// shortfall can only be miner fee. The "skim" cases below were accepted
// before the slot rule and are rejected now.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenBinArray } from '@bitauth/libauth';
import {
  boxOfficeContract,
  buildBuy,
  buildCheckIn,
  escrowContract,
  encodeMarkerCommitment,
  encodeRefundNoticeMessage,
  encodeTicketCommitment,
  scopeByte,
  validateShow,
} from '../src/tx/index.js';
import { signDataMessage } from '../src/tx/sign.js';
import { fakeCoin, freshKey, makeShow, saleHeight, sampleShowParams, signWallet, utxoAt } from './helpers.js';
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

const CAP = 1_500n;

/** A sold seat as made-up coins: the escrow coin and the matching ticket at the buyer's address. */
const sale = (ctx, { buyer = freshKey(), seat = seatOf(0, 1) } = {}) => ({
  buyer,
  seat,
  esc: escrowCoin(ctx, { seat, buyerPkh: buyer.pkh, currentHeight: saleHeight(ctx.show) }),
  tkt: ticketCoin(ctx, { seat, buyerPkh: buyer.pkh, currentHeight: saleHeight(ctx.show) }),
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

  test('control + REJECT fee drain: refund at V - cap passes (the rest is miner fee), V - cap - 1 fails', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const V = coinValue(ctx);
    expectAccept(assert, honest(ctx, s, [out(p2pkh(s.buyer.pkh), V - CAP)]), 'at the cap');
    const resolved = honest(ctx, s, [out(p2pkh(s.buyer.pkh), V - CAP - 1n)]);
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT skim: the ticket\'s slot paid to someone else, even inside the cap', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const V = coinValue(ctx);
    const resolved = honest(ctx, s, [out(p2pkh(s.buyer.pkh), V - CAP), out(p2pkh(freshKey().pkh), CAP)]);
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT skim: an output beyond the slots (no fee is due, so there is no fee slot)', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const V = coinValue(ctx);
    const resolved = honest(ctx, s, [out(p2pkh(s.buyer.pkh), V - CAP), out(p2pkh(s.buyer.pkh), 600), out(p2pkh(freshKey().pkh), 900)]);
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT skim: a plain coin added to open a slot for the skimmer', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const skimmer = freshKey();
    const V = coinValue(ctx);
    const resolved = assemble({
      inputs: [
        { coin: s.esc, unlock: escrowUnlock(ctx).handBack(1) },
        { coin: s.tkt, signer: s.buyer },
        { coin: fakeCoin(skimmer.pkh, 2_000), signer: skimmer },
      ],
      outputs: [out(p2pkh(s.buyer.pkh), V - CAP), out(p2pkh(s.buyer.pkh), 1000), out(p2pkh(skimmer.pkh), 2_000n + CAP - 1000n)],
    });
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT hand-back with the escrow coin after its ticket (escrow coins come first)', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const resolved = assemble({
      inputs: [
        { coin: s.tkt, signer: s.buyer },
        { coin: s.esc, unlock: escrowUnlock(ctx).handBack(0) },
      ],
      outputs: [out(p2pkh(s.buyer.pkh), 1000), out(p2pkh(s.buyer.pkh), coinValue(ctx) - 500n)],
    });
    t.diagnostic(why(expectReject(assert, resolved, { failing: 1 })));
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

    test('REJECT fee output padded above the posted fee (organiser takes the allowance)', (t) => {
      const ctx = feeShow();
      const s = sale(ctx);
      const resolved = honest(ctx, s, twoOut(ctx, s, coinValue(ctx) - FEE - CAP, FEE + CAP - 500n));
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

  test('control + REJECT payout floor: organiser gets V - cap (passes, the rest is miner fee), V - cap - 1 (fails)', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const V = coinValue(ctx);
    expectAccept(assert, honest(ctx, s, [out(p2pkh(ctx.organiser.pkh), V - CAP), keepsakeOut(ctx, s)]), 'at the cap');
    const resolved = honest(ctx, s, [out(p2pkh(ctx.organiser.pkh), V - CAP - 1n), keepsakeOut(ctx, s)]);
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT holder skim: a third output for the holder, even inside the cap', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const V = coinValue(ctx);
    const resolved = honest(ctx, s, [out(p2pkh(ctx.organiser.pkh), V - CAP), keepsakeOut(ctx, s), out(p2pkh(s.buyer.pkh), 600)]);
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT holder skim: the keepsake carries more than the ticket did', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const V = coinValue(ctx);
    const fat = nftOut(p2pkh(s.buyer.pkh), 2_000, { category: ctx.show.category, commitment: encodeTicketCommitment(s.seat, s.buyer.pkh) });
    const resolved = honest(ctx, s, [out(p2pkh(ctx.organiser.pkh), V - CAP), fat]);
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT holder skim: a plain coin added to open a third slot', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const V = coinValue(ctx);
    const resolved = assemble({
      inputs: [
        { coin: s.esc, unlock: escrowUnlock(ctx).checkIn(1) },
        { coin: s.tkt, signer: s.buyer },
        { coin: fakeCoin(s.buyer.pkh, 2_000), signer: s.buyer },
      ],
      outputs: [out(p2pkh(ctx.organiser.pkh), V - CAP), keepsakeOut(ctx, s), out(p2pkh(s.buyer.pkh), 2_000n + CAP - 1000n)],
    });
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
      const built = buildBuy({ show: ctx.show, boxOfficeUtxo: shard, fundingUtxos: [fakeCoin(holder.pkh, 50_000)], buyerPkh: holder.pkh, currentHeight: saleHeight(ctx.show) });
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

  test('control + REJECT settle floor: refund at V - cap passes (the rest is miner fee), V - cap - 1 fails', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const V = coinValue(ctx);
    expectAccept(assert, honest(ctx, [s], [out(p2pkh(s.buyer.pkh), V - CAP)]), 'at the cap');
    const resolved = honest(ctx, [s], [out(p2pkh(s.buyer.pkh), V - CAP - 1n)]);
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT pusher skim: an extra output for the pusher, even inside the cap', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const V = coinValue(ctx);
    const resolved = honest(ctx, [s], [out(p2pkh(s.buyer.pkh), V - CAP), out(p2pkh(freshKey().pkh), CAP - 900n)]);
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT pusher skim: the pusher adds a coin of their own to open a slot', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const pusher = freshKey();
    const V = coinValue(ctx);
    const resolved = assemble({
      inputs: [settleInput(ctx, s.esc), { coin: fakeCoin(pusher.pkh, 2_000), signer: pusher }],
      outputs: [out(p2pkh(s.buyer.pkh), V - CAP), out(p2pkh(pusher.pkh), 2_000n + CAP - 1000n)],
      locktime: settleHeight(ctx),
    });
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT a buyer who pushes a batch takes another coin\'s allowance through their own payout', (t) => {
    const ctx = makeShow(assert);
    const victim = sale(ctx, { seat: seatOf(0, 1) });
    const pusher = sale(ctx, { seat: seatOf(0, 2) });
    const V = coinValue(ctx);
    const resolved = honest(ctx, [victim, pusher], [out(p2pkh(victim.buyer.pkh), V - CAP), out(p2pkh(pusher.buyer.pkh), V + CAP - 500n)]);
    t.diagnostic(why(expectReject(assert, resolved, { failing: 1 })));
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
      // coin 1 finds no fee slot; coin 0 finds a fee that is not exactly its own
      t.diagnostic(why(expectReject(assert, resolved, { failing: [0, 1] })));
    });

    test('REJECT fee double-counted: second fee slot paid to the pusher', (t) => {
      const ctx = feeShow();
      const coins = [sale(ctx), sale(ctx, { seat: seatOf(0, 2) })];
      const resolved = honest(ctx, coins, [
        ...refundAll(ctx, coins, FEE + 500n),
        out(p2pkh(ctx.organiser.pkh), 2n * FEE),
        out(p2pkh(freshKey().pkh), FEE),
      ]);
      t.diagnostic(why(expectReject(assert, resolved, { failing: [0, 1] })));
    });

    test('REJECT fee output padded above the posted fee (organiser takes the allowance)', (t) => {
      const ctx = feeShow();
      const s = sale(ctx);
      const resolved = honest(ctx, [s], [out(p2pkh(s.buyer.pkh), coinValue(ctx) - FEE - CAP), out(p2pkh(ctx.organiser.pkh), FEE + CAP - 500n)]);
      t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
    });

    test('REJECT fee skipped entirely (refund the full coin to the buyer)', (t) => {
      const ctx = feeShow();
      const s = sale(ctx);
      const resolved = honest(ctx, [s], [out(p2pkh(s.buyer.pkh), coinValue(ctx) - 500n)]);
      t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
    });
  });
});

describe('settle fee slots when only some coins owe a fee (price 100,000, 50 bps)', () => {
  // 50 bps of 101,000 is 505 sats, which is waived (under 546); a coin of
  // 120,000 owes 600. Coins that owe a fee come first; a fee-free coin has no
  // fee slot, and no output may sit there.
  const mixedShow = () => makeShow(assert, { overrides: { price: 100_000n, noShowFeeBps: 50 } });
  const owingSale = (ctx) => {
    const buyer = freshKey();
    const seat = seatOf(0, 2);
    return { buyer, seat, esc: escrowCoin(ctx, { seat, buyerPkh: buyer.pkh, value: 120_000n }) };
  };

  test('control: the coin that owes a fee first, its fee at k + 0', () => {
    const ctx = mixedShow();
    const free = sale(ctx);
    const owing = owingSale(ctx);
    const org = p2pkh(ctx.organiser.pkh);
    const resolved = assemble({
      inputs: [settleInput(ctx, owing.esc), settleInput(ctx, free.esc)],
      outputs: [out(p2pkh(owing.buyer.pkh), 120_000n - 600n - 500n), out(p2pkh(free.buyer.pkh), 101_000n - 500n), out(org, 600)],
      locktime: settleHeight(ctx),
    });
    expectAccept(assert, resolved);
  });

  test('REJECT a fee-free coin\'s fee slot paid to someone else', (t) => {
    const ctx = mixedShow();
    const free = sale(ctx);
    const owing = owingSale(ctx);
    const org = p2pkh(ctx.organiser.pkh);
    const resolved = assemble({
      inputs: [settleInput(ctx, free.esc), settleInput(ctx, owing.esc)],
      outputs: [
        out(p2pkh(free.buyer.pkh), 101_000n - 500n),
        out(p2pkh(owing.buyer.pkh), 120_000n - 600n - 500n),
        out(p2pkh(freshKey().pkh), 600), // slot k + 0 belongs to the fee-free coin
        out(org, 600),
      ],
      locktime: settleHeight(ctx),
    });
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
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

  test('REJECT refund paid to the pusher (the organiser cannot redirect it)', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const resolved = run(ctx, [s], notice(ctx, 'C'), 'C', [out(p2pkh(ctx.organiser.pkh), coinValue(ctx) - 500n)]);
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('control + REJECT refund floor: V - cap passes (the rest is miner fee), V - cap - 1 fails', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const V = coinValue(ctx);
    expectAccept(assert, run(ctx, [s], notice(ctx, 'C'), 'C', [out(p2pkh(s.buyer.pkh), V - CAP)]), 'at the cap');
    const resolved = run(ctx, [s], notice(ctx, 'C'), 'C', [out(p2pkh(s.buyer.pkh), V - CAP - 1n)]);
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT pusher skim under a C or R notice: an extra output for the pusher, even inside the cap', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const V = coinValue(ctx);
    const outputs = [out(p2pkh(s.buyer.pkh), V - CAP), out(p2pkh(freshKey().pkh), CAP - 900n)];
    t.diagnostic(why(expectReject(assert, run(ctx, [s], notice(ctx, 'C'), 'C', outputs), { failing: 0 })));
    t.diagnostic(why(expectReject(assert, run(ctx, [s], notice(ctx, 'R', s.seat), 'R', outputs), { failing: 0 })));
  });

  test('REJECT the organiser cancels and pays himself out of three refunds (F1)', (t) => {
    const ctx = makeShow(assert);
    const coins = [sale(ctx, { seat: seatOf(0, 1) }), sale(ctx, { seat: seatOf(0, 2) }), sale(ctx, { seat: seatOf(1, 1) })];
    const V = coinValue(ctx);
    const outputs = [...coins.map((s) => out(p2pkh(s.buyer.pkh), V - CAP)), out(p2pkh(ctx.organiser.pkh), 3n * CAP - 2_600n)];
    t.diagnostic(why(expectReject(assert, run(ctx, coins, notice(ctx, 'C'), 'C', outputs), { failing: [0, 1, 2] })));
  });

  test('REJECT an organiser who also bought a ticket takes the others\' allowance through his own refund', (t) => {
    const ctx = makeShow(assert);
    const victims = [sale(ctx, { seat: seatOf(0, 1) }), sale(ctx, { seat: seatOf(0, 2) })];
    const own = sale(ctx, { buyer: ctx.organiser, seat: seatOf(0, 3) });
    const V = coinValue(ctx);
    const outputs = [...victims.map((s) => out(p2pkh(s.buyer.pkh), V - CAP)), out(p2pkh(ctx.organiser.pkh), V + 2n * CAP - 900n)];
    t.diagnostic(why(expectReject(assert, run(ctx, [...victims, own], notice(ctx, 'C'), 'C', outputs), { failing: 2 })));
  });

  test('REJECT the pusher adds a coin of their own to a refund to open a slot', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const pusher = freshKey();
    const V = coinValue(ctx);
    const resolved = assemble({
      inputs: [refundInput(ctx, s.esc, notice(ctx, 'C'), 'C'), { coin: fakeCoin(pusher.pkh, 2_000), signer: pusher }],
      outputs: [out(p2pkh(s.buyer.pkh), V - CAP), out(p2pkh(pusher.pkh), 2_000n + CAP - 1000n)],
    });
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
  test('control: settle and refund batched in one transaction pass', () => {
    const ctx = makeShow(assert);
    const b = sale(ctx, { seat: seatOf(0, 2) });
    const c = sale(ctx, { seat: seatOf(0, 3) });
    const V = coinValue(ctx);
    const resolved = assemble({
      inputs: [settleInput(ctx, b.esc), refundInput(ctx, c.esc, notice(ctx, 'R', c.seat), 'R')],
      outputs: [out(p2pkh(b.buyer.pkh), V - 800n), out(p2pkh(c.buyer.pkh), V - 800n)],
      locktime: settleHeight(ctx),
    });
    expectAccept(assert, resolved);
  });

  test('REJECT a hand-back batched with a settle and a refund (settle and refund take only Escrow coins)', (t) => {
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
    t.diagnostic(why(expectReject(assert, resolved, { failing: [1, 2] })));
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
      outputs: [out(p2pkh(buyer.pkh), coinValue(ctx)), out(p2pkh(freshKey().pkh), coinValue(ctx) - 1_000n)],
      locktime: settleHeight(ctx),
    });
    t.diagnostic(why(expectReject(assert, resolved, { failing: 1 })));
  });

  test('REJECT check-in mixed with a hand-back', (t) => {
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
    // the check-in allows only two inputs; the hand-back sees the keepsake
    t.diagnostic(why(expectReject(assert, resolved, { failing: [0, 1] })));
  });

  test('REJECT check-in mixed with a settle', (t) => {
    const ctx = makeShow(assert);
    const holder = freshKey();
    const a = sale(ctx, { buyer: holder, seat: seatOf(0, 1) });
    const b = sale(ctx, { seat: seatOf(0, 2) });
    const resolved = assemble({
      inputs: [{ coin: a.esc, unlock: escrowUnlock(ctx).checkIn(2), sequence: SEQUENCE_LOCKTIME }, settleInput(ctx, b.esc), { coin: a.tkt, signer: holder }],
      outputs: [out(p2pkh(ctx.organiser.pkh), coinValue(ctx) - 500n), out(p2pkh(b.buyer.pkh), coinValue(ctx) - 500n), keepsakeOut(ctx, a)],
      locktime: settleHeight(ctx),
    });
    // the check-in allows only two inputs; the settle takes only Escrow coins
    t.diagnostic(why(expectReject(assert, resolved, { failing: [0, 1] })));
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
    const tkt = ticketCoin(ctx, { seat: seatOf(0, 1), buyerPkh: buyer.pkh, currentHeight: saleHeight(ctx.show) });
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

describe('payout and fee outputs carry no tokens (M6)', () => {
  // Any input that spends output 0 of its transaction can create a new token
  // category in the spending transaction. The kit's made-up coins sit at
  // vout 0, so each case can mint junk tokens of a fresh category onto an
  // Escrow payout or fee output. (Real escrow coins sit at vout 2; tickets
  // and keepsakes can sit at vout 0.)
  const junk = (fromCoin) => ({ amount: 1_000_000_000n, category: fromCoin.txid });
  const withJunk = (output, fromCoin) => ({ ...output, token: junk(fromCoin) });
  const V = (ctx) => coinValue(ctx);

  test('REJECT settle: junk tokens minted onto the buyer\'s refund (a griefing pusher)', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const honest = (refund) => assemble({ inputs: [settleInput(ctx, s.esc)], outputs: [refund], locktime: settleHeight(ctx) });
    expectAccept(assert, honest(out(p2pkh(s.buyer.pkh), V(ctx) - 500n)), 'control');
    t.diagnostic(why(expectReject(assert, honest(withJunk(out(p2pkh(s.buyer.pkh), V(ctx) - 500n), s.esc)), { failing: 0 })));
    const bigNft = { ...out(p2pkh(s.buyer.pkh), V(ctx) - 500n), token: { amount: 0n, category: s.esc.txid, nft: { capability: 'none', commitment: new Uint8Array(128) } } };
    t.diagnostic(why(expectReject(assert, honest(bigNft), { failing: 0 })));
  });

  test('REJECT refund under a C notice: junk tokens on the buyer\'s refund', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const resolved = assemble({ inputs: [refundInput(ctx, s.esc, notice(ctx, 'C'), 'C')], outputs: [withJunk(out(p2pkh(s.buyer.pkh), V(ctx) - 500n), s.esc)] });
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT settle with a no-show fee: junk tokens on the organiser\'s fee output', (t) => {
    const ctx = makeShow(assert, { overrides: { price: 100_000n, noShowFeeBps: 1000 } });
    const s = sale(ctx);
    const fee = 10_100n;
    const resolved = assemble({
      inputs: [settleInput(ctx, s.esc)],
      outputs: [out(p2pkh(s.buyer.pkh), V(ctx) - fee - 500n), withJunk(out(p2pkh(ctx.organiser.pkh), fee), s.esc)],
      locktime: settleHeight(ctx),
    });
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT hand-back: junk tokens (minted from the ticket input) on the refund or on the fee output', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const handBack = (outputs) => assemble({ inputs: [{ coin: s.esc, unlock: escrowUnlock(ctx).handBack(1) }, { coin: s.tkt, signer: s.buyer }], outputs });
    t.diagnostic(why(expectReject(assert, handBack([withJunk(out(p2pkh(s.buyer.pkh), V(ctx)), s.tkt)]), { failing: 0 })));
    const feeCtx = makeShow(assert, { overrides: { price: 100_000n, handBackFeeBps: 500 } });
    const f = sale(feeCtx);
    const fee = 5_050n;
    const resolved = assemble({
      inputs: [{ coin: f.esc, unlock: escrowUnlock(feeCtx).handBack(1) }, { coin: f.tkt, signer: f.buyer }],
      outputs: [out(p2pkh(f.buyer.pkh), V(feeCtx) - fee - 500n), out(p2pkh(f.buyer.pkh), 1000), withJunk(out(p2pkh(feeCtx.organiser.pkh), fee), f.tkt)],
    });
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT check-in: junk tokens (minted from the ticket input) on the organiser\'s payout', (t) => {
    const ctx = makeShow(assert);
    const s = sale(ctx);
    const resolved = assemble({
      inputs: [{ coin: s.esc, unlock: escrowUnlock(ctx).checkIn(1) }, { coin: s.tkt, signer: s.buyer }],
      outputs: [withJunk(out(p2pkh(ctx.organiser.pkh), V(ctx) - 1000n), s.tkt), keepsakeOut(ctx, s)],
    });
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });
});

describe('a show with an absurd minerFeeCap, deployed by hand past validateShow (M1, TOK-2)', () => {
  // validateShow refuses minerFeeCap above 2,000 sats. Even if someone deploys
  // the contracts with a cap of 1,000,000 anyway, the slot rule means the
  // allowance can only be burned as miner fee: nobody can keep it.
  const absurd = () => {
    const organiser = freshKey();
    const dataKey = freshKey();
    const show = { ...sampleShowParams(organiser, dataKey), category: crypto.getRandomValues(new Uint8Array(32)), minerFeeCap: 1_000_000n };
    assert.throws(() => validateShow(show), (error) => error.code === 'bad-show');
    const escrow = escrowContract(show);
    return { organiser, dataKey, show, contracts: { escrow, boxOffice: boxOfficeContract(show, escrow.lockingBytecode) } };
  };

  test('REJECT the organiser cancels before the show and takes 9,454 of an 11,000-sat coin', (t) => {
    const ctx = absurd();
    const s = sale(ctx);
    const resolved = assemble({
      inputs: [refundInput(ctx, s.esc, notice(ctx, 'C'), 'C')],
      outputs: [out(p2pkh(s.buyer.pkh), 546), out(p2pkh(ctx.organiser.pkh), 9_454)],
    });
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT a stranger settles after the show and takes 9,454 of an 11,000-sat coin', (t) => {
    const ctx = absurd();
    const s = sale(ctx);
    const resolved = assemble({
      inputs: [settleInput(ctx, s.esc)],
      outputs: [out(p2pkh(s.buyer.pkh), 546), out(p2pkh(freshKey().pkh), 9_454)],
      locktime: settleHeight(ctx),
    });
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('LIMIT on such a show a pusher can still burn the cap as miner fee (why validateShow bounds it)', () => {
    const ctx = absurd();
    const s = sale(ctx);
    const resolved = assemble({ inputs: [refundInput(ctx, s.esc, notice(ctx, 'C'), 'C')], outputs: [out(p2pkh(s.buyer.pkh), 546)] });
    expectAccept(assert, resolved, 'buyer gets 546, the miner gets the rest, the pusher gets nothing');
  });
});
