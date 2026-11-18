// The screening room's worker side (worker/lib/room.js): the pass and the
// media folder, POST /api/room/enter (shapes, errors, the rehearsal show,
// routed before the door's shows.json parse), /api/health's room status, the
// rate limit, ROOM_KEY in the config (errors never echo a value), and that
// no guest text reaches a log. No chain and no network: the chain client is
// a stub and shows.json is given as text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import { handleApi } from '../worker/lib/api.js';
import { bytesToHex, hexToBytes } from '../worker/lib/bytes.js';
import { workerConfig } from '../worker/lib/config.js';
import { createRateLimiter, DEFAULT_LIMITS } from '../worker/lib/limits.js';
import {
  checkPass,
  createRoomShowsCache,
  enterRoom,
  isSeatLabel,
  opensUntilMs,
  readRoomShows,
  rehearsalEventAt,
  REHEARSAL,
  roomMediaFolder,
  roomPass,
  sameInConstantTime,
} from '../worker/lib/room.js';
import { createNodeWorker } from '../worker/node/handler.js';
import { onRequest } from '../functions/api/[[route]].js';

const KEY_HEX = '5e'.repeat(32);
const KEY = hexToBytes(KEY_HEX);
const TXID = 'ab'.repeat(32);
const ORIGIN = 'https://doorstub.pages.dev';
const TEMPLATE = `${ORIGIN}/room/#show={show}&seat={seat}&txid={txid}&pass={pass}&m={media}`;
const SHOWS = {
  version: 1,
  network: 'simnet',
  origin: ORIGIN,
  shows: [
    { id: 'screening-1', kind: 'real', title: 'Doorstub screening 1', eventAt: '2026-11-24T13:00:00Z', durationMin: 25 },
    { id: 'screening-2', kind: 'real', title: 'Doorstub screening 2', eventAt: '2026-11-28T05:00:00Z', durationMin: 25 },
    { id: 'sample-a', kind: 'sample-settle', title: 'Sample A' },
    { id: 'broken', kind: 'real', title: 'No time', durationMin: 25 },
  ],
};
const SHOWS_TEXT = JSON.stringify(SHOWS);
const NOW = Date.parse('2026-11-20T10:03:30Z');

const body = (overrides = {}) => {
  const b = { show: 'screening-1', seat: 'S-0-1', txid: TXID, ...overrides };
  return { ...b, pass: overrides.pass ?? roomPass(KEY, b.show, b.seat, b.txid) };
};

/** handleApi with stubs: no chain, shows from text, a clock, and every log line kept. */
const api = (overrides = {}) => {
  const logs = [];
  const roomShows = createRoomShowsCache({ network: 'simnet' });
  const deps = {
    network: 'simnet',
    configErrors: [],
    dataKey: null,
    doorLinks: { 'screening-1': TEMPLATE, 'screening-2': TEMPLATE },
    roomKey: KEY,
    loadShows: async () => ({ shows: [], rejected: [] }),
    roomShows: () => roomShows(async () => SHOWS_TEXT),
    openChain: () => ({ tip: async () => 977_700, close: () => {} }),
    claims: { kind: 'memory' },
    limiter: createRateLimiter(),
    clientIp: '203.0.113.5',
    now: () => NOW,
    log: (line) => logs.push(line),
    ...overrides,
  };
  const call = async (path, init) => {
    const response = await handleApi(new Request(`${ORIGIN}${path}`, init), deps);
    return { status: response.status, body: await response.json() };
  };
  const enter = (b) => call('/api/room/enter', { method: 'POST', body: typeof b === 'string' ? b : JSON.stringify(b) });
  return { deps, logs, call, enter };
};

