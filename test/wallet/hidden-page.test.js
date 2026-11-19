// The 11/19 iPhone recordings: the first "Open Selene" never showed Selene's
// "Connect to Doorstub?" prompt; only a second trip did. Selene first sends
// only its relay key, and asks its user once the page has answered (dapp_ready
// names the dapp). "Open Selene" hides the page, and @wizardconnect/core
// closed the page's relay socket the moment the page was hidden, so nobody
// answered until the user came back.
//
// The whole stack runs for real here (dapp and wallet libraries, nostr-tools,
// encryption) over a local relay. A fake `document` lets the library's own
// visibility handling run in Node; the wallet is created without it (it is
// another app). The wallet behaves like Selene (sim-wallet askToConnect).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeKeyExchangeURI } from '@wizardconnect/core';
import { buildSignRequest, checkSignedReply, createWalletSession, memoryStorage, pathLookup } from '../../src/wallet/index.js';
import { buildBuy } from '../../src/tx/index.js';
import { fakeCoin, makeShow, saleHeight } from '../helpers.js';
import { startLocalRelay } from '../support/local-relay.js';
import { makeSimWallet } from '../support/sim-wallet.js';
import { installWsCloseGuard } from '../support/node-ws-guard.js';

installWsCloseGuard();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (predicate, what, ms = 5_000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
};

/** A document whose visibility a test sets; the library reads `document.visibilityState`. */
const fakeDocument = () => {
  const target = new EventTarget();
  let state = 'visible';
  return {
    get visibilityState() {
      return state;
    },
    addEventListener: (...args) => target.addEventListener(...args),
    removeEventListener: (...args) => target.removeEventListener(...args),
    set(next) {
      state = next;
      target.dispatchEvent(new Event('visibilitychange'));
    },
  };
};

/**
 * A page with a session over a local relay, and a Selene-like wallet that
 * joins while the page is hidden (the user pressed "Open Selene").
 */
const openSelene = async (t, { hiddenHoldMs, freezeAfterHide = false } = {}) => {
  const quiet = { log: console.log, debug: console.debug };
  console.log = () => {};
  console.debug = () => {};
  const relay = await startLocalRelay();
  const doc = fakeDocument();
  globalThis.document = doc;
  const states = [];
  const session = createWalletSession({
    relayUrls: [relay.url],
    storage: memoryStorage(),
    ...(hiddenHoldMs !== undefined && { hiddenHoldMs }),
    onStatus: (e) => states.push(e.state),
  });
  const links = await session.pair();
  const dappKey = decodeKeyExchangeURI(links.uri).publicKey;
  await waitFor(() => relay.stats.connections >= 1, 'the page to reach the relay');
  await sleep(100);

  const prompts = [];
  let answer;
  const pressed = new Promise((resolve) => (answer = resolve));
  doc.set('hidden');
  if (freezeAfterHide) relay.freeze(dappKey);
  // The wallet is another app: create it without the page's document.
  delete globalThis.document;
  const sim = makeSimWallet();
  const wallet = await sim.pairOverRelay(links.uri, {
    askToConnect: ({ dappName }) => {
      prompts.push({ dappName, hidden: doc.visibilityState === 'hidden' });
      return pressed;
    },
  });
  globalThis.document = doc;
  t.after(async () => {
    await session.disconnect();
    wallet.close();
    await sleep(50);
    await relay.close();
    delete globalThis.document;
    console.log = quiet.log;
    console.debug = quiet.debug;
  });
  return { relay, doc, session, sim, wallet, states, prompts, connect: () => answer(true), dappKey, uri: links.uri };
};

test('reproduction (the library closes the socket when the page hides): no prompt while the page is hidden; it appears only after the user comes back', { timeout: 30_000 }, async (t) => {
  const { doc, session, states, prompts, connect } = await openSelene(t, { hiddenHoldMs: 0 });
  await sleep(1_500);
  assert.equal(prompts.length, 0, 'the wallet never asked: the page could not answer its hello');
  assert.equal(session.state, 'pairing');

  doc.set('visible'); // the user comes back to Safari
  await waitFor(() => prompts.length === 1, 'the prompt after the page answered');
  assert.equal(prompts[0].dappName, 'Doorstub');
  await waitFor(() => session.state === 'approving', 'the page to see the wallet joined');
  assert.ok(!states.includes('error'), "Selene's hello (relay key, no xpubs) is not a broken wallet");

  connect();
  await waitFor(() => session.state === 'connected', 'the xpubs after Connect');
  assert.equal(session.wallet.name, 'Doorstub sim wallet');
});

test('fix: a hidden page waiting for the wallet keeps its relay open, so the prompt appears on the first trip and the wallet connects while the page is still hidden', { timeout: 30_000 }, async (t) => {
  const { relay, doc, session, states, prompts, connect } = await openSelene(t);
  await waitFor(() => prompts.length === 1, 'the prompt while the page is hidden');
  assert.deepEqual(prompts[0], { dappName: 'Doorstub', hidden: true });
  assert.equal(session.state, 'approving');

  connect();
  await waitFor(() => session.state === 'connected', 'the xpubs while the page is hidden');
  assert.equal(doc.visibilityState, 'hidden');
  assert.ok(!states.includes('error'));

  // Back on the page: the library's own reconnect runs (a fresh socket, the relay replayed), and nothing breaks.
  const before = relay.stats.connections;
  doc.set('visible');
  await waitFor(() => relay.stats.connections > before, 'the reconnect after the return');
  await sleep(300);
  assert.equal(session.state, 'connected');
  assert.equal(prompts.length, 1, 'the wallet asked once');
});

