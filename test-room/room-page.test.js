// The screening room page (app/room/, app/src/room/): the sync maths, the
// state machine, the clock, the player rule, enter's retries, the in-page
// assistant (a pasted secret makes no request), the copy and its words, the
// import graph (no wallet, chain or libauth code), the build's chunk rule,
// _headers, the Node server's /room/ and media types, and the media gate.
// Run with `npm run test:room` (outside `npm test`; see CLAIMS C9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOM_LABELS, ROOM_SENTENCES, fill, say } from '../app/src/room/copy.js';
import { CHIPS, createRoomController } from '../app/src/room/controller.js';
import {
  FETCH_TIMEOUT_MS,
  MAX_SEEK_LEAD_S,
  QUESTIONS_AFTER_MIN,
  REHEARSAL_SHOW,
  REMEASURE_EVERY_MS,
  REPLAY_DAYS,
  REPLAY_MS,
  RESYNC_DRIFT_S,
  RESYNC_GAP_MS,
  RETRY_EVERY_MS,
  RETURN_DRIFT_S,
  STALL_QUIET_MS,
  answerPieces,
  choosePlayer,
  countdownText,
  createClock,
  enterOutcome,
  filmPosition,
  mediaFromRoomJson,
  opensUntilOf,
  parseFragment,
  phaseAt,
  replayOpen,
  retryDelay,
  showFromList,
  syncDecision,
} from '../app/src/room/state.js';
import { roomView } from '../app/src/room/view.js';
import { QUESTIONS_AFTER_MIN as WORKER_QUESTIONS_AFTER_MIN, REHEARSAL, roomPass } from '../worker/lib/room.js';
import { gateRoomMedia, printableStrings } from '../scripts/room-media-gate.mjs';
import { startWorkerServer } from '../worker/node/server.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const MIN = 60_000;
const T0 = Date.parse('2026-11-24T13:00:00Z');
const TXID = 'ab'.repeat(32);
const KEY = '11'.repeat(32);
const FRAGMENT = `#show=screening-1&seat=S-0-12&txid=${TXID}&pass=${'cd'.repeat(16)}&m=${'ef'.repeat(16)}`;
const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// ------------------------------------------------------------------ sync maths

test('room sync: seek once at the start, then only past the drift, at most once per 30 s, never during or right after a stall', () => {
  assert.equal(filmPosition(T0 + 90_000, T0), 90);
  assert.equal(filmPosition(T0 - 5_000, T0), 0, 'never before the start');
  const base = { position: 90, currentTime: 90, sinceSyncMs: Infinity, sinceStallMs: Infinity, filmSeconds: 675.8 };
  assert.equal(syncDecision({ ...base, trigger: 'start', currentTime: 0 }), 90, 'the start always seeks');
  assert.equal(syncDecision({ ...base, trigger: 'start', lead: 1.2 }), 91.2, 'a seek lands ahead by the measured lead');
  assert.equal(syncDecision({ ...base, trigger: 'start', lead: 60 }), 90 + MAX_SEEK_LEAD_S, 'the lead is capped');
  assert.equal(syncDecision({ ...base, trigger: 'start', position: 700 }), 675.3, 'never past the end of the film');
  // The regular check: only past 5 s.
  assert.equal(RESYNC_DRIFT_S, 5);
  assert.equal(syncDecision({ ...base, trigger: 'tick', currentTime: 86 }), null, '4 s behind: left alone');
  assert.equal(syncDecision({ ...base, trigger: 'tick', currentTime: 84.9 }), 90, '5.1 s behind: re-synced');
  assert.equal(syncDecision({ ...base, trigger: 'tick', currentTime: 95.5 }), 90, 'ahead counts too');
  // Coming back to the page: 1 s.
  assert.equal(RETURN_DRIFT_S, 1);
  assert.equal(syncDecision({ ...base, trigger: 'return', currentTime: 88.5 }), 90);
  assert.equal(syncDecision({ ...base, trigger: 'return', currentTime: 89.5 }), null);
  // Rate limit and stalls.
  assert.equal(RESYNC_GAP_MS, 30_000);
  assert.equal(syncDecision({ ...base, trigger: 'tick', currentTime: 60, sinceSyncMs: 29_999 }), null, 'once per 30 s');
  assert.equal(syncDecision({ ...base, trigger: 'tick', currentTime: 60, sinceSyncMs: 30_000 }), 90);
  assert.equal(syncDecision({ ...base, trigger: 'tick', currentTime: 60, stalled: true }), null, 'never while stalled');
  assert.equal(syncDecision({ ...base, trigger: 'tick', currentTime: 60, sinceStallMs: STALL_QUIET_MS - 1 }), null, 'never right after a stall');
  assert.equal(syncDecision({ ...base, trigger: 'return', currentTime: 60, sinceStallMs: 2_000 }), null);
});

// ------------------------------------------------------------------ the state machine

test('room states: before, running, after, ended; questions close 10 min after the event; replay for 4 days after that', () => {
  assert.equal(QUESTIONS_AFTER_MIN, 10);
  assert.equal(WORKER_QUESTIONS_AFTER_MIN, QUESTIONS_AFTER_MIN, 'the page and worker/lib/room.js agree');
  assert.equal(REPLAY_DAYS, 4, 'CLAIMS: Watch from the start stays 4 days after questions close');
  assert.equal(REPLAY_MS, 4 * 24 * 60 * MIN);
  const opensUntilMs = opensUntilOf(T0, 25);
  assert.equal(opensUntilMs, T0 + 35 * MIN);
  const at = (now, filmSeconds = 675.8) => phaseAt({ now, eventAtMs: T0, filmSeconds, opensUntilMs });
  assert.equal(at(T0 - 1), 'before');
  assert.equal(at(T0), 'running');
  assert.equal(at(T0 + 675_799), 'running');
  assert.equal(at(T0 + 675_800), 'after');
  assert.equal(at(opensUntilMs - 1), 'after');
  assert.equal(at(opensUntilMs), 'ended');
  assert.equal(at(T0 + 20 * MIN, null), 'running', 'no film known: the screening still runs (the page says the film did not load)');
  assert.equal(replayOpen({ now: T0 + 5 * MIN, phase: 'running', opensUntilMs }), false, 'not while the film runs');
  assert.equal(replayOpen({ now: T0 + 20 * MIN, phase: 'after', opensUntilMs }), true);
  assert.equal(replayOpen({ now: opensUntilMs + REPLAY_MS - 1, phase: 'ended', opensUntilMs }), true);
  assert.equal(replayOpen({ now: opensUntilMs + REPLAY_MS, phase: 'ended', opensUntilMs }), false);
  assert.equal(countdownText(45_200), '46 s');
  assert.equal(countdownText(12 * MIN), '12 min');
  assert.equal(countdownText(5 * 60 * MIN + 50 * MIN), '5 h 50 min');
  assert.equal(countdownText(3 * 24 * 60 * MIN), '3 days');
});

