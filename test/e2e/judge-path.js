#!/usr/bin/env node
// npm run e2e: the judge path in a real browser, on simnet.
//
// Builds the site in simnet mode, serves it with the production CSP (simnet
// swapped in for the mainnet servers) next to the stub worker, and drives
// headless Chrome through it while the sim wallet pairs over the PUBLIC
// WizardConnect relay and signs (it never broadcasts; the page does, to the
// simnet only):
//   home -> Get a ticket (A) -> connect dialog -> wallet joins -> buy -> ticket
//   -> hand it back -> buy B -> the refund arrives by itself -> walk in at the
//   real show -> door link -> a second A ticket -> mine past its grace -> the
//   page settles it -> My tickets -> proof strip.
// Screenshots at 390x844 and 1440x900 go to .cache/screens/.
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { build } from 'vite';
import { connectRpc } from '../../simnet/index.js';
import { makeSimWallet } from '../support/sim-wallet.js';
import { repoRoot, startStage } from './stage.js';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SCREENS = join(repoRoot, '.cache', 'screens');
const RUN = join(repoRoot, '.cache', 'e2e', String(Date.now()));
const SIZES = [
  { name: '390', width: 390, height: 844, deviceScaleFactor: 2 },
  { name: '1440', width: 1440, height: 900, deviceScaleFactor: 1 },
];
const only = process.argv.includes('--quick');
const homeOnly = process.argv.includes('--home');

const log = (...a) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(SCREENS, { recursive: true });
mkdirSync(RUN, { recursive: true });

log('building the site in simnet mode');
await build({ configFile: join(repoRoot, 'app', 'vite.config.js'), root: join(repoRoot, 'app'), mode: 'simnet', logLevel: 'warn' });

const stage = await startStage({ dir: join(RUN, 'studio'), root: join(repoRoot, '.cache', 'app-simnet'), csp: true });
const rpc = await connectRpc(stage.simnet.url, { clientName: 'doorstub e2e' });
const wallet = makeSimWallet({ name: 'Sim wallet' });
let browser;
let pairing;
let failed = false;
const consoleErrors = [];

const shot = async (page, name, { selector, full = false } = {}) => {
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
    await page.screenshot({ path: join(SCREENS, `${name}-${size.name}.png`), fullPage: full });
  }
  await page.setViewport({ width: SIZES[0].width, height: SIZES[0].height, deviceScaleFactor: 2 });
};

/** A DOM click (immune to the print animation moving the element under the mouse). */
const click = async (page, selector) => {
  await page.waitForSelector(selector, { timeout: 30_000 });
  await page.$eval(selector, (el) => el.click());
};

