// Attacks on BoxOffice (buy, closeSales). Each case asserts the 2026 VM rejects
// in standard AND consensus mode, and names the input whose own rule stops it.
// Honest controls (must pass) sit next to the attacks they bound.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeDataPush, flattenBinArray } from '@bitauth/libauth';
import {
  DoorstubError,
  MAX_COMMITMENT_BYTES,
  assertCommitmentSize,
  buildBuy,
  buildCloseSales,
  encodeBoxOfficeCommitment,
  encodeMarkerCommitment,
  encodeTicketCommitment,
} from '../src/tx/index.js';
import { signDigest } from '../src/tx/sign.js';
import { fakeCoin, freshKey, makeShow, randomTxid, saleHeight, signWallet, utxoAt } from './helpers.js';
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
  honestBuy,
  nftOut,
  out,
  p2pkh,
  rawUnlock,
  seatOf,
  settleHeight,
  shardCoin,
  why,
} from './kit.js';

/** Replace output `i` of a list (returns a copy). */
const withOutput = (outputs, i, output) => outputs.map((o, j) => (j === i ? output : o));
/** Copy of `output` with its NFT changed. */
const withNft = (output, nft) => ({ ...output, token: { ...output.token, nft: { ...output.token.nft, ...nft } } });
/** Copy of `output` with a new value. */
const withValue = (output, value) => ({ ...output, valueSatoshis: BigInt(value) });
/** Take `sats` out of the change output (the last one). */
const lessChange = (outputs, sats) =>
  outputs.map((o, j) => (j === outputs.length - 1 ? withValue(o, o.valueSatoshis - BigInt(sats)) : o));

