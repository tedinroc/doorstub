#!/usr/bin/env node
// npm run e2e: the judge path in a real browser, on simnet, with the real
// worker and keeper.
//
// Stage (test/e2e/stage.js): an in-process simnet; the studio's genesis on it
// (one sample A that starts a few blocks ahead, sample B, one real show
// whose door link is a test secret); the worker's Node adapter serving the
// app built in simnet mode, /shows.json and the real /api/notice and
// /api/door, with the production CSP (simnet swapped in). The sim wallet is
// funded on simnet and pairs over the PUBLIC WizardConnect relay (one retry
// on the other public relay; if both are down, a local relay, and the log
// says so). It only signs; the page broadcasts, to the simnet only.
//
// Path, each step asserted in the DOM and in the simnet's own state:
//   home -> Get a ticket (A) -> connect -> wallet joins -> buy A -> ticket
//   -> hand it back -> buy B -> the refund arrives by itself (/api/notice,
//   no second approval) -> buy the real show -> Walk in -> door link,
//   keepsake stub -> buy A again -> mine past start + grace -> one keeper
//   pass (worker/lib/keeper.js; the page's own settle push is switched off
//   for this run) -> REFUNDED -> My tickets -> proof strip counts -> a phone's
//   connect dialog -> dark mode.
// The browser runs in New York time (not this machine's zone), so the real
// show's event time is checked in the reader's own zone. The walk-in is raced by a
// front-runner that polls the real show's Escrow mempool over Fulcrum and asks
// the door the moment the check-in appears; it must get 409 while the page,
// which reserved its claim before sending the check-in, gets the link.
// Screenshots at 390x844 and 1440x900 go to .cache/e2e/screens/.
//   --home      home page only (light and dark)
//   --screens   every step at 360x740, 375x667, 390x844 and 1440x900, light and dark, into .cache/screens/
//               (plus the approve state and the empty-wallet road, which this mode stages in the page's
//               store for the screenshot only; nothing is asserted from them)
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { build } from 'vite';
import { binToHex, decodeTransaction, encodeLockingBytecodeP2pkh, hexToBin } from '@bitauth/libauth';
import { connectRpc } from '../../simnet/index.js';
import { scripthashOf } from '../../src/chain/address.js';
import { createWorkerChain } from '../../worker/lib/chain.js';
import { runKeeper } from '../../worker/lib/keeper.js';
import { parseWorkerShows, seatLabelOf } from '../../worker/lib/shows.js';
import { libauthVmCheck } from '../../worker/node/vm.js';
import { clockText } from '../../app/src/lib/view.js';
import { makeSimWallet } from '../support/sim-wallet.js';
import { startLocalRelay } from '../support/local-relay.js';
import { parseNft, walletLabel } from '../support/bcmr-parse.js';
import { REAL_SHOW, STAGE_DOOR_LINK, repoRoot, startStage } from './stage.js';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CACHE = join(repoRoot, '.cache');
const OUT = join(CACHE, 'e2e');
const SCREENS = join(OUT, 'screens');
const RUN = join(OUT, 'runs', String(Date.now()));
const allScreens = process.argv.includes('--screens');
const SIZES = allScreens
  ? [
      { name: '360', width: 360, height: 740, deviceScaleFactor: 2 },
      { name: '375', width: 375, height: 667, deviceScaleFactor: 2 },
      { name: '390', width: 390, height: 844, deviceScaleFactor: 2 },
      { name: '1440', width: 1440, height: 900, deviceScaleFactor: 1 },
    ]
  : [
      { name: '390', width: 390, height: 844, deviceScaleFactor: 2 },
      { name: '1440', width: 1440, height: 900, deviceScaleFactor: 1 },
    ];
const SCHEMES = allScreens ? ['light', 'dark'] : ['light'];
const SHOTS = allScreens ? join(CACHE, 'screens') : SCREENS;
const homeOnly = process.argv.includes('--home');
const PAIR_WAIT_MS = 45_000;
const TOKEN_SATS = 1_000;
/** The browser's time zone: not this machine's, so the page must use the reader's own zone. November: GMT-5. */
const VIEWER_ZONE = 'America/New_York';

const log = (...a) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (condition, what) => {
  if (!condition) throw new Error(`assertion failed: ${what}`);
  checks.push(what);
};
const checks = [];

/** Kill any Chrome left over from an earlier run whose profile is under this repo's .cache/. */
const killLeftoverChrome = () => {
  try {
    execFileSync('pkill', ['-f', `--user-data-dir=${CACHE}/`], { stdio: 'ignore' });
    log('killed a leftover Chrome from an earlier run');
  } catch {
    // none running
  }
};

mkdirSync(SCREENS, { recursive: true });
mkdirSync(SHOTS, { recursive: true });
mkdirSync(RUN, { recursive: true });
killLeftoverChrome();

log('building the site in simnet mode');
await build({ configFile: join(repoRoot, 'app', 'vite.config.js'), root: join(repoRoot, 'app'), mode: 'simnet', logLevel: 'warn' });

// A local relay is started up front (its URL must be in the page's CSP), but used only if both public relays fail.
const localRelay = await startLocalRelay();
const stage = await startStage({
  dir: join(RUN, 'studio'),
  root: join(CACHE, 'app-simnet'),
  csp: true,
  cspExtra: [localRelay.url],
  firstStart: '+8',
  count: 1,
});
const rpc = await connectRpc(stage.simnet.url, { clientName: 'doorstub e2e' });
/** In --screens mode the first approval waits until the page's "Approve in ..." state is photographed. */
let approvalGate = null;
const wallet = makeSimWallet({
  name: 'Sim wallet',
  approve: async () => {
    if (approvalGate !== null) await approvalGate.promise;
    return true;
  },
});
const receive = wallet.addressAt('receive', 0);
/** The wallet's first receive addresses: the app buys to the first unused one. */
const walletReceive = Array.from({ length: 20 }, (_, i) => wallet.addressAt('receive', i));
let browser;
let pairing;
let failed = false;
const consoleErrors = [];
const consoleWarnings = [];
const apiAnswers = [];

// ------------------------------------------------------------------ the simnet's own view (independent of the page)

const chainTx = async (txid) => decodeTransaction(hexToBin(await rpc.request('blockchain.transaction.get', [txid])));
const unspentAt = async (lockingBytecode) => rpc.request('blockchain.scripthash.listunspent', [scripthashOf(lockingBytecode), 'include_tokens']);
const historyAt = async (lockingBytecode) => (await rpc.request('blockchain.scripthash.get_history', [scripthashOf(lockingBytecode)])).map((h) => h.tx_hash);
const tipHeight = async () => (await rpc.request('blockchain.headers.subscribe', [])).height;
const isUnspent = async (lockingBytecode, txid, vout) => (await unspentAt(lockingBytecode)).some((u) => u.tx_hash === txid && u.tx_pos === vout);
const outpointOf = (input) => ({ txid: binToHex(input.outpointTransactionHash), vout: input.outpointIndex });
const spends = (tx, txid, vout) => tx.inputs.some((i) => binToHex(i.outpointTransactionHash) === txid && i.outpointIndex === vout);
const sameHex = (a, b) => binToHex(a) === binToHex(b);
/** Wire-order category bytes of a show (shows.json posts display order). */
const categoryOf = (show) => hexToBin(show.params.category);
const escrowLock = (show) => hexToBin(show.derived.escrowLockingBytecode);
const payeeLock = (show) => encodeLockingBytecodeP2pkh(hexToBin(show.params.organiserPkh));

