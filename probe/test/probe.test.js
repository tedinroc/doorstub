// Offline tests for the probe: request building and reply checking, with a
// simulated wallet (throwaway mnemonic) that signs with libauth. Each request
// goes through a JSON round trip, as it would over the relay. Nothing touches
// the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { decodeTransaction, encodeTransaction, hexToBin, binToHex } from '@bitauth/libauth';
import { SHAPES, USER_PROMPT, buildShape, makeProbeShow, madeUpTxid, A_REAL_NEED } from '../src/shapes.js';
import { toSignRequest } from '../src/wire.js';
import { checkReply, refusal } from '../src/check.js';
import { makeSimWallet } from './sim-wallet.js';
import { p2pkhLockingBytecode } from '../../src/tx/index.js';

const overRelay = (request) => JSON.parse(JSON.stringify(request));

const setup = (walletOptions = {}) => {
  const wallet = makeSimWallet(walletOptions);
  const probe = makeProbeShow();
  return { wallet, probe, walletPkh: wallet.pkhAt('receive', 0) };
};

/** Made-up "real" coins at the sim wallet's receive/change addresses, as a scan would return them. */
const scannedCoins = (wallet) => [
  { txid: madeUpTxid(), vout: 3, value: 8_000n, path: 'change', index: 2, lockingBytecode: p2pkhLockingBytecode(wallet.pkhAt('change', 2)) },
  { txid: madeUpTxid(), vout: 0, value: 9_000n, path: 'receive', index: 5, lockingBytecode: p2pkhLockingBytecode(wallet.pkhAt('receive', 5)) },
];

const run = (ctx, id, extra = {}) => {
  const shape = buildShape(id, { probe: ctx.probe, walletPkh: ctx.walletPkh, ...extra });
  const request = toSignRequest(shape);
  let signedHex;
  try {
    signedHex = ctx.wallet.sign(overRelay(request));
  } catch (e) {
    return { shape, request, result: refusal(shape, e.message) };
  }
  return { shape, request, result: checkReply(shape, signedHex) };
};

for (const id of ['A-free', 'B', 'C']) {
  test(`${id}: sim wallet signs, every check passes`, () => {
    const ctx = setup();
    const { shape, request, result } = run(ctx, id);
    assert.equal(result.verdict, 'PASS', result.summary);
    assert.equal(request.transaction.broadcast, false);
    assert.equal(request.transaction.userPrompt, USER_PROMPT);
    assert.ok(shape.madeUpInputIndexes.length > 0);
    assert.ok(shape.covenantInputIndexes.includes(0), 'input 0 is the covenant input');
    assert.deepEqual(request.inputPaths, [[1, 'receive', 0]]);
    assert.equal(result.vm.ok, true);
    assert.equal(result.signatures[0].algorithm, 'schnorr');
  });
}

test('A-free: outputs are the real buy (BoxOffice, ticket to wallet, escrow, change to wallet)', () => {
  const ctx = setup();
  const shape = buildShape('A-free', ctx);
  const outs = shape.transaction.outputs;
  const walletLock = p2pkhLockingBytecode(ctx.walletPkh);
  assert.equal(outs.length, 4);
  assert.deepEqual(outs[0].lockingBytecode, ctx.probe.contracts.boxOffice.lockingBytecode);
  assert.equal(outs[0].token.nft.capability, 'minting');
  assert.deepEqual(outs[1].lockingBytecode, walletLock);
  assert.equal(outs[1].token.nft.commitment[0], 0x54);
  assert.deepEqual(outs[2].lockingBytecode, ctx.probe.contracts.escrow.lockingBytecode);
  assert.equal(outs[2].token.nft.commitment[0], 0x45);
  assert.deepEqual(outs[3].lockingBytecode, walletLock);
  assert.equal(shape.sourceOutputs[1].valueSatoshis, 50_000n);
});

test('every source output in every request matches its input (Selene rule) and stays at or under 40 bytes except D', () => {
  const ctx = setup();
  for (const { id } of SHAPES) {
    const shape = buildShape(id, { ...ctx, coins: scannedCoins(ctx.wallet) });
    const request = overRelay(toSignRequest(shape));
    const tx = decodeTransaction(hexToBin(request.transaction.transaction));
    assert.equal(tx.inputs.length, request.transaction.sourceOutputs.length);
    tx.inputs.forEach((input, i) => {
      const so = request.transaction.sourceOutputs[i];
      assert.equal(so.outpointTransactionHash, binToHex(input.outpointTransactionHash));
      assert.equal(so.unlockingBytecode, binToHex(input.unlockingBytecode));
      assert.equal(so.sequenceNumber, input.sequenceNumber);
      assert.match(so.valueSatoshis, /^<bigint: \d+n>$/);
      const commitmentBytes = (so.token?.nft?.commitment ?? '').length / 2;
      if (id === 'D' && i === 1) assert.equal(commitmentBytes, 41);
      else assert.ok(commitmentBytes <= 40, `${id} input ${i} commitment ${commitmentBytes} B`);
    });
  }
});