describe('BoxOffice.buy attacks', () => {
  test('control: an honest buy passes', (t) => {
    const ctx = makeShow(assert);
    const h = honestBuy(ctx);
    expectAccept(assert, assemble(h));
    t.diagnostic(`buy outputs: ${h.outputs.length}`);
  });

  test('REJECT extra mint at output 3 (a second ticket for the buyer)', (t) => {
    const ctx = makeShow(assert);
    const h = honestBuy(ctx);
    const extra = nftOut(p2pkh(h.buyer.pkh), 1000, {
      category: ctx.show.category,
      commitment: encodeTicketCommitment(seatOf(0, 2), h.buyer.pkh),
    });
    const outputs = [...h.outputs.slice(0, 3), extra, ...lessChange(h.outputs, 1000).slice(3)];
    t.diagnostic(why(expectReject(assert, assemble({ inputs: h.inputs, outputs }), { failing: 0 })));
  });

  test('REJECT extra mint at output 5 (last index under the output cap)', (t) => {
    const ctx = makeShow(assert);
    const h = honestBuy(ctx);
    const change = lessChange(h.outputs, 3000)[3];
    const extra = nftOut(p2pkh(h.buyer.pkh), 1000, {
      category: ctx.show.category,
      commitment: encodeMarkerCommitment(seatOf(0, 9), h.buyer.pkh),
    });
    const outputs = [...h.outputs.slice(0, 3), change, out(p2pkh(h.buyer.pkh), 2000), extra];
    t.diagnostic(why(expectReject(assert, assemble({ inputs: h.inputs, outputs }), { failing: 0 })));
  });

  test('REJECT output-count overflow: 7 outputs, the 7th mints a ticket', (t) => {
    const ctx = makeShow(assert);
    const h = honestBuy(ctx);
    const change = lessChange(h.outputs, 4000)[3];
    const filler = out(p2pkh(h.buyer.pkh), 1000);
    const extra = nftOut(p2pkh(h.buyer.pkh), 1000, {
      category: ctx.show.category,
      commitment: encodeTicketCommitment(seatOf(0, 2), h.buyer.pkh),
    });
    const outputs = [...h.outputs.slice(0, 3), change, filler, filler, extra];
    assert.equal(outputs.length, 7);
    t.diagnostic(why(expectReject(assert, assemble({ inputs: h.inputs, outputs }), { failing: 0 })));
  });

  test('REJECT output-count overflow: 7 outputs even with no extra token (the cap itself)', (t) => {
    const ctx = makeShow(assert);
    const h = honestBuy(ctx);
    const change = lessChange(h.outputs, 3000)[3];
    const filler = out(p2pkh(h.buyer.pkh), 1000);
    const outputs = [...h.outputs.slice(0, 3), change, filler, filler, filler];
    t.diagnostic(why(expectReject(assert, assemble({ inputs: h.inputs, outputs }), { failing: 0 })));
  });

  test('REJECT minting capability leaked to output 1 (ticket is a minting NFT)', (t) => {
    const ctx = makeShow(assert);
    const h = honestBuy(ctx);
    const outputs = withOutput(h.outputs, 1, withNft(h.outputs[1], { capability: 'minting' }));
    t.diagnostic(why(expectReject(assert, assemble({ inputs: h.inputs, outputs }), { failing: 0 })));
  });

  test('REJECT minting capability leaked to output 2 (marker is a minting NFT)', (t) => {
    const ctx = makeShow(assert);
    const h = honestBuy(ctx);
    const outputs = withOutput(h.outputs, 2, withNft(h.outputs[2], { capability: 'minting' }));
    t.diagnostic(why(expectReject(assert, assemble({ inputs: h.inputs, outputs }), { failing: 0 })));
  });

  test('REJECT mutable marker (could be rewritten later)', (t) => {
    const ctx = makeShow(assert);
    const h = honestBuy(ctx);
    const outputs = withOutput(h.outputs, 2, withNft(h.outputs[2], { capability: 'mutable' }));
    t.diagnostic(why(expectReject(assert, assemble({ inputs: h.inputs, outputs }), { failing: 0 })));
  });

  test('REJECT shard loses minting capability (box office killed)', (t) => {
    const ctx = makeShow(assert);
    const h = honestBuy(ctx);
    const outputs = withOutput(h.outputs, 0, withNft(h.outputs[0], { capability: 'mutable' }));
    t.diagnostic(why(expectReject(assert, assemble({ inputs: h.inputs, outputs }), { failing: 0 })));
  });

  test('REJECT shard stolen: output 0 sent to the buyer\'s own address', (t) => {
    const ctx = makeShow(assert);
    const h = honestBuy(ctx);
    const outputs = withOutput(h.outputs, 0, { ...h.outputs[0], lockingBytecode: p2pkh(h.buyer.pkh) });
    t.diagnostic(why(expectReject(assert, assemble({ inputs: h.inputs, outputs }), { failing: 0 })));
  });

  test('REJECT shard value drained by 1 sat', (t) => {
    const ctx = makeShow(assert);
    const h = honestBuy(ctx);
    const outputs = withOutput(h.outputs, 0, withValue(h.outputs[0], h.outputs[0].valueSatoshis - 1n));
    outputs[3] = withValue(outputs[3], outputs[3].valueSatoshis + 1n);
    t.diagnostic(why(expectReject(assert, assemble({ inputs: h.inputs, outputs }), { failing: 0 })));
  });

  test('REJECT wrong category on the ticket (buyer brings their own minting token)', (t) => {
    const ctx = makeShow(assert);
    const h = honestBuy(ctx);
    const fakeCategory = randomTxid();
    const own = coin(nftOut(p2pkh(h.buyer.pkh), 1000, { category: fakeCategory, commitment: new Uint8Array(), capability: 'minting' }));
    const outputs = withOutput(h.outputs, 1, { ...h.outputs[1], token: { ...h.outputs[1].token, category: fakeCategory } });
    outputs[3] = withValue(outputs[3], outputs[3].valueSatoshis + 1000n);
    const resolved = assemble({ inputs: [...h.inputs, { coin: own, signer: h.buyer }], outputs });
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT wrong category on the marker (escrow coin no Escrow path accepts)', (t) => {
    const ctx = makeShow(assert);
    const h = honestBuy(ctx);
    const fakeCategory = randomTxid();
    const own = coin(nftOut(p2pkh(h.buyer.pkh), 1000, { category: fakeCategory, commitment: new Uint8Array(), capability: 'minting' }));
    const outputs = withOutput(h.outputs, 2, { ...h.outputs[2], token: { ...h.outputs[2].token, category: fakeCategory } });
    outputs[3] = withValue(outputs[3], outputs[3].valueSatoshis + 1000n);
    const resolved = assemble({ inputs: [...h.inputs, { coin: own, signer: h.buyer }], outputs });
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT seat reuse: shard counter not advanced (next buyer would get the same seat)', (t) => {
    const ctx = makeShow(assert);
    const h = honestBuy(ctx);
    const same = encodeBoxOfficeCommitment({ open: true, shard: 0, sold: 0 });
    const outputs = withOutput(h.outputs, 0, withNft(h.outputs[0], { commitment: same }));
    t.diagnostic(why(expectReject(assert, assemble({ inputs: h.inputs, outputs }), { failing: 0 })));
  });

  test('REJECT seat reuse across shards: shard 0 rewrites its shard byte to 1', (t) => {
    const ctx = makeShow(assert);
    const h = honestBuy(ctx);
    const posing = encodeBoxOfficeCommitment({ open: true, shard: 1, sold: 1 });
    const outputs = withOutput(h.outputs, 0, withNft(h.outputs[0], { commitment: posing }));
    t.diagnostic(why(expectReject(assert, assemble({ inputs: h.inputs, outputs }), { failing: 0 })));
  });

  test('REJECT seat reuse: ticket and marker reuse an already-sold seat of the shard', (t) => {
    const ctx = makeShow(assert);
    const first = honestBuy(ctx);
    const firstSigned = assemble(first);
    expectAccept(assert, firstSigned, 'first sale');
    const shard = utxoAt(firstSigned.transaction, 0); // sold = 1
    const h = honestBuy(ctx, { shard }); // honest second sale is seat 2
    const oldSeat = seatOf(0, 1);
    const outputs = h.outputs.slice();
    outputs[1] = withNft(outputs[1], { commitment: encodeTicketCommitment(oldSeat, h.buyer.pkh) });
    outputs[2] = withNft(outputs[2], { commitment: encodeMarkerCommitment(oldSeat, h.buyer.pkh) });
    t.diagnostic(why(expectReject(assert, assemble({ inputs: h.inputs, outputs }), { failing: 0 })));
  });

  test('REJECT counter rolled back to 0 after a sale', (t) => {
    const ctx = makeShow(assert);
    const first = assemble(honestBuy(ctx));
    const h = honestBuy(ctx, { shard: utxoAt(first.transaction, 0) });
    const reset = encodeBoxOfficeCommitment({ open: true, shard: 0, sold: 0 });
    const outputs = withOutput(h.outputs, 0, withNft(h.outputs[0], { commitment: reset }));
    t.diagnostic(why(expectReject(assert, assemble({ inputs: h.inputs, outputs }), { failing: 0 })));
  });

  test('REJECT buy not at input 0 (shard at input 1)', (t) => {
    const ctx = makeShow(assert);
    const h = honestBuy(ctx);
    const resolved = assemble({ inputs: [h.inputs[1], h.inputs[0]], outputs: h.outputs });
    t.diagnostic(why(expectReject(assert, resolved, { failing: 1 })));
  });

  test('REJECT two box-office shards in one transaction (both run buy)', (t) => {
    const ctx = makeShow(assert);
    const h = honestBuy(ctx);
    const second = { coin: ctx.shardUtxos[1], unlock: ctx.contracts.boxOffice.unlock('buy', [h.buyer.pkh]) };
    const outputs = h.outputs.slice();
    outputs.splice(3, 0, ctx.signedGenesis.transaction.outputs[1]); // shard 1 passed through unchanged
    const resolved = assemble({ inputs: [h.inputs[0], second, h.inputs[1]], outputs });
    t.diagnostic(why(expectReject(assert, resolved, { failing: [0, 1] })));
  });

  test('REJECT a second minting input of the category (leaked to a P2PKH by a bad genesis)', (t) => {
    const ctx = makeShow(assert);
    const h = honestBuy(ctx);
    const leaked = coin(
      nftOut(p2pkh(h.buyer.pkh), 1000, {
        category: ctx.show.category,
        commitment: encodeBoxOfficeCommitment({ open: true, shard: 9, sold: 0 }),
        capability: 'minting',
      }),
    );
    const outputs = lessChange(h.outputs, 0);
    outputs[3] = withValue(outputs[3], outputs[3].valueSatoshis + 1000n);
    const resolved = assemble({ inputs: [...h.inputs, { coin: leaked, signer: h.buyer }], outputs });
    // The leaked input is a plain P2PKH and passes on its own; only BoxOffice stops it.
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT ticket sent to a different pkh than the marker names', (t) => {
    const ctx = makeShow(assert);
    const h = honestBuy(ctx);
    const other = freshKey();
    const outputs = withOutput(h.outputs, 1, { ...h.outputs[1], lockingBytecode: p2pkh(other.pkh) });
    t.diagnostic(why(expectReject(assert, assemble({ inputs: h.inputs, outputs }), { failing: 0 })));
  });

  test('REJECT ticket commitment names another pkh than the marker', (t) => {
    const ctx = makeShow(assert);
    const h = honestBuy(ctx);
    const other = freshKey();
    const outputs = h.outputs.slice();
    outputs[1] = { ...withNft(outputs[1], { commitment: encodeTicketCommitment(h.seat, other.pkh) }), lockingBytecode: p2pkh(other.pkh) };
    t.diagnostic(why(expectReject(assert, assemble({ inputs: h.inputs, outputs }), { failing: 0 })));
  });

  test('REJECT marker names another pkh than the ticket (refund would go elsewhere)', (t) => {
    const ctx = makeShow(assert);
    const h = honestBuy(ctx);
    const other = freshKey();
    const outputs = withOutput(h.outputs, 2, withNft(h.outputs[2], { commitment: encodeMarkerCommitment(h.seat, other.pkh) }));
    t.diagnostic(why(expectReject(assert, assemble({ inputs: h.inputs, outputs }), { failing: 0 })));
  });

  test('REJECT marker names another seat than the ticket', (t) => {
    const ctx = makeShow(assert);
    const h = honestBuy(ctx);
    const outputs = withOutput(h.outputs, 2, withNft(h.outputs[2], { commitment: encodeMarkerCommitment(seatOf(0, 7), h.buyer.pkh) }));
    t.diagnostic(why(expectReject(assert, assemble({ inputs: h.inputs, outputs }), { failing: 0 })));
  });

  test('REJECT ticket carries 999 sats (below the 1,000 floor)', (t) => {
    const ctx = makeShow(assert);
    const h = honestBuy(ctx);
    const outputs = withOutput(h.outputs, 1, withValue(h.outputs[1], 999));
    outputs[3] = withValue(outputs[3], outputs[3].valueSatoshis + 1n);
    t.diagnostic(why(expectReject(assert, assemble({ inputs: h.inputs, outputs }), { failing: 0 })));
  });

  test('REJECT escrow underpaid by 1 sat (price + 999)', (t) => {
    const ctx = makeShow(assert);
    const h = honestBuy(ctx);
    const outputs = withOutput(h.outputs, 2, withValue(h.outputs[2], coinValue(ctx) - 1n));
    outputs[3] = withValue(outputs[3], outputs[3].valueSatoshis + 1n);
    t.diagnostic(why(expectReject(assert, assemble({ inputs: h.inputs, outputs }), { failing: 0 })));
  });

  test('REJECT ticket money kept by the buyer (marker coin at the buyer\'s address)', (t) => {
    const ctx = makeShow(assert);
    const h = honestBuy(ctx);
    const outputs = withOutput(h.outputs, 2, { ...h.outputs[2], lockingBytecode: p2pkh(h.buyer.pkh) });
    t.diagnostic(why(expectReject(assert, assemble({ inputs: h.inputs, outputs }), { failing: 0 })));
  });

  test('REJECT ticket money sent to another show\'s Escrow', (t) => {
    const ctx = makeShow(assert);
    const other = makeShow(assert);
    const h = honestBuy(ctx);
    const outputs = withOutput(h.outputs, 2, { ...h.outputs[2], lockingBytecode: other.contracts.escrow.lockingBytecode });
    t.diagnostic(why(expectReject(assert, assemble({ inputs: h.inputs, outputs }), { failing: 0 })));
  });

  test('REJECT ticket and marker swapped (outputs 1 and 2)', (t) => {
    const ctx = makeShow(assert);
    const h = honestBuy(ctx);
    const outputs = h.outputs.slice();
    [outputs[1], outputs[2]] = [outputs[2], outputs[1]];
    t.diagnostic(why(expectReject(assert, assemble({ inputs: h.inputs, outputs }), { failing: 0 })));
  });

  test('REJECT 41-byte ticket commitment (2026 consensus allows 128; the contract does not)', (t) => {
    const ctx = makeShow(assert);
    const h = honestBuy(ctx);
    const long = flattenBinArray([h.outputs[1].token.nft.commitment, new Uint8Array(17)]);
    assert.equal(long.length, MAX_COMMITMENT_BYTES + 1);
    const outputs = withOutput(h.outputs, 1, withNft(h.outputs[1], { commitment: long }));
    const result = expectReject(assert, assemble({ inputs: h.inputs, outputs }), { failing: 0 });
    t.diagnostic(why(result));
  });

  test('REJECT 41-byte commitment refused by the encoder before anything is built', () => {
    assert.equal(assertCommitmentSize(new Uint8Array(MAX_COMMITMENT_BYTES)).length, 40);
    assert.throws(
      () => assertCommitmentSize(new Uint8Array(MAX_COMMITMENT_BYTES + 1)),
      (error) => error instanceof DoorstubError && error.code === 'commitment-too-long',
    );
  });

  test('REJECT fungible amount smuggled onto the ticket (consensus: no fungible tokens after genesis)', (t) => {
    const ctx = makeShow(assert);
    const h = honestBuy(ctx);
    const outputs = withOutput(h.outputs, 1, { ...h.outputs[1], token: { ...h.outputs[1].token, amount: 1000n } });
    // BoxOffice does not look at amounts; the token rules stop it.
    t.diagnostic(why(expectReject(assert, assemble({ inputs: h.inputs, outputs }), { verify: /fungible|amount|token/i })));
  });

  test('REJECT buy after closeSales (builder refuses; hand-built tx fails in the VM)', (t) => {
    const ctx = makeShow(assert);
    const closed = buildCloseSales({
      show: ctx.show,
      shardUtxos: [ctx.shardUtxos[0]],
      fundingUtxos: [fakeCoin(ctx.organiser.pkh, 20_000)],
      changeLockingBytecode: p2pkh(ctx.organiser.pkh),
      signShard: ({ digest }) => signDigest(ctx.organiser.privateKey, digest),
    });
    const signedClose = signWallet(closed, ctx.organiser.privateKey);
    expectAccept(assert, signedClose, 'closeSales');
    const closedShard = utxoAt(signedClose.transaction, 0);
    const buyer = freshKey();
    assert.throws(
      () => buildBuy({ show: ctx.show, boxOfficeUtxo: closedShard, fundingUtxos: [fakeCoin(buyer.pkh, 50_000)], buyerPkh: buyer.pkh, currentHeight: saleHeight(ctx.show) }),
      (error) => error.code === 'sales-closed',
    );
    // Hand-built: same outputs as an open sale, but spending the closed shard.
    const h = honestBuy(ctx, { buyer, shard: ctx.shardUtxos[1] });
    const keepClosed = withNft(h.outputs[0], { commitment: encodeBoxOfficeCommitment({ open: false, shard: 0, sold: 1 }) });
    const reopen = withNft(h.outputs[0], { commitment: encodeBoxOfficeCommitment({ open: true, shard: 0, sold: 1 }) });
    const fix = (o) => [o, ...h.outputs.slice(1)].map((x, i) => (i === 1 || i === 2
      ? withNft(x, { commitment: (i === 1 ? encodeTicketCommitment : encodeMarkerCommitment)(seatOf(0, 1), buyer.pkh) })
      : x));
    const unlock = ctx.contracts.boxOffice.unlock('buy', [buyer.pkh]);
    for (const shardOut of [keepClosed, reopen]) {
      const resolved = assemble({ inputs: [{ coin: closedShard, unlock }, h.inputs[1]], outputs: fix(shardOut) });
      t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
    }
  });

  test('control + REJECT per-shard limit: seat 32,767 sells, seat 32,768 cannot', (t) => {
    const ctx = makeShow(assert);
    const buyer = freshKey();
    const almost = shardCoin(ctx, { sold: 32_766 });
    const last = buildBuy({ show: ctx.show, boxOfficeUtxo: almost, fundingUtxos: [fakeCoin(buyer.pkh, 50_000)], buyerPkh: buyer.pkh, currentHeight: saleHeight(ctx.show) });
    expectAccept(assert, signWallet(last, buyer.privateKey), 'seat 32,767');
    const full = shardCoin(ctx, { sold: 32_767 });
    assert.throws(
      () => buildBuy({ show: ctx.show, boxOfficeUtxo: full, fundingUtxos: [fakeCoin(buyer.pkh, 50_000)], buyerPkh: buyer.pkh, currentHeight: saleHeight(ctx.show) }),
      (error) => error.code === 'shard-full',
    );
    // Hand-built: whatever the outputs say, toPaddedBytes(32768, 2) fails.
    const wrapped = Uint8Array.of(0, 0x00, 0x80); // shard 0, 32768 LE
    const outputs = last.transaction.outputs.map((o, i) => {
      if (i === 0) return withNft(o, { commitment: Uint8Array.of(1, ...wrapped) });
      if (i === 1) return withNft(o, { commitment: Uint8Array.of(0x54, ...wrapped, ...buyer.pkh) });
      if (i === 2) return withNft(o, { commitment: Uint8Array.of(0x45, ...wrapped, ...buyer.pkh) });
      return o;
    });
    const resolved = assemble({
      inputs: [
        { coin: full, unlock: ctx.contracts.boxOffice.unlock('buy', [buyer.pkh]) },
        { coin: { txid: last.transaction.inputs[1].outpointTransactionHash, vout: 0, output: last.sourceOutputs[1] }, signer: buyer },
      ],
      outputs,
    });
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT buyerPkh argument of 21 bytes', (t) => {
    const ctx = makeShow(assert);
    const h = honestBuy(ctx);
    const unlock = rawUnlock(ctx.contracts.boxOffice, 0, [Uint8Array.of(...h.buyer.pkh, 0)]);
    const resolved = assemble({ inputs: [{ ...h.inputs[0], unlock }, h.inputs[1]], outputs: h.outputs });
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT unknown function selector (2) on BoxOffice', (t) => {
    const ctx = makeShow(assert);
    const h = honestBuy(ctx);
    const unlock = rawUnlock(ctx.contracts.boxOffice, 2, [h.buyer.pkh]);
    const resolved = assemble({ inputs: [{ ...h.inputs[0], unlock }, h.inputs[1]], outputs: h.outputs });
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('REJECT buy that also settles someone else\'s escrow coin', (t) => {
    const ctx = makeShow(assert);
    const h = honestBuy(ctx);
    const victim = freshKey();
    const esc = escrowCoin(ctx, { seat: seatOf(3, 1), buyerPkh: victim.pkh });
    const outputs = h.outputs.slice();
    outputs[3] = withValue(outputs[3], outputs[3].valueSatoshis + coinValue(ctx)); // attacker pockets it
    const resolved = assemble({
      inputs: [...h.inputs, { coin: esc, unlock: escrowUnlock(ctx).settle(), sequence: SEQUENCE_LOCKTIME }],
      outputs,
      locktime: settleHeight(ctx),
    });
    t.diagnostic(why(expectReject(assert, resolved, { failing: 2 })));
  });
});

describe('BoxOffice.closeSales attacks', () => {
  /** Honest closeSales of shard 0: input 0 shard, input 1 organiser coin. */
  const honestClose = (ctx, shard = ctx.shardUtxos[0], sold = 0) => {
    const funding = fakeCoin(ctx.organiser.pkh, 20_000);
    return {
      inputs: [
        { coin: shard, unlock: closeSalesUnlock(ctx) },
        { coin: funding, signer: ctx.organiser },
      ],
      outputs: [
        nftOut(ctx.contracts.boxOffice.lockingBytecode, shard.output.valueSatoshis, {
          category: ctx.show.category,
          commitment: encodeBoxOfficeCommitment({ open: false, shard: shard.output.token.nft.commitment[1], sold }),
          capability: 'minting',
        }),
        out(p2pkh(ctx.organiser.pkh), 19_000),
      ],
    };
  };

  test('control: an honest closeSales passes', () => {
    const ctx = makeShow(assert);
    expectAccept(assert, assemble(honestClose(ctx)));
  });

  test('REJECT closeSales signed by a key that is not the organiser', (t) => {
    const ctx = makeShow(assert);
    const h = honestClose(ctx);
    const intruder = freshKey();
    const inputs = [{ ...h.inputs[0], unlock: closeSalesUnlock(ctx, intruder) }, h.inputs[1]];
    t.diagnostic(why(expectReject(assert, assemble({ inputs, outputs: h.outputs }), { failing: 0 })));
  });

  test('REJECT closeSales with an empty signature', (t) => {
    const ctx = makeShow(assert);
    const h = honestClose(ctx);
    const inputs = [{ ...h.inputs[0], unlock: ctx.contracts.boxOffice.unlock('closeSales', [new Uint8Array()]) }, h.inputs[1]];
    t.diagnostic(why(expectReject(assert, assemble({ inputs, outputs: h.outputs }), { failing: 0 })));
  });

  test('REJECT organiser signature replayed onto a different transaction', (t) => {
    const ctx = makeShow(assert);
    const h = honestClose(ctx);
    const signed = assemble(h);
    expectAccept(assert, signed, 'original closeSales');
    const stolenUnlock = signed.transaction.inputs[0].unlockingBytecode;
    const outputs = [h.outputs[0], out(p2pkh(freshKey().pkh), 19_000)];
    const inputs = [{ ...h.inputs[0], unlock: stolenUnlock }, h.inputs[1]];
    t.diagnostic(why(expectReject(assert, assemble({ inputs, outputs }), { failing: 0 })));
  });

  test('REJECT reopening: closeSales output in the open state', (t) => {
    const ctx = makeShow(assert);
    const h = honestClose(ctx);
    const outputs = withOutput(h.outputs, 0, withNft(h.outputs[0], { commitment: encodeBoxOfficeCommitment({ open: true, shard: 0, sold: 0 }) }));
    t.diagnostic(why(expectReject(assert, assemble({ inputs: h.inputs, outputs }), { failing: 0 })));
  });

  test('REJECT organiser moves the minting NFT to their own address (even closed)', (t) => {
    const ctx = makeShow(assert);
    const h = honestClose(ctx);
    const outputs = withOutput(h.outputs, 0, { ...h.outputs[0], lockingBytecode: p2pkh(ctx.organiser.pkh) });
    t.diagnostic(why(expectReject(assert, assemble({ inputs: h.inputs, outputs }), { failing: 0 })));
  });

  test('REJECT organiser mints a marker into the Escrow during closeSales', (t) => {
    const ctx = makeShow(assert);
    const h = honestClose(ctx);
    const marker = nftOut(ctx.contracts.escrow.lockingBytecode, 11_000, {
      category: ctx.show.category,
      commitment: encodeMarkerCommitment(seatOf(0, 1), ctx.organiser.pkh),
    });
    const funding = fakeCoin(ctx.organiser.pkh, 20_000);
    const outputs = [h.outputs[0], marker, out(p2pkh(ctx.organiser.pkh), 28_000)];
    const inputs = [...h.inputs, { coin: funding, signer: ctx.organiser }];
    t.diagnostic(why(expectReject(assert, assemble({ inputs, outputs }), { failing: 0 })));
  });

  test('REJECT organiser mints a ticket to someone during closeSales', (t) => {
    const ctx = makeShow(assert);
    const h = honestClose(ctx);
    const friend = freshKey();
    const ticket = nftOut(p2pkh(friend.pkh), 1000, {
      category: ctx.show.category,
      commitment: encodeTicketCommitment(seatOf(0, 1), friend.pkh),
    });
    const outputs = [h.outputs[0], ticket, out(p2pkh(ctx.organiser.pkh), 18_000)];
    t.diagnostic(why(expectReject(assert, assemble({ inputs: h.inputs, outputs }), { failing: 0 })));
  });

  test('REJECT closeSales spawns an extra OPEN shard at the BoxOffice (re-sell seats under a copied shard byte)', (t) => {
    const ctx = makeShow(assert);
    const h = honestClose(ctx);
    const spawn = nftOut(ctx.contracts.boxOffice.lockingBytecode, 1000, {
      category: ctx.show.category,
      commitment: encodeBoxOfficeCommitment({ open: true, shard: 0, sold: 0 }),
      capability: 'minting',
    });
    const outputs = [h.outputs[0], spawn, out(p2pkh(ctx.organiser.pkh), 18_000)];
    t.diagnostic(why(expectReject(assert, assemble({ inputs: h.inputs, outputs }), { failing: 0 })));
  });

  test('REJECT closeSales rewrites the shard byte or the counter', (t) => {
    const ctx = makeShow(assert);
    for (const commitment of [
      encodeBoxOfficeCommitment({ open: false, shard: 1, sold: 0 }),
      encodeBoxOfficeCommitment({ open: false, shard: 0, sold: 5 }),
    ]) {
      const h = honestClose(ctx);
      const outputs = withOutput(h.outputs, 0, withNft(h.outputs[0], { commitment }));
      t.diagnostic(why(expectReject(assert, assemble({ inputs: h.inputs, outputs }), { failing: 0 })));
    }
  });

  test('REJECT closeSales drains the shard by 1 sat', (t) => {
    const ctx = makeShow(assert);
    const h = honestClose(ctx);
    const outputs = [withValue(h.outputs[0], 999), out(p2pkh(ctx.organiser.pkh), 19_001)];
    t.diagnostic(why(expectReject(assert, assemble({ inputs: h.inputs, outputs }), { failing: 0 })));
  });

  test('REJECT fungible amount minted during closeSales (consensus)', (t) => {
    const ctx = makeShow(assert);
    const h = honestClose(ctx);
    const outputs = withOutput(h.outputs, 0, { ...h.outputs[0], token: { ...h.outputs[0].token, amount: 1n } });
    t.diagnostic(why(expectReject(assert, assemble({ inputs: h.inputs, outputs }), { verify: /fungible|amount|token/i })));
  });

  test('REJECT closeSales on a shard of another category planted at the BoxOffice (BoxOffice knows its category)', (t) => {
    const ctx = makeShow(assert);
    const otherCategory = randomTxid();
    const planted = shardCoin(ctx, { category: otherCategory });
    const funding = fakeCoin(ctx.organiser.pkh, 20_000);
    const closed = nftOut(ctx.contracts.boxOffice.lockingBytecode, 1000, {
      category: otherCategory,
      commitment: encodeBoxOfficeCommitment({ open: false, shard: 0, sold: 0 }),
      capability: 'minting',
    });
    const resolved = assemble({
      inputs: [{ coin: planted, unlock: closeSalesUnlock(ctx) }, { coin: funding, signer: ctx.organiser }],
      outputs: [closed, out(p2pkh(ctx.organiser.pkh), 19_000)],
    });
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });

  test('LIMIT closeSales may leave extra CLOSED tokens at the BoxOffice; they can never sell', (t) => {
    const ctx = makeShow(assert);
    const h = honestClose(ctx);
    const spare = nftOut(ctx.contracts.boxOffice.lockingBytecode, 1000, {
      category: ctx.show.category,
      commitment: encodeBoxOfficeCommitment({ open: false, shard: 7, sold: 0 }),
      capability: 'minting',
    });
    const outputs = [h.outputs[0], spare, out(p2pkh(ctx.organiser.pkh), 18_000)];
    const signed = assemble({ inputs: h.inputs, outputs });
    expectAccept(assert, signed, 'closeSales with a spare closed token (organiser\'s own sats, stays locked)');
    // The spare is closed for good: buying from it fails, and closeSales keeps it closed.
    const spareCoin = utxoAt(signed.transaction, 1);
    const buyer = freshKey();
    const h2 = honestBuy(ctx, { buyer, shard: ctx.shardUtxos[1] });
    const outs = h2.outputs.map((o, i) => {
      if (i === 0) return withNft(o, { commitment: encodeBoxOfficeCommitment({ open: true, shard: 7, sold: 1 }) });
      if (i === 1) return withNft(o, { commitment: encodeTicketCommitment(seatOf(7, 1), buyer.pkh) });
      if (i === 2) return withNft(o, { commitment: encodeMarkerCommitment(seatOf(7, 1), buyer.pkh) });
      return o;
    });
    const resolved = assemble({ inputs: [{ coin: spareCoin, unlock: ctx.contracts.boxOffice.unlock('buy', [buyer.pkh]) }, h2.inputs[1]], outputs: outs });
    t.diagnostic(why(expectReject(assert, resolved, { failing: 0 })));
  });
});

test('kit self-check: rawUnlock matches the normal unlocking encoder', () => {
  const ctx = makeShow(assert);
  const pkh = freshKey().pkh;
  assert.deepEqual(rawUnlock(ctx.contracts.boxOffice, 0, [pkh]), ctx.contracts.boxOffice.unlock('buy', [pkh]));
  assert.deepEqual(encodeDataPush(new Uint8Array()), Uint8Array.of(0));
});