/** The buy's ticket and marker, read from the chain: [seat hex, value at the escrow]. */
const checkBuyOnChain = async (show, txid, what) => {
  const tx = await chainTx(txid);
  const ticket = tx.outputs[1];
  const marker = tx.outputs[2];
  ok(ticket.token && sameHex(ticket.token.category, categoryOf(show)) && ticket.token.nft.capability === 'none', `${what}: ticket is an immutable NFT of the show's category`);
  const c = ticket.token.nft.commitment;
  const buyer = walletReceive.find((a) => sameHex(a.pkh, c.slice(4)));
  ok(c.length === 24 && c[0] === 0x54 && buyer !== undefined, `${what}: ticket commitment is 'T' | seat | a pkh of the wallet's receive addresses (24 bytes)`);
  ok(sameHex(ticket.lockingBytecode, buyer.lockingBytecode), `${what}: ticket NFT goes to that receive address (receive ${buyer.index})`);
  const seatHex = binToHex(c.slice(1, 4));
  ok(sameHex(marker.lockingBytecode, escrowLock(show)), `${what}: marker coin sits at the show's Escrow address`);
  ok(marker.token && marker.token.nft.commitment[0] === 0x45 && binToHex(marker.token.nft.commitment.slice(1, 4)) === seatHex, `${what}: marker commitment is 'E' | same seat`);
  ok(marker.valueSatoshis === BigInt(show.params.price + TOKEN_SATS), `${what}: escrow coin holds price + 1,000 sats`);
  ok(await isUnspent(escrowLock(show), txid, 2), `${what}: the escrow coin is unspent on simnet`);
  ok(await isUnspent(buyer.lockingBytecode, txid, 1), `${what}: the ticket NFT is unspent in the wallet on simnet`);
  return { seatHex, value: marker.valueSatoshis, buyer };
};

/** A spend of the escrow coin (txid:2) paying `lock`: the payout at index 0, and no token unless allowed. */
const checkSpendOnChain = async (show, buyTxid, spendTxid, { lock, minValue, keepsake = null, what }) => {
  const tx = await chainTx(spendTxid);
  ok(spends(tx, buyTxid, 2), `${what}: spends the escrow coin`);
  ok(sameHex(tx.outputs[0].lockingBytecode, lock), `${what}: output 0 pays the right address`);
  ok(tx.outputs[0].valueSatoshis >= minValue, `${what}: output 0 is at least ${minValue} sats (got ${tx.outputs[0].valueSatoshis})`);
  const tokenOutputs = tx.outputs.filter((o) => o.token !== undefined);
  if (keepsake !== null) {
    ok(tokenOutputs.length === 1 && sameHex(tx.outputs[1].lockingBytecode, keepsake), `${what}: the only token output is the keepsake back to the buyer's address`);
  } else ok(tokenOutputs.length === 0, `${what}: no output carries a token (marker burned)`);
  ok(!(await isUnspent(escrowLock(show), buyTxid, 2)), `${what}: the escrow coin is gone on simnet`);
  return tx;
};

// ------------------------------------------------------------------ the browser

const shot = async (page, name, { selector, full = false } = {}) => {
  for (const scheme of SCHEMES) {
    if (allScreens) await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
    for (const size of SIZES) {
      await page.setViewport({ width: size.width, height: size.height, deviceScaleFactor: size.deviceScaleFactor });
      await sleep(250);
      if (selector) {
        await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (el) {
            const r = el.getBoundingClientRect();
            window.scrollTo({ top: Math.max(0, window.scrollY + r.top - 76), behavior: 'instant' });
          }
        }, selector);
        await sleep(200);
      }
      await page.screenshot({ path: join(SHOTS, `${name}-${size.name}${scheme === 'dark' ? '-dark' : ''}.png`), fullPage: full });
    }
  }
  if (allScreens) await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
};

/**
 * Play a stamp's landing (the thud keyframes) again, paused every 25 ms, and read the page's width at each
 * frame; `unclipped` is the widest frame with the ticket's clip taken off (to show the check can see it).
 */
const stampLanding = (page, selector) =>
  page.evaluate((sel) => {
    const stamp = document.querySelector(sel);
    const ticket = stamp.closest('.ticket');
    const had = stamp.classList.contains('thud');
    const overflow = ticket.style.overflow; // CSSOM only: the page's CSP refuses a written style attribute
    const frames = () => {
      stamp.classList.remove('thud');
      void stamp.offsetWidth;
      stamp.classList.add('thud');
      const anim = stamp.getAnimations().find((a) => a.animationName === 'thud');
      anim.pause();
      const widths = [];
      for (let t = 0; t <= 550; t += 25) {
        anim.currentTime = t;
        widths.push(document.documentElement.scrollWidth);
      }
      anim.finish();
      return widths;
    };
    const widths = frames();
    ticket.style.overflow = 'visible';
    const unclipped = Math.max(...frames());
    ticket.style.overflow = overflow;
    if (!had) stamp.classList.remove('thud');
    return { widths, unclipped, inner: window.innerWidth };
  }, selector);

/** A DOM click (immune to the print animation moving the element under the mouse). */
const click = async (page, selector) => {
  await page.waitForSelector(selector, { timeout: 30_000 });
  await page.$eval(selector, (el) => el.click());
};

const state = (page) =>
  page.evaluate(() => {
    const s = window.__doorstub.controller.store.get();
    return JSON.parse(
      JSON.stringify(
        {
          flows: s.flows,
          wallet: { state: s.wallet.state, name: s.wallet.name, relay: s.wallet.relay, uri: s.wallet.pairing?.uri ?? null },
          keeper: s.keeper,
          proof: s.proof?.txCounts ?? null,
          tickets: s.tickets.map((t) => ({ key: `${t.showId}:${t.seatHex}`, state: t.state, kind: t.show.kind })),
        },
        (k, v) => (typeof v === 'bigint' ? v.toString() : v),
      ),
    );
  });