const state = (patch = {}) => ({
  stage: 'ready',
  show: 'screening-1',
  verified: false,
  title: 'Doorstub screening 1',
  seatLabel: 'S-0-12',
  txid: TXID,
  eventAtMs: T0,
  durationMin: 25,
  opensUntilMs: null,
  closesAtMs: T0 + 35 * MIN,
  media: { film: { seconds: 675.8, version: 'a1b2c3d4e5f6' }, preview: null },
  mediaFailed: false,
  serverNow: T0 - 2 * 60 * MIN,
  phase: 'before',
  replay: false,
  entered: false,
  mode: 'none',
  muted: false,
  needsTap: false,
  playerFailed: false,
  transcript: [],
  anyAi: false,
  copied: false,
  ...patch,
});

test('room view: a bad link, connecting, the countdown, and seat text only after a verified enter', () => {
  const bad = roomView(state({ stage: 'invalid' }));
  assert.deepEqual(bad.lines, [ROOM_SENTENCES.badLink]);
  assert.equal(bad.chat, 'none');
  assert.equal(bad.copy, false);
  assert.deepEqual(bad.receipt, []);

  const connecting = roomView(state({ stage: 'connecting', phase: null, eventAtMs: null }));
  assert.deepEqual(connecting.lines, [ROOM_SENTENCES.connecting]);
  assert.equal(connecting.chat, 'connecting');

  const before = roomView(state(), { timeZone: 'UTC' });
  assert.deepEqual(before.lines, ['Starts Tue 24 Nov, 13:00 UTC · in 2 h']);
  assert.equal(before.screen, 'countdown');
  assert.equal(before.countdown, '2 h');
  assert.equal(before.enter, true, 'Enter the room unlocks sound');
  assert.equal(before.preview, false, 'no preview button without a preview in room.json');
  assert.deepEqual(before.receipt, [], 'no seat or receipt text before /api/room/enter checked the pass');
  assert.equal(before.chat, 'connecting', 'the chat waits for the first answer from enter');
  const down = roomView(state({ retrying: true }), { timeZone: 'UTC' });
  assert.equal(down.chat, 'open', 'with enter being retried (Functions down) the in-page chat still opens');
  assert.deepEqual(down.receipt, [], 'but no seat or receipt text without a verified enter');

  const verified = roomView(state({ verified: true, entered: true, media: { film: { seconds: 675.8, version: 'a' }, preview: { seconds: 135.8, version: 'b' } } }), { timeZone: 'UTC' });
  assert.deepEqual(verified.receipt, ['Seat S-0-12 · your check-in is on chain: abababab…abab.', 'The organiser was paid when you walked in.']);
  assert.equal(verified.enter, false);
  assert.equal(verified.preview, true);
  assert.equal(verified.chat, 'open');
  assert.equal(verified.label, ROOM_SENTENCES.labelMatch, 'the matching-words label while no model is used');
  assert.equal(roomView(state({ verified: true, anyAi: true })).label, ROOM_SENTENCES.labelAi);

  // The operator's rehearsal has no ticket and no check-in: no receipt and no thanks, even verified.
  assert.equal(REHEARSAL_SHOW, REHEARSAL.id);
  const rehearsal = (patch) => roomView(state({ show: REHEARSAL_SHOW, title: 'Doorstub rehearsal', seatLabel: 'R-0-1', txid: '0'.repeat(64), verified: true, ...patch }), { timeZone: 'UTC' });
  assert.deepEqual(rehearsal({}).receipt, [], 'a rehearsal shows no seat or receipt text');
  assert.equal(rehearsal({}).chat, 'open');
  assert.deepEqual(rehearsal({ phase: 'ended', serverNow: T0 + 40 * MIN }).lines, [ROOM_SENTENCES.ended], 'and no thanks for walking in');
});

test('room view: the film running (muted until a tap), a missing film, after the film, the end, and a free play that is never stopped', () => {
  const running = (patch) => roomView(state({ phase: 'running', serverNow: T0 + 60_000, mode: 'sync', verified: true, ...patch }));
  assert.equal(running({ needsTap: true, muted: true }).screen, 'tap', 'Tap to watch with sound over the muted film');
  assert.equal(running({}).screen, 'film');
  assert.equal(running({}).controls, true);
  assert.deepEqual(running({ media: { film: null, preview: null }, mode: 'none' }).lines, [ROOM_SENTENCES.filmMissing]);
  assert.equal(running({ media: null, mediaFailed: true, mode: 'none' }).screen, 'missing');
  assert.deepEqual(running({ media: null, mediaFailed: false, mode: 'none' }).lines, [], 'room.json still loading: no sentence yet');

  const after = roomView(state({ phase: 'after', serverNow: T0 + 20 * MIN, replay: true, mode: 'done', verified: true }), { timeZone: 'UTC' });
  assert.deepEqual(after.lines, ['The film has finished. Questions are open until Tue 24 Nov, 13:35 UTC.']);
  assert.equal(after.screen, 'replay');
  assert.equal(after.chat, 'open');

  const ended = roomView(state({ phase: 'ended', serverNow: T0 + 40 * MIN, replay: true, verified: true }));
  assert.deepEqual(ended.lines, [ROOM_SENTENCES.ended, ROOM_SENTENCES.thanks]);
  assert.equal(ended.chat, 'closed');
  assert.deepEqual(roomView(state({ phase: 'ended', replay: true })).lines, [ROOM_SENTENCES.ended], 'no thanks without a verified enter');
  const gone = roomView(state({ phase: 'ended', replay: false }));
  assert.equal(gone.screen, 'blank', 'no media 4 days after questions close');
  assert.equal(gone.replay, false);
  assert.equal(roomView(state({ phase: 'ended', replay: false, mode: 'free-film' })).screen, 'film', 'a free play already running keeps playing');
});

