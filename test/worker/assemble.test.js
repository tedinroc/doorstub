// The worker builds settle and refund without libauth (workerd cannot load
// it, worker/RUNTIME.md). These tests pin its bytes to src/tx's builders over
// many random shows and coin sets, run every result through the libauth 2026
// VM in both modes, and check the worker's own rule check accepts exactly the
// honest transactions and refuses tampered ones. They also pin the worker's
// transaction codec against libauth's on every Doorstub path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { binToHex, decodeTransaction as libDecode, encodeTransaction as libEncode } from '@bitauth/libauth';
import {
  buildBuy,
  buildCheckIn,
  buildHandBack,
  buildRefund,
  buildSettle,
  describeResult,
  encodeMarkerCommitment,
  encodeRefundNoticeMessage,
  evaluateTransaction,
  verifyRefundNotice,
} from '../../src/tx/index.js';
import { signDataMessage } from '../../src/tx/sign.js';
import { fakeCoin, freshKey, makeShow, randomTxid, saleHeight, signWallet, utxoAt } from '../helpers.js';
import { bytesToHex, concat, WorkerError } from '../../worker/lib/bytes.js';
import { signDataEcdsa } from '../../worker/lib/crypto.js';
import { assembleRefund, assembleSettle, batchCoins, coinFromElectrum, feeOnCoin } from '../../worker/lib/escrow.js';
import { checkCheckIn, checkEscrowSpend, isVetted, vet } from '../../worker/lib/rules.js';
import { boxOfficeScripts, escrowScripts, p2pkhLockingBytecode } from '../../worker/lib/script.js';
import { refundNoticeMessage } from '../../worker/lib/shows.js';
import { decodeTransaction, encodeTransaction } from '../../worker/lib/tx.js';
import { libauthVmCheck } from '../../worker/node/vm.js';

/** The worker's view of a src/tx show (numbers, recomputed scripts). */
const workerShow = (show) => {
  const s = { ...show, startHeight: Number(show.startHeight), graceBlocks: Number(show.graceBlocks), categoryHex: bytesToHex(show.category) };
  s.escrow = escrowScripts(s);
  s.boxOffice = boxOfficeScripts(s, s.escrow.lockingBytecode);
  return s;
};

let rngState = 0x2545f491;
const rand = (n) => {
  rngState ^= rngState << 13;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5;
  return (rngState >>> 0) % n;
};

const markerCoin = (show, contracts, { shard, sold, value, pkh = freshKey().pkh }) => {
  const seat = Uint8Array.of(shard, sold & 0xff, sold >> 8);
  return {
    txid: randomTxid(),
    vout: rand(6),
    output: {
      lockingBytecode: contracts.escrow.lockingBytecode,
      valueSatoshis: value,
      token: { amount: 0n, category: show.category, nft: { capability: 'none', commitment: encodeMarkerCommitment(seat, pkh) } },
    },
    seat,
    buyerPkh: pkh,
  };
};

const randomCoins = (show, contracts, k) =>
  Array.from({ length: k }, (_, i) => {
    const base = BigInt(show.price) + 1_000n;
    // Some coins hold more (a buyer may overpay the escrow output), so some owe a fee and some do not.
    const value = rand(3) === 0 ? base + BigInt(rand(200_000)) : base;
    return markerCoin(show, contracts, { shard: rand(4), sold: i + 1, value });
  });

const assertVmOk = (resolved, label) => {
  const result = evaluateTransaction(resolved);
  assert.equal(describeResult(result), 'ok', `${label}: valid in the 2026 VM`);
};

test('worker scripts: Escrow and BoxOffice redeem scripts, locking bytecode and script hash equal src/tx over random shows', () => {
  for (let i = 0; i < 20; i += 1) {
    const price = 6_000 + rand(2_000_000);
    const cap = 1_200 + rand(Math.min(800, Math.floor(price / 5) - 1_200 + 1));
    const { show, contracts } = makeShow(assert, {
      shards: 1,
      overrides: {
        price: BigInt(price),
        minerFeeCap: BigInt(cap),
        startHeight: rand(2_000_000),
        graceBlocks: rand(1_000),
        handBackFeeBps: rand(1_001),
        noShowFeeBps: rand(1_001),
      },
    });
    const w = workerShow(show);
    assert.equal(bytesToHex(w.escrow.redeemScript), binToHex(contracts.escrow.redeemScript));
    assert.equal(bytesToHex(w.escrow.lockingBytecode), binToHex(contracts.escrow.lockingBytecode));
    assert.equal(bytesToHex(w.boxOffice.redeemScript), binToHex(contracts.boxOffice.redeemScript));
    assert.equal(bytesToHex(w.boxOffice.lockingBytecode), binToHex(contracts.boxOffice.lockingBytecode));
  }
});

