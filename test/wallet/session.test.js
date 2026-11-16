// The WizardConnect session wrapper running the REAL DappConnectionManager,
// wired to the sim wallet in memory (no relay, no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSignRequest, checkSignedReply, createWalletSession, deriveWalletAddress, memoryStorage, pathLookup } from '../../src/wallet/index.js';
import { buildBuy } from '../../src/tx/index.js';
import { fakeCoin, makeShow, saleHeight } from '../helpers.js';
import { makeSimWallet } from '../support/sim-wallet.js';

const waitFor = async (predicate, ms = 2_000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
};

const pairedSession = async (simOptions = {}, sessionOptions = {}) => {
  const sim = makeSimWallet(simOptions);
  const events = { ready: [], status: [], disconnect: [] };
  const storage = sessionOptions.storage ?? memoryStorage();
  const session = createWalletSession({
    initiateRelay: sim.inProcessRelay(),
    storage,
    onWalletReady: (info) => events.ready.push(info),
    onStatus: (e) => events.status.push(e),
    onDisconnect: (reason, message) => events.disconnect.push({ reason, message }),
    ...sessionOptions,
  });
  const links = await session.pair();
  return { sim, session, links, events, storage };
};

/** A buy paid by the sim wallet's receive 0, ready to sign. */
const buyRequest = (sim) => {
  const { show, contracts, shardUtxos } = makeShow(assert);
  const r0 = sim.addressAt('receive', 0);
  const built = buildBuy({ show, contracts, boxOfficeUtxo: shardUtxos[0], fundingUtxos: [fakeCoin(r0.pkh, 50_000)], buyerPkh: r0.pkh, currentHeight: saleHeight(show) });
  return { built, request: buildSignRequest(built, { pathOf: pathLookup([r0]), userPrompt: 'Doorstub: test buy' }) };
};