test('A-real: real coins from receive and change get the right inputPaths and pass', () => {
  const ctx = setup();
  const { shape, request, result } = run(ctx, 'A-real', { coins: scannedCoins(ctx.wallet) });
  assert.equal(result.verdict, 'PASS', result.summary);
  assert.deepEqual(request.inputPaths, [[1, 'receive', 5], [2, 'change', 2]]);
  assert.deepEqual(shape.madeUpInputIndexes, [0]);
  assert.equal(shape.walletInputIndexes.length, 2);
});

test('A-real: refuses to build without enough coins', () => {
  const ctx = setup();
  assert.throws(() => buildShape('A-real', { ...ctx, coins: [] }), (e) => e.code === 'no-coins');
  const small = [{ ...scannedCoins(ctx.wallet)[0], value: A_REAL_NEED - 1n }];
  assert.throws(() => buildShape('A-real', { ...ctx, coins: small }), (e) => e.code === 'no-coins');
});

test('ECDSA signatures pass too', () => {
  const ctx = setup({ algorithm: 'ecdsa' });
  const { result } = run(ctx, 'B');
  assert.equal(result.verdict, 'PASS', result.summary);
  assert.equal(result.signatures[0].algorithm, 'ecdsa');
});

test('SIGHASH ALL|FORKID (0x41) passes; NONE|ANYONECANPAY (0xc2) fails only on the sighash check', () => {
  const ok = run(setup({ sighash: 0x41 }), 'B').result;
  assert.equal(ok.verdict, 'PASS', ok.summary);
  assert.equal(ok.signatures[0].sighashType, 0x41);
  const lifted = run(setup({ sighash: 0xc2 }), 'C').result;
  assert.equal(lifted.verdict, 'FAIL');
  assert.deepEqual(lifted.checks.filter((c) => !c.ok).map((c) => c.name), ['wallet input 1 sighash 0x61 or 0x41']);
  assert.equal(lifted.vm.ok, true, 'the VM alone would accept it; the probe must flag it');
});

test('D: a Selene-like wallet refuses; the refusal text is kept', () => {
  const ctx = setup({ strict40: true });
  const { result } = run(ctx, 'D');
  assert.equal(result.verdict, 'REFUSED');
  assert.equal(result.walletError, 'Invalid signing source output at index 1');
  assert.match(result.summary, /as expected/);
});

test('D: a wallet without the 40-byte rule signs; its own input is still checked', () => {
  const ctx = setup({ strict40: false });
  const { result } = run(ctx, 'D');
  assert.equal(result.verdict, 'SIGNED');
  assert.ok(result.checks.find((c) => c.name === 'VM: wallet input 1').ok, result.summary);
  assert.equal(result.vm.ok, false, 'the covenant input fails by design');
});

test('a refusal on a normal shape is REFUSED with the wallet text', () => {
  const ctx = setup();
  const shape = buildShape('B', ctx);
  const result = refusal(shape, 'User rejected');
  assert.equal(result.verdict, 'REFUSED');
  assert.match(result.summary, /User rejected/);
});

test('FAIL: wallet changes an output', () => {
  const ctx = setup({
    tamper: (tx) => ({ ...tx, outputs: tx.outputs.map((o, i) => (i === 0 ? { ...o, valueSatoshis: o.valueSatoshis - 1n } : o)) }),
  });
  const { result } = run(ctx, 'B');
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.checks.find((c) => c.name === 'outputs byte-equal').ok, false);
});

test('FAIL: wallet touches the covenant input', () => {
  const ctx = setup({
    tamper: (tx) => ({ ...tx, inputs: tx.inputs.map((inp, i) => (i === 0 ? { ...inp, unlockingBytecode: inp.unlockingBytecode.slice(1) } : inp)) }),
  });
  const { result } = run(ctx, 'C');
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.checks.find((c) => c.name === 'covenant input 0 untouched').ok, false);
});

test('FAIL: signature by the wrong key', () => {
  const other = makeSimWallet();
  const ctx = setup();
  const shape = buildShape('B', ctx);
  // Sign as if the coin were at the other wallet's receive 0: the request is
  // re-pointed so the sim wallet agrees to sign, then checked against the real shape.
  const request = overRelay(toSignRequest(shape));
  const lock = binToHex(p2pkhLockingBytecode(other.pkhAt('receive', 0)));
  request.transaction.sourceOutputs[1].lockingBytecode = lock;
  const signedHex = other.sign(request);
  const result = checkReply(shape, signedHex);
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.checks.find((c) => c.name === 'wallet input 1 key matches its address').ok, false);
  assert.equal(result.vm.ok, false);
});

test('FAIL: unsigned or garbage reply', () => {
  const ctx = setup();
  const shape = buildShape('A-free', ctx);
  assert.equal(checkReply(shape, binToHex(encodeTransaction(shape.transaction))).verdict, 'FAIL');
  assert.equal(checkReply(shape, 'zz').verdict, 'FAIL');
  assert.equal(checkReply(shape, '').verdict, 'FAIL');
  const d = buildShape('D', ctx);
  assert.equal(checkReply(d, 'zz').verdict, 'FAIL');
});

test('probe source has no broadcast path', () => {
  const dir = new URL('../src/', import.meta.url);
  for (const file of readdirSync(dir)) {
    const text = readFileSync(new URL(file, dir), 'utf8');
    assert.doesNotMatch(text, /blockchain\.transaction\.broadcast/, file);
    assert.doesNotMatch(text, /broadcast\s*:\s*(true|!0)/, file);
  }
});