test('assembleSettle is byte-equal to buildSettle (fee and fee-free coins, 1 to 100 coins) and valid in the VM', () => {
  for (const [k, bps] of [[1, 0], [2, 100], [3, 0], [7, 250], [16, 1_000], [100, 100]]) {
    const { show, contracts } = makeShow(assert, { shards: 1, overrides: { price: 10_000n, noShowFeeBps: bps, startHeight: 900_000, graceBlocks: 2 } });
    const w = workerShow(show);
    const coins = randomCoins(show, contracts, k);
    const mine = assembleSettle({ show: w, coins });
    const theirs = buildSettle({ show, escrowUtxos: coins });
    assert.equal(bytesToHex(mine.bytes), binToHex(libEncode(theirs.transaction)), `settle of ${k} coins at ${bps} bps`);
    assert.equal(mine.fee, theirs.fee);
    assert.deepEqual(mine.seats.map(bytesToHex), theirs.seats.map(binToHex));
    if (k <= 16 || k === 100) assertVmOk({ transaction: mine.transaction, sourceOutputs: mine.sourceOutputs }, `settle x${k}`);
    // The worker's rule check takes it, and so does the full vet with the VM.
    const vetted = vet({ show: w, kind: 'settle', transaction: mine.transaction, sourceOutputs: mine.sourceOutputs, tip: 900_002, vmCheck: k <= 16 ? libauthVmCheck : undefined });
    assert.ok(isVetted(vetted));
    assert.equal(vetted.txid, mine.txid);
  }
});

test('assembleRefund is byte-equal to buildRefund with worker ECDSA R notices and studio Schnorr C notices, and valid in the VM', () => {
  for (const k of [1, 2, 5, 40, 100]) {
    const { show, contracts, dataKey } = makeShow(assert, { shards: 1 });
    const w = workerShow(show);
    const coins = randomCoins(show, contracts, k);
    const cancel = { scope: 'C', signature: signDataMessage(dataKey.privateKey, encodeRefundNoticeMessage({ scope: 'C', category: show.category })) };
    // Every other coin gets its own 'R' notice from the worker's signer; the rest fall back to the 'C' notice.
    const seatNotices = coins
      .filter((_, i) => i % 2 === 0)
      .map((coin) => ({ scope: 'R', seat: coin.seat, signature: signDataEcdsa(dataKey.privateKey, refundNoticeMessage({ scope: 'R', category: show.category, seat: coin.seat })) }));
    for (const n of seatNotices) assert.ok(verifyRefundNotice({ show, notice: n }), 'src/tx verifies the worker\'s notice');
    for (const notices of [[...seatNotices, cancel], [cancel]]) {
      const mine = assembleRefund({ show: w, coins, notices });
      const theirs = buildRefund({ show, escrowUtxos: coins, notices });
      assert.equal(bytesToHex(mine.bytes), binToHex(libEncode(theirs.transaction)), `refund of ${k} coins`);
      assert.equal(mine.fee, theirs.fee);
      if (k <= 5) assertVmOk({ transaction: mine.transaction, sourceOutputs: mine.sourceOutputs }, `refund x${k}`);
      checkEscrowSpend({ show: w, kind: 'refund', transaction: mine.transaction, sourceOutputs: mine.sourceOutputs });
    }
    // R notices alone, every coin: the sample show B keeper path.
    const allSeats = coins.map((coin) => ({ scope: 'R', seat: coin.seat, signature: signDataEcdsa(dataKey.privateKey, refundNoticeMessage({ scope: 'R', category: show.category, seat: coin.seat })) }));
    const mine = assembleRefund({ show: w, coins, notices: allSeats });
    assert.equal(bytesToHex(mine.bytes), binToHex(libEncode(buildRefund({ show, escrowUtxos: coins, notices: allSeats }).transaction)));
    // 100 coins with DER notices (up to 72 bytes each, 8 more than Schnorr) still fit the standard size and the VM budget.
    if (k <= 5 || k === 100) assert.deepEqual(libauthVmCheck(mine), { ok: true }, `all-R refund x${k}`);
    if (k === 100) assert.ok(mine.size < 100_000, `${mine.size} bytes`);
  }
});

