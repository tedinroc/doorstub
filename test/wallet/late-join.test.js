// A wallet that joins after @wizardconnect/dapp's 30 s key-exchange wait
// (a pasted link in Paytaca, a slow QR scan) still pairs: the session nudges
// the library's own "connected" handler once the key exchange completes
// (APP-BRIEF 8, probe/src/connect.js). The REAL DappConnectionManager runs,
// wired to the sim wallet in memory; only Date is mocked, so 45 s pass at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { LIBRARY_KEY_EXCHANGE_WAIT_MS, buildSignRequest, checkSignedReply, createWalletSession, memoryStorage, pathLookup } from '../../src/wallet/index.js';
import { buildBuy } from '../../src/tx/index.js';
import { fakeCoin, makeShow, saleHeight } from '../helpers.js';
import { makeSimWallet } from '../support/sim-wallet.js';

// Real time (Date is mocked in these tests).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (predicate, what, ms = 2_000) => {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
};

/** Pair with a wallet whose key exchange completes 45 s after the relay connected. */
const pairLate = async (t, { lateJoinCheckMs }) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const libraryErrors = [];
  t.mock.method(console, 'error', (...args) => libraryErrors.push(args.join(' ')));
  const sim = makeSimWallet();
  const session = createWalletSession({ initiateRelay: sim.inProcessRelay({ holdKeyExchange: true }), storage: memoryStorage(), lateJoinCheckMs });
  t.after(() => session.disconnect());
  await session.pair();
  await sleep(150); // the library is polling for the key exchange
  assert.equal(session.state, 'pairing');
  t.mock.timers.tick(LIBRARY_KEY_EXCHANGE_WAIT_MS + 1_000);
  await waitFor(() => libraryErrors.some((e) => /Key exchange timed out/.test(e)), 'the library to give up');
  t.mock.timers.tick(14_000); // 45 s after the link was made, the wallet joins
  sim.joinLate();
  return { sim, session };
};

test('late join: a wallet that joins 45 s after the link was made still pairs and signs', async (t) => {
  const { sim, session } = await pairLate(t, { lateJoinCheckMs: 10 });
  await waitFor(() => session.state === 'connected', 'wallet_ready after the nudge');
  assert.equal(session.wallet.name, 'Doorstub sim wallet');

  const { show, contracts, shardUtxos } = makeShow(assert);
  const r0 = sim.addressAt('receive', 0);
  const built = buildBuy({ show, contracts, boxOfficeUtxo: shardUtxos[0], fundingUtxos: [fakeCoin(r0.pkh, 50_000)], buyerPkh: r0.pkh, currentHeight: saleHeight(show) });
  const hex = await session.sign(buildSignRequest(built, { pathOf: pathLookup([r0]), userPrompt: 'Doorstub: test buy' }));
  assert.equal(checkSignedReply(built, hex).ok, true);
});

test('late join control: without the nudge the same late wallet never pairs (the library alone gives up)', async (t) => {
  const { session } = await pairLate(t, { lateJoinCheckMs: 0 });
  await sleep(300);
  assert.equal(session.state, 'pairing', 'still waiting: nothing sent dapp_ready');
  assert.equal(session.wallet, null);
});