const state = (page) => page.evaluate(() => {
  const s = window.__doorstub.controller.store.get();
  return JSON.parse(JSON.stringify({ flows: s.flows, wallet: { state: s.wallet.state, name: s.wallet.name }, keeper: s.keeper, proof: s.proof?.txCounts ?? null, tickets: s.tickets.map((t) => ({ key: `${t.showId}:${t.seatHex}`, state: t.state, kind: t.show.kind })) }, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
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

try {
  const showA = stage.shows.find((s) => s.kind === 'sample-settle');
  const showB = stage.shows.find((s) => s.kind === 'sample-refund-seat');
  const real = stage.shows.find((s) => s.kind === 'real');
  await rpc.request('simnet.fund', { address: wallet.addressAt('receive', 0).address, sats: 2_000_000, mine: true });

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    userDataDir: join(RUN, 'chrome'),
    args: ['--no-first-run', '--no-default-browser-check', '--disable-features=Translate'],
  });
  const page = await browser.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  const url = `${stage.server.origin}/?fulcrum=${encodeURIComponent(stage.simnet.url)}&usd=208`;
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(`[data-buy="${showA.id}"]`, { timeout: 30_000 });
  await page.waitForSelector(`[data-buy="${showB.id}"]`, { timeout: 30_000 });
  log(`home ready in ${Date.now() - t0} ms`);
  await sleep(600);
  await shot(page, '01-home');
  await shot(page, '01-home-full', { full: true });
  if (homeOnly) {
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await shot(page, '01-home-dark');
    await shot(page, '01-home-dark-full', { full: true });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  }

  if (homeOnly) throw Object.assign(new Error('home only'), { done: true });

  // Get a ticket (A) -> the connect dialog.
  await click(page, `[data-buy="${showA.id}"]`);
  await page.waitForFunction(() => document.querySelector('[data-wiz-uri]')?.value?.startsWith('wiz://'), { timeout: 30_000 });
  await page.waitForSelector('[data-qr] svg', { timeout: 10_000 });
  const uri = await page.$eval('[data-wiz-uri]', (el) => el.value);
  log('pairing link', uri.slice(0, 40));
  await shot(page, '02-connect');

  // The wallet joins over the public relay; the buy continues by itself.
  const tPair = Date.now();
  pairing = await wallet.pairOverRelay(uri);
  await waitState(page, (s) => s.wallet.state === 'connected', 'wallet_ready over the public relay', 90_000);
  log(`wallet connected in ${Date.now() - tPair} ms`);
  const keyA = await waitState(page, (s) => s.flows[showA.id]?.step === 'done' && s.flows[showA.id].ticketKey, 'buy A', 90_000);
  log(`bought A (${keyA}) ${Date.now() - t0} ms after the page opened; prompt: ${wallet.log.at(-1).userPrompt}`);
  await page.waitForSelector(`[data-ticket="${keyA}"][data-state="held"]`);
  await sleep(1300);
  await shot(page, '03-ticket-a', { selector: `[data-show="${showA.id}"]` });

  // Hand it back.
  await click(page, `[data-hand-back="${keyA}"]`);
  await waitState(page, (s) => s.flows[keyA]?.step === 'done', 'hand back', 60_000);
  await page.waitForSelector(`[data-ticket="${keyA}"][data-state="handedBack"]`, { timeout: 30_000 });
  log(`handed back; prompt: ${wallet.log.at(-1).userPrompt}`);
  await sleep(1500);
  await shot(page, '04-handed-back', { selector: `[data-show="${showA.id}"]` });

  if (!only) {
    // Sample B: buy, then the refund arrives with no second approval.
    const approvals = wallet.log.length;
    await click(page, `[data-buy="${showB.id}"]`);
    const keyB = await waitState(page, (s) => s.flows[showB.id]?.step === 'done' && s.flows[showB.id].ticketKey, 'buy B', 60_000);
    await sleep(500);
    await shot(page, '05-b-notice', { selector: `[data-ticket="${keyB}"]` });
    await waitState(page, (s) => s.flows[keyB]?.step === 'back', 'B refund sequence', 60_000);
    await page.waitForSelector(`[data-ticket="${keyB}"][data-state="refunded"]`, { timeout: 30_000 });
    if (wallet.log.length !== approvals + 1) throw new Error('the B refund asked the wallet for a second approval');
    log('B refunded by itself');
    await sleep(1500);
    await shot(page, '06-b-refunded', { selector: `[data-ticket="${keyB}"]` });

    // A real show: buy, walk in (confirm), the door answers.
    if (real) {
      await click(page, `[data-buy="${real.id}"]`);
      const keyR = await waitState(page, (s) => s.flows[real.id]?.step === 'done' && s.flows[real.id].ticketKey, 'buy real', 60_000);
      await sleep(1300);
      await shot(page, '07-real-held', { selector: `[data-ticket="${keyR}"]` });
      await click(page, `[data-walk-in="${keyR}"]`);
      await waitState(page, (s) => s.flows[keyR]?.link || s.flows[keyR]?.doorError, 'door answer', 60_000);
      const door = await state(page);
      if (!door.flows[keyR].link) throw new Error(`the door did not answer: ${JSON.stringify(door.flows[keyR])}`);
      await page.waitForSelector(`[data-ticket="${keyR}"] [data-door-link]`, { timeout: 10_000 });
      await page.waitForSelector(`[data-ticket="${keyR}"][data-state="walkedIn"]`, { timeout: 30_000 });
      log(`walked in; prompt: ${wallet.log.at(-1).userPrompt}`);
      await sleep(1500);
      await shot(page, '08-walked-in', { selector: `[data-ticket="${keyR}"]` });
    }

    // A second A ticket, then the show passes its grace: the page settles it by itself.
    await click(page, `[data-buy="${showA.id}"]`);
    const keyA2 = await waitState(page, (s) => s.flows[showA.id]?.step === 'done' && s.flows[showA.id].ticketKey !== keyA && s.flows[showA.id].ticketKey, 'second buy A', 60_000);
    const tip = (await rpc.request('blockchain.headers.subscribe', [])).height;
    const settleAt = showA.params.startHeight + showA.params.graceBlocks + 1;
    await rpc.request('simnet.mine', { blocks: settleAt - 1 - tip });
    await waitState(page, (s) => s.keeper.length > 0, 'the page pushes the settle', 60_000);
    await waitState(page, (s) => s.tickets.find((t) => t.key === keyA2)?.state === 'refunded', 'second A settled', 60_000);
    log('the page settled the started show');
    await sleep(1200);
    await shot(page, '09-proof', { selector: '#proof' });

    // My tickets.
    await click(page, '[data-wallet-chip]');
    await page.waitForSelector('.drawer .list');
    await sleep(900);
    await shot(page, '10-my-tickets');
    await page.keyboard.press('Escape');
    const final = await state(page);
    log('proof strip', JSON.stringify(final.proof));
    log('tickets', JSON.stringify(final.tickets.map((t) => `${t.kind}:${t.state}`)));
    await shot(page, '11-full', { full: true });
  }

  // A phone opening the connect dialog: Open Selene is the main button, the QR is one tap away.
  // A fresh context: the first page's remembered pairing would skip the dialog.
  const phoneContext = await browser.createBrowserContext();
  const phone = await phoneContext.newPage();
  await phone.emulate({ viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
  await phone.goto(url, { waitUntil: 'domcontentloaded' });
  await phone.waitForSelector('[data-connect]', { timeout: 30_000 });
  await click(phone, '[data-connect]');
  await phone.waitForFunction(() => document.querySelector('[data-wiz-uri]')?.value?.startsWith('wiz://'), { timeout: 30_000 });
  await sleep(500);
  await phone.screenshot({ path: join(SCREENS, '02-connect-phone-390.png') });
  await phone.close();
  await phoneContext.close();

  // Dark mode.
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, '12-dark');
  await shot(page, '12-dark-full', { full: true });

  const relevant = consoleErrors.filter((e) => !/favicon|ERR_NAME_NOT_RESOLVED|api\.coin/.test(e));
  if (relevant.length > 0) log('console errors:', relevant.slice(0, 10));
  log(`PASS: judge path on simnet; screenshots in ${SCREENS}`);
} catch (e) {
  if (e.done) {
    log(`home screenshots in ${SCREENS}`);
  } else {
  failed = true;
  console.error('E2E FAILED:', e);
  try {
    const pages = await browser?.pages();
    const page = pages?.at(-1);
    if (page) await page.screenshot({ path: join(SCREENS, 'failure.png'), fullPage: true });
  } catch {
    // ignore
  }
  if (consoleErrors.length) console.error('console errors:', consoleErrors.slice(0, 20));
  }
} finally {
  try {
    pairing?.close();
  } catch {
    // ignore
  }
  await browser?.close().catch(() => {});
  rpc.close();
  await stage.close();
  rmSync(join(RUN, 'chrome'), { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
