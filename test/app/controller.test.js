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
import { ticketModel } from '../../app/src/lib/view.js';
import { memoryStorage } from '../../src/wallet/index.js';
import { settleOpensAt } from '../../src/shows/index.js';
import { BroadcastError, checkSignatureFree, fetchShowLedger, liveEscrowUtxos } from '../../src/chain/index.js';
import { buildSettle } from '../../src/tx/index.js';
import { makeSimWallet } from '../support/sim-wallet.js';
import { stubApi, stubErrorBody } from '../support/stub-worker.js';
import { scratchDir } from '../simnet/support.js';
import { REAL_SHOW } from '../e2e/stage.js';

const DOOR_LINK = 'https://example.org/doorstub-test-door';

const waitFor = async (predicate, what, ms = 8_000) => {
  const start = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
};

/** createApi over an in-process stub (so app/src/lib/api.js runs too). `intercept(path, body)` runs first (tests). */
const apiOver = (stub, intercept = async () => {}) =>
  createApi({
    retryDelaysMs: [1, 1, 1],
    fetchImpl: async (url, init) => {
      const path = new URL(url, 'http://local').pathname;
      try {
        const body = JSON.parse(init.body);
        await intercept(path, body);
        const result = path === '/api/notice' ? await stub.notice(body) : await stub.door(body);
        return new Response(JSON.stringify(result), { status: 200 });
      } catch (e) {
        return new Response(JSON.stringify(stubErrorBody(e)), { status: e.status ?? 500 });
      }
    },
  });