test('the worker\'s rule check refuses tampered settles and refunds (so an assembler bug cannot move money elsewhere)', () => {
  const { show, contracts, dataKey } = makeShow(assert, { shards: 1, overrides: { price: 10_000n, noShowFeeBps: 100, startHeight: 900_000, graceBlocks: 2 } });
  const other = makeShow(assert, { shards: 1 });
  const w = workerShow(show);
  const coins = [
    markerCoin(show, contracts, { shard: 0, sold: 1, value: 200_000n }),
    markerCoin(show, contracts, { shard: 1, sold: 1, value: 11_000n }),
  ];
  const settle = assembleSettle({ show: w, coins });
  const check = (tx, sourceOutputs = settle.sourceOutputs, kind = 'settle', tip = 900_002) => () => checkEscrowSpend({ show: w, kind, transaction: tx, sourceOutputs, tip });
  assert.doesNotThrow(check(settle.transaction));
  const outputs = settle.transaction.outputs;
  const attacker = p2pkhLockingBytecode(freshKey().pkh);
  const cases = [
    ['wrong-payee', { ...settle.transaction, outputs: [{ ...outputs[0], lockingBytecode: attacker }, ...outputs.slice(1)] }],
    ['wrong-amount', { ...settle.transaction, outputs: [{ ...outputs[0], valueSatoshis: outputs[0].valueSatoshis - 1_600n }, ...outputs.slice(1)] }],
    ['wrong-amount', { ...settle.transaction, outputs: [{ ...outputs[0], valueSatoshis: 200_000n }, ...outputs.slice(1)] }],
    ['extra-output', { ...settle.transaction, outputs: [...outputs, { lockingBytecode: attacker, valueSatoshis: 600n }] }],
    ['wrong-fee', { ...settle.transaction, outputs: [...outputs.slice(0, 2), { ...outputs[2], valueSatoshis: outputs[2].valueSatoshis + 1n }] }],
    ['missing-fee', { ...settle.transaction, outputs: outputs.slice(0, 2) }],
    ['too-early', { ...settle.transaction, locktime: 900_001 }],
    ['final-sequence', { ...settle.transaction, inputs: settle.transaction.inputs.map((i) => ({ ...i, sequenceNumber: 0xffffffff })) }],
    ['token-on-payout', { ...settle.transaction, outputs: [{ ...outputs[0], token: coins[0].output.token }, ...outputs.slice(1)] }],
  ];
  for (const [code, tx] of cases) assert.throws(check(tx), (e) => e instanceof WorkerError && e.code === code, code);
  assert.throws(check(settle.transaction, settle.sourceOutputs, 'settle', 900_001), (e) => e.code === 'not-final');
  // A coin of another show's Escrow, or a plain coin, can never be an input.
  assert.throws(check(settle.transaction, [settle.sourceOutputs[0], { lockingBytecode: other.contracts.escrow.lockingBytecode, valueSatoshis: 11_000n }]), (e) => e.code === 'not-escrow');
  assert.throws(check(settle.transaction, [settle.sourceOutputs[0], fakeCoin(freshKey().pkh, 11_000).output]), (e) => e.code === 'not-escrow');

  // Refund: a notice for another seat, another show, or by another key is refused.
  const sign = (key, scope, seat, category = show.category) => signDataEcdsa(key, refundNoticeMessage({ scope, category, seat }));
  const good = assembleRefund({ show: w, coins, notices: coins.map((c) => ({ scope: 'R', seat: c.seat, signature: sign(dataKey.privateKey, 'R', c.seat) })) });
  assert.doesNotThrow(check(good.transaction, good.sourceOutputs, 'refund'));
  for (const [label, signature] of [
    ['other seat', sign(dataKey.privateKey, 'R', coins[1].seat)],
    ['other show', sign(dataKey.privateKey, 'R', coins[0].seat, other.show.category)],
    ['other key', sign(freshKey().privateKey, 'R', coins[0].seat)],
  ]) {
    const bad = assembleRefund({ show: w, coins, notices: [{ scope: 'R', seat: coins[0].seat, signature }, { scope: 'R', seat: coins[1].seat, signature: sign(dataKey.privateKey, 'R', coins[1].seat) }] });
    assert.throws(check(bad.transaction, bad.sourceOutputs, 'refund'), (e) => e.code === 'bad-notice', label);
    assert.equal(libauthVmCheck(bad).ok, false, `${label}: the VM agrees`);
  }
  // vet with the VM refuses what the VM refuses even if the rules were fooled.
  assert.throws(() => vet({ show: w, kind: 'settle', transaction: settle.transaction, sourceOutputs: settle.sourceOutputs, tip: 900_002, vmCheck: () => ({ ok: false, reason: 'test' }) }), (e) => e.code === 'vm-invalid');
});

test('batches: at most 100 coins each, coins that owe a fee first', () => {
  const { show, contracts } = makeShow(assert, { shards: 1, overrides: { price: 10_000n, noShowFeeBps: 100 } });
  const w = workerShow(show);
  const coins = Array.from({ length: 230 }, (_, i) => markerCoin(show, contracts, { shard: 0, sold: i + 1, value: i % 7 === 0 ? 100_000n : 11_000n }));
  const batches = batchCoins(w, coins, 100, { feeFirst: true });
  assert.deepEqual(batches.map((b) => b.length), [100, 100, 30]);
  const owes = (c) => feeOnCoin(c.output.valueSatoshis, w.noShowFeeBps) > 0n;
  const flat = batches.flat();
  const firstFree = flat.findIndex((c) => !owes(c));
  assert.ok(flat.slice(firstFree).every((c) => !owes(c)), 'every fee-owing coin comes before every fee-free one');
  assert.equal(flat.filter(owes).length, coins.filter(owes).length);
});