test('room pass and media folder: HMAC-SHA256 with domain separation, first 32 hex; checkPass compares in constant time', () => {
  const expected = bytesToHex(hmac(sha256, KEY, new TextEncoder().encode(`doorstub-room-v1\nscreening-1\nS-0-1\n${TXID}`))).slice(0, 32);
  assert.equal(roomPass(KEY, 'screening-1', 'S-0-1', TXID), expected);
  assert.equal(roomPass(KEY_HEX, 'screening-1', 'S-0-1', TXID), expected, 'the key as hex or bytes');
  assert.equal(roomPass(KEY, 'screening-1', 'S-0-1', TXID), roomPass(KEY, 'screening-1', 'S-0-1', TXID), 'stable');
  for (const other of [roomPass(KEY, 'screening-2', 'S-0-1', TXID), roomPass(KEY, 'screening-1', 'S-0-2', TXID), roomPass(KEY, 'screening-1', 'S-0-1', 'cd'.repeat(32)), roomPass('11'.repeat(32), 'screening-1', 'S-0-1', TXID)]) {
    assert.notEqual(other, expected);
  }
  assert.equal(roomMediaFolder(KEY), bytesToHex(hmac(sha256, KEY, new TextEncoder().encode('doorstub-room-media-v1'))).slice(0, 32));
  assert.match(roomMediaFolder(KEY), /^[0-9a-f]{32}$/);
  assert.notEqual(roomMediaFolder(KEY), roomMediaFolder('11'.repeat(32)));

  assert.equal(checkPass(KEY, 'screening-1', 'S-0-1', TXID, expected), true);
  assert.equal(checkPass(KEY, 'screening-1', 'S-0-1', TXID, expected.toUpperCase()), true);
  for (const bad of [`0${expected.slice(1)}` === expected ? `1${expected.slice(1)}` : `0${expected.slice(1)}`, `${expected.slice(0, 31)}${expected[31] === '0' ? '1' : '0'}`, expected.slice(0, 30), `${expected}00`, 'zz'.repeat(16), undefined, 42]) {
    assert.equal(checkPass(KEY, 'screening-1', 'S-0-1', TXID, bad), false, String(bad));
  }
  // The comparison reads every byte whether the first or the last one differs.
  const counted = (bytes) => {
    const reads = { n: 0 };
    const proxy = new Proxy(bytes, {
      get(target, prop) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) reads.n += 1;
        return Reflect.get(target, prop);
      },
    });
    return { proxy, reads };
  };
  const a = hexToBytes(expected);
  for (const position of [0, 15]) {
    const b = a.slice();
    b[position] ^= 1;
    const left = counted(a);
    const right = counted(b);
    assert.equal(sameInConstantTime(left.proxy, right.proxy), false);
    assert.equal(left.reads.n, 16, `all 16 bytes read when byte ${position} differs`);
    assert.equal(right.reads.n, 16);
  }
  assert.equal(sameInConstantTime(a, a.slice()), true);
  assert.equal(sameInConstantTime(a, a.slice(0, 15)), false);
  const source = readFileSync(new URL('../worker/lib/room.js', import.meta.url), 'utf8');
  assert.match(source, /return sameInConstantTime\(expected, /, 'checkPass uses the constant-time comparison');
});