const setup = async (t, { walletOptions = {}, behaviour = {}, intercept, deps = {} } = {}) => {
  const simnet = await startSimnet({ port: 0, seed: 'app-controller', height: 977_600 });
  t.after(() => simnet.close());
  const scratch = scratchDir('app-controller');
  t.after(scratch.cleanup);
  const boot = await bootstrapSimnet({ server: simnet.url, dir: scratch.dir, count: 2, firstStart: '+36', refundSeatStart: '+6500', schedule: [REAL_SHOW] });
  const secrets = JSON.parse(readFileSync(boot.secretsPath, 'utf8'));
  const shows = () => JSON.parse(readFileSync(boot.showsPath, 'utf8')).shows;
  const doorLinks = Object.fromEntries(shows().filter((s) => s.kind === 'real').map((s) => [s.params.category, DOOR_LINK]));
  const stub = stubApi({ shows, dataPrivateKey: hexToBin(secrets.data.privateKey), doorLinks, behaviour });
  const wallet = makeSimWallet(walletOptions);
  const controller = createController({
    runtime: { network: 'simnet', servers: [simnet.url], apiOrigin: '', showsUrl: '/shows.json', testHooks: true },
    deps: {
      fetchShows: async () => readFileSync(boot.showsPath, 'utf8'),
      initiateRelay: wallet.inProcessRelay(),
      storage: memoryStorage(),
      api: apiOver(stub, intercept === undefined ? undefined : (path, body) => intercept(path, body, { simnet })),
      sleep: async () => {},
      dappIcon: 'https://doorstub.pages.dev/icon.png',
      ...deps,
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
  await waitFor(() => state().shows.length === 4, 'all four shows verified');
  const onSale = controller.onSale();
  assert.deepEqual(onSale.map((s) => s.kind), ['sample-settle', 'sample-refund-seat', 'real']);
  const [showA, showB, real] = onSale;
  await waitFor(() => state().ledgers.size === 4 && state().proof !== null, 'ledgers and proof strip');
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
  // What the wallet paid: the price, 2,000 sats for the ticket and marker, and the buy's network fee (under 1,500 sats).
  const paidA = state().paid[buyA.txid];
  assert.ok(paidA > 102_000n && paidA < 103_500n, `paid ${paidA}`);
  assert.ok(paidA > back.returned, 'more was paid than came back: the difference is the network fees');

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

  // A real show: buy, walk in (the holder's wallet signs the check-in), the door answers with the link.
  const boughtReal = await controller.buy(real.id);
  assert.ok(boughtReal?.key, JSON.stringify(state().flows[real.id]?.error));
  const sentIn = await controller.walkIn(boughtReal.key);
  assert.ok(sentIn?.txid, JSON.stringify(state().flows[boughtReal.key]?.error));
  assert.match(wallet.log.at(-1).userPrompt, /^Doorstub: walk in with seat S-\d-1\. This pays the organiser 0\.000\d+ BCH; your ticket stays as a keepsake\.$/);
  assert.equal(state().flows[boughtReal.key].link, DOOR_LINK);
  // The page reserved its claim first (before the check-in was sent), then asked the door with the same claim.
  const doorCalls = stub.calls.filter((c) => c.endpoint === 'reserve' || c.endpoint === 'door');
  assert.deepEqual(doorCalls.map((c) => [c.endpoint, c.txid]), [['reserve', sentIn.txid], ['door', sentIn.txid]]);
  assert.equal(doorCalls[0].claim, doorCalls[1].claim);
  assert.match(doorCalls[0].claim, /^[0-9a-f]{64}$/);
  // Someone who saw the check-in on the network and asks with another claim, or none, is refused.
  await assert.rejects(stub.door({ category: real.categoryHex, txid: sentIn.txid, claim: 'ee'.repeat(32) }), (e) => e.status === 409 && e.code === 'already-answered');
  await assert.rejects(stub.door({ category: real.categoryHex, txid: sentIn.txid }), (e) => e.status === 409);
  await waitFor(() => {
    const t4 = state().tickets.find((x) => `${x.showId}:${x.seatHex}` === boughtReal.key);
    return t4?.state === 'walkedIn' && t4.pending !== true;
  }, 'walked in, from the chain');
  // After a reload the flow is gone; the check-in txid comes from the chain and the door answers again.
  controller.dismiss(boughtReal.key);
  await controller.retryDoor(boughtReal.key);
  assert.equal(state().flows[boughtReal.key].link, DOOR_LINK);
  assert.equal(stub.calls.filter((c) => c.endpoint === 'door').at(-1).txid, sentIn.txid);
  assert.equal(stub.calls.filter((c) => c.endpoint === 'door').at(-1).claim, doorCalls[0].claim, 'the same claim after a reload (kept in storage)');

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
  assert.deepEqual(state().proof.txCounts, { buy: 4, handBack: 1, checkIn: 1, settle: 1, refund: 1 });
  assert.equal(wallet.log.length, 6, 'the settle needed no approval');

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
  assert.match(say(poor.key, poor.vars), /^You need about 0\.00\d+ BCH for this ticket; your wallet has 0\.0005 BCH\.$/);
  // Not a wall: the wallet's next receive address, how much to send, and the buy goes on by itself when it arrives.
  assert.equal(poor.fund.address, wallet.addressAt('receive', 1).address);
  assert.equal(poor.fund.amount, '0.0006', 'what is missing plus 1,000 sats, rounded up to 0.0001 BCH');
  assert.equal(poor.fund.uri, `${poor.fund.address}?amount=0.0006`);
  assert.equal(say('fundHere', { amount: poor.fund.amount }), 'Send at least 0.0006 BCH to this address. When it arrives, the buy continues and your wallet asks you to approve.');
  const asked = wallet.log.length;
  await controller.pool.request('simnet.fund', { address: poor.fund.address, sats: 60_000 });
  // The wallet is asked to approve with no click on the page (it declines here, so the flow ends declined).
  await waitFor(() => state().flows[showA.id]?.error?.key === 'walletDeclined', 'the buy continued when the coins arrived', 15_000);
  assert.equal(wallet.log.length, asked + 1);
  assert.equal(state().wallet.balance, 110_000n);

  await controller.pool.request('simnet.fund', { address: wallet.addressAt('receive', 2).address, sats: 500_000, mine: true });
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

test('walk in: the door claim is reserved before the check-in is sent; a failed reservation still sends it; a 409 is not asked again', async (t) => {
  const reserves = [];
  let ctl;
  let observer = false;
  const { controller, wallet, state, stub } = await setup(t, {
    intercept: async (path, body) => {
      if (path !== '/api/door') return;
      if (body.reserve === true) {
        // Only this page knows the txid now: the network has not seen the check-in.
        const known = await ctl.pool.request('blockchain.transaction.get', [body.txid]).then(() => true, () => false);
        reserves.push({ txid: body.txid, known });
        if (observer) throw Object.assign(new Error('the door is down'), { status: 503, code: 'chain-down' });
      } else if (observer) {
        // Someone read the check-in from the network and asked first, with a claim of their own.
        await stub.door({ category: body.category, txid: body.txid, claim: 'ee'.repeat(32) }).catch(() => {});
      }
    },
  });
  ctl = controller;
  await controller.start();
  const real = controller.onSale().find((s) => s.kind === 'real');
  await controller.pool.request('simnet.fund', { address: wallet.addressAt('receive', 0).address, sats: 1_000_000, mine: true });
  await controller.connect();
  await waitFor(() => state().wallet.state === 'connected' && state().wallet.balance !== null, 'wallet ready');

  const one = await controller.buy(real.id);
  assert.ok(one?.key, JSON.stringify(state().flows[real.id]?.error));
  const sent = await controller.walkIn(one.key);
  assert.ok(sent?.txid);
  assert.deepEqual(reserves, [{ txid: sent.txid, known: false }], 'reserved before the check-in reached the network');
  assert.equal(state().flows[one.key].link, DOOR_LINK);

  // The reservation fails (non-fatal: the check-in is sent anyway), and an observer claims first: the page says so once.
  observer = true;
  const two = await controller.buy(real.id);
  assert.ok(two?.key, JSON.stringify(state().flows[real.id]?.error));
  const warn = console.warn;
  console.warn = () => {};
  let sent2;
  try {
    sent2 = await controller.walkIn(two.key);
  } finally {
    console.warn = warn;
  }
  assert.ok(sent2?.txid, 'the check-in went out although the reservation failed');
  assert.equal(await controller.pool.request('blockchain.transaction.get', [sent2.txid]).then(() => true, () => false), true);
  const flow = state().flows[two.key];
  assert.equal(flow.link, undefined);
  assert.equal(flow.doorError.key, 'doorTaken');
  assert.deepEqual(flow.doorError.actions, [], 'no "Try again" for a 409');
  assert.equal(say(flow.doorError.key, flow.doorError.vars), 'The door already gave the event link for this check-in to another page, so it cannot give it here.');
  const pageAsks = stub.calls.filter((c) => c.endpoint === 'door' && c.txid === sent2.txid && c.claim !== 'ee'.repeat(32));
  assert.equal(pageAsks.length, 1, 'a 409 is not retried');
});

test('a real show stops selling and walking in when its call ends, by the page clock, even when Try again is pressed or the wallet approves after the end', async (t) => {
  const callEnd = Date.parse(REAL_SHOW.eventAt) + REAL_SHOW.durationMin * 60_000;
  let clock = Date.now();
  let decline = false;
  let onApprove = () => {};
  const { controller, wallet, state, stub } = await setup(t, {
    walletOptions: {
      approve: () => {
        onApprove();
        return decline ? 'User rejected the request' : true;
      },
    },
    deps: { keeper: false, now: () => clock },
  });
  await controller.start();
  const real = controller.onSale().find((s) => s.kind === 'real');
  await controller.pool.request('simnet.fund', { address: wallet.addressAt('receive', 0).address, sats: 1_000_000, mine: true });
  await controller.connect();
  await waitFor(() => state().wallet.state === 'connected' && state().wallet.balance !== null, 'wallet ready');
  const seatOf = (key) => key.split(':')[1];
  const coinOf = async (key) => (await fetchShowLedger(controller.pool, real, { contracts: real.contracts })).bySeat.get(seatOf(key));
  const reserves = () => stub.calls.filter((c) => c.endpoint === 'reserve').length;

  // A late arrival buys during the call; the wallet declines the walk-in, which leaves Try again on the card.
  clock = callEnd - 10 * 60_000;
  const one = await controller.buy(real.id);
  assert.ok(one?.key, JSON.stringify(state().flows[real.id]?.error));
  // A cancelled show has no walk-in, even during its call (a check-in would pay its organiser).
  real.cancelled = true;
  const before = wallet.log.length;
  assert.equal(await controller.walkIn(one.key), undefined);
  assert.match(state().flows[one.key].error.vars.message, /cancelled this show/);
  assert.equal(wallet.log.length, before, 'the wallet was not asked');
  real.cancelled = false;
  decline = true;
  await controller.walkIn(one.key);
  assert.deepEqual(state().flows[one.key].error.actions, ['retry']);
  decline = false;

  // The call ends. Try again (controller.walkIn, as App.jsx maps it) asks no wallet and sends nothing.
  clock = callEnd + 5 * 60_000;
  const asked = wallet.log.length;
  assert.equal(await controller.walkIn(one.key), undefined);
  const late = state().flows[one.key].error;
  assert.equal(late.key, 'callSalesEnded');
  assert.deepEqual(late.actions, [], 'no Try again after the call');
  assert.equal(wallet.log.length, asked, 'the wallet was not asked');
  assert.equal(reserves(), 0, 'the door was not asked');
  assert.equal((await coinOf(one.key)).spend, null, 'the coin is unspent');
  // The ticket keeps Hand it back and the settle countdown, without Walk in.
  const held = ticketModel(state().tickets.find((x) => `${x.showId}:${x.seatHex}` === one.key), { tip: state().chain.tip, now: clock, timeZone: 'UTC' });
  assert.equal(held.canWalkIn, false);
  assert.equal(held.canHandBack, true);
  assert.equal(held.lines.at(-1), 'The event is over, so Walk in is closed.');
  assert.equal(held.call, null);
  assert.notEqual(held.countdown, null);

  // Walk in tapped a minute before the end, approved after it: the signed check-in is not sent.
  clock = callEnd - 60_000;
  const two = await controller.buy(real.id);
  assert.ok(two?.key, JSON.stringify(state().flows[real.id]?.error));
  onApprove = () => {
    clock = callEnd + 10_000;
  };
  assert.equal(await controller.walkIn(two.key), undefined);
  assert.equal(state().flows[two.key].error.key, 'callSalesEnded');
  assert.equal(wallet.log.at(-1).outcome, 'signed', 'the wallet did approve');
  assert.equal(reserves(), 0);
  assert.equal((await coinOf(two.key)).spend, null);

  // Get a ticket tapped 30 s before the end, approved after it: the signed buy is not sent.
  clock = callEnd - 30_000;
  const sold = (await fetchShowLedger(controller.pool, real, { contracts: real.contracts })).bySeat.size;
  assert.equal(await controller.buy(real.id), undefined);
  assert.equal(state().flows[real.id].error.key, 'callSalesEnded');
  assert.deepEqual(state().flows[real.id].error.actions, []);
  assert.equal(wallet.log.at(-1).outcome, 'signed', 'the wallet did approve');
  assert.equal((await fetchShowLedger(controller.pool, real, { contracts: real.contracts })).bySeat.size, sold, 'no new ticket on chain');

  // Hand it back still works after the call.
  onApprove = () => {};
  const back = await controller.handBack(one.key);
  assert.ok(back?.txid, JSON.stringify(state().flows[one.key]?.error));
});

test('a hand-back that loses the race to a settle says another transaction spent the coin, and the card shows the settle', async (t) => {
  const { controller, wallet, state } = await setup(t, { deps: { keeper: false } });
  await controller.start();
  const showA = controller.onSale().find((s) => s.kind === 'sample-settle');
  await controller.pool.request('simnet.fund', { address: wallet.addressAt('receive', 0).address, sats: 1_000_000, mine: true });
  await controller.connect();
  await waitFor(() => state().wallet.state === 'connected' && state().wallet.balance !== null, 'wallet ready');
  const bought = await controller.buy(showA.id);
  assert.ok(bought?.key, JSON.stringify(state().flows[showA.id]?.error));
  const tip = state().chain.tip;
  await controller.pool.request('simnet.mine', { blocks: settleOpensAt(showA) - 1 - tip });
  await waitFor(() => state().chain.tip === settleOpensAt(showA) - 1, 'the tip passed start + grace');
  // Anyone (here the test, through the same servers) pushes the settle just before the holder's hand-back goes out.
  const coins = liveEscrowUtxos(await fetchShowLedger(controller.pool, showA, { contracts: showA.contracts }));
  assert.equal(coins.length, 1);
  await controller.pool.broadcastChecked(checkSignatureFree(buildSettle({ show: showA, escrowUtxos: coins, contracts: showA.contracts })));
  await controller.handBack(bought.key);
  const flow = state().flows[bought.key];
  assert.equal(flow.error?.key, 'coinSpent', JSON.stringify(flow));
  assert.deepEqual(flow.error.actions, []);
  const ticket = state().tickets.find((x) => `${x.showId}:${x.seatHex}` === bought.key);
  assert.equal(ticket.state, 'refunded');
  assert.equal(ticket.refundPath, 'settle');
  assert.equal(wallet.log.length, 2, 'the buy and the hand-back were signed; nothing else');
});

test('a relay hiccup keeps the paired wallet: a buy waits for it, a refused send is sent once more, a request the wallet has is never cancelled or sent anew, and only a wallet that does not come back is paired anew', async (t) => {
  const { controller, wallet, state } = await setup(t, { deps: { keeper: false, reconnectWaitMs: 1_500 } });
  await controller.start();
  const showA = controller.onSale().find((s) => s.kind === 'sample-settle');
  await controller.pool.request('simnet.fund', { address: wallet.addressAt('receive', 0).address, sats: 1_000_000, mine: true });
  await controller.connect();
  await waitFor(() => state().wallet.state === 'connected' && state().wallet.balance !== null, 'wallet ready');
  const paired = state().wallet.pairing.uri;
  assert.equal(wallet.sessions.size, 1);
  const stepsOf = (key) => {
    const steps = [];
    const unsubscribe = controller.store.subscribe((s) => {
      const step = s.flows[key]?.step;
      if (step !== undefined && steps.at(-1) !== step) steps.push(step);
    });
    return { steps, unsubscribe };
  };

  // The relay blips just as Get a ticket is pressed: the page says it is reconnecting and buys once the wallet is back.
  const first = stepsOf(showA.id);
  wallet.blip({ ms: 150 });
  assert.equal(state().wallet.state, 'reconnecting');
  const bought = await controller.buy(showA.id);
  first.unsubscribe();
  assert.ok(bought?.key, JSON.stringify(state().flows[showA.id]));
  assert.ok(first.steps.includes('reconnecting'), 'the card said it was reconnecting');
  assert.equal(say('walletReconnecting'), 'Reconnecting to your wallet.');
  assert.equal(state().connectOpen, false, 'no new pairing');
  assert.equal(state().wallet.pairing.uri, paired);
  assert.equal(wallet.sessions.size, 1);

  // The relay refuses the send just as the wallet is asked (the wallet never saw it): once the relay is back the page
  // sends it once more, and the wallet gets one request.
  let seen = wallet.requests.length;
  const refused = stepsOf(showA.id);
  let blipped = false;
  const unblip = controller.store.subscribe((s) => {
    if (!blipped && s.flows[showA.id]?.step === 'approve') {
      blipped = true;
      wallet.blip({ ms: 100, refuse: true });
    }
  });
  const second = await controller.buy(showA.id);
  unblip();
  refused.unsubscribe();
  assert.ok(second?.key, JSON.stringify(state().flows[showA.id]));
  assert.ok(blipped);
  assert.deepEqual(refused.steps, ['preparing', 'approve', 'reconnecting', 'approve', 'sending', 'done']);
  assert.equal(wallet.requests.length, seen + 1, 'one request reached the wallet');
  assert.equal(wallet.cancels.length, 0);

  // A request the wallet already has (it is not looking at its screen) while the relay blips: the page keeps waiting
  // on it. Nothing is cancelled or sent anew, so one Hand it back is one approval.
  wallet.pause();
  seen = wallet.requests.length;
  const handing = controller.handBack(bought.key);
  await waitFor(() => state().flows[bought.key]?.step === 'approve' && wallet.requests.length === seen + 1, 'the wallet holds the hand-back request');
  wallet.blip({ ms: 100 });
  await waitFor(() => state().wallet.state === 'connected', 'the relay is back');
  await new Promise((r) => setTimeout(r, 50));
  wallet.resume();
  await handing;
  const back = state().flows[bought.key];
  assert.equal(back.error, undefined, JSON.stringify(back.error));
  assert.equal(back.step, 'done');
  assert.equal(wallet.cancels.length, 0, 'the request was not cancelled');
  assert.equal(wallet.requests.length, seen + 1, 'and not sent anew');
  assert.equal(state().wallet.pairing.uri, paired);

  // A phone wallet asleep: the library hears no pong for 75 s and says 'reconnecting' while the relay stays up. Hand it
  // back still sends at once and says "Approve in {wallet}" (it does not give up after the wait); when the wallet app
  // is opened it says wallet_ready, the library sends the request again with the same sequence, and the wallet shows
  // it once.
  wallet.pause();
  controller.session.manager.stopPingInterval();
  controller.session.manager.emit('reconnecting');
  assert.equal(state().wallet.state, 'reconnecting');
  seen = wallet.requests.length;
  const asleep = stepsOf(second.key);
  const handing2 = controller.handBack(second.key);
  await waitFor(() => state().flows[second.key]?.step === 'approve', 'Approve in the wallet at once', 1_000);
  await new Promise((r) => setTimeout(r, 1_800)); // longer than the reconnect wait
  assert.equal(state().flows[second.key].step, 'approve');
  assert.equal(state().flows[second.key].error, undefined);
  assert.equal(wallet.requests.length, seen + 1, 'the request went out while the wallet was away');
  wallet.wake();
  await handing2;
  asleep.unsubscribe();
  assert.equal(state().flows[second.key].error, undefined, JSON.stringify(state().flows[second.key].error));
  assert.equal(state().flows[second.key].step, 'done');
  assert.ok(!asleep.steps.includes('reconnecting'), asleep.steps.join(' > '));
  assert.equal(wallet.requests.length, seen + 1, 'one request, shown once');
  assert.equal(wallet.cancels.length, 0);
  assert.equal(state().wallet.state, 'connected');

  // A wallet that does not come back within the wait: only then does Get a ticket start a new pairing.
  wallet.blip({ ms: 60_000 });
  await controller.buy(showA.id);
  assert.equal(state().connectOpen, true, 'the connect dialog opened after the wait');
  assert.equal(state().pendingBuy, showA.id);
  assert.notEqual(state().wallet.pairing?.uri ?? null, paired);
});

test('a buy refused as a conflict while the wallet relay blips is retried once the wallet is back, or bought on a new pairing when the wallet is gone, never left spinning', async (t) => {
  const { controller, wallet, state } = await setup(t, { deps: { keeper: false, reconnectWaitMs: 1_000 } });
  await controller.start();
  const showA = controller.onSale().find((s) => s.kind === 'sample-settle');
  await controller.pool.request('simnet.fund', { address: wallet.addressAt('receive', 0).address, sats: 1_000_000, mine: true });
  await controller.connect();
  await waitFor(() => state().wallet.state === 'connected' && state().wallet.balance !== null, 'wallet ready');
  // The network refuses the first broadcast as a conflict, and at that moment the wallet relay blips (or the wallet
  // ends the connection).
  const broadcast = controller.pool.broadcastChecked.bind(controller.pool);
  let calls = 0;
  let meanwhile = () => wallet.blip({ ms: 300 });
  controller.pool.broadcastChecked = async (checked) => {
    calls += 1;
    if (calls === 1) {
      meanwhile();
      throw new BroadcastError('rejected', 'the transaction was rejected by network rules', { errors: [{ message: 'txn-mempool-conflict' }] });
    }
    return broadcast(checked);
  };

  // The wallet is back within the wait: the retry goes on and the buy is sent.
  const bought = await controller.buy(showA.id);
  assert.ok(bought?.key, JSON.stringify(state().flows[showA.id]));
  assert.equal(calls, 2);
  assert.equal(state().flows[showA.id].step, 'done');

  // The wallet does not come back (here it ended the connection): the retry does not leave the card spinning on
  // "preparing"; a new pairing opens and the buy runs on it.
  calls = 0;
  meanwhile = () => controller.session.manager.emit('disconnect', 'user_disconnect', 'Wallet disconnected');
  await controller.buy(showA.id);
  await waitFor(() => state().flows[showA.id]?.step === 'done' && state().flows[showA.id].ticketKey !== bought.key, 'the buy on the new pairing');
  assert.equal(calls, 2);
  assert.equal(state().pendingBuy, null);
});

test('reopening the connect dialog shows the same link while it waits for a wallet; the other relay makes a new one', async () => {
  let pairs = 0;
  const fakeSession = () => ({
    wallet: null,
    pair: async ({ relay }) => {
      pairs += 1;
      return { uri: `wiz://pairing-${pairs}-relay-${relay}`, qrUri: 'WIZ://X', selene: 'wiz://x', cashonize: 'https://cashonize.com/?uri=x', copy: 'wiz://x' };
    },
    restore: async () => false,
    disconnect: async () => {},
  });
  const controller = createController({
    runtime: { network: 'simnet', servers: ['ws://127.0.0.1:1'], apiOrigin: '', showsUrl: '/shows.json', testHooks: true },
    deps: { createSession: fakeSession, fetchShows: async () => '{}', sleep: async () => {} },
  });
  const first = await controller.connect();
  controller.closeConnect();
  assert.equal(controller.store.get().connectOpen, false);
  const again = await controller.connect();
  assert.equal(again.uri, first.uri, 'a pasted link stays valid');
  assert.equal(controller.store.get().connectOpen, true);
  assert.equal(pairs, 1);
  const other = await controller.connect({ relay: 1 });
  assert.equal(pairs, 2);
  assert.notEqual(other.uri, first.uri);
  await controller.close();
});

test('the tickets this page acted on are kept for the tab, so a reload keeps finished tickets under their cards', async () => {
  const saved = new Map([['doorstub.touched', JSON.stringify(['sample-b:020001', 'screening-1:010001', 'bad key', 7])]]);
  const tabStorage = { getItem: (k) => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, String(v)) };
  const make = (deps) =>
    createController({
      runtime: { network: 'simnet', servers: ['ws://127.0.0.1:1'], apiOrigin: '', showsUrl: '/shows.json', testHooks: true },
      deps: { fetchShows: async () => '{}', sleep: async () => {}, ...deps },
    });
  const controller = make({ tabStorage });
  assert.deepEqual([...controller.touched()], ['sample-b:020001', 'screening-1:010001'], 'only well-formed ticket keys are read back');
  await controller.close();
  // Storage that throws (blocked): the page works the same, from memory.
  const blocked = make({ tabStorage: { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } } });
  assert.deepEqual([...blocked.touched()], []);
  await blocked.close();
});
