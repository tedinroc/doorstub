// NETWORK test: pair the app's session with the sim wallet over the PUBLIC
// WizardConnect relay and sign one request. Nothing is broadcast to any chain
// (broadcast: false, a made-up funding outpoint).
// Skipped unless DOORSTUB_NET=1:  DOORSTUB_NET=1 node --test test/wallet/relay.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSignRequest, checkSignedReply, createWalletSession, memoryStorage, pathLookup } from '../../src/wallet/index.js';
import { buildBuy } from '../../src/tx/index.js';
import { fakeCoin, makeShow, saleHeight } from '../helpers.js';
import { makeSimWallet } from '../support/sim-wallet.js';
import { installWsCloseGuard } from '../support/node-ws-guard.js';

installWsCloseGuard();

const skip = process.env.DOORSTUB_NET !== '1' && 'set DOORSTUB_NET=1 to run network tests';

test('public relay: pair, wallet_ready, sign one buy, reply passes the checks', { skip, timeout: 120_000 }, async () => {
  const sim = makeSimWallet();
  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));
  const session = createWalletSession({ storage: memoryStorage(), onWalletReady: resolveReady });
  const links = await session.pair();
  const wallet = await sim.pairOverRelay(links.uri);
  try {
    let timer;
    const info = await Promise.race([ready, new Promise((_, rej) => (timer = setTimeout(() => rej(new Error('no wallet_ready in 60 s')), 60_000)))]);
    clearTimeout(timer);
    assert.equal(info.network, 'mainnet');
    const { show, contracts, shardUtxos } = makeShow(assert);
    const r0 = sim.addressAt('receive', 0);
    const built = buildBuy({ show, contracts, boxOfficeUtxo: shardUtxos[0], fundingUtxos: [fakeCoin(r0.pkh, 50_000)], buyerPkh: r0.pkh, currentHeight: saleHeight(show) });
    const hex = await session.sign(buildSignRequest(built, { pathOf: pathLookup([r0]), userPrompt: 'Doorstub relay self-test: sign only' }), { timeoutMs: 60_000 });
    const result = checkSignedReply(built, hex);
    assert.equal(result.ok, true, result.summary);
  } finally {
    await session.disconnect();
    wallet.close();
  }
});