const waitState = async (page, fn, what, ms = 60_000) => {
  const start = Date.now();
  for (;;) {
    const s = await state(page);
    const value = fn(s);
    if (value) return value;
    const errors = Object.values(s.flows).filter((f) => f?.error).map((f) => JSON.stringify(f.error));
    if (errors.length) throw new Error(`${what}: a flow failed: ${errors.join(' | ')}`);
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
};

const domText = (page, selector) => page.$eval(selector, (el) => el.textContent.trim());

/** Pair the sim wallet with the page's current pairing link; true once the page says the wallet is connected. */
const pairWith = async (page, uri, ms = PAIR_WAIT_MS) => {
  try {
    pairing?.close();
  } catch {
    // ignore
  }
  pairing = await wallet.pairOverRelay(uri);
  try {
    await waitState(page, (s) => s.wallet.state === 'connected', 'wallet_ready', ms);
    return true;
  } catch {
    return false;
  }
};

const openPage = async (url) => {
  const page = await browser.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
    if (m.type() === 'warn' || m.type() === 'warning') consoleWarnings.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('response', async (r) => {
    const path = new URL(r.url()).pathname;
    if (!path.startsWith('/api/')) return;
    let body = null;
    try {
      body = await r.json();
    } catch {
      // not JSON
    }
    apiAnswers.push({ path, status: r.status(), body });
  });
  await page.emulateTimezone(VIEWER_ZONE);
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  // Note whether show cards were drawn from shows.json, with Get a ticket waiting, before the genesis checks passed.
  await page.evaluateOnNewDocument(() => {
    window.__sawWaiting = [];
    new MutationObserver(() => {
      for (const el of document.querySelectorAll('[data-buy-waiting]')) {
        const id = el.getAttribute('data-buy-waiting');
        if (!window.__sawWaiting.includes(id)) window.__sawWaiting.push(id);
      }
    }).observe(document, { subtree: true, childList: true, attributes: true });
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return page;
};

// Every /api/door request as the worker receives it (the stage's worker runs in this process), with whether the
// simnet already knew its txid at that moment: the page's reservation must come before its check-in is sent.
// While a front-runner races the page, the page's own ask (a claim that is not the front-runner's) waits at the
// door until the front-runner has its answers (at most 4 s), so the front-runner always asks first.
const doorLog = [];
let doorHold = null;
const watchDoor = () => {
  const { worker } = stage.server;
  const handle = worker.handle;
  worker.handle = async (request, context) => {
    if (request.method === 'POST' && new URL(request.url).pathname === '/api/door') {
      const body = await request.clone().json().catch(() => null);
      const entry = { body, known: typeof body?.txid === 'string' && stage.simnet.chain.txs.has(body.txid.toLowerCase()) };
      doorLog.push(entry);
      const hold = doorHold;
      if (hold !== null && body?.reserve !== true && typeof body?.claim === 'string' && !hold.claims.has(body.claim)) {
        entry.released = await Promise.race([hold.released.then(() => 'front-runner'), sleep(4_000).then(() => 'timeout')]);
      }
      entry.handledAt = performance.now();
    }
    return handle(request, context);
  };
};

const postDoor = async (body) => {
  const response = await fetch(`${stage.server.origin}/api/door`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) };
};
const randomClaim = () => binToHex(crypto.getRandomValues(new Uint8Array(32)));

/**
 * A front-runner: polls the real show's Escrow mempool over Fulcrum (as anyone can) and, the moment a spend of
 * the escrow coin appears, asks the door for the link twice at once, without a claim and with a claim of its own.
 */
const startFrontRunner = (show, buyTxid) => {
  const scripthash = scripthashOf(escrowLock(show));
  const claim = randomClaim();
  let release;
  const released = new Promise((r) => (release = r));
  doorHold = { claims: new Set([claim]), released };
  const seen = new Set();
  const answers = [];
  let stopped = false;
  let polls = 0;
  let error = null;
  const done = (async () => {
    while (!stopped) {
      polls += 1;
      for (const { tx_hash: txid } of await rpc.request('blockchain.scripthash.get_mempool', [scripthash])) {
        if (seen.has(txid)) continue;
        seen.add(txid);
        if (!spends(await chainTx(txid), buyTxid, 2)) continue;
        const [noClaim, ownClaim] = await Promise.all([
          postDoor({ category: show.params.category, txid }),
          postDoor({ category: show.params.category, txid, claim }),
        ]);
        answers.push({ txid, at: performance.now(), noClaim, ownClaim });
        stopped = true;
        release();
      }
      if (!stopped) await sleep(15);
    }
  })().catch((e) => {
    error = e;
    release();
  });
  return {
    answers,
    polls: () => polls,
    error: () => error,
    stop: async () => {
      stopped = true;
      await done;
      release();
      doorHold = null;
    },
  };
};

try {
  const showA = stage.shows.find((s) => s.kind === 'sample-settle');
  const showB = stage.shows.find((s) => s.kind === 'sample-refund-seat');
  const real = stage.shows.find((s) => s.kind === 'real');
  const cap = BigInt(showA.params.minerFeeCap);
  watchDoor();
  const fund = await rpc.request('simnet.fund', { address: receive.address, sats: 2_000_000, mine: true });
  ok(await isUnspent(receive.lockingBytecode, fund.txid, 0), 'the sim wallet is funded on simnet (2,000,000 sats)');
  log(`tip ${await tipHeight()}; sample A starts at ${showA.params.startHeight}, settles from ${showA.params.startHeight + showA.params.graceBlocks + 1}`);

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    userDataDir: join(RUN, 'chrome'),
    args: ['--no-first-run', '--no-default-browser-check', '--disable-features=Translate'],
  });
  const base = `${stage.server.origin}/?fulcrum=${encodeURIComponent(stage.simnet.url)}&usd=208&pagekeeper=0`;
  const t0 = Date.now();
  let page = await openPage(base);
  await page.waitForSelector(`[data-buy="${showA.id}"]`, { timeout: 30_000 });
  await page.waitForSelector(`[data-buy="${showB.id}"]`, { timeout: 30_000 });
  await page.waitForSelector(`[data-buy="${real.id}"]`, { timeout: 30_000 });
  log(`home ready in ${Date.now() - t0} ms`);
  const sawWaiting = await page.evaluate(() => window.__sawWaiting);
  ok([showA.id, showB.id, real.id].every((id) => sawWaiting.includes(id)), `the cards were drawn from shows.json first, Get a ticket waiting for the genesis check (${sawWaiting.join(', ')})`);
  ok((await domText(page, `[data-show="${real.id}"]`)).includes(real.card), 'the real show card shows its card text from shows.json');
  // The real show's call, as shows.json posts it (CONTRACT: eventAt, durationMin, seatPrefix), in the reader's own zone.
  ok(real.eventAt === REAL_SHOW.eventAt && real.durationMin === 25 && real.seatPrefix === 'S', `shows.json: the real show names its event (${real.eventAt}), 25 minutes and seat letter S`);
  const callMs = Date.parse(real.eventAt);
  const callClock = clockText(new Date(callMs), { timeZone: VIEWER_ZONE });
  const newYork = new Intl.DateTimeFormat('en-GB', { timeZone: VIEWER_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(callMs);
  const callRow = await domText(page, `[data-show="${real.id}"] [data-fact="call"] dd`);
  ok(callRow.includes(`, ${newYork} GMT\u20115`), `the real card's Event row is in the browser's zone, named (New York: ${newYork} GMT-5): "${callRow}"`);
  ok(callRow.startsWith(`${callClock} (in `) && callRow.endsWith('), for 25 minutes.'), 'the Event row reads "<time> (in ...), for 25 minutes."');
  ok((await domText(page, `[data-show="${real.id}"] .subtitle`)) === 'Online, 25 minutes', 'the real card\'s subtitle is "Online, 25 minutes" (no times)');
  ok((await page.$(`[data-show="${showA.id}"] .subtitle`)) === null && (await page.$(`[data-show="${showB.id}"] .subtitle`)) === null, 'the sample cards have no subtitle');
  // The worker's data key signs sample B's notices only; the real show's notices need the studio's second data key.
  const health = await (await fetch(`${stage.server.origin}/api/health`)).json();
  ok(Array.isArray(health.signer?.alsoKeyOf) && health.signer.alsoKeyOf.length === 0, '/api/health: the worker\'s data key is no real show\'s key (alsoKeyOf [])');
  ok(health.signer.shows.length === 1 && health.signer.shows[0].keyMatches === true, '/api/health: the worker\'s data key is sample B\'s');
  ok(real.params.organiserDataPk === stage.secrets.realData.publicKey && real.params.organiserDataPk !== stage.secrets.data.publicKey, 'the real show\'s organiserDataPk is the studio\'s realData key, not the worker\'s data key');
  ok(health.door?.shows?.some((d) => d.id === real.id && d.configured === true) && health.door.record === 'memory', '/api/health: the real show\'s door is configured; the Node adapter keeps the door record in memory');
  await sleep(600);
  // The judge reaches "Get a ticket" in the first phone screen, and nothing scrolls sideways.
  // 375x667 is an iPhone SE: with Safari's bars about 560 px of it show the page.
  for (const [width, height, fold] of [[360, 740, 600], [375, 667, 560], [390, 844, 700]]) {
    await page.setViewport({ width, height, deviceScaleFactor: 2 });
    await sleep(200);
    const m = await page.evaluate(() => ({
      buy: document.querySelector('[data-buy]').getBoundingClientRect().bottom,
      scroll: document.documentElement.scrollWidth,
      inner: window.innerWidth,
    }));
    log(`${width}x${height}: first "Get a ticket" ends at ${Math.round(m.buy)} px; page ${m.scroll} px wide`);
    ok(m.scroll <= m.inner, `no horizontal scroll at ${width} px`);
    ok(m.buy <= fold, `"Get a ticket" inside the first phone screen at ${width}x${height} (ends by ${fold} px)`);
  }
  // A real show's card: its start block reads as the end of sales and walk-in; a sample keeps "Starts".
  ok((await domText(page, `[data-show="${real.id}"] [data-fact="start"]`)).startsWith('DoorBuy and walk in until the event ends,'), 'the real show\'s Door row reads "Buy and walk in until the event ends, ..."');
  ok((await domText(page, `[data-show="${showA.id}"] [data-fact="start"]`)).startsWith('StartsBlock'), 'a sample show\'s start row reads "Starts"');
  // The required BLAZE banner links the source repository; Check it yourself links the contracts and the one-page architecture.
  ok((await page.$eval('.blaze a[href="https://github.com/tedinroc/doorstub"]', (el) => el.textContent)) === 'Source code', 'the banner links the source repository');
  const sourceLinks = await page.$$eval('[data-source-file]', (els) => els.map((el) => el.getAttribute('href')));
  ok(['contracts/BoxOffice.cash', 'contracts/Escrow.cash', 'ARCHITECTURE.md', 'CLAIMS.md'].every((f) => sourceLinks.includes(`https://github.com/tedinroc/doorstub/blob/main/${f}`)), 'Check it yourself links both contracts, ARCHITECTURE.md and CLAIMS.md');
  ok((await page.$$('#check .verify .row .ok')).length === 3, 'Check it yourself ticks only the two recomputed addresses and the verified genesis');
  ok((await domText(page, '#organisers')).includes('Plan, not built yet'), 'For organisers marks the revenue plan as a plan');
  await shot(page, '01-home');
  await shot(page, '01-home-full', { full: true });
  if (homeOnly) {
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await shot(page, '01-home-dark');
    await shot(page, '01-home-dark-full', { full: true });
    throw Object.assign(new Error('home only'), { done: true });
  }

  // ---------------------------------------------------------------- connect: public relay, one retry, then a local relay
  if (allScreens) {
    let release;
    approvalGate = { promise: new Promise((r) => (release = r)), release };
  }
  await click(page, `[data-buy="${showA.id}"]`);
  await page.waitForFunction(() => document.querySelector('[data-wiz-uri]')?.value?.startsWith('wiz://'), { timeout: 30_000 });
  await page.waitForSelector('[data-qr] svg', { timeout: 10_000 });
  ok((await page.$eval('[data-open-selene]', (el) => el.getAttribute('href'))).startsWith('wiz://'), 'Open Selene is a raw wiz:// link');
  await shot(page, '02-connect');
  const tPair = Date.now();
  let relayUsed = 'public relay 1';
  let paired = await pairWith(page, await page.$eval('[data-wiz-uri]', (el) => el.value));
  if (!paired) {
    log('the first public relay did not pair within 45 s; one retry on the other public relay');
    relayUsed = 'public relay 2';
    await page.evaluate(() => window.__doorstub.controller.connect({ relay: 1 }));
    const uri2 = await waitState(page, (s) => s.wallet.relay === 1 && s.wallet.uri, 'the second pairing link', 15_000);
    paired = await pairWith(page, uri2);
  }
  if (!paired) {
    log('PUBLIC RELAYS DOWN: both public WizardConnect relays failed; pairing over the local relay instead');
    relayUsed = 'LOCAL relay (public relays down)';
    await page.close();
    page = await openPage(`${base}&relay=${encodeURIComponent(localRelay.url)}`);
    await click(page, `[data-buy="${showA.id}"]`);
    await page.waitForFunction(() => document.querySelector('[data-wiz-uri]')?.value?.startsWith('wiz://'), { timeout: 30_000 });
    paired = await pairWith(page, await page.$eval('[data-wiz-uri]', (el) => el.value));
    if (!paired) throw new Error('the wallet did not pair even over the local relay');
  }
  log(`wallet connected over ${relayUsed} in ${Date.now() - tPair} ms`);
  if (approvalGate !== null) {
    await waitState(page, (s) => s.flows[showA.id]?.step === 'approve', 'the approve state', 60_000);
    await sleep(500);
    await shot(page, '02b-approve', { selector: `[data-show="${showA.id}"]` });
    approvalGate.release();
    approvalGate = null;
  }
  ok((await domText(page, '[data-wallet-chip]')).length > 0, 'the header shows the connected wallet chip');

  // ---------------------------------------------------------------- buy A (continues by itself after pairing)
  const keyA = await waitState(page, (s) => s.flows[showA.id]?.step === 'done' && s.flows[showA.id].ticketKey, 'buy A', 90_000);
  const buyA = (await state(page)).flows[showA.id].txid;
  log(`bought A (${keyA}) ${Math.round((Date.now() - t0) / 1000)} s after the page opened; prompt: ${wallet.log.at(-1).userPrompt}`);
  ok(/^Doorstub: buy seat A-\d-1 for 0\.001 BCH\. The money waits in the show's contract\.$/.test(wallet.log.at(-1).userPrompt), 'buy prompt is the CLAIMS.md section 7 wording');
  await page.waitForSelector(`[data-ticket="${keyA}"][data-state="held"]`);
  const a1 = await checkBuyOnChain(showA, buyA, 'buy A');
  ok(keyA === `${showA.id}:${a1.seatHex}`, 'the ticket card is for the seat the chain shows');
  await sleep(1300);
  await shot(page, '03-ticket-a', { selector: `[data-show="${showA.id}"]` });

  // ---------------------------------------------------------------- hand it back
  await click(page, `[data-hand-back="${keyA}"]`);
  await waitState(page, (s) => s.flows[keyA]?.step === 'done', 'hand back', 60_000);
  await page.waitForSelector(`[data-ticket="${keyA}"][data-state="handedBack"]`, { timeout: 30_000 });
  const handBackTxid = (await state(page)).flows[keyA].txid;
  log(`handed back; prompt: ${wallet.log.at(-1).userPrompt}`);
  ok(/^Doorstub: hand back seat A-\d-1\. 0\.\d+ BCH comes back to this wallet\.$/.test(wallet.log.at(-1).userPrompt), 'hand-back prompt is the CLAIMS.md section 7 wording');
  const hb = await checkSpendOnChain(showA, buyA, handBackTxid, { lock: a1.buyer.lockingBytecode, minValue: a1.value - cap, what: 'hand back' });
  ok(spends(hb, buyA, 1), 'hand back: also spends (burns) the ticket NFT');
  ok(!(await isUnspent(a1.buyer.lockingBytecode, buyA, 1)), 'hand back: the ticket NFT left the wallet on simnet');
  await sleep(1500);
  ok((await domText(page, `[data-ticket="${keyA}"] .stamp`)) === 'HANDED BACK', 'ticket card stamped HANDED BACK');
  const landing = await stampLanding(page, `[data-ticket="${keyA}"] .stamp`);
  log(`HANDED BACK landing at ${landing.inner} px: page ${Math.max(...landing.widths)} px wide at most (${landing.unclipped} px without the ticket's clip)`);
  ok(landing.inner === 390 && landing.widths.every((w) => w <= landing.inner), `the stamp landing never widens the page at 390 px (iOS Safari would zoom the whole page out): ${landing.widths.join(' ')}`);
  await shot(page, '04-handed-back', { selector: `[data-show="${showA.id}"]` });

  // ---------------------------------------------------------------- sample B: the refund arrives with no second approval
  const approvals = wallet.log.length;
  // Record when each refund step reaches the page (the store, not the poll), to check every step stays readable.
  // (The store changes before the page renders, so `stamped` says whether the card showed a stamp up to that change.)
  await page.evaluate((showId) => {
    window.__refundSteps = [];
    window.__doorstub.controller.store.subscribe((s) => {
      for (const f of Object.values(s.flows)) {
        if (f?.kind !== 'refund') continue;
        const last = window.__refundSteps.at(-1);
        if (last?.step !== f.step) window.__refundSteps.push({ step: f.step, at: performance.now(), stamped: document.querySelector(`[data-ticket^="${showId}:"] .stamp`) !== null });
      }
    });
  }, showB.id);
  await click(page, `[data-buy="${showB.id}"]`);
  const keyB = await waitState(page, (s) => s.flows[showB.id]?.step === 'done' && s.flows[showB.id].ticketKey, 'buy B', 60_000);
  const buyB = (await state(page)).flows[showB.id].txid;
  const b = await checkBuyOnChain(showB, buyB, 'buy B');
  // The judge sees the organiser's notice step on its own (screenshot at the phone size, while it is the active step).
  await waitState(page, (s) => s.flows[keyB]?.step === 'notice' && s.flows[keyB], 'B notice step', 30_000);
  await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: 'center', behavior: 'instant' }), `[data-ticket="${keyB}"]`);
  ok((await domText(page, `[data-ticket="${keyB}"] .track .step.active`)) === 'Organiser refund notice', 'B: the "Organiser refund notice" step is the active one on its own');
  ok((await page.$(`[data-ticket="${keyB}"] .stamp`)) === null, 'B: no REFUNDED stamp during the notice step');
  await page.screenshot({ path: join(SHOTS, '05-b-notice-390.png') });
  await waitState(page, (s) => s.flows[keyB]?.step === 'sent' && s.flows[keyB], 'B sent step', 30_000);
  ok((await domText(page, `[data-ticket="${keyB}"] .track .step.active`)) === 'Refund sent', 'B: "Refund sent" is shown as the active step');
  await page.screenshot({ path: join(SHOTS, '05b-b-sent-390.png') });
  // The page's width on every frame while REFUNDED lands (the stamp, the coin flying to the wallet chip, the chip's pulse).
  await page.evaluate(() => {
    window.__widest = 0;
    const frame = () => {
      window.__widest = Math.max(window.__widest, document.documentElement.scrollWidth);
      if (window.__widestStop !== true) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  await waitState(page, (s) => s.flows[keyB]?.step === 'back', 'B refund sequence', 60_000);
  const steps = await page.evaluate(() => window.__refundSteps);
  const at = Object.fromEntries(steps.map((x) => [x.step, x]));
  const spans = { held: at.notice.at - at.held.at, notice: at.sent.at - at.notice.at, sent: at.back.at - at.sent.at };
  log(`B refund steps: ${Object.entries(spans).map(([k, v]) => `${k} ${Math.round(v)} ms`).join(', ')}; held to money back ${Math.round(at.back.at - at.held.at)} ms`);
  ok(['held', 'notice', 'sent', 'back'].every((k) => at[k] !== undefined), 'B: the four refund steps came in order');
  ok(Object.values(spans).every((v) => v >= 1_150), `B: every step stays on screen at least about 1.2 s (${JSON.stringify(spans)})`);
  ok(at.back.at - at.held.at <= 7_500, 'B: from "Ticket held" to "Money back" in under about 7 s');
  ok(!at.held.stamped && !at.notice.stamped && !at.sent.stamped && !at.back.stamped, 'B: the REFUNDED stamp comes only with "Money back"');
  await page.waitForSelector(`[data-ticket="${keyB}"][data-state="refunded"]`, { timeout: 30_000 });
  const refundTxid = (await state(page)).flows[keyB].txid;
  ok(wallet.log.length === approvals + 1, 'B: the wallet was asked once (the buy), never for the refund');
  const notice = apiAnswers.find((a) => a.path === '/api/notice' && a.status === 200);
  ok(notice !== undefined && /^[0-9a-f]+$/.test(notice.body.signature) && notice.body.scope === 'R' && notice.body.seat === b.seatHex, 'B: the worker signed an R notice for this seat (/api/notice 200)');
  await checkSpendOnChain(showB, buyB, refundTxid, { lock: b.buyer.lockingBytecode, minValue: b.value - cap, what: 'B refund' });
  ok(await isUnspent(b.buyer.lockingBytecode, buyB, 1), 'B refund: the ticket NFT stays in the wallet (refunded, not burned)');
  await sleep(1500);
  ok((await domText(page, `[data-ticket="${keyB}"] .stamp`)) === 'REFUNDED', 'B ticket card stamped REFUNDED');
  const widest = await page.evaluate(() => {
    window.__widestStop = true;
    return { max: window.__widest, inner: window.innerWidth };
  });
  ok(widest.inner === 390 && widest.max <= widest.inner, `B: while REFUNDED lands (stamp, coin flight, chip pulse) the page is never wider than the screen (${widest.max} px at ${widest.inner} px)`);
  log('B refunded by itself');
  await shot(page, '06-b-refunded', { selector: `[data-ticket="${keyB}"]` });

  // ---------------------------------------------------------------- the real show: buy, walk in, the door answers
  await click(page, `[data-buy="${real.id}"]`);
  const keyR = await waitState(page, (s) => s.flows[real.id]?.step === 'done' && s.flows[real.id].ticketKey, 'buy real', 60_000);
  const buyR = (await state(page)).flows[real.id].txid;
  const r = await checkBuyOnChain(real, buyR, 'buy real');
  await page.waitForSelector(`[data-walk-in="${keyR}"]`, { timeout: 30_000 });
  await sleep(1300);
  const labelR = await domText(page, `[data-ticket="${keyR}"] .seat`);
  ok(/^S-\d-1$/.test(labelR), `the real ticket's seat label uses the show's letter S (${labelR})`);
  const callBox = `[data-ticket="${keyR}"] .countdown.call`;
  ok((await domText(page, `${callBox} .cd-l`)) === 'Event starts in', 'a held real ticket counts down to the event ("Event starts in")');
  ok((await domText(page, `${callBox} > p`)) === `The event starts ${callClock}, for 25 minutes.`, 'under the event countdown: "The event starts <time in the reader\'s zone>, for 25 minutes."');
  // A wallet reading the show's BCMR (the registry the studio's genesis wrote) gets the same label.
  const registry = JSON.parse(readFileSync(join(dirname(stage.boot.showsPath), 'bcmr', `${real.params.category}.json`), 'utf8'));
  const parsedR = parseNft(registry, real.params.category, (await chainTx(buyR)).outputs[1].token.nft.commitment, r.buyer.pkh);
  ok(walletLabel(parsedR.decoded) === labelR, `the BCMR NFT parse of this ticket gives the page's label (${walletLabel(parsedR.decoded)})`);
  await shot(page, '07-real-held', { selector: `[data-ticket="${keyR}"]` });
  const doorFrom = doorLog.length;
  const answersFrom = apiAnswers.length;
  const frontRunner = startFrontRunner(real, buyR);
  await click(page, `[data-walk-in="${keyR}"]`);
  try {
    await waitState(page, (s) => s.flows[keyR]?.link || s.flows[keyR]?.doorError, 'door answer', 60_000);
  } finally {
    await frontRunner.stop();
  }
  const doorFlow = (await state(page)).flows[keyR];
  ok(typeof doorFlow.link === 'string', `the door answered: ${JSON.stringify(doorFlow.doorError ?? null)}`);
  ok(/^Doorstub: walk in with seat S-\d-1\. This pays the organiser 0\.\d+ BCH; your ticket stays as a keepsake\.$/.test(wallet.log.at(-1).userPrompt), 'check-in prompt is the CLAIMS.md section 7 wording');
  ok(wallet.log.at(-1).userPrompt.includes(`seat ${labelR}.`), 'the check-in prompt names the seat label the page shows');
  const checkInTxid = doorFlow.txid;
  // The page reserved its claim with the check-in's txid before it sent the check-in, then asked with the same claim.
  const pageClaim = await page.evaluate((txid) => JSON.parse(localStorage.getItem(`doorstub.door.${txid}`)).claim, checkInTxid);
  const pageDoor = doorLog.slice(doorFrom).filter((d) => d.body?.claim === pageClaim);
  ok(pageDoor[0]?.body?.reserve === true && pageDoor[0].body.txid === checkInTxid, 'the page\'s first door call is a reservation for this check-in\'s txid, with its claim');
  ok(pageDoor[0].known === false, 'the reservation reached the door before the check-in reached the network (simnet did not know the txid yet)');
  ok(pageDoor.length === 2 && pageDoor[1].body.reserve === undefined && pageDoor[1].body.txid === checkInTxid && pageDoor[1].known === true, 'then, after sending the check-in, the page asked once with the same claim');
  const reserveAnswer = apiAnswers.slice(answersFrom).find((a) => a.path === '/api/door');
  ok(reserveAnswer?.status === 200 && JSON.stringify(reserveAnswer.body) === '{"reserved":true,"again":false}', `the door answered the reservation 200 { reserved: true, again: false } (${JSON.stringify(reserveAnswer)})`);
  ok(!apiAnswers.some((a) => a.path === '/api/door' && a.status === 404) && !consoleWarnings.some((w) => /door reservation failed/.test(w)), 'no door 404 and no failed reservation in the console');
  // The front-runner saw the check-in in the Escrow mempool and asked before the page; the door refused it both ways.
  const [raced] = frontRunner.answers;
  ok(frontRunner.error() === null && raced?.txid === checkInTxid, `the front-runner saw the check-in in the Escrow mempool (${frontRunner.polls()} polls; ${frontRunner.error() ?? 'no error'})`);
  ok(pageDoor[1].released === 'front-runner' && raced.at < pageDoor[1].handledAt, 'the front-runner\'s asks reached the door before the page\'s ask');
  ok(raced.noClaim.status === 409 && raced.noClaim.body?.error?.code === 'already-answered', `front-runner without a claim: 409 already-answered (${raced.noClaim.status})`);
  ok(raced.ownClaim.status === 409 && raced.ownClaim.body?.error?.code === 'already-answered', `front-runner with its own claim: 409 already-answered (${raced.ownClaim.status})`);
  ok(!JSON.stringify(raced).includes('example.org'), 'the front-runner never saw the link');
  log(`front-runner: saw the check-in after ${frontRunner.polls()} mempool polls, asked twice, got 409 twice; then the page's ask got the link`);
  await checkSpendOnChain(real, buyR, checkInTxid, { lock: payeeLock(real), minValue: r.value - cap, keepsake: r.buyer.lockingBytecode, what: 'check-in' });
  const keepsake = (await unspentAt(r.buyer.lockingBytecode)).find((u) => u.tx_hash === checkInTxid && u.tx_pos === 1);
  ok(keepsake?.token_data?.nft?.commitment?.startsWith(`54${r.seatHex}`), 'check-in: the keepsake stub (same ticket commitment) is unspent in the wallet');
  const workerShow = parseWorkerShows(readFileSync(stage.boot.showsPath, 'utf8'), { network: 'simnet' }).shows.find((s) => s.id === real.id);
  const expectedLink = STAGE_DOOR_LINK.replace('{seat}', encodeURIComponent(seatLabelOf(workerShow, hexToBin(r.seatHex))));
  ok(doorFlow.link === expectedLink, `the door link is the show's secret link for this seat (${doorFlow.link})`);
  await page.waitForSelector(`[data-ticket="${keyR}"] [data-door-link]`, { timeout: 10_000 });
  ok((await page.$eval(`[data-ticket="${keyR}"] [data-door-link]`, (el) => el.href)) === expectedLink, 'the page shows the door link');
  await page.waitForSelector(`[data-ticket="${keyR}"][data-state="walkedIn"]`, { timeout: 30_000 });
  // One claimant per check-in: someone who only knows the txid is refused; the page's own claim gets the link again.
  const observer = await fetch(`${stage.server.origin}/api/door`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ category: real.params.category, txid: checkInTxid }) });
  ok(observer.status === 409, `the door refuses a caller without the page's claim (${observer.status})`);
  const claim = await page.evaluate((txid) => JSON.parse(localStorage.getItem(`doorstub.door.${txid}`)).claim, checkInTxid);
  const again = await (await fetch(`${stage.server.origin}/api/door`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ category: real.params.category, txid: checkInTxid, claim }) })).json();
  ok(again.again === true && again.link === expectedLink, 'the page\'s claim gets the same link again');
  const lateReserve = await postDoor({ category: real.params.category, txid: checkInTxid, claim: randomClaim(), reserve: true });
  ok(lateReserve.status === 409 && lateReserve.body?.error?.code === 'already-answered', `a third party reserving this check-in with another claim gets 409 already-answered (${lateReserve.status})`);
  ok(seatLabelOf(workerShow, hexToBin(r.seatHex)) === labelR && doorFlow.link.includes(`seat=${labelR}`), 'the worker labels the seat as the page does (S-x-y), and the link carries it');
  log(`walked in; door link ${doorFlow.link}`);
  await sleep(1500);
  ok((await domText(page, `[data-ticket="${keyR}"] .stamp`)) === 'WALKED IN', 'real ticket card stamped WALKED IN');
  const walkedLines = await page.$$eval(`[data-ticket="${keyR}"] .lines p`, (els) => els.map((el) => el.textContent.trim()));
  ok(walkedLines.some((l) => l.startsWith(`The event starts ${callClock} (in `) && l.endsWith(').')), `the walked-in ticket says when the event starts, in the reader's zone (${walkedLines.join(' | ')})`);
  await shot(page, '08-walked-in', { selector: `[data-ticket="${keyR}"]` });

  // ---------------------------------------------------------------- a second A ticket, then the cron keeper settles it
  await click(page, `[data-buy="${showA.id}"]`);
  const keyA2 = await waitState(page, (s) => s.flows[showA.id]?.step === 'done' && s.flows[showA.id].ticketKey !== keyA && s.flows[showA.id].ticketKey, 'second buy A', 60_000);
  const buyA2 = (await state(page)).flows[showA.id].txid;
  const a2 = await checkBuyOnChain(showA, buyA2, 'second buy A');
  await page.waitForSelector(`[data-ticket="${keyA2}"][data-state="held"]`, { timeout: 30_000 });
  await sleep(1000);
  await shot(page, '09-a2-held', { selector: `[data-ticket="${keyA2}"]` });
  const settleLocktime = showA.params.startHeight + showA.params.graceBlocks;
  const mined = await rpc.request('simnet.mine', { blocks: settleLocktime - (await tipHeight()) });
  ok(mined.height === settleLocktime, `mined to block ${settleLocktime} (start + grace); settling opens at the next block`);
  await page.waitForSelector(`[data-sales-ended="${showA.id}"]`, { timeout: 30_000 });
  ok((await page.$(`[data-buy="${showA.id}"]`)) === null, 'after the start, sample A offers no "Get a ticket"');
  ok((await page.$(`[data-show="${showA.id}"] [data-ticket="${keyA2}"][data-state="held"]`)) !== null, 'after the start, the held ticket stays on its show card (it does not vanish)');
  ok((await domText(page, `[data-sales-ended="${showA.id}"]`)) === `Sales for this show ended at block ${showA.params.startHeight.toLocaleString('en-US')}.`, 'the card says sales ended, in the CLAIMS.md 9.1 wording');
  await sleep(2500);
  ok((await state(page)).keeper.length === 0 && (await isUnspent(escrowLock(showA), buyA2, 2)), 'the page did not push the settle (switched off for this run): the coin waits for the keeper');
  const { shows: keeperShows } = parseWorkerShows(readFileSync(stage.boot.showsPath, 'utf8'), { network: 'simnet' });
  const chain = createWorkerChain({ network: 'simnet', servers: [stage.simnet.url] });
  let report;
  try {
    report = await runKeeper({ shows: keeperShows, chain, dataKey: hexToBin(stage.env.STUDIO_DATA_KEY), vmCheck: libauthVmCheck });
  } finally {
    chain.close();
  }
  const settled = report.shows.find((s) => s.id === showA.id)?.actions.find((a) => a.path === 'settle');
  ok(report.errors.length === 0, `keeper pass without errors (${JSON.stringify(report.errors)})`);
  ok(settled?.status === 'sent' && settled.seats.includes(a2.seatHex), `the keeper sent the settle for seat ${a2.seatHex}`);
  ok(report.sent === 1, 'the keeper sent exactly one transaction (nothing else was due)');
  log(`keeper pass: ${report.sent} sent; settle ${settled.txid}`);
  const st = await checkSpendOnChain(showA, buyA2, settled.txid, { lock: a2.buyer.lockingBytecode, minValue: a2.value - cap, what: 'keeper settle' });
  ok(st.locktime === settleLocktime, 'keeper settle: locktime is start + grace');
  ok(await isUnspent(a2.buyer.lockingBytecode, buyA2, 1), 'keeper settle: the ticket NFT stays in the wallet');
  await page.waitForSelector(`[data-ticket="${keyA2}"][data-state="refunded"]`, { timeout: 60_000 });
  await sleep(1500);
  ok((await domText(page, `[data-ticket="${keyA2}"] .stamp`)) === 'REFUNDED', 'second A ticket card stamped REFUNDED');
  await shot(page, '10-a2-refunded', { selector: `[data-ticket="${keyA2}"]` });

  // ---------------------------------------------------------------- proof strip: the page's counts equal the chain's
  const buys = [buyA, buyB, buyR, buyA2];
  const expected = { buy: 4, handBack: 1, checkIn: 1, settle: 1, refund: 1 };
  const histories = new Set([...(await historyAt(escrowLock(showA))), ...(await historyAt(escrowLock(showB))), ...(await historyAt(escrowLock(real)))]);
  const ours = new Set([...buys, handBackTxid, refundTxid, checkInTxid, settled.txid]);
  ok(histories.size === 8 && [...ours].every((t) => histories.has(t)), 'the three Escrow addresses hold exactly the 8 transactions of this run');
  await page.waitForFunction(
    (want) => Object.entries(want).every(([p, n]) => document.querySelector(`[data-proof="${p}"] .n`)?.textContent.trim() === String(n)),
    { timeout: 30_000 },
    expected,
  );
  ok(true, `proof strip shows ${JSON.stringify(expected)}`);
  await shot(page, '11-proof', { selector: '#proof' });

  // ---------------------------------------------------------------- My tickets
  await click(page, '[data-wallet-chip]');
  await page.waitForSelector('.drawer .list');
  const want = { [keyA]: ['handedBack', 'HANDED BACK'], [keyB]: ['refunded', 'REFUNDED'], [keyR]: ['walkedIn', 'WALKED IN'], [keyA2]: ['refunded', 'REFUNDED'] };
  for (const [key, [st2, stamp]] of Object.entries(want)) {
    await page.waitForSelector(`.drawer [data-ticket="${key}"][data-state="${st2}"]`, { timeout: 30_000 });
    ok((await domText(page, `.drawer [data-ticket="${key}"] .stamp`)) === stamp, `My tickets: ${key} is ${stamp}`);
  }
  await sleep(900);
  await shot(page, '12-my-tickets');
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.querySelector('.drawer .head button')?.click());
  await shot(page, '13-full', { full: true });

  // ---------------------------------------------------------------- a reload keeps the finished tickets under their cards
  await page.reload({ waitUntil: 'domcontentloaded' });
  for (const [show, key] of [[showA, keyA], [showB, keyB], [real, keyR]]) {
    await page.waitForSelector(`[data-show="${show.id}"] [data-ticket="${key}"]`, { timeout: 30_000 });
  }
  ok(true, 'after a reload the handed-back, refunded and walked-in tickets are still under their show cards');

  // ---------------------------------------------------------------- a phone opening the connect dialog (fresh context: no remembered pairing)
  const phoneContext = await browser.createBrowserContext();
  try {
    const phone = await phoneContext.newPage();
    await phone.emulate({
      viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    });
    await phone.goto(base, { waitUntil: 'domcontentloaded' });
    await phone.waitForSelector('[data-connect]', { timeout: 30_000 });
    await click(phone, '[data-connect]');
    await phone.waitForFunction(() => document.querySelector('[data-wiz-uri]')?.value?.startsWith('wiz://'), { timeout: 30_000 });
    ok(await phone.$eval('[data-open-selene]', (el) => el.classList.contains('block') && !el.classList.contains('quiet')), 'on a phone, Open Selene is the main button');
    await sleep(500);
    await phone.screenshot({ path: join(SHOTS, '14-connect-phone-390.png') });
    await phone.close();
  } finally {
    await phoneContext.close();
  }

  if (allScreens) {
    // Staged for the screenshots only: the empty-wallet road on sample B's card (the controller test drives it for real).
    await page.evaluate((address, id) => {
      const store = window.__doorstub.controller.store;
      const next = { id };
      store.set((st) => ({
        flows: {
          ...st.flows,
          [next.id]: { kind: 'buy', step: 'preparing', at: Date.now(), error: { key: 'needMore', vars: { need: '0.00102932 BCH', have: '0 BCH' }, actions: ['retry'], fund: { address, amount: '0.0011', uri: `${address}?amount=0.0011` } } },
        },
      }));
      window.__stagedFund = next.id;
    }, walletReceive[9].address, showB.id);
    await sleep(400);
    await shot(page, '16-empty-wallet', { selector: '[data-fund]' });
    await page.evaluate(() => window.__doorstub.controller.dismiss(window.__stagedFund));
    // The connect dialog opened by "Get a ticket" (it names the show and the price).
    await page.evaluate((id) => {
      const store = window.__doorstub.controller.store;
      const next = { id };
      store.set({ pendingBuy: next.id, connectOpen: true, wallet: { ...store.get().wallet, pairing: { uri: 'wiz://staged', qrUri: 'WIZ://STAGED', selene: 'wiz://staged', cashonize: 'https://cashonize.com/?uri=staged', copy: 'wiz://staged' } } });
    }, showB.id);
    await sleep(500);
    await shot(page, '17-connect-next');
    await page.evaluate(() => window.__doorstub.controller.store.set({ pendingBuy: null, connectOpen: false }));
    await sleep(300);
  }

  // ---------------------------------------------------------------- dark mode
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, '15-dark');
  await shot(page, '15-dark-full', { full: true });

  const csp = consoleErrors.filter((e) => /Content Security Policy|Refused to/.test(e));
  ok(csp.length === 0, `no CSP violations (${csp.slice(0, 3).join(' | ')})`);
  const other = consoleErrors.filter((e) => !/favicon|ERR_NAME_NOT_RESOLVED|status of 409/.test(e) && !csp.includes(e));
  if (other.length > 0) log('console errors (not failing):', other.slice(0, 10));
  log(`PASS: judge path on simnet with the real worker and keeper (${checks.length} checks; wallet paired over ${relayUsed}); screenshots in .cache/e2e/screens/`);
} catch (e) {
  if (e.done) {
    log('home screenshots in .cache/e2e/screens/');
  } else {
    failed = true;
    console.error('E2E FAILED:', e);
    console.error(`passed ${checks.length} checks before the failure; last: ${checks.at(-1)}`);
    try {
      const pages = await browser?.pages();
      const page = pages?.at(-1);
      if (page) await page.screenshot({ path: join(SCREENS, 'failure.png'), fullPage: true });
    } catch {
      // ignore
    }
    if (consoleErrors.length) console.error('console errors:', consoleErrors.slice(0, 20));
    console.error('api answers:', JSON.stringify(apiAnswers.slice(-10)));
  }
} finally {
  try {
    pairing?.close();
  } catch {
    // ignore
  }
  await browser?.close().catch(() => {});
  killLeftoverChrome();
  rpc.close();
  await stage.close();
  await localRelay.close();
  rmSync(join(RUN, 'chrome'), { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