test('coinFromElectrum keeps only live markers of the show (look-alikes, plain coins and short coins are ignored)', () => {
  const { show, contracts } = makeShow(assert, { shards: 1 });
  const w = workerShow(show);
  const coin = markerCoin(show, contracts, { shard: 2, sold: 9, value: 11_000n });
  const item = (over = {}, token = {}) => ({
    height: 0,
    tx_hash: binToHex(coin.txid),
    tx_pos: 3,
    value: 11_000,
    token_data: { amount: '0', category: binToHex(show.category), nft: { capability: 'none', commitment: binToHex(coin.output.token.nft.commitment) }, ...token },
    ...over,
  });
  const parsed = coinFromElectrum(w, item());
  assert.equal(parsed.seatHex, binToHex(coin.seat));
  assert.equal(bytesToHex(parsed.buyerPkh), binToHex(coin.buyerPkh));
  assert.equal(coinFromElectrum(w, item({}, { category: binToHex(randomTxid()) })).ignored, 'another category');
  assert.equal(coinFromElectrum(w, item({ token_data: undefined })).ignored, 'no token');
  assert.equal(coinFromElectrum(w, item({ value: 10_999 })).ignored, 'below price + 1,000 sats');
  assert.equal(coinFromElectrum(w, item({}, { nft: { capability: 'none', commitment: `54${binToHex(coin.output.token.nft.commitment).slice(2)}` } })).ignored, 'not a marker');
  assert.equal(coinFromElectrum(w, item({}, { nft: { capability: 'minting', commitment: '01000000' } })).ignored, 'not an immutable NFT');
});

test('worker transaction codec equals libauth on every Doorstub path (buy, hand-back, check-in, settle, refund, genesis)', () => {
  const { show, contracts, shardUtxos, signedGenesis, dataKey } = makeShow(assert, { overrides: { handBackFeeBps: 500 } });
  const buyer = freshKey();
  const buy = signWallet(
    buildBuy({ show, boxOfficeUtxo: shardUtxos[0], fundingUtxos: [fakeCoin(buyer.pkh, 50_000)], buyerPkh: buyer.pkh, currentHeight: saleHeight(show) }),
    buyer.privateKey,
  );
  const ticket = utxoAt(buy.transaction, 1);
  const escrow = utxoAt(buy.transaction, 2);
  const handBack = signWallet(buildHandBack({ show, escrowUtxo: escrow, ticketUtxo: ticket }), buyer.privateKey);
  const checkIn = signWallet(buildCheckIn({ show, escrowUtxo: escrow, ticketUtxo: ticket }), buyer.privateKey);
  const settle = buildSettle({ show, escrowUtxos: [escrow] });
  const refund = buildRefund({ show, escrowUtxos: [escrow], notices: [{ scope: 'C', signature: signDataMessage(dataKey.privateKey, encodeRefundNoticeMessage({ scope: 'C', category: show.category })) }] });
  for (const [label, resolved] of Object.entries({ genesis: signedGenesis, buy, handBack, checkIn, settle, refund })) {
    const bytes = libEncode(resolved.transaction);
    const decoded = decodeTransaction(bytes);
    assert.deepEqual(decoded, libDecode(bytes), `${label}: decodes like libauth`);
    assert.equal(bytesToHex(encodeTransaction(decoded)), binToHex(bytes), `${label}: re-encodes to the same bytes`);
  }
  // The door's check-in rule check takes the honest check-in and refuses a hand-back.
  const w = workerShow(show);
  const seen = checkCheckIn({ show: w, transaction: checkIn.transaction, sourceOutputs: checkIn.sourceOutputs });
  assert.equal(bytesToHex(seen.seat), binToHex(buy.transaction.outputs[2].token.nft.commitment.slice(1, 4)));
  assert.throws(() => checkCheckIn({ show: w, transaction: handBack.transaction, sourceOutputs: handBack.sourceOutputs }), (e) => e instanceof WorkerError);
  // Malformed bytes are refused, never half-read.
  const bytes = libEncode(buy.transaction);
  for (const bad of [bytes.slice(0, -1), concat([bytes, Uint8Array.of(0)]), Uint8Array.of(2, 0, 0, 0, 0xfd, 1)]) {
    assert.throws(() => decodeTransaction(bad), (e) => e.code === 'bad-transaction');
  }
  assert.ok(contracts);
});