// ------------------------------------------------------------------ inputs

test('room fragment: show, seat, txid, pass and m, all in shape, or nothing', () => {
  assert.deepEqual(parseFragment(FRAGMENT), { show: 'screening-1', seat: 'S-0-12', txid: TXID, pass: 'cd'.repeat(16), m: 'ef'.repeat(16) });
  assert.equal(parseFragment(''), null);
  assert.equal(parseFragment(FRAGMENT.replace('&m=', '&x=')), null, 'no media folder');
  assert.equal(parseFragment(FRAGMENT.replace('S-0-12', 'S-0-12<b>')), null);
  assert.equal(parseFragment(FRAGMENT.replace('screening-1', 'Screening 1')), null);
  assert.equal(parseFragment(FRAGMENT.replace(TXID, TXID.slice(2))), null);
  assert.equal(parseFragment(FRAGMENT.replace(`pass=${'cd'.repeat(16)}`, 'pass=zz')), null);
  assert.equal(parseFragment(`#show=rehearsal&seat=R-0-1&txid=${TXID}&pass=${'0'.repeat(32)}&m=${'1'.repeat(32)}`)?.show, 'rehearsal');
  const shows = { shows: [{ id: 'screening-1', kind: 'real', title: 'Doorstub screening 1', eventAt: '2026-11-24T13:00:00Z', durationMin: 25 }, { id: 'a', kind: 'sample-settle' }] };
  assert.deepEqual(showFromList(shows, 'screening-1'), { title: 'Doorstub screening 1', eventAtMs: T0, durationMin: 25 });
  assert.equal(showFromList(shows, 'a'), null);
  assert.equal(showFromList(shows, 'rehearsal'), null, 'the rehearsal is not in shows.json; enter gives its time');
  assert.deepEqual(mediaFromRoomJson({ film: { seconds: 60, version: 'abc' }, preview: null }), { film: { seconds: 60, version: 'abc' }, preview: null });
  assert.deepEqual(mediaFromRoomJson({ film: { seconds: 'x', version: 'abc' } }), { film: null, preview: null });
});

test('room enter: only 400 and 403 mean a bad pass; 5xx, 404, 429, network errors and non-JSON retry at 1.5, 3, 6, 12 s, then every 30 s', () => {
  const ok = { status: 200, json: { eventAt: '2026-11-24T13:00:00Z', now: T0 } };
  assert.equal(enterOutcome(ok), 'ok');
  assert.equal(enterOutcome({ status: 400, json: {} }), 'bad-pass');
  assert.equal(enterOutcome({ status: 403, json: null }), 'bad-pass');
  for (const status of [0, 404, 429, 500, 502, 503, 1102]) assert.equal(enterOutcome({ status, json: null }), 'retry', String(status));
  assert.equal(enterOutcome({ status: 200, json: null }), 'retry', 'an HTML error page with 200');
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(retryDelay), [1_500, 3_000, 6_000, 12_000, RETRY_EVERY_MS, RETRY_EVERY_MS, RETRY_EVERY_MS]);
  assert.equal(RETRY_EVERY_MS, 30_000);
});

test('room clock: Date.now() + offset survives a sleep gap; a wall-clock jump is corrected on the next measurement', () => {
  let local = T0 - 12 * 60 * MIN; // the device's own clock
  const skew = -7_000; // the device runs 7 s behind the server
  const server = () => local - skew;
  const clock = createClock({ now: () => local });
  // A Date header (whole seconds) first, then enter's `now` in ms sharpens it.
  const dateHeader = new Date(Math.floor(server() / 1000) * 1000).toUTCString();
  local += 40;
  assert.equal(clock.fromDate(dateHeader, local - 40, local), true);
  assert.ok(Math.abs(clock.now() - server()) <= 1_000);
  const sent = local;
  local += 80;
  assert.equal(clock.fromServer(server() - 40, sent, local), true, "enter's now replaces the rougher Date header");
  assert.ok(Math.abs(clock.now() - server()) <= 2, `off by ${clock.now() - server()} ms`);
  // A rough Date header that agrees does not replace it.
  const before = clock.offset();
  assert.equal(clock.fromDate(new Date(Math.floor(server() / 1000) * 1000).toUTCString(), local, local + 30), false);
  assert.equal(clock.offset(), before);

  // A laptop sleeps for 8 hours: performance.now() would stop, Date.now() does not.
  local += 8 * 60 * MIN;
  assert.ok(Math.abs(clock.now() - server()) <= 2, 'no drift after a sleep gap');

  // The device's clock is set forward by 2 minutes (NTP after waking): serverNow is off until re-measured...
  local += 120_000;
  const truth = local - skew - 120_000;
  assert.ok(Math.abs(clock.now() - truth - 120_000) <= 2);
  // ...and the next Date header, rough as it is, wins because it disagrees by far more than both error bounds.
  const header = new Date(Math.floor(truth / 1000) * 1000).toUTCString();
  assert.equal(clock.fromDate(header, local - 30, local), true);
  assert.ok(Math.abs(clock.now() - truth) <= 1_000, `off by ${clock.now() - truth} ms after the jump`);
  assert.equal(clock.fromDate('not a date', local, local), false);
});