test('room enter: answer shape, every refusal, and the rehearsal show', async () => {
  const { enter } = api();
  const ok = await enter(body());
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body, {
    show: 'screening-1',
    title: 'Doorstub screening 1',
    seatLabel: 'S-0-1',
    eventAt: '2026-11-24T13:00:00Z',
    durationMin: 25,
    now: NOW,
    opensUntil: '2026-11-24T13:35:00Z',
  });
  assert.equal(Object.keys(ok.body).some((k) => /media|folder|pass/i.test(k)), false, 'the media folder and pass are not echoed');
  assert.equal((await enter(body({ txid: TXID.toUpperCase(), pass: roomPass(KEY, 'screening-1', 'S-0-1', TXID).toUpperCase() }))).status, 200, 'hex in either case');

  const refusals = [
    ['[]', 400, 'bad-request'],
    ['not json', 400, 'bad-request'],
    [{ ...body(), show: 'Screening-1' }, 400, 'bad-request'],
    [{ ...body(), show: 'x'.repeat(41) }, 400, 'bad-request'],
    [{ ...body(), seat: 's-0-1' }, 400, 'bad-request'],
    [{ ...body(), seat: 'S-256-1' }, 400, 'bad-request'],
    [{ ...body(), seat: 'S-0-65536' }, 400, 'bad-request'],
    [{ ...body(), seat: 'S-01-1' }, 400, 'bad-request'],
    [{ ...body(), txid: 'ab' }, 400, 'bad-request'],
    [{ ...body(), pass: 'ab'.repeat(15) }, 400, 'bad-request'],
    [{ ...body(), pass: 'zz'.repeat(16) }, 400, 'bad-request'],
    [body({ pass: roomPass(KEY, 'screening-2', 'S-0-1', TXID) }), 403, 'bad-pass'],
    [{ ...body(), seat: 'S-0-2' }, 403, 'bad-pass'],
    [body({ show: 'sample-a' }), 404, 'unknown-show'],
    [body({ show: 'broken' }), 404, 'unknown-show'],
    [body({ show: 'screening-9' }), 404, 'unknown-show'],
  ];
  for (const [b, status, code] of refusals) {
    const r = await enter(b);
    assert.equal(r.status, status, `${JSON.stringify(b)} -> ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.code, code);
  }
  // Without ROOM_KEY nothing can be checked: 503 for any well-formed request, before the pass.
  const keyless = await api({ roomKey: null }).enter(body());
  assert.equal(keyless.status, 503);
  assert.equal(keyless.body.error.code, 'room-not-configured');
  assert.equal((await api({ roomKey: null }).enter({ ...body(), seat: 'bad' })).status, 400, 'shapes first');

  // The rehearsal: not in shows.json; the next 5-minute mark at least 2 minutes away; 25 minutes.
  const rehearsal = await enter(body({ show: 'rehearsal', seat: 'R-0-1' }));
  assert.equal(rehearsal.status, 200, JSON.stringify(rehearsal.body));
  assert.deepEqual(rehearsal.body, {
    show: 'rehearsal',
    title: 'Doorstub rehearsal',
    seatLabel: 'R-0-1',
    eventAt: '2026-11-20T10:10:00Z',
    durationMin: 25,
    now: NOW,
    opensUntil: '2026-11-20T10:45:00Z',
  });
  assert.deepEqual(REHEARSAL, { id: 'rehearsal', title: 'Doorstub rehearsal', durationMin: 25 });
  assert.equal(rehearsalEventAt(Date.parse('2026-11-20T10:03:00Z')), Date.parse('2026-11-20T10:05:00Z'), 'exactly 2 minutes away is enough');
  assert.equal(rehearsalEventAt(Date.parse('2026-11-20T10:03:00.001Z')), Date.parse('2026-11-20T10:10:00Z'));
  assert.equal(rehearsalEventAt(Date.parse('2026-11-20T10:58:00Z')), Date.parse('2026-11-20T11:00:00Z'));
  assert.equal(rehearsalEventAt(NOW, 5), NOW + 5_000, 'a lead (simnet only) replaces the 5-minute mark');
  assert.equal((await enter(body({ show: 'rehearsal', seat: 'R-0-1', pass: roomPass(KEY, 'screening-1', 'R-0-1', TXID) }))).status, 403, 'a rehearsal pass needs ROOM_KEY too');
  const led = await api({ rehearsalLeadS: 20 }).enter(body({ show: 'rehearsal', seat: 'R-0-1' }));
  assert.equal(led.body.eventAt, '2026-11-20T10:03:50Z');
  assert.equal(opensUntilMs(0, 25), 35 * 60_000);
});

test('room enter runs before the door parses shows.json, and reads shows.json lightly', async () => {
  let loads = 0;
  const { enter, call } = api({
    loadShows: async () => {
      loads += 1;
      throw new Error('parseWorkerShows would throw here');
    },
  });
  assert.equal((await enter(body())).status, 200);
  assert.equal(loads, 0, 'enter never calls loadShows');
  const health = await call('/api/health');
  assert.equal(health.body.ok, false, 'the door\'s parse failed');
  assert.deepEqual(health.body.room, { configured: true, media: false, links: 'room' }, 'the room status does not depend on it');

  assert.deepEqual(readRoomShows(SHOWS_TEXT, { network: 'simnet' }), {
    origin: ORIGIN,
    shows: [
      { id: 'screening-1', kind: 'real', title: 'Doorstub screening 1', eventAt: '2026-11-24T13:00:00Z', durationMin: 25 },
      { id: 'screening-2', kind: 'real', title: 'Doorstub screening 2', eventAt: '2026-11-28T05:00:00Z', durationMin: 25 },
    ],
  });
  assert.throws(() => readRoomShows(SHOWS_TEXT, { network: 'mainnet' }), (e) => e.code === 'wrong-network');
  assert.throws(() => readRoomShows('{', { network: 'simnet' }), (e) => e.code === 'bad-shows');
  assert.throws(() => readRoomShows('{"version":2,"shows":[]}', { network: 'simnet' }), (e) => e.code === 'bad-shows');
  // Cached per text.
  let reads = 0;
  const cache = createRoomShowsCache({ network: 'simnet' });
  const text = async () => {
    reads += 1;
    return SHOWS_TEXT;
  };
  const first = await cache(text);
  assert.equal(await cache(text), first);
  assert.equal(reads, 2);
  // A shows.json that cannot be read is a retryable 500, not a bad pass.
  const down = await api({ roomShows: async () => { throw new Error('shows.json answered 503'); } }).enter(body());
  assert.equal(down.status, 500);
  assert.equal(down.body.error.retryable, true);
  assert.equal((await api({ roomShows: undefined }).enter(body())).status, 503, 'an adapter without the room reader');
  assert.equal((await api({ roomShows: undefined }).enter(body({ show: 'rehearsal', seat: 'R-0-1' }))).status, 200, 'the rehearsal reads no shows');
  assert.equal(isSeatLabel('S-255-65535'), true);
});

test('health: a top-level room status of booleans and a word; door.shows configured is false for a room link without ROOM_KEY', async () => {
  const realShows = SHOWS.shows.slice(0, 2).map((s) => ({ ...s, door: { endpoint: '/api/door' } }));
  const loadShows = async () => ({ shows: realShows, rejected: [] });
  const health = async (overrides) => (await api({ loadShows, ...overrides }).call('/api/health')).body;

  const ready = await health({ roomMediaReady: async () => true });
  assert.deepEqual(ready.room, { configured: true, media: true, links: 'room' });
  assert.deepEqual(ready.door.shows, [{ id: 'screening-1', configured: true }, { id: 'screening-2', configured: true }]);
  assert.equal(JSON.stringify(ready).includes(roomMediaFolder(KEY)), false, 'the media folder is never shown');
  assert.equal(JSON.stringify(ready).includes(KEY_HEX), false);

  assert.deepEqual((await health({ roomMediaReady: async () => false })).room, { configured: true, media: false, links: 'room' });
  assert.deepEqual((await health({ roomMediaReady: async () => { throw new Error('ASSETS down'); } })).room, { configured: true, media: false, links: 'room' });
  assert.deepEqual((await health({ doorLinks: null })).room, { configured: true, media: false, links: 'none' });
  assert.deepEqual((await health({ doorLinks: { 'screening-1': TEMPLATE } })).room.links, 'other', 'one real show without a link');
  assert.deepEqual((await health({ doorLinks: { 'screening-1': TEMPLATE, 'screening-2': 'https://meet.example.org/abc-defg-hij' } })).room.links, 'other');
  assert.deepEqual((await health({ doorLinks: { 'screening-1': TEMPLATE.replace(ORIGIN, 'https://example.org'), 'screening-2': TEMPLATE } })).room.links, 'other');
  assert.deepEqual((await health({ doorLinks: { 'screening-1': TEMPLATE.replace('&pass={pass}', ''), 'screening-2': TEMPLATE } })).room.links, 'other');

  const keyless = await health({ roomKey: null, roomMediaReady: async () => true });
  assert.deepEqual(keyless.room, { configured: false, media: false, links: 'room' });
  assert.deepEqual(keyless.door.shows, [{ id: 'screening-1', configured: false }, { id: 'screening-2', configured: false }], 'a {pass} link cannot be filled without ROOM_KEY');
  const plain = await health({ roomKey: null, doorLinks: { 'screening-1': 'https://meet.example.org/abc', 'screening-2': 'https://meet.example.org/def' } });
  assert.deepEqual(plain.door.shows.map((s) => s.configured), [true, true], 'other links need no key');
  assert.deepEqual(plain.room, { configured: false, media: false, links: 'other' });
});

test('room links: health says room, and the config takes it, only for show={show}&seat={seat}&txid={txid}&pass={pass}&m={media}, in any order', async () => {
  const ROOM_LINK_ERROR = 'DOOR_LINKS: a room link must carry show={show}&seat={seat}&txid={txid}&pass={pass}&m={media}';
  const realShows = SHOWS.shows.slice(0, 2).map((s) => ({ ...s, door: { endpoint: '/api/door' } }));
  const loadShows = async () => ({ shows: realShows, rejected: [] });
  const linksFor = async (template) => (await api({ loadShows, doorLinks: { 'screening-1': template, 'screening-2': template } }).call('/api/health')).body.room.links;
  const config = (template) => workerConfig({ ROOM_KEY: KEY_HEX, DOOR_LINKS: JSON.stringify({ 'screening-1': template, 'screening-2': template }) }).errors;

  const reordered = `${ORIGIN}/room/#m={media}&pass={pass}&txid={txid}&seat={seat}&show={show}`;
  for (const good of [TEMPLATE, reordered]) {
    assert.equal(await linksFor(good), 'room', good);
    assert.deepEqual(config(good), [], good);
  }
  const bad = {
    'no m': TEMPLATE.replace('&m={media}', ''),
    'media= for m=': TEMPLATE.replace('m={media}', 'media={media}'),
    'no txid': TEMPLATE.replace('&txid={txid}', ''),
  };
  for (const [why, template] of Object.entries(bad)) {
    assert.equal(await linksFor(template), 'other', why);
    assert.deepEqual(config(template), [ROOM_LINK_ERROR], why);
  }
  // Also not a room link: a key twice, an extra key, an encoded placeholder, the wrong site.
  for (const template of [`${TEMPLATE}&m={media}`, `${TEMPLATE}&x=1`, TEMPLATE.replace('{seat}', '%7Bseat%7D'), TEMPLATE.replace(ORIGIN, 'https://example.org')]) {
    assert.equal(await linksFor(template), 'other', template);
  }
  // The error is the same fixed sentence whatever the link holds: no part of the value comes back.
  const marker = 'qzx';
  const errors = config(`https://${marker}.example.org/room/#show={show}&seat={seat}&pass={pass}&m={media}&${marker}=${marker}`);
  assert.deepEqual(errors, [ROOM_LINK_ERROR]);
  assert.equal(errors.join(' ').includes(marker), false);
  // A link that is not a room link is not held to it.
  assert.deepEqual(workerConfig({ DOOR_LINKS: JSON.stringify({ x: 'https://meet.example.org/abc?s={seat}' }) }).errors, []);
});

test('limits: room/enter is 30 a minute per IP', async () => {
  assert.deepEqual(DEFAULT_LIMITS['room/enter'], { max: 30, windowMs: 60_000 });
  const limiter = createRateLimiter({ limits: { 'room/enter': { max: 2, windowMs: 60_000 } } });
  const at = (ip) => api({ limiter, clientIp: ip }).enter(body());
  assert.equal((await at('198.51.100.1')).status, 200);
  assert.equal((await at('198.51.100.1')).status, 200);
  const third = await at('198.51.100.1');
  assert.equal(third.status, 429);
  assert.equal(third.body.error.code, 'rate-limited');
  assert.equal((await at('198.51.100.2')).status, 200, 'per IP');
  const shared = createRateLimiter();
  let last;
  for (let i = 0; i < 31; i += 1) last = await api({ limiter: shared }).enter(body());
  assert.equal(last.status, 429, 'the 31st in a minute');
});

test('config: ROOM_KEY is checked; a {pass} or {media} link without it is an error; errors never contain any part of a value', () => {
  const ok = workerConfig({ DOORSTUB_NETWORK: 'simnet', DOORSTUB_FULCRUM: 'ws://127.0.0.1:1', ROOM_KEY: KEY_HEX, DOOR_LINKS: JSON.stringify({ 'screening-1': TEMPLATE }) });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.roomKey, KEY);
  assert.equal(ok.rehearsalLeadS, null);
  assert.equal(workerConfig({}).roomKey, null);

  const needsKey = workerConfig({ DOOR_LINKS: JSON.stringify({ 'screening-1': TEMPLATE }) });
  assert.equal(needsKey.errors.length, 1);
  assert.match(needsKey.errors[0], /ROOM_KEY/);
  assert.equal(workerConfig({ DOOR_LINKS: JSON.stringify({ x: 'https://example.org/r#m={media}' }) }).errors.length, 1, '{media} alone needs the key too');
  assert.deepEqual(workerConfig({ DOOR_LINKS: JSON.stringify({ x: 'https://meet.example.org/abc?s={seat}' }) }).errors, [], 'other links need no key');
  const fixedShow = workerConfig({ ROOM_KEY: KEY_HEX, DOOR_LINKS: JSON.stringify({ 'screening-1': TEMPLATE.replace('{show}', 'screening-2') }) });
  assert.deepEqual(
    fixedShow.errors,
    ['DOOR_LINKS: a link with {pass} must name its show as {show}', 'DOOR_LINKS: a room link must carry show={show}&seat={seat}&txid={txid}&pass={pass}&m={media}'],
    'the pass is made for the door\'s own show id',
  );

  // A marker inside every bad value: no error may carry it (health publishes config errors).
  const marker = 'qzx';
  const bad = [
    { DOOR_LINKS: `{"${marker}-show": https://${marker}.example.org/x}` },
    { DOOR_LINKS: `{"screening-1": "https://meet.google.com/${marker}"` },
    { DOOR_LINKS: JSON.stringify(`${marker}`) },
    { DOOR_LINKS: JSON.stringify([`https://${marker}.example.org`]) },
    { DOOR_LINKS: JSON.stringify({ [`${marker}-show`]: `http://${marker}.example.org` }) },
    { DOOR_LINKS: JSON.stringify({ [`${marker}-show`]: `https://${marker}.example.org/#pass={pass}` }) },
    { DOOR_LINKS: JSON.stringify({ [`${marker}-show`]: 42 }) },
    { ROOM_KEY: `${marker}${'0'.repeat(61)}` },
    { ROOM_KEY: '0'.repeat(63) },
    { STUDIO_DATA_KEY: `${marker}${'1'.repeat(61)}` },
    { DOORSTUB_NETWORK: `${marker}net` },
    { DOORSTUB_NETWORK: 'simnet', DOORSTUB_FULCRUM: `${marker}://x` },
    { DOORSTUB_NETWORK: 'simnet', DOORSTUB_FULCRUM: 'ws://127.0.0.1:1', ROOM_REHEARSAL_LEAD_S: `${marker}` },
    { ROOM_REHEARSAL_LEAD_S: '30' },
  ];
  for (const env of bad) {
    const { errors } = workerConfig(env);
    assert.ok(errors.length >= 1, `${JSON.stringify(env)} is an error`);
    assert.equal(errors.join(' ').toLowerCase().includes(marker), false, `${JSON.stringify(env)} -> ${errors.join(' | ')}`);
    for (const [name, value] of Object.entries(env)) {
      if (name === 'DOORSTUB_NETWORK' && value === 'simnet') continue;
      for (let i = 0; i + 8 <= value.length; i += 1) {
        const piece = value.slice(i, i + 8);
        if (/^[0-9]+$/.test(piece) || 'DOOR_LINKS must be JSON { "<show id>": "https://..." }'.includes(piece)) continue;
        assert.equal(errors.join(' ').includes(piece), false, `${name}: "${piece}" leaked into ${errors.join(' | ')}`);
      }
    }
  }
  // The old leak: V8's JSON.parse message quotes the input.
  const meet = workerConfig({ DOOR_LINKS: '{"screening-1": https://meet.google.com/abc-defg-hij}' });
  assert.equal(meet.doorLinks, null);
  assert.doesNotMatch(meet.errors.join(' '), /meet|ening-1|abc-defg/);

  // The rehearsal lead: simnet only, 1 to 600 seconds.
  const sim = (lead) => workerConfig({ DOORSTUB_NETWORK: 'simnet', DOORSTUB_FULCRUM: 'ws://127.0.0.1:1', ROOM_REHEARSAL_LEAD_S: lead });
  assert.equal(sim('20').rehearsalLeadS, 20);
  assert.deepEqual(sim('20').errors, []);
  assert.equal(sim('0').rehearsalLeadS, null);
  assert.equal(sim('601').errors.length, 1);
  const main = workerConfig({ ROOM_REHEARSAL_LEAD_S: '20' });
  assert.equal(main.rehearsalLeadS, null, 'never on mainnet');
  assert.match(main.errors[0], /simnet test runs only/);
});

