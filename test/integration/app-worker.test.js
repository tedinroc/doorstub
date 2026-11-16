// The page and the worker together, on simnet, with no browser and no
// internet: the app's controller (app/src/lib/controller.js) talks to the
// REAL worker handlers (worker/node/handler.js, the same code as Pages
// Functions plus the libauth VM) through the app's own API client, and the
// cron keeper (worker/lib/keeper.js) settles a started show. The browser
// version of this path is `npm run e2e`.
//
//   sample B: buy -> /api/notice signs an R notice (the buy's txid sent along)
//             -> the page refunds, no second approval
//   real:     buy -> walk in -> /api/door with the page's claim secret -> link;
//             a caller without the claim is refused (409); the page asks again
//             after a "reload" and gets the same link
//   sample A: buy -> mine past start + grace -> the page's settle push is off
//             -> one keeper pass settles it -> the page shows it refunded
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hexToBin } from '@bitauth/libauth';
import { startSimnet } from '../../simnet/index.js';
import { bootstrapSimnet } from '../../studio/index.js';
import { createController } from '../../app/src/lib/controller.js';
import { createApi } from '../../app/src/lib/api.js';
import { memoryStorage } from '../../src/wallet/index.js';
import { settleOpensAt } from '../../src/shows/index.js';
import { createNodeWorker } from '../../worker/node/handler.js';
import { createWorkerChain } from '../../worker/lib/chain.js';
import { runKeeper } from '../../worker/lib/keeper.js';
import { parseWorkerShows, seatLabelOf } from '../../worker/lib/shows.js';
import { libauthVmCheck } from '../../worker/node/vm.js';
import { makeSimWallet } from '../support/sim-wallet.js';
import { scratchDir } from '../simnet/support.js';
import { REAL_SHOW, STAGE_DOOR_LINK } from '../e2e/stage.js';

const waitFor = async (predicate, what, ms = 8_000) => {
  const start = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
};