test('room player: native HLS only on Apple WebKit that says it plays HLS; hls.js everywhere else', () => {
  const safari = { vendor: 'Apple Computer, Inc.', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15', canPlayHls: 'maybe' };
  const iosChrome = { vendor: 'Apple Computer, Inc.', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1', canPlayHls: 'maybe' };
  const chrome = { vendor: 'Google Inc.', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36', canPlayHls: 'maybe' };
  const firefox = { vendor: '', userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0', canPlayHls: '' };
  assert.equal(choosePlayer(safari), 'native');
  assert.equal(choosePlayer(iosChrome), 'native', 'every iOS browser is WebKit');
  assert.equal(choosePlayer(chrome), 'hls', "Chrome's own HLS is not used");
  assert.equal(choosePlayer(firefox), 'hls');
  assert.equal(choosePlayer({ ...safari, canPlayHls: '' }), 'hls');
  assert.equal(choosePlayer({ ...firefox, mse: false }), 'none');
});

test('room answers: plain text; only links to the site itself are clickable', () => {
  const pieces = answerPieces('See https://doorstub.pages.dev, or https://github.com/tedinroc/doorstub. Also https://evil.example/x.', { origin: 'http://127.0.0.1:5000' });
  assert.deepEqual(pieces, [
    { text: 'See ' },
    { text: 'https://doorstub.pages.dev', href: 'https://doorstub.pages.dev' },
    { text: ', or ' },
    { text: 'https://github.com/tedinroc/doorstub' },
    { text: '. Also ' },
    { text: 'https://evil.example/x' },
    { text: '.' },
  ]);
  assert.deepEqual(answerPieces('https://user:pw@doorstub.pages.dev/'), [{ text: 'https://user:pw@doorstub.pages.dev/' }]);
  assert.deepEqual(answerPieces('<b>bold</b>'), [{ text: '<b>bold</b>' }], 'markup stays text');
});

// ------------------------------------------------------------------ the controller, with a fake window

const fakeWindow = (hash) => {
  const timers = [];
  let nextId = 1;
  const win = {
    location: { hash, href: `https://doorstub.pages.dev/room/${hash}`, origin: 'https://doorstub.pages.dev', reload() {} },
    setTimeout: (fn, ms) => {
      timers.push({ id: nextId, fn, ms });
      nextId += 1;
      return nextId - 1;
    },
    clearTimeout: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    setInterval: () => 0,
    clearInterval: () => {},
    document: { visibilityState: 'visible', addEventListener() {} },
    addEventListener() {},
    navigator: { vendor: '', userAgent: 'node', clipboard: { writeText: async () => {} } },
  };
  return { win, timers };
};
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
};
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', date: new Date(T0 - 60 * MIN).toUTCString(), ...headers } });

test('room controller: enter retries until it answers, a bad pass ends in the bad-link state, and the receipt waits for it', async () => {
  const { win, timers } = fakeWindow(FRAGMENT);
  const answers = [() => json(503, { error: { code: 'room-not-configured' } }), () => new Response('<html>1102</html>', { status: 200 }), () => Promise.reject(new TypeError('offline')), () => json(200, { show: 'screening-1', title: 'Doorstub screening 1', seatLabel: 'S-0-12', eventAt: '2026-11-24T13:00:00Z', durationMin: 25, now: T0 - 60 * MIN, opensUntil: '2026-11-24T13:35:00Z' })];
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([url, init?.method ?? 'GET']);
    if (url === '/shows.json') return json(200, { version: 1, shows: [{ id: 'screening-1', kind: 'real', title: 'Doorstub screening 1', eventAt: '2026-11-24T13:00:00Z', durationMin: 25 }] });
    if (url.endsWith('/room.json')) return json(200, { film: { seconds: 675.8, version: 'a1' }, preview: null });
    if (url === '/api/room/enter') return answers.shift()();
    throw new Error(`unexpected ${url}`);
  };
  const room = createRoomController({ win, fetchImpl, now: () => T0 - 60 * MIN });
  room.start();
  await flush();
  assert.equal(room.store.get().stage, 'ready', 'the static files alone give the countdown');
  assert.equal(room.store.get().verified, false);
  assert.deepEqual(roomView(room.store.get()).receipt, []);
  // Enter is down (503), but the chat runs in the page: it opens, and answers, with no seat text.
  assert.equal(room.store.get().retrying, true);
  assert.equal(roomView(room.store.get()).chat, 'open');
  assert.equal(room.actions.ask('What is Doorstub?'), true, 'a question is answered while enter is retried');
  assert.equal(room.store.get().transcript.at(-1).answers[0].id, 'what-is-doorstub');
  const delays = [];
  while (!room.store.get().verified) {
    assert.equal(timers.length, 1, 'one retry waits');
    const t = timers.shift();
    delays.push(t.ms);
    t.fn();
    await flush();
  }
  assert.deepEqual(delays, [1_500, 3_000, 6_000]);
  assert.equal(roomView(room.store.get()).receipt[0], 'Seat S-0-12 · your check-in is on chain: abababab…abab.');
  assert.equal(room.store.get().closesAtMs, T0 + 35 * MIN);
  assert.deepEqual(calls.filter(([u]) => u === '/api/room/enter').map(([, m]) => m), ['POST', 'POST', 'POST', 'POST']);

  const bad = fakeWindow(FRAGMENT);
  const badRoom = createRoomController({ win: bad.win, fetchImpl: async (url) => (url === '/api/room/enter' ? json(403, { error: { code: 'bad-pass' } }) : fetchImpl(url)), now: () => T0 - 60 * MIN });
  badRoom.start();
  await flush();
  assert.equal(badRoom.store.get().stage, 'invalid');
  assert.deepEqual(roomView(badRoom.store.get()).lines, [ROOM_SENTENCES.badLink]);
  assert.equal(bad.timers.length, 0, 'a bad pass is not retried');

  const broken = createRoomController({ win: fakeWindow('#show=x').win, fetchImpl: async () => assert.fail('no request for a broken link') });
  broken.start();
  assert.equal(broken.store.get().stage, 'invalid');

  // A request that never answers (a captive portal, a dead phone link) is given up after FETCH_TIMEOUT_MS
  // and retried like a network error, so the chat does not wait minutes on "Connecting to the room…".
  const hung = fakeWindow(FRAGMENT);
  let hangs = 0;
  const hangingFetch = async (url, init) => {
    if (url !== '/api/room/enter') return fetchImpl(url, init);
    hangs += 1;
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  };
  const hungRoom = createRoomController({ win: hung.win, fetchImpl: hangingFetch, now: () => T0 - 60 * MIN });
  hungRoom.start();
  await flush();
  assert.equal(hungRoom.store.get().retrying, false);
  assert.equal(roomView(hungRoom.store.get()).chat, 'connecting');
  const abort = hung.timers.find((t) => t.ms === FETCH_TIMEOUT_MS);
  assert.ok(abort !== undefined && hung.timers.length === 1, 'only the hanging enter is waiting (the static files answered and cleared their timers)');
  hung.timers.splice(hung.timers.indexOf(abort), 1);
  abort.fn();
  await flush();
  assert.equal(hungRoom.store.get().retrying, true, 'the hung enter counts as a network error');
  assert.equal(roomView(hungRoom.store.get()).chat, 'open');
  assert.deepEqual(hung.timers.map((t) => t.ms), [1_500], 'and is retried');
  assert.equal(hangs, 1);
  hungRoom.stop();
});

test('room chat: chips and typed questions are answered in the page; a pasted seed phrase is refused, never echoed and never sent', async () => {
  const { win } = fakeWindow(FRAGMENT);
  let requests = 0;
  const fetchImpl = async (url) => {
    requests += 1;
    if (url === '/shows.json') return json(200, { version: 1, shows: [] });
    if (url.endsWith('/room.json')) return json(200, { film: { seconds: 60, version: 'a1' }, preview: null });
    return json(200, { show: 'screening-1', title: 'Doorstub screening 1', seatLabel: 'S-0-12', eventAt: '2026-11-24T13:00:00Z', durationMin: 25, now: T0 - MIN, opensUntil: '2026-11-24T13:35:00Z' });
  };
  const room = createRoomController({ win, fetchImpl, now: () => T0 - MIN });
  assert.equal(room.actions.ask('What is Doorstub?'), false, 'no chat before enter has answered');
  room.start();
  await flush();
  assert.equal(room.store.get().verified, true);
  const sent = requests;

  assert.ok(CHIPS.length >= 4 && CHIPS.length <= 6);
  room.actions.chip('room-how');
  room.actions.ask('Can I get a refund for this screening?');
  room.actions.ask(`my wallet words: ${SEED}`);
  room.actions.ask('  ');
  const t = room.store.get().transcript;
  assert.deepEqual(
    t.map((i) => (i.kind === 'question' ? `Q:${i.text}` : `A:${i.via}:${i.answers.map((a) => a.id).join(',')}`)),
    ['Q:How does the room work?', 'A:chip:room-how', 'Q:Can I get a refund for this screening?', 'A:match:refund-screening', 'A:refusal:refusal-secret'],
  );
  assert.ok(!JSON.stringify(t).includes('abandon'), 'the phrase is not kept or shown');
  assert.equal(requests, sent, 'answering made no request');
  assert.equal(fill(ROOM_SENTENCES.fromFaq, { q: t[1].answers[0].q }), 'From the FAQ: How does the room work?');
});

/** A <video> stand-in: native HLS (Apple WebKit), so no hls.js import. */
const fakeVideo = () => {
  const listeners = {};
  const attrs = {};
  const el = {
    muted: false,
    paused: true,
    currentTime: 0,
    readyState: 4,
    playbackRate: 1,
    dataset: {},
    addEventListener: (type, fn) => (listeners[type] ??= []).push(fn),
    canPlayType: () => 'maybe',
    getAttribute: (name) => attrs[name] ?? null,
    removeAttribute: (name) => delete attrs[name],
    set src(v) {
      attrs.src = v;
    },
    get src() {
      return attrs.src ?? '';
    },
    load() {},
    play() {
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      this.paused = true;
    },
  };
  const end = () => {
    el.paused = true;
    for (const fn of listeners.ended ?? []) fn();
  };
  return { el, end };
};

test('room controller: a preview watched to its end before the start, or a synced film sent to its end early, still starts (or rejoins) the screening', async () => {
  let local = T0 - 10 * MIN;
  let interval = null;
  const { win } = fakeWindow(FRAGMENT);
  win.setInterval = (fn) => {
    interval = fn;
    return 1;
  };
  win.navigator = { vendor: 'Apple Computer, Inc.', userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15', clipboard: { writeText: async () => {} } };
  const fetchImpl = async (url) => {
    const date = { date: new Date(local).toUTCString() };
    if (url === '/shows.json') return json(200, { version: 1, shows: [{ id: 'screening-1', kind: 'real', title: 'Doorstub screening 1', eventAt: '2026-11-24T13:00:00Z', durationMin: 25 }] }, date);
    if (url.endsWith('/room.json')) return json(200, { film: { seconds: 675.8, version: 'a1' }, preview: { seconds: 120, version: 'b1' } }, date);
    return json(200, { show: 'screening-1', title: 'Doorstub screening 1', seatLabel: 'S-0-12', eventAt: '2026-11-24T13:00:00Z', durationMin: 25, now: local, opensUntil: '2026-11-24T13:35:00Z' }, date);
  };
  const video = fakeVideo();
  const room = createRoomController({ win, fetchImpl, now: () => local });
  room.start();
  await flush();
  room.attachVideo(video.el);
  interval();
  await flush();
  assert.equal(room.store.get().phase, 'before');

  room.actions.watchPreview();
  await flush();
  assert.equal(room.store.get().mode, 'free-preview');
  assert.match(video.el.src, /\/preview\.m3u8$/);
  video.end();
  await flush();
  assert.equal(room.store.get().mode, 'none', 'the preview ended: back to waiting');
  const waiting = roomView(room.store.get());
  assert.equal(waiting.screen, 'countdown');
  assert.equal(waiting.preview, true, 'Watch the preview is offered again');

  local = T0 + 5_000;
  interval();
  await flush();
  let s = room.store.get();
  assert.equal(s.mode, 'sync', 'the screening starts at its time after the preview');
  assert.ok(['film', 'tap'].includes(roomView(s).screen), roomView(s).screen);
  assert.match(video.el.src, /\/film\.m3u8$/);
  assert.equal(video.el.paused, false);
  assert.ok(Math.abs(video.el.currentTime - 5) < 1, `seeks to where the screening is (${video.el.currentTime})`);

  // The film's controls sent it to its end while the screening still runs: it rejoins where everyone is.
  local = T0 + 60_000;
  video.el.currentTime = 675.8;
  video.end();
  await flush();
  s = room.store.get();
  assert.equal(s.mode, 'sync');
  assert.equal(video.el.paused, false);
  assert.ok(Math.abs(video.el.currentTime - 60) < 1, `rejoined at ${video.el.currentTime}`);

  // The film's own end: done.
  local = T0 + 675_000;
  video.end();
  await flush();
  assert.equal(room.store.get().mode, 'done');
  room.stop();
});

test('room controller: a slow /shows.json is read once, however many ticks run while it is out', async () => {
  let local = T0 - 60 * MIN;
  let interval = null;
  const { win } = fakeWindow(FRAGMENT);
  win.setInterval = (fn) => {
    interval = fn;
    return 1;
  };
  const held = [];
  let reads = 0;
  const showsBody = { version: 1, shows: [{ id: 'screening-1', kind: 'real', title: 'Doorstub screening 1', eventAt: '2026-11-24T13:00:00Z', durationMin: 25 }] };
  const fetchImpl = async (url) => {
    if (url === '/shows.json') {
      reads += 1;
      return new Promise((resolve) => held.push(() => resolve(json(200, showsBody, { date: new Date(local).toUTCString() }))));
    }
    if (url.endsWith('/room.json')) return json(200, { film: { seconds: 675.8, version: 'a1' }, preview: null });
    return json(200, { show: 'screening-1', title: 'Doorstub screening 1', seatLabel: 'S-0-12', eventAt: '2026-11-24T13:00:00Z', durationMin: 25, now: local, opensUntil: '2026-11-24T13:35:00Z' });
  };
  const room = createRoomController({ win, fetchImpl, now: () => local });
  const ticks = async (n) => {
    for (let i = 0; i < n; i += 1) {
      local += 500;
      interval();
      await flush();
    }
  };
  room.start();
  await flush();
  // Enter answered (so the countdown runs), but the first /shows.json is still out: the ticks wait for it.
  assert.equal(room.store.get().phase, 'before');
  await ticks(20);
  assert.equal(reads, 1, 'one read in flight across 20 ticks');
  held.shift()();
  await flush();
  await ticks(4);
  assert.equal(reads, 1, 'no new read right after one answered');

  // Ten minutes on, the clock is re-measured: one read, held again across the ticks.
  local += REMEASURE_EVERY_MS;
  await ticks(20);
  assert.equal(reads, 2, 'the re-measure is one read, not one per tick');
  assert.equal(held.length, 1);
  held.shift()();
  await flush();
  await ticks(4);
  assert.equal(reads, 2);
  room.stop();
});

// ------------------------------------------------------------------ words

const ALL = () => [...Object.entries(ROOM_SENTENCES), ...Object.entries(ROOM_LABELS)];

test('room copy: no word CLAIMS.md section 3 rules out, no "live", no first person, no promise to answer', () => {
  const banned = [
    [/\bthe first\b|\bfirst (?:to|ever|of its kind)\b/i, 'first'],
    [/\bnew\b/i, 'new'],
    [/\bthe only\b/i, 'the only'],
    [/never been done/i, 'never been done'],
    [/full refund/i, 'full refund'],
    [/before the show/i, 'before the show'],
    [/back on sale/i, 'your seat goes back on sale'],
    [/automatic/i, 'automatic'],
    [/trustless/i, 'trustless entry'],
    [/\bguarantee/i, 'a promise of entry'],
    [/\blive\b/i, 'live'],
    [/\bcall\b/i, 'call (the room says screening)'],
    [/will answer|reads every question|good question/i, 'a promise to answer'],
    [/\b(?:I|me|my|we|our|us)\b/, 'first person'],
  ];
  for (const [key, text] of ALL()) for (const [re, word] of banned) assert.doesNotMatch(text, re, `${key} uses "${word}": ${text}`);
  assert.equal(say('receipt', { seat: 'S-0-1', txid: 'x' }), 'Seat S-0-1 · your check-in is on chain: x.');
  assert.throws(() => say('nope'), /no room sentence/);
});

const claims = readFileSync(join(root, 'CLAIMS.md'), 'utf8');
const section = (n) => {
  const start = claims.indexOf(`\n## ${n}.`);
  if (start < 0) return '';
  const next = claims.indexOf('\n## ', start + 4);
  return claims.slice(start, next < 0 ? undefined : next);
};
const listed = `${section(9)}\n${section(11)}`;
// Until CLAIMS.md carries the room's sentences (main session; .cache/room has the rows), this is a todo, not a pass.
const claimsHasRoom = listed.includes(ROOM_SENTENCES.noscript);

test('room copy: every sentence is in CLAIMS.md (section 9, or 11.1 for the chat), word for word', { todo: claimsHasRoom ? false : 'CLAIMS.md has no room sentences yet' }, () => {
  const missing = Object.entries(ROOM_SENTENCES).filter(([, text]) => !listed.includes(`\`${text}\``));
  assert.deepEqual(missing, [], `add these to CLAIMS.md:\n${missing.map(([k, t]) => `${k}: ${t}`).join('\n')}`);
});

test('room page head: noindex, and its title, description and no-JavaScript line are copy.js sentences', () => {
  const html = readFileSync(join(root, 'app/room/index.html'), 'utf8');
  const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  assert.match(html, /<meta name="robots" content="noindex" \/>/);
  // A second policy beside the site's header CSP: the room may connect only to its own origin (not the
  // site's Fulcrum servers, wallet relays or price APIs), and run no worker. First in <head>, before any
  // script or link, so it covers everything the page loads.
  const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]*)" \/>/.exec(html);
  assert.equal(meta?.[1], "connect-src 'self'; worker-src 'none'");
  assert.ok(meta.index < html.indexOf('<link') && meta.index < html.indexOf('<script'), 'the room CSP comes before any link or script');
  assert.equal(decode(/<title>([^<]*)<\/title>/.exec(html)[1]), ROOM_SENTENCES.pageTitle);
  assert.equal(decode(/<meta name="description" content="([^"]*)"/.exec(html)[1]), ROOM_SENTENCES.pageDescription);
  assert.equal(/<noscript>([^<]*)<\/noscript>/.exec(html)[1], ROOM_SENTENCES.noscript);
  assert.equal(ROOM_SENTENCES.noscript, 'This screening room needs JavaScript to play the film and the chat.');
  assert.doesNotMatch(html, /og:|twitter:/, 'an unlisted room has no link-preview card');
  assert.match(html, /src="\/src\/room\/main\.jsx"/);
});

// ------------------------------------------------------------------ what the room loads

test('room code: imports nothing from src/wallet, src/chain, libauth or WizardConnect, and never touches localStorage', () => {
  const seen = new Set();
  const external = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const body = readFileSync(file, 'utf8');
    assert.doesNotMatch(body, /localStorage|sessionStorage|indexedDB|document\.cookie/, `${relative(root, file)} touches browser storage`);
    for (const m of body.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (spec.startsWith('.')) {
        const target = resolve(dirname(file), spec);
        if (/\.(?:css)$/.test(target)) continue;
        visit(target);
      } else external.add(spec);
    }
  };
  visit(join(root, 'app/src/room/main.jsx'));
  const files = [...seen].map((f) => relative(root, f)).sort();
  for (const f of files) assert.doesNotMatch(f, /^src\/(?:wallet|chain|tx)\/|^app\/src\/lib\/(?:controller|api|view|runtime|dev|price|errors)\.js$|^app\/src\/env\.js$/, `the room imports ${f}`);
  assert.ok(files.includes('worker/lib/room-faq.js') && files.includes('worker/lib/room-match.js'), 'the assistant runs in the page');
  assert.deepEqual([...external].sort(), ['hls.js/light', 'preact', 'preact/hooks']);
});

