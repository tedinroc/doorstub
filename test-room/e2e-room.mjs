#!/usr/bin/env node
// npm run e2e:room: the screening room in a real browser, on a local stage.
//
// Stage: the site built for production into .cache/room/e2e/dist; a 60 s test
// film (scripts/room-test-film.mjs) and a 12 s preview, encoded with
// scripts/room-media.mjs and copied in with scripts/add-room-media.mjs under a
// TEST room key generated into .cache/room/e2e/ (never .secrets/room.json);
// the worker's Node adapter on simnet with that key, a short rehearsal lead
// (ROOM_REHEARSAL_LEAD_S) and a shows.json holding one real show whose start
// the run moves; the page's CSP and the room's X-Robots-Tag from
// app/public/_headers. No chain, no network beyond 127.0.0.1.
//
// Path, each step asserted in the page:
//   rehearsal link -> countdown, the rehearsal's title and no receipt (it has
//   no check-in), label, Enter the room -> a chip, a typed question, a pasted
//   12-word phrase (refused, no request) -> the preview played to its end ->
//   the film starts at eventAt with sound, within 2 s of the server -> a real
//   show joined late in a new tab (its receipt; muted in step, Tap to watch
//   with sound)
//   -> after the film (Watch from the start) -> after questions close -> 4 days
//   later (no media) -> a bad pass -> enter down (503): countdown and chat,
//   no seat text -> phone and desktop layout. Countdown, chat and playing
//   screenshots at 390x844 and 1440x900 go to .cache/room/shots/.
// ONE headless Chrome (it waits while 3 run on this machine), niced, killed
// at the end. Screenshots go to .cache/room/e2e/screens/.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { setPriority } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { build } from 'vite';
import { ROOM_LABELS, ROOM_SENTENCES } from '../app/src/room/copy.js';
import { roomMediaFolder, roomPass } from '../worker/lib/room.js';
import { startWorkerServer } from '../worker/node/server.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = join(repoRoot, '.cache', 'room', 'e2e');
const DIST = join(OUT, 'dist');
const HLS = join(OUT, 'hls');
const SCREENS = join(OUT, 'screens');
/** The countdown, the chat and the playing film at a phone and a desktop size, for a person to look at. */
const SHOTS = join(repoRoot, '.cache', 'room', 'shots');
const PROFILE = join(OUT, 'chrome');
const KEY_FILE = join(OUT, 'test-room-key.json');
const FILM_SECONDS = 60;
const PREVIEW_SECONDS = 12;
/** The rehearsal starts this long after enter (simnet only; worker/lib/config.js). */
const LEAD_S = 40;
const PHONE = { width: 390, height: 844, deviceScaleFactor: 2 };
const DESKTOP = { width: 1440, height: 900, deviceScaleFactor: 1 };
const MAX_CHROME = 3;

const log = (...a) => console.log(`[e2e:room ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const ok = (condition, what) => {
  if (!condition) throw new Error(`assertion failed: ${what}`);
  checks.push(what);
};
const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// Niced, and so is every child (ffmpeg, Chrome).
try {
  setPriority(10);
} catch {
  // not allowed here; carry on at normal priority
}
mkdirSync(SCREENS, { recursive: true });
mkdirSync(SHOTS, { recursive: true });

/** Chrome left over from an earlier run of this script (its profile is under .cache/room/e2e/). */
const killOurChrome = () => {
  try {
    execFileSync('pkill', ['-f', `--user-data-dir=${PROFILE}`], { stdio: 'ignore' });
    log('killed a Chrome left over from an earlier run');
  } catch {
    // none running
  }
};

/** Headless Chrome browsers on this machine (main processes, not their helpers). */
const headlessChromes = () => {
  const r = spawnSync('pgrep', ['-fl', 'Chrome.*headless'], { encoding: 'utf8' });
  return (r.stdout ?? '').split('\n').filter((l) => l.trim() !== '' && !l.includes('--type=')).length;
};

const waitForChromeSlot = async () => {
  const until = Date.now() + 15 * 60_000;
  for (;;) {
    const n = headlessChromes();
    if (n < MAX_CHROME) return n;
    if (Date.now() > until) throw new Error(`${n} headless Chromes have been running for 15 minutes; not starting a fourth`);
    log(`${n} headless Chromes are running; waiting for one to finish`);
    await sleep(10_000);
  }
};

const node = (script, args) => {
  const r = spawnSync(process.execPath, [join(repoRoot, script), ...args], { encoding: 'utf8', cwd: repoRoot });
  if (r.status !== 0) throw new Error(`${script} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout.trim();
};

