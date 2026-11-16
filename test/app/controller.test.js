// The app's controller (app/src/lib/controller.js) end to end on simnet, with
// no browser: the studio makes the catalogue, the controller loads and
// verifies it, pairs the sim wallet through the real WizardConnect dapp
// manager (in process), and runs the judge path: buy sample A, hand it back,
// buy sample B and watch its refund arrive (notice -> refund -> money back),
// then a second A ticket settled by the page itself once the show is past its
// grace. Then the stuck states: not enough BCH, a declined approval, the
// notice service down, sales ended.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hexToBin } from '@bitauth/libauth';
import { startSimnet } from '../../simnet/index.js';
import { bootstrapSimnet } from '../../studio/index.js';
import { createController } from '../../app/src/lib/controller.js';
import { createApi } from '../../app/src/lib/api.js';
import { say } from '../../app/src/lib/copy.js';
import { memoryStorage } from '../../src/wallet/index.js';
import { settleOpensAt } from '../../src/shows/index.js';
import { makeSimWallet } from '../support/sim-wallet.js';
import { stubApi } from '../support/stub-worker.js';
import { scratchDir } from '../simnet/support.js';

const waitFor = async (predicate, what, ms = 8_000) => {
  const start = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
};

/** createApi over an in-process stub (so app/src/lib/api.js runs too). */
const apiOver = (stub) =>
  createApi({
    retryDelaysMs: [1, 1, 1],
    fetchImpl: async (url, init) => {
      const path = new URL(url, 'http://local').pathname;
      try {
        const result = path === '/api/notice' ? await stub.notice(JSON.parse(init.body)) : await stub.door(JSON.parse(init.body));
        return new Response(JSON.stringify(result), { status: 200 });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: e.status ?? 500 });
      }
    },
  });

const setup = async (t, { walletOptions = {}, behaviour = {} } = {}) => {
  const simnet = await startSimnet({ port: 0, seed: 'app-controller', height: 977_600 });
  t.after(() => simnet.close());
  const scratch = scratchDir('app-controller');
  t.after(scratch.cleanup);
  const boot = await bootstrapSimnet({ server: simnet.url, dir: scratch.dir, count: 2, firstStart: '+36', refundSeatStart: '+6500' });
  const secrets = JSON.parse(readFileSync(boot.secretsPath, 'utf8'));
  const stub = stubApi({ shows: () => JSON.parse(readFileSync(boot.showsPath, 'utf8')).shows, dataPrivateKey: hexToBin(secrets.data.privateKey), behaviour });
  const wallet = makeSimWallet(walletOptions);
  const controller = createController({
    runtime: { network: 'simnet', servers: [simnet.url], apiOrigin: '', showsUrl: '/shows.json', testHooks: true },
    deps: {
      fetchShows: async () => readFileSync(boot.showsPath, 'utf8'),
      initiateRelay: wallet.inProcessRelay(),
      storage: memoryStorage(),
      api: apiOver(stub),
      sleep: async () => {},
      dappIcon: 'https://doorstub.pages.dev/icon.png',
    },
  });
  t.after(async () => {
    await controller.session?.disconnect();
    await controller.close();
  });
  return { simnet, boot, stub, wallet, controller, state: () => controller.store.get() };
};

const flowDone = (state, key) => state().flows[key]?.step === 'done' || state().flows[key]?.error !== undefined;