test('fix, phone froze the page at once: nothing is lost, the return answers the hello exactly as before', { timeout: 30_000 }, async (t) => {
  const { relay, doc, dappKey, session, prompts, connect } = await openSelene(t, { freezeAfterHide: true });
  await sleep(1_500);
  assert.equal(prompts.length, 0, 'a frozen page cannot answer');
  relay.thaw(dappKey);
  doc.set('visible');
  await waitFor(() => prompts.length === 1, 'the prompt after the return');
  connect();
  await waitFor(() => session.state === 'connected', 'the xpubs');
});

test('fix, phone froze the page after it answered: the xpubs the wallet sent while the page was frozen are replayed on the return', { timeout: 30_000 }, async (t) => {
  // A send the frozen page started is refused when the page reconnects; the library logs that.
  t.mock.method(console, 'error', () => {});
  const { relay, doc, dappKey, session, prompts, connect } = await openSelene(t);
  await waitFor(() => prompts.length === 1, 'the prompt while the page is hidden');
  await waitFor(() => session.state === 'approving', 'the hello');
  relay.freeze(dappKey); // the phone freezes the page now
  connect(); // the user presses Connect; the xpubs reach the relay but not the frozen page
  await sleep(1_200); // the return is at least a second later (message times are in seconds)
  assert.equal(session.state, 'approving');
  relay.thaw(dappKey);
  doc.set('visible');
  await waitFor(() => session.state === 'connected', 'the replayed xpubs');
});

test('fix: a payment approved while the page is hidden reaches the page while it is still hidden', { timeout: 30_000 }, async (t) => {
  const { doc, session, sim, prompts, connect } = await openSelene(t);
  await waitFor(() => prompts.length === 1, 'the prompt');
  connect();
  await waitFor(() => session.state === 'connected', 'the xpubs');
  doc.set('visible');
  await sleep(300);

  const { show, contracts, shardUtxos } = makeShow(assert);
  const r0 = sim.addressAt('receive', 0);
  const built = buildBuy({ show, contracts, boxOfficeUtxo: shardUtxos[0], fundingUtxos: [fakeCoin(r0.pkh, 50_000)], buyerPkh: r0.pkh, currentHeight: saleHeight(show) });
  const signing = session.sign(buildSignRequest(built, { pathOf: pathLookup([r0]), userPrompt: 'Doorstub: hidden-page test' }), { timeoutMs: 15_000 });
  doc.set('hidden'); // "Approve in Selene": the user opens the wallet
  const hex = await signing;
  assert.equal(doc.visibilityState, 'hidden', 'answered while the page was hidden');
  assert.equal(checkSignedReply(built, hex).ok, true);
});

test("a connected page ignores Selene's hello after Selene restarts (relay key first, xpubs after it re-approves a link it knows)", { timeout: 30_000 }, async (t) => {
  const { doc, session, sim, states, prompts, connect, uri } = await openSelene(t);
  await waitFor(() => prompts.length === 1, 'the prompt');
  connect();
  await waitFor(() => session.state === 'connected', 'the xpubs');
  doc.set('visible');
  await sleep(300);
  const before = states.length;
  // Selene opened again: a new connection on the same link says hello, then (link known) sends its xpubs again.
  delete globalThis.document;
  const again = await sim.pairOverRelay(uri, { askToConnect: () => true });
  globalThis.document = doc;
  t.after(() => again.close());
  await sleep(1_500);
  assert.equal(session.state, 'connected');
  assert.deepEqual(states.slice(before).filter((s) => s !== 'connected'), [], 'never "error" or "approving" on the way');
  assert.equal(session.wallet.name, 'Doorstub sim wallet');
});

test('back before the hold ends: the replay cutoff stays put back after the reconnect, so xpubs the wallet stamped before the return but sent after it still count', { timeout: 30_000 }, async (t) => {
  // RelayClient keeps a second copy of its cutoff per wallet+dapp pair (RelayClient.sessionTimestamps):
  // disconnect() moves it to "now", and the next "connected" raises the cutoff to it. Selene stamps a
  // message when it makes it; a send that the phone delays (the user tapped Connect and came straight
  // back) reaches the relay after the page's reconnect, stamped before it.
  const { relay, doc, session, wallet, prompts, connect } = await openSelene(t);
  await waitFor(() => prompts.length === 1, 'the prompt while the page is hidden');
  await waitFor(() => session.state === 'approving', 'the hello');
  const walletClient = [...wallet.manager.connections.values()][0].client;
  const send = walletClient.relay.bind(walletClient);
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  walletClient.relay = async (msg) => {
    if (msg.action === 'wallet_ready' && Object.values(msg.session ?? {}).some((s) => s.paths?.length > 0)) await gate;
    return send(msg);
  };
  connect(); // the xpubs are stamped now, and their send is held up
  await sleep(1_200); // the return is at least a second later (message times are in seconds)
  const before = relay.stats.connections;
  doc.set('visible');
  await waitFor(() => relay.stats.connections > before, 'the reconnect after the return');
  await sleep(500);
  assert.equal(session.state, 'approving');
  release();
  await waitFor(() => session.state === 'connected', 'the xpubs stamped before the return');
});
