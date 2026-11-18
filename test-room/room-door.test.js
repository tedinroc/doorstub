// The door fills a screening room link: {show}, {seat}, {txid}, {pass} and
// {media}, the same link on every ask, and the link opens the room. A room
// link without ROOM_KEY is refused with 503 before any chain call or claim,
// so the check-in's one answer is not used up. Real check-ins on an
// in-process simnet (test/worker/support.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeTransaction } from '@bitauth/libauth';
import { txidOf } from '../worker/lib/crypto.js';
import { answerDoor, fillLink } from '../worker/lib/door.js';
import { hexToBytes } from '../worker/lib/bytes.js';
import { roomMediaFolder, roomPass } from '../worker/lib/room.js';
import { buyTicket, get, post, send, signedCheckIn, startWorker, workerSimnet } from '../test/worker/support.js';

const KEY_HEX = '7a'.repeat(32);
const KEY = hexToBytes(KEY_HEX);
const ORIGIN = 'https://doorstub.pages.dev';
const TEMPLATE = `${ORIGIN}/room/#show={show}&seat={seat}&txid={txid}&pass={pass}&m={media}`;
const screening = { id: 'screening-1', kind: 'real', title: 'Doorstub screening 1', card: 'A real show.', startHeight: '+300', eventAt: '2026-11-24T13:00:00Z', durationMin: 25, seatPrefix: 'S' };

test('door: a room link carries the show, seat, check-in, pass and media folder; the same on every ask; it opens the room', async (t) => {
  const ctx = await workerSimnet(t, { name: 'room-door', schedule: [screening] });
  const real = ctx.shows.find((s) => s.id === 'screening-1');
  const worker = await startWorker(t, ctx, { env: { DOOR_LINKS: JSON.stringify({ 'screening-1': TEMPLATE }), ROOM_KEY: KEY_HEX } });

  const claim = 'e5'.repeat(32);
  const ticket = await buyTicket(ctx.rpc, real);
  const checkIn = signedCheckIn(real, ticket);
  const txid = txidOf(encodeTransaction(checkIn.transaction));
  assert.equal((await post(worker, '/api/door', { category: real.categoryHex, txid, claim, reserve: true })).status, 200);
  assert.equal(await send(ctx.rpc, checkIn), txid);
  const answer = await post(worker, '/api/door', { category: real.categoryHex, txid, claim });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const link = new URL(answer.body.link);
  assert.equal(`${link.origin}${link.pathname}`, `${ORIGIN}/room/`);
  const fragment = Object.fromEntries(new URLSearchParams(link.hash.slice(1)));
  assert.deepEqual(fragment, { show: 'screening-1', seat: 'S-0-1', txid, pass: roomPass(KEY, 'screening-1', 'S-0-1', txid), m: roomMediaFolder(KEY) });
  const again = await post(worker, '/api/door', { category: real.categoryHex, txid, claim });
  assert.equal(again.body.again, true);
  assert.equal(again.body.link, answer.body.link, 'the same pass on every ask');

  // The link's fragment is what the room page sends to enter.
  const { m, ...enter } = fragment;
  const entered = await post(worker, '/api/room/enter', enter);
  assert.equal(entered.status, 200, JSON.stringify(entered.body));
  assert.deepEqual({ ...entered.body, now: 0 }, { show: 'screening-1', title: 'Doorstub screening 1', seatLabel: 'S-0-1', eventAt: '2026-11-24T13:00:00Z', durationMin: 25, now: 0, opensUntil: '2026-11-24T13:35:00Z' });
  assert.equal((await post(worker, '/api/room/enter', { ...enter, seat: 'S-0-2' })).status, 403, 'another seat on the same check-in');

  const health = await get(worker, '/api/health');
  assert.deepEqual(health.body.config.errors, []);
  assert.deepEqual(health.body.door.shows, [{ id: 'screening-1', configured: true }]);
  assert.deepEqual(health.body.room, { configured: true, media: false, links: 'room' });

  // Without ROOM_KEY the same template is a config error, the door is not configured, and asking it gives 503.
  const keyless = await startWorker(t, ctx, { env: { DOOR_LINKS: JSON.stringify({ 'screening-1': TEMPLATE }) } });
  const keylessHealth = await get(keyless, '/api/health');
  assert.equal(keylessHealth.body.config.errors.length, 1);
  assert.match(keylessHealth.body.config.errors[0], /ROOM_KEY/);
  assert.deepEqual(keylessHealth.body.door.shows, [{ id: 'screening-1', configured: false }]);
  assert.deepEqual(keylessHealth.body.room, { configured: false, media: false, links: 'room' });
  const refused = await post(keyless, '/api/door', { category: real.categoryHex, txid, claim });
  assert.equal(refused.status, 503);
  assert.equal(refused.body.error.code, 'door-not-configured');
  assert.equal((await post(keyless, '/api/room/enter', enter)).status, 503);
});

test('door: a {pass} or {media} link without ROOM_KEY answers 503 before any chain call or claim; the claim record is untouched', async () => {
  const shows = [{ id: 'screening-1', kind: 'real', categoryHex: 'cc'.repeat(32), door: { endpoint: '/api/door' } }];
  const chain = new Proxy({}, { get: () => () => assert.fail('no chain call before the key check') });
  const calls = [];
  const record = (name) => async (...args) => {
    calls.push([name, ...args]);
    return 'first';
  };
  const claims = { kind: 'memory', reserve: record('reserve'), claim: record('claim') };
  const body = { category: shows[0].categoryHex, txid: 'dd'.repeat(32), claim: 'a1'.repeat(32) };
  for (const template of [TEMPLATE, `${ORIGIN}/room/#m={media}`]) {
    await assert.rejects(
      answerDoor({ shows, chain, doorLinks: { 'screening-1': template }, roomKey: null, claims, body }),
      (e) => e.code === 'door-not-configured' && e.status === 503,
    );
  }
  assert.deepEqual(calls, [], 'claims.claim was never called');
  // With the key the door goes on to the chain (which this stub refuses).
  await assert.rejects(answerDoor({ shows, chain, doorLinks: { 'screening-1': TEMPLATE }, roomKey: KEY, claims, body }), /no chain call/);
  // A reservation needs no link, so it still works without the key.
  await answerDoor({ shows, chain, doorLinks: { 'screening-1': TEMPLATE }, roomKey: null, claims, body: { ...body, reserve: true } });
  assert.deepEqual(calls.map((c) => c[0]), ['reserve']);

  // fillLink: {show} is the door's own show; {seat} is URL-encoded; links without {pass} or {media} need no key.
  assert.equal(fillLink('https://x.example/{show}/{seat}/{txid}', { showId: 'screening-1', seatLabel: 'S-0-1', txid: 'ab' }), 'https://x.example/screening-1/S-0-1/ab');
  assert.equal(fillLink('https://x.example/?seat={seat}', { showId: 'screening-1', seatLabel: 'S 0', txid: 'ab' }), 'https://x.example/?seat=S%200');
  assert.equal(
    fillLink(TEMPLATE, { showId: 'screening-2', seatLabel: 'S-1-7', txid: 'ef'.repeat(32), roomKey: KEY }),
    `${ORIGIN}/room/#show=screening-2&seat=S-1-7&txid=${'ef'.repeat(32)}&pass=${roomPass(KEY, 'screening-2', 'S-1-7', 'ef'.repeat(32))}&m=${roomMediaFolder(KEY)}`,
  );
});
