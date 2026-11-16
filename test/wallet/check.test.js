// checkSignedReply for buy, handBack and checkIn: the sim wallet signs our
// request (after a JSON round trip, as over the relay); good replies come back
// checked and broadcastable; every kind of tampering is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hexToBin } from '@bitauth/libauth';
import { createFulcrumPool, isChecked } from '../../src/chain/index.js';
import { ACCEPTED_SIGHASH, assertSignedReply, buildBuyWithCoins, buildSignRequest, checkSignedReply, pathLookup } from '../../src/wallet/index.js';
import { buildCheckIn, buildHandBack, p2pkhLockingBytecode } from '../../src/tx/index.js';
import { prompts } from '../../src/shows/index.js';
import { fakeCoin, saleHeight } from '../helpers.js';
import { makeFakeNetwork, makeMiniChain } from '../support/fake-fulcrum.js';
import { makeScenario } from '../support/scenario.js';
import { makeSimWallet } from '../support/sim-wallet.js';

const overRelay = (request) => JSON.parse(JSON.stringify(request));

/** A show on the mini chain plus a sim wallet with coins at receive 0 and change 1. */
const setup = (walletOptions = {}) => {
  const chain = makeMiniChain();
  const s = makeScenario(assert, chain);
  const sim = makeSimWallet(walletOptions);
  const r0 = sim.addressAt('receive', 0);
  const c1 = sim.addressAt('change', 1);
  const coins = [
    { ...fakeCoin(r0.pkh, 8_000), path: 'receive', index: 0 },
    { ...fakeCoin(c1.pkh, 9_000), path: 'change', index: 1 },
  ];
  const pathOf = pathLookup([r0, c1]);
  return { chain, s, sim, r0, c1, coins, pathOf };
};

const buildBuyFor = ({ s, r0, c1, coins }) =>
  buildBuyWithCoins({
    show: s.show,
    boxOfficeUtxo: s.shardUtxos[0],
    coins,
    buyerPkh: r0.pkh,
    currentHeight: saleHeight(s.show),
    changeLockingBytecode: c1.lockingBytecode,
    contracts: s.contracts,
  }).built;

/** Buy with the sim wallet, put it on the chain, return the sale (ticket at receive 0). */
const simBuy = (ctx) => {
  const built = buildBuyFor(ctx);
  const checked = assertSignedReply(built, ctx.sim.sign(overRelay(buildSignRequest(built, { pathOf: ctx.pathOf, userPrompt: prompts.buy(ctx.s.show, built.seat) }))));
  ctx.chain.add(checked.transaction, 0);
  return {
    escrowUtxo: { txid: hexToBin(checked.txid), vout: 2, output: built.transaction.outputs[2] },
    ticketUtxo: { txid: hexToBin(checked.txid), vout: 1, output: built.transaction.outputs[1] },
    seat: built.seat,
  };
};

