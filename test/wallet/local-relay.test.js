// The whole WizardConnect stack (real dapp manager, real wallet manager,
// nostr-tools, NIP-44/59 encryption) over a LOCAL relay on 127.0.0.1: the
// same path the app takes over the public relays, without the internet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSignRequest, checkSignedReply, createWalletSession, memoryStorage, pathLookup } from '../../src/wallet/index.js';
import { buildBuy } from '../../src/tx/index.js';
import { fakeCoin, makeShow, saleHeight } from '../helpers.js';
import { startLocalRelay } from '../support/local-relay.js';
import { makeSimWallet } from '../support/sim-wallet.js';
import { installWsCloseGuard } from '../support/node-ws-guard.js';

installWsCloseGuard();

const quietly = async (fn) => {
  // The relay client logs every message at debug level; keep the test output readable.
  const { log, debug } = console;
  console.log = () => {};
  console.debug = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.debug = debug;
  }
};

test('local relay: pair, wallet_ready, sign a buy, reply passes; the link names the local relay', { timeout: 30_000 }, async () => {
  const relay = await startLocalRelay();
  const sim = makeSimWallet();
  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));
  const session = createWalletSession({ relayUrls: [relay.url], storage: memoryStorage(), onWalletReady: resolveReady });
  let wallet;
  try {
    await quietly(async () => {
      const links = await session.pair();
      assert.match(links.uri, new RegExp(`^wiz://127\\.0\\.0\\.1:${relay.port}\\?.*&pr=ws$`));
      wallet = await sim.pairOverRelay(links.uri);
      const info = await ready;
      assert.equal(info.network, 'mainnet');
      assert.equal(info.name, 'Doorstub sim wallet');
      const { show, contracts, shardUtxos } = makeShow(assert);
      const r0 = sim.addressAt('receive', 0);
      const built = buildBuy({ show, contracts, boxOfficeUtxo: shardUtxos[0], fundingUtxos: [fakeCoin(r0.pkh, 50_000)], buyerPkh: r0.pkh, currentHeight: saleHeight(show) });
      const hex = await session.sign(buildSignRequest(built, { pathOf: pathLookup([r0]), userPrompt: 'Doorstub local relay test' }), { timeoutMs: 15_000 });
      const result = checkSignedReply(built, hex);
      assert.equal(result.ok, true, result.summary);
    });
    assert.ok(relay.stats.published >= 4, 'messages really went through the relay');
  } finally {
    await quietly(async () => {
      await session.disconnect();
      wallet?.close();
      await new Promise((r) => setTimeout(r, 50));
      await relay.close();
    });
  }
});