let browser;
let server;
let failed = false;
try {
  killOurChrome();

  // ------------------------------------------------------------------ build, film, media, test key
  log('building the site (production) into .cache/room/e2e/dist');
  await build({ configFile: join(repoRoot, 'app', 'vite.config.js'), root: join(repoRoot, 'app'), mode: 'production', logLevel: 'warn', build: { outDir: DIST, emptyOutDir: true } });
  ok(existsSync(join(DIST, 'room', 'index.html')), 'the build has room/index.html');

  log(`making the ${FILM_SECONDS} s test film and the ${PREVIEW_SECONDS} s preview`);
  const film = node('scripts/room-test-film.mjs', ['--seconds', String(FILM_SECONDS)]).split('\n').pop();
  const preview = node('scripts/room-test-film.mjs', ['--seconds', String(PREVIEW_SECONDS)]).split('\n').pop();
  log('encoding them (HLS, veryfast)');
  log(node('scripts/room-media.mjs', [film, HLS, '--name', 'film', '--preset', 'veryfast']).split('\n').pop());
  log(node('scripts/room-media.mjs', [preview, HLS, '--name', 'preview', '--preset', 'veryfast']).split('\n').pop());

  if (!existsSync(KEY_FILE)) writeFileSync(KEY_FILE, `${JSON.stringify({ ROOM_KEY: randomBytes(32).toString('hex'), note: 'test key for npm run e2e:room only' })}\n`, { mode: 0o600 });
  const key = JSON.parse(readFileSync(KEY_FILE, 'utf8')).ROOM_KEY;
  const folder = roomMediaFolder(key);
  log(node('scripts/add-room-media.mjs', ['--from', HLS, '--key-file', KEY_FILE, '--dist', DIST]).split('\n').pop());
  ok(existsSync(join(DIST, 'room', 'media', folder, 'film.m3u8')), 'add-room-media put the film under the folder the test key derives');
  const roomJson = JSON.parse(readFileSync(join(DIST, 'room', 'media', folder, 'room.json'), 'utf8'));
  ok(near(roomJson.film.seconds, FILM_SECONDS, 0.5) && near(roomJson.preview.seconds, PREVIEW_SECONDS, 0.5), `room.json: film ${roomJson.film.seconds} s, preview ${roomJson.preview.seconds} s`);

  // ------------------------------------------------------------------ the worker on simnet
  const headersFile = readFileSync(join(repoRoot, 'app', 'public', '_headers'), 'utf8');
  const csp = /Content-Security-Policy: (.+)/.exec(headersFile)[1];
  const robots = /\n\/room\/\*\n(?:\s+[\w-]+: .+\n)*?\s+X-Robots-Tag: (.+)\n/.exec(headersFile)?.[1];
  ok(robots === 'noindex', '_headers gives /room/* X-Robots-Tag noindex');
  ok(/media-src 'self' blob:;/.test(csp), "_headers' CSP has media-src 'self' blob:");

  /** The real show of this run: its start moves as the run goes (late join, after, ended, gone). */
  let realAt = Date.now() + 3_600_000;
  const showsText = () => JSON.stringify({ version: 1, network: 'simnet', origin: 'https://doorstub.pages.dev', generatedAt: iso(Date.now()), shows: [{ id: 'screening-e2e', kind: 'real', title: 'Doorstub screening E2E', eventAt: iso(realAt), durationMin: 25 }] });
  process.env.ROOM_REHEARSAL_LEAD_S = String(LEAD_S);
  server = await startWorkerServer({
    env: { DOORSTUB_NETWORK: 'simnet', DOORSTUB_FULCRUM: 'ws://127.0.0.1:9', ROOM_KEY: key, ROOM_REHEARSAL_LEAD_S: String(LEAD_S) },
    showsText,
    port: 0,
    staticRoot: DIST,
    vm: false,
    htmlHeaders: { 'content-security-policy': csp, 'x-robots-tag': robots },
    log: (line) => log(`worker: ${line}`),
  });
  ok(server.config.errors.length === 0, `worker config has no errors (${server.config.errors.join('; ')})`);
  const origin = server.url;
  log(`worker and site on ${origin}`);

  const link = (show, seat, { pass } = {}) => {
    const txid = randomBytes(32).toString('hex');
    return { txid, url: `${origin}/room/#show=${show}&seat=${seat}&txid=${txid}&pass=${pass ?? roomPass(key, show, seat, txid)}&m=${folder}` };
  };

  const head = await fetch(`${origin}/room/`);
  ok(head.status === 200 && (await head.text()).includes('<div id="room"></div>'), '/room/ serves the room page');
  ok(/media-src 'self' blob:/.test(head.headers.get('content-security-policy') ?? ''), '/room/ answers with a CSP that has media-src');
  ok(head.headers.get('x-robots-tag') === 'noindex', '/room/ answers with X-Robots-Tag: noindex');
  const master = await fetch(`${origin}/room/media/${folder}/film.m3u8`);
  ok(master.status === 200 && master.headers.get('content-type') === 'application/vnd.apple.mpegurl', 'the master playlist is served as application/vnd.apple.mpegurl');

  // ------------------------------------------------------------------ one headless Chrome
  const running = await waitForChromeSlot();
  log(`${running} headless Chrome(s) running elsewhere; starting one`);
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    userDataDir: PROFILE,
    // Desktop Chrome's own autoplay rule: sound only after the guest interacted with the page.
    args: ['--no-first-run', '--no-default-browser-check', '--disable-features=Translate', '--autoplay-policy=document-user-activation-required', '--mute-audio'],
  });
  const context = browser.defaultBrowserContext();
  await context.overridePermissions(origin, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);

  const consoleErrors = [];
  const foreign = [];
  /** `expected`: console errors this page is meant to cause (the bad pass's 403 from /api/room/enter). */
  const watch = (page, expected = null) => {
    const state = { requests: 0 };
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (expected !== null && expected.test(m.text())) return;
      consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(String(e)));
    page.on('request', (r) => {
      state.requests += 1;
      if (!r.url().startsWith(origin) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) foreign.push(r.url());
    });
    return state;
  };
  const text = (page, sel) => page.$eval(sel, (el) => el.textContent.trim()).catch(() => null);
  const waitText = async (page, sel, want, what, timeout = 10_000) => {
    const until = Date.now() + timeout;
    let last = null;
    while (Date.now() < until) {
      last = await text(page, sel);
      if (last !== null && (typeof want === 'string' ? last.includes(want) : want.test(last))) return last;
      await sleep(150);
    }
    throw new Error(`${what}: ${sel} never showed ${want} (last: ${last})`);
  };
  const video = (page) =>
    page.$eval('[data-room-video]', (v) => ({ t: v.currentTime, paused: v.paused, muted: v.muted, ready: v.readyState, kind: v.dataset.player, src: v.currentSrc }));
  /**
   * `name`-390.png and `name`-1440.png in .cache/room/shots/ (the phone one whole-page, so the chat
   * under the film shows), each also checked for sideways scroll; then back to `restore`.
   */
  const shots = async (page, name, restore) => {
    for (const [size, fullPage] of [
      [PHONE, true],
      [DESKTOP, false],
    ]) {
      await page.setViewport(size);
      await sleep(300);
      const wide = await page.evaluate(() => document.documentElement.scrollWidth);
      ok(wide <= size.width, `${name} at ${size.width} px has no sideways scroll (${wide})`);
      await page.screenshot({ path: join(SHOTS, `${name}-${size.width}.png`), fullPage });
    }
    await page.setViewport(restore);
  };
  const waitPlaying = async (page, what, timeout = 15_000) => {
    const until = Date.now() + timeout;
    let v;
    while (Date.now() < until) {
      v = await video(page);
      if (!v.paused && v.t > 0.2 && v.ready >= 3) return v;
      await sleep(200);
    }
    throw new Error(`${what}: the film did not play (${JSON.stringify(v)})`);
  };

  // ------------------------------------------------------------------ the rehearsal room
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const net = watch(page);
  let enterAnswer = null;
  page.on('response', async (r) => {
    if (r.url() === `${origin}/api/room/enter` && r.status() === 200) enterAnswer = await r.json().catch(() => null);
  });
  const rehearsal = link('rehearsal', 'R-0-1');
  log('opening the rehearsal room');
  await page.goto(rehearsal.url, { waitUntil: 'load' });
  ok((await page.title()) === ROOM_SENTENCES.pageTitle, 'the page title is the room title');
  ok((await page.$eval('meta[name="robots"]', (m) => m.content)) === 'noindex', 'the page carries a robots noindex meta');
  ok((await page.$eval('meta[http-equiv="Content-Security-Policy"]', (m) => m.content)) === "connect-src 'self'; worker-src 'none'", "the room's own CSP meta lets it connect only to its own origin");
  await waitText(page, '[data-status]', /^Starts .+ · in \d+ s$/, 'the countdown');
  ok(true, 'before the start: "Starts {time} · in {countdown}"');
  ok(/^\d+ s$/.test(await text(page, '[data-countdown]')), 'the screen shows the countdown');
  await waitText(page, '[data-room-title]', 'Doorstub rehearsal', 'the title after a verified enter');
  ok(true, 'after a verified enter the title is "Doorstub rehearsal"');
  ok((await page.$('[data-receipt]')) === null, 'the rehearsal shows no receipt: it has no ticket and no check-in');
  ok(enterAnswer !== null && enterAnswer.show === 'rehearsal', 'POST /api/room/enter answered for the rehearsal');
  const eventAtMs = Date.parse(enterAnswer.eventAt);
  ok(eventAtMs - Date.now() > 10_000, `the rehearsal starts ${(eventAtMs - Date.now()) / 1000} s from now`);
  ok((await text(page, '[data-chat-label]')) === ROOM_SENTENCES.labelMatch, 'the chat label is the matching-words one');
  ok((await page.$('[data-preview]')) !== null, 'Watch the preview is offered (room.json has a preview)');
  const before = await video(page);
  ok(before.paused && before.t === 0, 'nothing plays before the start');
  ok(before.kind === 'hls', 'Chrome plays through hls.js');
  ok(await page.$eval('[data-room-video]', (v) => v.hasAttribute('playsinline')), 'the video plays inline (playsinline)');
  await shots(page, 'countdown', { width: 1280, height: 800 });
  // The narrowest phones: the countdown's buttons stack and the screen grows to hold them, none cut off.
  for (const width of [320, 360, 375]) {
    await page.setViewport({ width, height: 640 });
    await sleep(200);
    const cut = await page.evaluate(() => {
      const screen = document.querySelector('.room-screen').getBoundingClientRect();
      return [...document.querySelectorAll('.room-screen button, .room-screen [data-countdown]')]
        .map((b) => ({ what: b.textContent.trim(), r: b.getBoundingClientRect() }))
        .filter(({ r }) => r.top < screen.top - 0.5 || r.bottom > screen.bottom + 0.5 || r.left < screen.left - 0.5 || r.right > screen.right + 0.5)
        .map(({ what }) => what);
    });
    ok(cut.length === 0, `at ${width} px the countdown's buttons sit inside the screen (${cut.join(', ')})`);
  }
  await page.setViewport({ width: 1280, height: 800 });

  await page.click('[data-enter]');
  await page.waitForFunction(() => document.querySelector('[data-enter]') === null, { timeout: 5_000 });
  ok(true, 'Enter the room is pressed and goes away');

  await page.click('[data-chip="room-how"]');
  await waitText(page, '[data-transcript]', 'From the FAQ: How does the room work?', 'a chip');
  ok(true, 'a chip answers under "From the FAQ: How does the room work?"');
  await page.type('#room-question', 'Can I get a refund for this screening?');
  await page.keyboard.press('Enter');
  await waitText(page, '[data-transcript]', 'From the FAQ: Can you get a refund for this screening?', 'a typed question');
  ok(true, 'a typed question answers from the FAQ');
  const seed = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const sentBefore = net.requests;
  await page.evaluate((s) => {
    const input = document.querySelector('#room-question');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(input, s);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, seed);
  await page.keyboard.press('Enter');
  await waitText(page, '[data-transcript]', 'Never share a seed phrase or private key', 'the pasted phrase');
  await sleep(1_000);
  ok(net.requests === sentBefore, `a pasted 12-word phrase is refused with no network request (${net.requests - sentBefore} made)`);
  ok(!(await text(page, '[data-transcript]')).includes('abandon'), 'the phrase is not shown back');
  ok((await page.$eval('#room-question', (i) => i.value)) === '', 'the field is cleared');

  await page.click('[data-copy-link]');
  await waitText(page, '[data-copy-link]', ROOM_LABELS.copied, 'copy link', 3_000);
  ok((await page.evaluate(() => navigator.clipboard.readText())) === rehearsal.url, "Copy this room's link copies the room link");
  await page.screenshot({ path: join(SCREENS, 'before-1280.png') });
  await shots(page, 'chat', { width: 1280, height: 800 });
  await sleep(200);
  const latest = await page.evaluate(() => {
    const list = document.querySelector('[data-transcript]');
    const box = list.getBoundingClientRect();
    const last = list.lastElementChild.getBoundingClientRect();
    return { top: Math.round(last.top - box.top), height: Math.round(box.height) };
  });
  ok(latest.top >= 0 && latest.top < latest.height, `after a resize the newest answer is still in view (${JSON.stringify(latest)})`);

  // The preview, watched to its end before the start: the countdown comes back, and the film still starts at eventAt.
  const leftS = (eventAtMs - Date.now()) / 1000;
  ok(leftS > PREVIEW_SECONDS + 8, `${leftS.toFixed(1)} s left before the start, enough for the ${PREVIEW_SECONDS} s preview`);
  await page.click('[data-preview]');
  await waitPlaying(page, 'Watch the preview');
  ok((await page.$eval('[data-screen]', (el) => el.dataset.screen)) === 'film', 'Watch the preview plays the preview');
  await page.waitForSelector('[data-screen="countdown"] [data-preview]', { timeout: (PREVIEW_SECONDS + 6) * 1000 });
  ok(Date.now() < eventAtMs - 1_500, 'the preview ended before the start, and the countdown came back with Watch the preview');

  // The start.
  const wait = eventAtMs - Date.now() - 1_500;
  log(`waiting ${Math.round(wait / 1000)} s for the start`);
  if (wait > 0) await sleep(wait);
  const early = await video(page);
  ok(early.paused, 'still waiting 1.5 s before the start');
  const started = await waitPlaying(page, 'the start', 8_000);
  const startedLate = (Date.now() - eventAtMs) / 1000;
  ok(startedLate < 4, `the film plays ${startedLate.toFixed(1)} s after eventAt`);
  ok(!started.muted, 'with sound: Enter the room unlocked it');
  ok((await page.$eval('[data-screen]', (s) => s.dataset.screen)) === 'film', 'the screen shows the film');
  for (const at of [6, 15]) {
    const delay = eventAtMs + at * 1000 - Date.now();
    if (delay > 0) await sleep(delay);
    const v = await video(page);
    const position = (Date.now() - eventAtMs) / 1000;
    ok(!v.paused && near(v.t, position, 2), `at +${at} s the player is at ${v.t.toFixed(2)} s, the screening at ${position.toFixed(2)} s`);
  }
  await page.screenshot({ path: join(SCREENS, 'film-1280.png') });
  await shots(page, 'playing', { width: 1280, height: 800 });

  // ------------------------------------------------------------------ a real show, joined late in a new tab
  realAt = Date.now() - 20_000;
  const late = await browser.newPage();
  await late.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  watch(late);
  const lateLink = link('screening-e2e', 'S-0-7');
  log('joining a real show 20 s late in a new tab');
  await late.goto(lateLink.url, { waitUntil: 'load' });
  await late.waitForSelector('[data-tap-sound]', { timeout: 15_000 });
  const lateV = await waitPlaying(late, 'the late join');
  ok(lateV.muted, 'a late join with no tap plays muted, in step');
  const latePos = (Date.now() - realAt) / 1000;
  ok(near(lateV.t, latePos, 2), `the late join is at ${lateV.t.toFixed(2)} s, the screening at ${latePos.toFixed(2)} s`);
  ok((await text(late, '[data-room-title]')) === 'Doorstub screening E2E', "a real show's title comes from shows.json");
  await waitText(late, '[data-receipt]', 'Seat S-0-7 · your check-in is on chain:', "a real show's receipt");
  ok((await text(late, '[data-receipt]')).includes(ROOM_SENTENCES.paid), "a real show's room shows the receipt after a verified enter: seat, check-in, organiser paid");
  await late.screenshot({ path: join(SCREENS, 'tap-390.png') });
  const cover = await late.evaluate(() => {
    const a = document.querySelector('.room-screen').getBoundingClientRect();
    const b = document.querySelector('[data-tap-sound]').getBoundingClientRect();
    return Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1;
  });
  ok(cover, 'Tap to watch with sound covers the whole film');
  await late.click('[data-tap-sound]');
  await late.waitForFunction(() => !document.querySelector('[data-room-video]').muted && document.querySelector('[data-tap-sound]') === null, { timeout: 5_000 });
  const tapped = await video(late);
  ok(!tapped.paused && near(tapped.t, (Date.now() - realAt) / 1000, 2), 'Tap to watch with sound unmutes and stays in step');
  // Phone layout: the film above the chat, no sideways scroll, text at least 16 px.
  const phone = await late.evaluate(() => ({
    screen: document.querySelector('.room-screen').getBoundingClientRect().top,
    chat: document.querySelector('.room-chat')?.getBoundingClientRect().top ?? null,
    scroll: document.documentElement.scrollWidth,
    smallest: Math.min(...[...document.querySelectorAll('p, button, input, li, span')].filter((e) => e.offsetParent !== null && e.textContent.trim() !== '').map((e) => parseFloat(getComputedStyle(e).fontSize))),
  }));
  ok(phone.chat !== null && phone.screen < phone.chat, 'on a phone the film is above the chat');
  ok(phone.scroll <= 390, `no sideways scroll at 390 px (${phone.scroll})`);
  ok(phone.smallest >= 16, `text is at least 16 px (${phone.smallest})`);
  await late.close();

  // ------------------------------------------------------------------ after the film, after questions close, 4 days later
  const visit = async (startedAgoMs, what) => {
    realAt = Date.now() - startedAgoMs;
    const p = await browser.newPage();
    await p.setViewport({ width: 1440, height: 900 });
    watch(p);
    await p.goto(link('screening-e2e', 'S-0-8').url, { waitUntil: 'load' });
    await p.waitForSelector('[data-receipt]', { timeout: 10_000 }).catch(() => {});
    log(what);
    return p;
  };
  const after = await visit((FILM_SECONDS + 10) * 1000, 'after the film');
  await waitText(after, '[data-status]', 'The film has finished. Questions are open until', 'after the film');
  ok(true, 'after the film: "The film has finished. Questions are open until {time}."');
  ok((await after.$('[data-ask]')) !== null, 'questions are still open');
  const side = await after.evaluate(() => {
    const r = (sel) => {
      const b = document.querySelector(sel).getBoundingClientRect();
      return { left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top) };
    };
    return { width: innerWidth, screen: r('.room-screen'), chat: r('.room-chat') };
  });
  ok(side.chat.left >= side.screen.right && side.chat.top <= side.screen.top + 1, `at 1440 px the chat sits beside the film (${JSON.stringify(side)})`);
  await after.click('[data-replay]');
  const replay = await waitPlaying(after, 'Watch from the start');
  ok(replay.t < 5 && !replay.muted, `Watch from the start plays from the beginning with sound (${replay.t.toFixed(2)} s)`);
  await after.screenshot({ path: join(SCREENS, 'after-1440.png') });
  await after.close();

  const ended = await visit(40 * 60_000, 'after questions close');
  await waitText(ended, '[data-status]', `${ROOM_SENTENCES.ended}${ROOM_SENTENCES.thanks}`, 'after questions close');
  ok(true, 'after opensUntil: "This screening has ended. Thank you for walking in."');
  ok((await ended.$('[data-ask]')) === null && (await ended.$('[data-chip]')) === null, 'the chat is closed');
  ok((await ended.$('[data-replay]')) !== null, 'Watch from the start stays within 4 days');
  await ended.close();

  const gone = await visit((25 + 10) * 60_000 + 4 * 24 * 3_600_000 + 60_000, '4 days after questions close');
  await waitText(gone, '[data-status]', ROOM_SENTENCES.ended, 'four days on');
  ok((await gone.$('[data-replay]')) === null, 'no media 4 days after questions close');
  await gone.close();

  // ------------------------------------------------------------------ a bad pass
  const bad = await browser.newPage();
  watch(bad, /status of 403 \(Forbidden\)/);
  await bad.goto(link('rehearsal', 'R-0-2', { pass: '0'.repeat(32) }).url, { waitUntil: 'load' });
  await waitText(bad, '[data-status]', ROOM_SENTENCES.badLink, 'a bad pass');
  ok((await bad.$('[data-receipt]')) === null && (await bad.$('[data-chat]')) === null, 'a bad pass shows no seat text and no chat');
  await bad.close();

  // ------------------------------------------------------------------ the Functions down: enter answers 503
  realAt = Date.now() + 3_600_000;
  const down = await browser.newPage();
  await down.setViewport({ width: 1440, height: 900 });
  watch(down, /status of 503/);
  await down.setRequestInterception(true);
  down.on('request', (r) => {
    if (r.url() === `${origin}/api/room/enter`) r.respond({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'room-not-configured', message: 'down', retryable: true } }) });
    else r.continue();
  });
  await down.goto(link('screening-e2e', 'S-0-9').url, { waitUntil: 'load' });
  await waitText(down, '[data-status]', /^Starts .+ · in /, 'the countdown with enter down');
  await down.waitForSelector('[data-chip="room-how"]', { timeout: 5_000 });
  await down.click('[data-chip="room-how"]');
  await waitText(down, '[data-transcript]', 'From the FAQ: How does the room work?', 'a chip with enter down');
  ok(true, 'with /api/room/enter down (503), the countdown shows and the in-page chat still answers');
  ok((await down.$('[data-receipt]')) === null, 'with enter down, no seat or receipt text');
  await down.close();

  ok(consoleErrors.length === 0, `no console errors or CSP violations (${consoleErrors.join(' | ')})`);
  ok(foreign.length === 0, `the room asked nothing of another origin (${foreign.join(', ')})`);
  log(`e2e:room PASSED: ${checks.length} checks`);
} catch (e) {
  failed = true;
  console.error(`[e2e:room] FAILED after ${checks.length} checks: ${e?.stack ?? e}`);
} finally {
  await browser?.close().catch(() => {});
  killOurChrome();
  await server?.close().catch(() => {});
  rmSync(PROFILE, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