test('page + real worker on simnet: B refund through the notice signer, walk in through the door (one claimant), A settled by one keeper pass', async (t) => {
  const simnet = await startSimnet({ port: 0, seed: 'app-worker', height: 977_600 });
  t.after(() => simnet.close());
  const scratch = scratchDir('app-worker');
  t.after(scratch.cleanup);
  const boot = await bootstrapSimnet({ server: simnet.url, dir: scratch.dir, count: 1, firstStart: '+8', refundSeatStart: '+6500', schedule: [REAL_SHOW] });
  const secrets = JSON.parse(readFileSync(boot.secretsPath, 'utf8'));
  const showsText = readFileSync(boot.showsPath, 'utf8');
  const realId = JSON.parse(showsText).shows.find((s) => s.kind === 'real').id;

  // The worker, in process, exactly as the stage serves it; every call is recorded.
  const worker = createNodeWorker({
    env: { DOORSTUB_NETWORK: 'simnet', DOORSTUB_FULCRUM: simnet.url, STUDIO_DATA_KEY: secrets.data.privateKey, DOOR_LINKS: JSON.stringify({ [realId]: STAGE_DOOR_LINK }) },
    showsPath: boot.showsPath,
    markerWaitMs: 2_000,
  });
  assert.deepEqual(worker.config.errors, []);
  const calls = [];
  const fetchImpl = async (url, init) => {
    const response = await worker.fetch(url, init);
    calls.push({ path: new URL(url).pathname, body: JSON.parse(init.body), status: response.status });
    return response;
  };

  const wallet = makeSimWallet();
  const claims = memoryStorage();
  const controller = createController({
    runtime: { network: 'simnet', servers: [simnet.url], apiOrigin: 'http://worker.test', showsUrl: '/shows.json', testHooks: true },
    deps: {
      fetchShows: async () => showsText,
      initiateRelay: wallet.inProcessRelay(),
      storage: memoryStorage(),
      claims,
      api: createApi({ origin: 'http://worker.test', fetchImpl, retryDelaysMs: [50, 50, 50] }),
      sleep: async () => {},
      keeper: false,
    },
  });
  t.after(async () => {
    await controller.session?.disconnect();
    await controller.close();
  });
  const state = () => controller.store.get();
  const ticket = (key) => state().tickets.find((x) => `${x.showId}:${x.seatHex}` === key);

  await controller.start();
  await waitFor(() => state().shows.length === 3, 'all three shows verified');
  const [showA, showB, real] = controller.onSale();
  assert.deepEqual([showA.kind, showB.kind, real.kind], ['sample-settle', 'sample-refund-seat', 'real']);
  await controller.pool.request('simnet.fund', { address: wallet.addressAt('receive', 0).address, sats: 1_000_000, mine: true });
  await controller.connect();
  await waitFor(() => state().wallet.state === 'connected', 'wallet connected');

  // ---------------------------------------------------------------- sample B through the real notice signer
  const b = await controller.buy(showB.id);
  assert.ok(b?.key, JSON.stringify(state().flows[showB.id]?.error));
  await waitFor(() => state().flows[b.key]?.step === 'back' || state().flows[b.key]?.error, 'B refund sequence');
  assert.equal(state().flows[b.key].error, undefined, JSON.stringify(state().flows[b.key].error));
  const notices = calls.filter((c) => c.path === '/api/notice');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].status, 200);
  assert.equal(notices[0].body.txid, b.txid, 'the page names the buy, so the signer finds the marker at once');
  assert.equal(wallet.log.length, 1, 'the refund needed no approval');
  await waitFor(() => ticket(b.key)?.state === 'refunded' && ticket(b.key).pending !== true, 'B refunded, from the chain');

  // ---------------------------------------------------------------- the real show through the real door
  const r = await controller.buy(real.id);
  assert.ok(r?.key, JSON.stringify(state().flows[real.id]?.error));
  const sentIn = await controller.walkIn(r.key);
  assert.ok(sentIn?.txid, JSON.stringify(state().flows[r.key]?.error));
  const label = seatLabelOf(parseWorkerShows(showsText, { network: 'simnet' }).shows.find((s) => s.id === real.id), hexToBin(ticket(r.key).seatHex));
  assert.match(label, /^D-\d-1$/);
  assert.equal(state().flows[r.key].link, STAGE_DOOR_LINK.replace('{seat}', label));
  const firstDoor = calls.filter((c) => c.path === '/api/door');
  assert.equal(firstDoor.length, 1);
  assert.match(firstDoor[0].body.claim, /^[0-9a-f]{64}$/, 'the page sends a random claim secret');
  assert.equal(JSON.parse(claims.getItem(`doorstub.door.${sentIn.txid}`)).claim, firstDoor[0].body.claim, 'and keeps it for this check-in');
  // Someone who saw only the txid (another client, no claim) is refused.
  const observer = await worker.handle(
    new Request('http://worker.test/api/door', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ category: real.categoryHex, txid: sentIn.txid }) }),
    { clientIp: '203.0.113.9' },
  );
  assert.equal(observer.status, 409);
  // A "reload": the flow is gone, the check-in txid comes from the chain, the kept claim gets the link again.
  await waitFor(() => ticket(r.key)?.state === 'walkedIn' && ticket(r.key).pending !== true, 'walked in, from the chain');
  controller.dismiss(r.key);
  await controller.retryDoor(r.key);
  assert.equal(state().flows[r.key].link, STAGE_DOOR_LINK.replace('{seat}', label));
  const again = calls.filter((c) => c.path === '/api/door').at(-1);
  assert.equal(again.status, 200);
  assert.equal(again.body.claim, firstDoor[0].body.claim);

  // ---------------------------------------------------------------- sample A settled by one keeper pass
  const a = await controller.buy(showA.id);
  assert.ok(a?.key, JSON.stringify(state().flows[showA.id]?.error));
  await controller.pool.request('simnet.mine', { blocks: settleOpensAt(showA) - 1 - state().chain.tip });
  await waitFor(() => state().chain.tip === settleOpensAt(showA) - 1, 'the page saw the new tip');
  await new Promise((r2) => setTimeout(r2, 300));
  assert.equal(state().keeper.length, 0, 'the page did not push a settle (switched off)');
  assert.equal(ticket(a.key).state, 'held');

  const chain = createWorkerChain({ network: 'simnet', servers: [simnet.url] });
  let report;
  try {
    report = await runKeeper({ shows: parseWorkerShows(showsText, { network: 'simnet' }).shows, chain, dataKey: hexToBin(secrets.data.privateKey), vmCheck: libauthVmCheck });
  } finally {
    chain.close();
  }
  assert.deepEqual(report.errors, []);
  assert.equal(report.sent, 1);
  const action = report.shows.find((s) => s.id === showA.id).actions[0];
  assert.equal(action.path, 'settle');
  assert.equal(action.status, 'sent');
  assert.deepEqual(action.seats, [ticket(a.key).seatHex]);
  await waitFor(() => ticket(a.key)?.state === 'refunded' && ticket(a.key).refundPath === 'settle', 'the page sees the keeper\'s settle');
  await waitFor(() => state().proof.txCounts.settle === 1, 'proof strip counts the settle');
  assert.deepEqual(state().proof.txCounts, { buy: 3, handBack: 0, checkIn: 1, settle: 1, refund: 1 });
  assert.equal(wallet.log.length, 4, 'three buys and one check-in were the only approvals');
});