test('buy: request is sign-only with inputPaths and a prompt; the reply passes and is broadcastable', async () => {
  const ctx = setup();
  const built = buildBuyFor(ctx);
  const request = buildSignRequest(built, { pathOf: ctx.pathOf, userPrompt: prompts.buy(ctx.s.show, built.seat) });
  assert.equal(request.transaction.broadcast, false);
  assert.deepEqual(request.inputPaths, [[1, 'change', 1], [2, 'receive', 0]]);
  assert.match(request.transaction.userPrompt, /^Doorstub: buy seat A-0-1 for 0\.0001 BCH\. The money waits in the show's contract\.$/);
  const result = checkSignedReply(built, ctx.sim.sign(overRelay(request)));
  assert.equal(result.ok, true, result.summary);
  assert.ok(isChecked(result.checked));
  assert.equal(result.checked.kind, 'buy');
  assert.deepEqual(result.signatures.map((x) => [x.algorithm, x.sighashType]), [['schnorr', 0x61], ['schnorr', 0x61]]);

  const net = makeFakeNetwork();
  net.addServer('wss://a.example:50004', ctx.chain.handler);
  const pool = createFulcrumPool({ network: 'simnet', servers: ['wss://a.example:50004'], WebSocketImpl: net.WebSocketImpl, allowBroadcast: true, pingIntervalMs: 0 });
  const sent = await pool.broadcastChecked(result.checked);
  assert.equal(sent.txid, result.checked.txid);
  pool.close();
});

test('handBack and checkIn: the ticket input is signed by the wallet, the reply passes', () => {
  const ctx = setup();
  const sale = simBuy(ctx);
  for (const [build, kind] of [[buildHandBack, 'handBack'], [buildCheckIn, 'checkIn']]) {
    const built = build({ show: ctx.s.show, escrowUtxo: sale.escrowUtxo, ticketUtxo: sale.ticketUtxo, contracts: ctx.s.contracts });
    const request = buildSignRequest(built, { pathOf: ctx.pathOf, userPrompt: 'Doorstub test' });
    assert.deepEqual(request.inputPaths, [[1, 'receive', 0]]);
    const result = checkSignedReply(built, ctx.sim.sign(overRelay(request)));
    assert.equal(result.ok, true, `${kind}: ${result.summary}`);
    assert.equal(result.checked.kind, kind);
  }
});

test('ECDSA signatures and sighash 0x41 are accepted', () => {
  for (const options of [{ algorithm: 'ecdsa' }, { sighash: 0x41 }]) {
    const ctx = setup(options);
    const built = buildBuyFor(ctx);
    const result = checkSignedReply(built, ctx.sim.sign(overRelay(buildSignRequest(built, { pathOf: ctx.pathOf, userPrompt: 'x' }))));
    assert.equal(result.ok, true, `${JSON.stringify(options)}: ${result.summary}`);
  }
  assert.deepEqual([...ACCEPTED_SIGHASH].sort(), [0x41, 0x61]);
});

const refused = (ctx, built, pattern) => {
  const hex = ctx.sim.sign(overRelay(buildSignRequest(built, { pathOf: ctx.pathOf, userPrompt: 'x' })));
  const result = checkSignedReply(built, hex);
  assert.equal(result.ok, false);
  assert.equal(result.checked, null);
  assert.match(result.summary, pattern);
  assert.throws(() => assertSignedReply(built, hex), (e) => e.code === 'bad-reply' && e.result.ok === false);
};

test('refused: sighash NONE, SINGLE, ANYONECANPAY (liftable signatures)', () => {
  for (const sighash of [0x42, 0x43, 0xc1, 0xe1, 0x62]) {
    const ctx = setup({ sighash });
    refused(ctx, buildBuyFor(ctx), /sighash 0x61 or 0x41/);
  }
});

test('refused: an output changed, added or removed', () => {
  const ctx0 = setup({ tamper: (tx) => ({ ...tx, outputs: tx.outputs.map((o, i) => (i === 3 ? { ...o, valueSatoshis: o.valueSatoshis - 1n } : o)) }) });
  refused(ctx0, buildBuyFor(ctx0), /outputs byte-equal/);
  const ctx1 = setup({ tamper: (tx) => ({ ...tx, outputs: [...tx.outputs, { lockingBytecode: p2pkhLockingBytecode(new Uint8Array(20)), valueSatoshis: 1_000n }] }) });
  refused(ctx1, buildBuyFor(ctx1), /output count unchanged/);
});

test('refused: a contract input touched, an outpoint or sequence changed, version or locktime changed', () => {
  const ctx0 = setup({ tamper: (tx) => ({ ...tx, inputs: tx.inputs.map((x, i) => (i === 0 ? { ...x, unlockingBytecode: x.unlockingBytecode.slice(1) } : x)) }) });
  refused(ctx0, buildBuyFor(ctx0), /contract input 0 untouched/);
  const ctx1 = setup({ tamper: (tx) => ({ ...tx, inputs: tx.inputs.map((x, i) => (i === 1 ? { ...x, sequenceNumber: 0 } : x)) }) });
  refused(ctx1, buildBuyFor(ctx1), /outpoints and sequences unchanged/);
  const ctx2 = setup({ tamper: (tx) => ({ ...tx, locktime: 5 }) });
  refused(ctx2, buildBuyFor(ctx2), /version and locktime unchanged/);
});

test('refused: a wallet input left unsigned or signed by another key', () => {
  const ctx0 = setup({ tamper: (tx) => ({ ...tx, inputs: tx.inputs.map((x, i) => (i === 2 ? { ...x, unlockingBytecode: new Uint8Array() } : x)) }) });
  refused(ctx0, buildBuyFor(ctx0), /wallet input 2 signed/);
  // Input 1 carries input 2's signature and key (receive/0 instead of change/1).
  const ctx1 = setup({ tamper: (tx) => ({ ...tx, inputs: tx.inputs.map((x, i) => (i === 1 ? { ...x, unlockingBytecode: tx.inputs[2].unlockingBytecode } : x)) }) });
  refused(ctx1, buildBuyFor(ctx1), /key matches its address|VM/);
});

test('refused: garbage, a different transaction, or a VM failure', () => {
  const ctx = setup();
  const built = buildBuyFor(ctx);
  assert.equal(checkSignedReply(built, 'not hex').ok, false);
  assert.equal(checkSignedReply(built, '00').ok, false);
  assert.equal(checkSignedReply(built, undefined).ok, false);
  // A valid-looking signature over different source outputs (wrong coin value) fails in the VM.
  const lie = { ...built, sourceOutputs: built.sourceOutputs.map((o, i) => (i === 1 ? { ...o, valueSatoshis: o.valueSatoshis + 1n } : o)) };
  const hex = ctx.sim.sign(overRelay(buildSignRequest(built, { pathOf: ctx.pathOf, userPrompt: 'x' })));
  const result = checkSignedReply(lie, hex);
  assert.equal(result.ok, false);
  assert.match(result.summary, /VM 2026/);
});

test('buildSignRequest: refuses coins outside the wallet and transactions with nothing to sign', () => {
  const ctx = setup();
  const built = buildBuyFor(ctx);
  assert.throws(() => buildSignRequest(built, { pathOf: () => undefined, userPrompt: 'x' }), (e) => e.code === 'unknown-coin');
  assert.throws(() => buildSignRequest(built, { pathOf: ctx.pathOf, userPrompt: '' }), (e) => e.code === 'no-prompt');
  assert.throws(() => buildSignRequest({ ...built, walletInputIndexes: [] }, { pathOf: ctx.pathOf, userPrompt: 'x' }), (e) => e.code === 'nothing-to-sign');
});