test('room build: hls.js gets its own chunk before the vendor rule, Preact its own, and the room is a second Vite input', async () => {
  const { default: config } = await import('../app/vite.config.js');
  const c = config({ command: 'build', mode: 'production' });
  const chunk = c.build.rollupOptions.output.manualChunks;
  assert.equal(chunk('/r/node_modules/hls.js/dist/hls.light.mjs'), 'hls');
  assert.equal(chunk('/r/node_modules/preact/dist/preact.module.js'), 'preact');
  assert.equal(chunk('/r/node_modules/qrcode/lib/index.js'), 'vendor');
  assert.equal(chunk('/r/node_modules/@bitauth/libauth/build/index.js'), 'libauth');
  assert.equal(chunk('/r/app/src/room/state.js'), undefined);
  assert.deepEqual(Object.keys(c.build.rollupOptions.input), ['main', 'room']);
  for (const path of Object.values(c.build.rollupOptions.input)) assert.ok(path.startsWith('/') || /^[A-Za-z]:/.test(path), 'absolute input paths');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.match(pkg.dependencies['hls.js'], /^1\.\d+\.\d+$/, 'hls.js is pinned to an exact 1.x');
  const licences = readFileSync(join(root, 'app/public/licenses.txt'), 'utf8');
  assert.ok(licences.includes(`hls.js ${pkg.dependencies['hls.js']}`) && licences.includes('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION'));
  assert.ok(ROOM_SENTENCES.hlsCredit.includes('Apache License 2.0'));
});