test('logs: no guest text reaches a log, and room.js and room-match.js log nothing', async () => {
  const secret = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
  const { enter, logs } = api({
    roomShows: async () => {
      throw new Error('shows.json answered 500');
    },
  });
  await enter({ ...body(), show: secret });
  await enter({ ...body(), seat: secret });
  await enter({ ...body(), pass: secret });
  await enter({ ...body(), q: secret });
  await enter(`{"show": "${secret}"`);
  await enter(body());
  assert.ok(logs.length >= 1, 'an unexpected error is logged');
  assert.equal(logs.some((line) => line.includes('abandon') || line.includes(TXID)), false, logs.join('\n'));
  for (const file of ['room.js', 'room-match.js']) {
    // The BIP39 word list (data) holds words such as "console"; it is cut out first.
    const source = readFileSync(new URL(`../worker/lib/${file}`, import.meta.url), 'utf8')
      .replace(/const BIP39_ENGLISH = `[^`]*`;/, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(source, /\bconsole\b|(?<!Math\.)\blog\s*\(|deps\.log/, `${file} never logs`);
  }
});

test('adapters: Pages Functions (ASSETS for shows.json and the film playlist) and the Node handler pass ROOM_KEY, the room reader and the media check', async () => {
  const folder = roomMediaFolder(KEY);
  const assets = (files) => ({
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (path in files) return new Response(files[path], { status: 200 });
      return new Response('<!doctype html><title>Doorstub</title>', { status: 200, headers: { 'content-type': 'text/html' } });
    },
  });
  const env = (files) => ({
    DOORSTUB_NETWORK: 'simnet',
    DOORSTUB_FULCRUM: 'ws://127.0.0.1:9',
    ROOM_KEY: KEY_HEX,
    DOOR_LINKS: JSON.stringify({ 'screening-1': TEMPLATE, 'screening-2': TEMPLATE }),
    ASSETS: assets(files),
  });
  const pages = async (path, init, files) => {
    const response = await onRequest({ request: new Request(`${ORIGIN}${path}`, init), env: env(files) });
    return { status: response.status, body: await response.json() };
  };
  const withFilm = { '/shows.json': SHOWS_TEXT, [`/room/media/${folder}/film.m3u8`]: '#EXTM3U\n#EXT-X-VERSION:7\n' };
  const entered = await pages('/api/room/enter', { method: 'POST', body: JSON.stringify(body()), headers: { 'cf-connecting-ip': '203.0.113.9' } }, withFilm);
  assert.equal(entered.status, 200, JSON.stringify(entered.body));
  assert.equal(entered.body.eventAt, '2026-11-24T13:00:00Z');
  assert.ok(Math.abs(entered.body.now - Date.now()) < 60_000, 'the server clock');

  const health = await pages('/api/health', undefined, withFilm);
  assert.deepEqual(health.body.room, { configured: true, media: true, links: 'room' });
  // Pages answers a missing file with the site's page (200, HTML): not a film.
  assert.deepEqual((await pages('/api/health', undefined, { '/shows.json': SHOWS_TEXT })).body.room, { configured: true, media: false, links: 'room' });

  const node = createNodeWorker({ env: { DOORSTUB_NETWORK: 'simnet', DOORSTUB_FULCRUM: 'ws://127.0.0.1:9', ROOM_KEY: KEY_HEX, ROOM_REHEARSAL_LEAD_S: '15' }, showsText: SHOWS_TEXT, vm: false, now: () => NOW, roomMediaReady: async () => true });
  const r = await node.fetch('http://worker.test/api/room/enter', { method: 'POST', body: JSON.stringify(body({ show: 'rehearsal', seat: 'R-0-1' })) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).eventAt, '2026-11-20T10:03:45Z', 'ROOM_REHEARSAL_LEAD_S on simnet');
  assert.deepEqual((await (await node.fetch('http://worker.test/api/health')).json()).room, { configured: true, media: true, links: 'none' });
});