test('controller on simnet: buy A, hand back, buy B and its refund arrives, the page settles a started show', async (t) => {
  const { controller, wallet, state, stub } = await setup(t);
  await controller.start();
  assert.equal(state().boot, 'ready');
  await waitFor(() => state().shows.length === 3, 'all three shows verified');
  const onSale = controller.onSale();
  assert.deepEqual(onSale.map((s) => s.kind), ['sample-settle', 'sample-refund-seat']);
  const [showA, showB] = onSale;
  await waitFor(() => state().ledgers.size === 3 && state().proof !== null, 'ledgers and proof strip');
  assert.deepEqual(state().proof.txCounts, { buy: 0, handBack: 0, checkIn: 0, settle: 0, refund: 0 });

  // Fund the wallet before it connects (the scan must find the coin).
  await controller.pool.request('simnet.fund', { address: wallet.addressAt('receive', 0).address, sats: 1_000_000, mine: true });

  // "Get a ticket" without a wallet opens the connect dialog and buys once the wallet is ready.
  await controller.buy(showA.id);
  assert.equal(state().connectOpen, true, 'the connect dialog opened');
  assert.equal(state().pendingBuy, showA.id, 'the buy waits for the wallet');
  await waitFor(() => state().pendingBuy === null, 'the wallet joined and the buy started');
  assert.ok(state().wallet.pairing.uri.startsWith('wiz://'));
  await waitFor(() => flowDone(state, showA.id), 'buy A');
  const buyA = state().flows[showA.id];
  assert.equal(buyA.error, undefined, JSON.stringify(buyA.error));
  assert.equal(state().wallet.state, 'connected');
  assert.equal(state().connectOpen, false);
  assert.match(wallet.log[0].userPrompt, /^Doorstub: buy seat A-\d-1 for 0\.001 BCH\. The money waits in the show's contract\.$/);
  assert.equal(buyA.prompt, wallet.log[0].userPrompt, 'the page shows the exact prompt the wallet shows');

  // The ticket is there at once (the app's own record), then from the chain.
  const keyA = buyA.ticketKey;
  await waitFor(() => state().tickets.find((x) => `${x.showId}:${x.seatHex}` === keyA && x.pending !== true), 'ticket A from the chain');
  const ticketA = state().tickets.find((x) => `${x.showId}:${x.seatHex}` === keyA);
  assert.equal(ticketA.state, 'held');
  assert.equal(ticketA.canAct, true);
  assert.equal(ticketA.buy.txid, buyA.txid);
  await waitFor(() => state().proof.txCounts.buy === 1, 'proof strip counts the buy');

  // Hand it back.
  await controller.handBack(keyA);
  const back = state().flows[keyA];
  assert.equal(back.error, undefined, JSON.stringify(back.error));
  assert.equal(back.step, 'done');
  assert.match(wallet.log.at(-1).userPrompt, /^Doorstub: hand back seat A-\d-1\. 0\.00\d+ BCH comes back to this wallet\.$/);
  // The coin (price + 1,000) and the ticket's own 1,000 sats, less the network fee (at most the cap).
  assert.ok(back.returned >= 102_000n - 1_500n && back.returned < 102_000n, `returned ${back.returned}`);
  await waitFor(() => state().tickets.find((x) => `${x.showId}:${x.seatHex}` === keyA)?.pending !== true && state().tickets.find((x) => `${x.showId}:${x.seatHex}` === keyA)?.state === 'handedBack', 'hand-back from the chain');
  assert.equal(state().returned[keyA], back.returned, 'the amount back is read from the chain too');

  // Sample B: buy, then the refund sequence runs by itself.
  const bought = await controller.buy(showB.id);
  assert.ok(bought?.key, JSON.stringify(state().flows[showB.id]?.error));
  await waitFor(() => state().flows[bought.key]?.step === 'back' || state().flows[bought.key]?.error, 'B refund sequence');
  const refundFlow = state().flows[bought.key];
  assert.equal(refundFlow.error, undefined, JSON.stringify(refundFlow.error));
  assert.equal(stub.calls.filter((c) => c.endpoint === 'notice').length, 1, 'one notice request');
  assert.equal(wallet.log.length, 3, 'no second approval for the refund');
  await waitFor(() => {
    const t2 = state().tickets.find((x) => `${x.showId}:${x.seatHex}` === bought.key);
    return t2?.state === 'refunded' && t2.refundPath === 'refund' && t2.pending !== true;
  }, 'B refunded from the chain');

  // A second A ticket, then the show starts and passes its grace: the page pushes the settle itself.
  const second = await controller.buy(showA.id);
  assert.ok(second?.key, JSON.stringify(state().flows[showA.id]?.error));
  const tip = state().chain.tip;
  await controller.pool.request('simnet.mine', { blocks: settleOpensAt(showA) - 1 - tip });
  await waitFor(() => state().keeper.length === 1, 'the page pushed a settle');
  assert.equal(state().keeper[0].showId, showA.id);
  assert.equal(state().keeper[0].count, 1);
  await waitFor(() => {
    const t3 = state().tickets.find((x) => `${x.showId}:${x.seatHex}` === second.key);
    return t3?.state === 'refunded' && t3.refundPath === 'settle';
  }, 'second A ticket settled');
  await waitFor(() => state().proof.txCounts.settle === 1, 'proof strip counts the settle');
  assert.deepEqual(state().proof.txCounts, { buy: 3, handBack: 1, checkIn: 0, settle: 1, refund: 1 });
  assert.equal(wallet.log.length, 4, 'the settle needed no approval');

  // After the start, the home page offers the next sample A instance, and an old buy attempt is refused with the next step.
  const next = controller.onSale().find((s) => s.kind === 'sample-settle');
  assert.ok(next && next.id !== showA.id, 'the next instance is on sale');
  await controller.buy(showA.id);
  const ended = state().flows[showA.id].error;
  assert.equal(ended.key, 'showSalesEnded');
  assert.deepEqual(ended.actions, ['nextInstance']);
});

test('controller stuck states: not enough BCH, a declined approval, the notice service down', async (t) => {
  let decline = 'User rejected the request';
  const { controller, wallet, state, stub } = await setup(t, {
    walletOptions: { approve: () => (decline === null ? true : decline) },
    behaviour: { down: true },
  });
  await controller.start();
  const [showA, showB] = controller.onSale();
  await controller.pool.request('simnet.fund', { address: wallet.addressAt('receive', 0).address, sats: 50_000, mine: true });
  await controller.connect();
  await waitFor(() => state().wallet.state === 'connected' && state().wallet.balance !== null, 'wallet ready');
  assert.equal(state().wallet.balance, 50_000n);

  await controller.buy(showA.id);
  const poor = state().flows[showA.id].error;
  assert.equal(poor.key, 'needMore');
  assert.match(say(poor.key, poor.vars), /^You need about 0\.00\d+ BCH for this ticket; your wallet has 0\.0005 BCH in plain BCH\.$/);

  await controller.pool.request('simnet.fund', { address: wallet.addressAt('receive', 1).address, sats: 500_000, mine: true });
  await controller.buy(showA.id);
  const declined = state().flows[showA.id].error;
  assert.equal(declined.key, 'walletDeclined');
  assert.equal(say(declined.key, declined.vars), 'Your wallet declined: “User rejected the request”. Nothing was sent.');
  assert.ok(declined.actions.includes('retry'));

  // Selene's words for a transaction it cannot check get their own sentence.
  decline = 'Wallet could not verify transaction';
  await controller.buy(showA.id);
  assert.equal(state().flows[showA.id].error.key, 'walletCouldNotVerify');

  // The notice service is down: the ticket stays held and the page says the keeper will refund it.
  decline = null;
  const bought = await controller.buy(showB.id);
  assert.ok(bought?.key);
  await waitFor(() => state().flows[bought.key]?.error, 'notice error');
  assert.equal(state().flows[bought.key].error.key, 'noticeDown');
  assert.deepEqual(state().flows[bought.key].error.actions, ['retryRefund']);
  assert.ok(stub.calls.filter((c) => c.endpoint === 'notice').length >= 4, 'the client retried before giving up');
  // Back up: retry works.
  stub.behaviour.down = false;
  await controller.retryRefund(bought.key);
  assert.equal(state().flows[bought.key].step, 'back');
});