// ------------------------------------------------------------------ _headers

/** Cloudflare Pages' rule matcher: one splat (.*), :placeholders ([^/]+). */
const pagesRules = () => {
  const text = readFileSync(join(root, 'app/public/_headers'), 'utf8');
  const rules = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || line.trim() === '') continue;
    if (!/^\s/.test(line)) {
      assert.ok((line.match(/\*/g) ?? []).length <= 1, `${line}: one splat at most`);
      const re = new RegExp(`^${line.trim().split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:(\w+)/g, '[^/]+')).join('.*')}$`);
      current = { path: line.trim(), re, headers: [] };
      rules.push(current);
    } else {
      const m = /^\s+([\w-]+):\s*(.+)$/.exec(line);
      current.headers.push([m[1].toLowerCase(), m[2]]);
    }
  }
  return (path) => {
    const out = {};
    for (const r of rules) {
      if (!r.re.test(path)) continue;
      for (const [k, v] of r.headers) {
        assert.equal(out[k], undefined, `${path}: ${k} is set by two rules (Pages would join them)`);
        out[k] = v;
      }
    }
    return out;
  };
};

test('room _headers: no header set twice; playlists and room.json no-cache, versioned files a day; types; noindex; media-src', () => {
  const headersFor = pagesRules();
  const room = headersFor('/room/');
  assert.equal(room['x-robots-tag'], 'noindex');
  assert.match(room['content-security-policy'], /media-src 'self' blob:;/);
  const f = 'ef'.repeat(16);
  for (const file of ['film.m3u8', 'preview.m3u8', 'room.json']) assert.equal(headersFor(`/room/media/${f}/${file}`)['cache-control'], 'no-cache', file);
  assert.equal(headersFor(`/room/media/${f}/film.m3u8`)['content-type'], 'application/vnd.apple.mpegurl');
  const v = `/room/media/${f}/a1b2c3d4e5f6/film/1080p`;
  assert.deepEqual(
    [`${v}/index.m3u8`, `${v}/init_0.mp4`, `${v}/seg-000.m4s`].map((p) => [headersFor(p)['cache-control'], headersFor(p)['content-type']]),
    [
      ['public, max-age=86400', 'application/vnd.apple.mpegurl'],
      ['public, max-age=86400', 'video/mp4'],
      ['public, max-age=86400', 'video/mp4'],
    ],
  );
  assert.equal(headersFor('/')['x-robots-tag'], undefined, 'the site itself stays indexable');
  assert.equal(headersFor('/shows.json')['cache-control'], 'no-cache');
});