test('pair: links for the connect dialog; wallet_ready gives name, network and xpub keys', async () => {
  const { sim, session, links, events } = await pairedSession();
  assert.match(links.uri, /^wiz:\/\//);
  assert.match(links.qrUri, /^WIZ:\/\//);
  assert.equal(links.qrUri, links.qrUri.toUpperCase(), 'QR text is uppercase for an alphanumeric QR');
  assert.equal(links.selene, links.uri);
  assert.equal(links.cashonize, `https://cashonize.com/?uri=${encodeURIComponent(links.uri)}`);
  assert.equal(session.state, 'pairing');
  await waitFor(() => events.ready.length === 1);
  const info = session.wallet;
  assert.equal(info.name, 'Doorstub sim wallet');
  assert.equal(info.network, 'mainnet');
  assert.equal(info.hasChange, true);
  assert.deepEqual(deriveWalletAddress(info.keys, 'receive', 4).pkh, sim.pkhAt('receive', 4));
  assert.equal(session.state, 'connected');
  await session.disconnect();
});

test('sign: one request round-trips through the real dapp manager and passes the checks', async () => {
  const { sim, session, events } = await pairedSession();
  await waitFor(() => events.ready.length === 1);
  const { built, request } = buyRequest(sim);
  const hex = await session.sign(request);
  const result = checkSignedReply(built, hex);
  assert.equal(result.ok, true, result.summary);
  assert.equal(sim.log.at(-1).userPrompt, 'Doorstub: test buy');
  assert.equal(sim.log.at(-1).outcome, 'signed');
  await session.disconnect();
});

test('sign: refuses a request without broadcast: false before sending it', async () => {
  const { sim, session, events } = await pairedSession();
  await waitFor(() => events.ready.length === 1);
  const { request } = buyRequest(sim);
  await assert.rejects(session.sign({ ...request, transaction: { ...request.transaction, broadcast: true } }), (e) => e.code === 'not-sign-only');
  assert.equal(sim.log.length, 0, 'nothing reached the wallet');
  await session.disconnect();
});

test('sign: the wallet\'s refusal comes back with its own words', async () => {
  const { sim, session, events } = await pairedSession({ approve: () => 'User rejected the transaction' });
  await waitFor(() => events.ready.length === 1);
  await assert.rejects(session.sign(buyRequest(sim).request), (e) => e.code === 'rejected' && /User rejected the transaction/.test(e.message));
  await session.disconnect();
});

test('sign: one at a time; a second request while one waits is "busy"; timeout tells the wallet to cancel', async () => {
  const { sim, session, events } = await pairedSession({}, { signTimeoutMs: 80 });
  await waitFor(() => events.ready.length === 1);
  sim.pause();
  const { request } = buyRequest(sim);
  const first = session.sign(request);
  assert.equal(session.busy, true);
  await assert.rejects(session.sign(request), (e) => e.code === 'busy');
  await assert.rejects(first, (e) => e.code === 'timeout');
  assert.equal(session.busy, false);
  await waitFor(() => sim.cancels.length === 1);
  assert.match(sim.cancels[0].reason, /stopped waiting/);
  sim.resume();
  await session.disconnect();
});

test('cancel: the caller can abort a waiting request', async () => {
  const { sim, session, events } = await pairedSession();
  await waitFor(() => events.ready.length === 1);
  sim.pause();
  const controller = new AbortController();
  const pending = session.sign(buyRequest(sim).request, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (e) => e.code === 'cancelled');
  await waitFor(() => sim.cancels.length === 1);
  sim.resume();
  await session.disconnect();
});

test('a testnet wallet is refused with a plain sentence', async () => {
  const { session, events } = await pairedSession({ xpubNetwork: 'testnet' });
  await waitFor(() => events.disconnect.length === 1);
  assert.equal(events.disconnect[0].reason, 'wrong-network');
  assert.equal(session.state, 'wrong-network');
  assert.equal(session.wallet, null);
  assert.match(events.status.at(-1).error, /testnet.*mainnet/);
  await assert.rejects(session.sign({ transaction: { broadcast: false } }), (e) => e.code === 'not-connected');
  await session.disconnect();
});

test('restore: the pairing survives a reload (stored session, same wallet), then disconnect forgets it', async () => {
  const storage = memoryStorage();
  const sim = makeSimWallet();
  const relay = sim.inProcessRelay();
  const first = createWalletSession({ initiateRelay: relay, storage });
  await first.pair();
  await waitFor(() => first.wallet !== null);
  await waitFor(() => JSON.parse(storage.getItem('doorstub-wizardconnect') ?? '{}').paths !== undefined);

  // "Reload": a new session object over the same storage.
  const ready = [];
  const second = createWalletSession({ initiateRelay: relay, storage, onWalletReady: (i) => ready.push(i) });
  assert.equal(await second.restore(), true);
  assert.equal(second.wallet?.name, 'Doorstub sim wallet', 'wallet known at once from storage');
  await waitFor(() => ready.length === 1);
  const hex = await second.sign(buyRequest(sim).request);
  assert.match(hex, /^02000000/);
  await second.disconnect();
  assert.equal(storage.getItem('doorstub-wizardconnect'), null);
  const third = createWalletSession({ initiateRelay: relay, storage });
  assert.equal(await third.restore(), false);
  await first.disconnect();
});

test('a wallet-side disconnect is reported (after the library\'s 8 s grace) and clears the stored pairing', async (t) => {
  const { sim, session, events, storage } = await pairedSession();
  await waitFor(() => events.ready.length === 1);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const s of sim.sessions.values()) s.disconnect('Removed in wallet');
  t.mock.timers.tick(1);
  await new Promise((r) => setImmediate(r));
  assert.equal(events.disconnect.length, 0, 'the library waits in case the wallet comes straight back');
  t.mock.timers.tick(8_000);
  t.mock.timers.reset();
  assert.equal(events.disconnect[0].message, 'Removed in wallet');
  assert.equal(session.state, 'disconnected');
  assert.equal(storage.getItem('doorstub-wizardconnect'), null);
  await session.disconnect();
});

test('pair({ relay: 1 }) puts the second relay first (retry when the first is down); dappName is Doorstub', async () => {
  const sim = makeSimWallet();
  const inner = sim.inProcessRelay();
  const seen = [];
  const session = createWalletSession({
    storage: memoryStorage(),
    initiateRelay: (cb, options) => {
      seen.push(options.explicitRelayUrls);
      return inner(cb, options);
    },
  });
  await session.pair();
  await session.pair({ relay: 1 });
  assert.deepEqual(seen, [
    ['wss://relay.riften.net:443', 'wss://relay.cauldron.quest:443'],
    ['wss://relay.cauldron.quest:443', 'wss://relay.riften.net:443'],
  ]);
  await waitFor(() => session.wallet !== null);
  assert.equal(session.manager.dappName, 'Doorstub');
  await session.disconnect();
});