// ------------------------------------------------------------------ the Node server and the media gate

test('room server: /room/ serves room/index.html; playlists and segments get their media types', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doorstub-room-'));
  try {
    mkdirSync(join(dir, 'room', 'media', 'f'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), '<p>site</p>');
    writeFileSync(join(dir, 'room', 'index.html'), '<p>room</p>');
    writeFileSync(join(dir, 'room', 'media', 'f', 'film.m3u8'), '#EXTM3U\n');
    writeFileSync(join(dir, 'room', 'media', 'f', 'seg-000.m4s'), 'x');
    writeFileSync(join(dir, 'room', 'media', 'f', 'init_0.mp4'), 'x');
    const server = await startWorkerServer({ env: { DOORSTUB_NETWORK: 'simnet', DOORSTUB_FULCRUM: 'ws://127.0.0.1:9' }, showsText: '{"version":1,"network":"simnet","shows":[]}', port: 0, staticRoot: dir, vm: false });
    try {
      const get = async (p) => {
        const r = await fetch(`${server.url}${p}`);
        return [r.status, r.headers.get('content-type'), await r.text()];
      };
      assert.deepEqual(await get('/room/'), [200, 'text/html; charset=utf-8', '<p>room</p>']);
      assert.deepEqual(await get('/'), [200, 'text/html; charset=utf-8', '<p>site</p>']);
      assert.deepEqual(await get('/nope'), [200, 'text/html; charset=utf-8', '<p>site</p>'], 'unknown paths fall back to the site, as on Pages');
      assert.equal((await get('/room/media/f/film.m3u8'))[1], 'application/vnd.apple.mpegurl');
      assert.equal((await get('/room/media/f/seg-000.m4s'))[1], 'video/mp4');
      assert.equal((await get('/room/media/f/init_0.mp4'))[1], 'video/mp4');
    } finally {
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const writeMedia = (dir, { master, variant, room = { film: { seconds: 8, version: 'v1' }, preview: null }, extra = {} } = {}) => {
  mkdirSync(join(dir, 'v1', 'film', '1080p'), { recursive: true });
  writeFileSync(join(dir, 'film.m3u8'), master ?? '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv1/film/1080p/index.m3u8\n');
  writeFileSync(join(dir, 'v1', 'film', '1080p', 'index.m3u8'), variant ?? '#EXTM3U\n#EXT-X-MAP:URI="init_0.mp4"\n#EXTINF:4.0,\nseg-000.m4s\n#EXTINF:4.0,\nseg-001.m4s\n#EXT-X-ENDLIST\n');
  for (const f of ['init_0.mp4', 'seg-000.m4s', 'seg-001.m4s']) writeFileSync(join(dir, 'v1', 'film', '1080p', f), Buffer.from('ftypiso5 moov VideoHandler'));
  writeFileSync(join(dir, 'room.json'), JSON.stringify(room));
  for (const [name, body] of Object.entries(extra)) writeFileSync(join(dir, name), body);
};

test('room media gate: size, extensions, byte ranges, http and absolute URIs, missing files, local paths, room.json and lengths', () => {
  const base = mkdtempSync(join(tmpdir(), 'doorstub-media-'));
  const words = [{ pattern: /someone-else/i, why: 'a handle other than tedinroc' }];
  const gate = (setup, options = {}) => {
    const dir = join(base, String(readdirSync(base).length));
    mkdirSync(dir);
    setup(dir);
    return gateRoomMedia(dir, { words, ...options }).problems;
  };
  try {
    assert.deepEqual(gate((d) => writeMedia(d)), []);
    assert.match(gate((d) => writeMedia(d, { extra: { 'notes.txt': 'x' } })).join(), /extension \.txt/);
    assert.match(gate((d) => writeMedia(d, { variant: '#EXTM3U\n#EXT-X-BYTERANGE:10@0\n#EXTINF:8.0,\nseg-000.m4s\n' })).join(), /BYTERANGE/);
    assert.match(gate((d) => writeMedia(d, { variant: '#EXTM3U\n#EXTINF:8.0,\nhttps://cdn.example/seg-000.m4s\n' })).join(), /"http"/);
    assert.match(gate((d) => writeMedia(d, { variant: '#EXTM3U\n#EXTINF:8.0,\n/abs/seg-000.m4s\n' })).join(), /not relative/);
    assert.match(gate((d) => writeMedia(d, { variant: '#EXTM3U\n#EXTINF:8.0,\nseg-009.m4s\n' })).join(), /missing file/);
    assert.match(gate((d) => writeMedia(d, { variant: '#EXTM3U\n#EXTINF:4.0,\nseg-000.m4s\n' })).join(), /4\.0 s, room\.json says 8 s/);
    assert.match(gate((d) => writeMedia(d, { room: { film: null, preview: null } })).join(), /no film|film\.m3u8 exists/);
    assert.match(gate((d) => writeMedia(d, { room: { film: { seconds: 8, version: 'v2' }, preview: null } })).join(), /not under v2\/film\//);
    assert.match(gate((d) => writeMedia(d, { extra: { 'room.json': '{"film":' } })).join(), /not JSON/);
    assert.match(
      gate((d) => {
        writeMedia(d);
        writeFileSync(join(d, 'v1', 'film', '1080p', 'init_0.mp4'), Buffer.concat([Buffer.from([0, 1]), Buffer.from('encoded by someone-else'), Buffer.from([0])]));
      }).join(),
      /forbidden word/,
    );
    assert.match(
      gate((d) => {
        writeMedia(d);
        writeFileSync(join(d, 'v1', 'film', '1080p', 'init_0.mp4'), Buffer.from(`\0${['', 'Users', 'someone', 'film.mov'].join('/')}\0`));
      }).join(),
      /local path/,
    );
    assert.match(
      gate((d) => {
        writeMedia(d);
        truncateSync(join(d, 'v1', 'film', '1080p', 'seg-001.m4s'), 25 * 1024 * 1024);
      }).join(),
      /25 MiB/,
    );
    assert.match(gate((d) => writeMedia(d, { extra: { '.DS_Store': 'x' } })).join(), /extension/, 'a deployed folder fails on a dot file');
    assert.deepEqual(gate((d) => writeMedia(d, { extra: { '.DS_Store': 'x' } }), { skipDot: true }), [], 'a source folder skips it');
    assert.deepEqual(printableStrings(Buffer.from([0, 0x41, 0x42, 0x43, 0x44, 0, 0x41])), ['ABCD']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('room pass: the page sends exactly what the worker signs (show, seat label, txid)', () => {
  const pass = roomPass(KEY, 'screening-1', 'S-0-12', TXID);
  const parsed = parseFragment(`#show=screening-1&seat=S-0-12&txid=${TXID}&pass=${pass}&m=${'ef'.repeat(16)}`);
  assert.equal(parsed.pass, pass);
  assert.equal(roomPass(KEY, parsed.show, parsed.seat, parsed.txid), pass);
});
