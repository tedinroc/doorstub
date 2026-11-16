// shows.json: round trip with the studio's writer, recomputed contracts must
// match "derived", policy, notices, door endpoint, network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { binToHex } from '@bitauth/libauth';
import { addNotices, parseShowsFile, seatNotice, showToJson } from '../../src/shows/index.js';
import { encodeRefundNoticeMessage, encodeSeat } from '../../src/tx/index.js';
import { signDataMessage } from '../../src/tx/sign.js';
import { freshKey, makeShow } from '../helpers.js';

const showEntry = (overrides = {}) => {
  const made = makeShow(assert);
  const show = { ...made.show, id: 'sample-a-1', kind: 'sample-settle', title: 'Sample show A', subtitle: 'Refunds itself', card: 'Sample show.', shards: 4, genesisTxid: binToHex(crypto.getRandomValues(new Uint8Array(32))), ...overrides };
  return { made, show, json: showToJson(show) };
};

const file = (shows, network = 'mainnet') => ({ version: 1, network, origin: 'https://doorstub.pages.dev', generatedAt: '2026-11-16T00:00:00Z', shows });

test('round trip: studio writes, app loads the same show (Uint8Array fields, sats as bigint, contracts recomputed)', () => {
  const { made, json } = showEntry();
  const loaded = parseShowsFile(JSON.stringify(file([json])), { network: 'mainnet' });
  assert.equal(loaded.rejected.length, 0, JSON.stringify(loaded.rejected));
  const show = loaded.shows[0];
  assert.deepEqual(show.category, made.show.category);
  assert.equal(show.price, 10_000n);
  assert.equal(show.minerFeeCap, 1_500n);
  assert.equal(typeof show.startHeight, 'number');
  assert.deepEqual(show.contracts.escrow.lockingBytecode, made.contracts.escrow.lockingBytecode);
  assert.deepEqual(show.contracts.boxOffice.lockingBytecode, made.contracts.boxOffice.lockingBytecode);
  assert.match(show.derived.escrowTokenAddress, /^bitcoincash:r/);
  assert.equal(show.seatPrefix, 'A');
  assert.equal(show.cancelled, false);
  assert.equal(show.door, null);
  assert.deepEqual(showToJson(show), json, 'writes back byte for byte');
  assert.equal(loaded.origin, 'https://doorstub.pages.dev');
});

test('every derived field is checked: one wrong field drops that show, the rest still loads', () => {
  const good = showEntry().json;
  for (const field of Object.keys(good.derived)) {
    const bad = showEntry({ id: 'bad' }).json;
    bad.derived[field] = field.endsWith('Address') ? good.derived[field] : good.derived[field].replace(/^../, (x) => (x === '00' ? '11' : '00'));
    const loaded = parseShowsFile(file([good, bad]));
    assert.equal(loaded.shows.length, 1, field);
    assert.equal(loaded.rejected[0].code, 'derived-mismatch', field);
    assert.equal(loaded.rejected[0].id, 'bad');
  }
});

test('posted parameters that change the contract are caught (the address would not match)', () => {
  const { json } = showEntry();
  const tampered = { ...json, params: { ...json.params, price: json.params.price + 1 } };
  assert.equal(parseShowsFile(file([tampered])).rejected[0].code, 'derived-mismatch');
});

test('policy: a show outside the bounds is refused (fee over 10%, cap over 2,000)', () => {
  const { json } = showEntry();
  const fee = { ...json, params: { ...json.params, handBackFeeBps: 1_001 } };
  const cap = { ...json, params: { ...json.params, minerFeeCap: 2_001 } };
  for (const bad of [fee, cap]) assert.equal(parseShowsFile(file([bad])).rejected[0].code, 'bad-show');
});

test('file-level checks: version, network, wrong network for this build, duplicates', () => {
  const { json } = showEntry();
  assert.throws(() => parseShowsFile({ ...file([json]), version: 2 }), (e) => e.code === 'bad-version');
  assert.throws(() => parseShowsFile({ ...file([json]), network: 'testnet' }), (e) => e.code === 'bad-network');
  assert.throws(() => parseShowsFile(file([json], 'simnet'), { network: 'mainnet' }), (e) => e.code === 'wrong-network');
  assert.throws(() => parseShowsFile('{nope'), (e) => e.code === 'bad-json');
  const dupId = parseShowsFile(file([json, { ...showEntry().json, id: json.id }]));
  assert.equal(dupId.rejected[0].code, 'duplicate-id');
  const dupCat = parseShowsFile(file([json, { ...json, id: 'other' }]));
  assert.equal(dupCat.rejected[0].code, 'duplicate-category');
  const badKind = parseShowsFile(file([{ ...json, kind: 'vip' }]));
  assert.equal(badKind.rejected[0].code, 'bad-kind');
  const badId = parseShowsFile(file([{ ...json, id: 'Bad Id' }]));
  assert.equal(badId.rejected[0].code, 'bad-id');
});

test('notices: a valid C notice cancels; a forged one is kept aside; R notices added live', () => {
  const { made, json } = showEntry();
  const sign = (key, scope, seat) => binToHex(signDataMessage(key.privateKey, encodeRefundNoticeMessage({ scope, category: made.show.category, seat })));
  const withC = { ...json, notices: [{ scope: 'C', signature: sign(made.dataKey, 'C') }] };
  assert.equal(parseShowsFile(file([withC])).shows[0].cancelled, true);
  const forged = { ...json, notices: [{ scope: 'C', signature: sign(freshKey(), 'C') }] };
  const loaded = parseShowsFile(file([forged])).shows[0];
  assert.equal(loaded.cancelled, false);
  assert.equal(loaded.invalidNotices.length, 1);

  const show = parseShowsFile(file([json])).shows[0];
  const seat = encodeSeat({ shard: 1, sold: 7 });
  const r = { scope: 'R', seat: binToHex(seat), signature: sign(made.dataKey, 'R', seat) };
  assert.equal(addNotices(show, [r]).added.length, 1);
  assert.equal(addNotices(show, [r]).added.length, 0, 'no duplicates');
  assert.equal(addNotices(show, [{ ...r, seat: binToHex(encodeSeat({ shard: 1, sold: 8 })) }]).invalid.length, 1, 'signature over another seat');
  assert.ok(seatNotice(show, seat));
  assert.equal(seatNotice(show, encodeSeat({ shard: 0, sold: 7 })), undefined);
  assert.equal(show.cancelled, false);
  assert.deepEqual(showToJson(show).notices, [r]);
});

const CALL = Object.freeze({ eventAt: '2026-11-24T13:00:00Z', durationMin: 25, seatPrefix: 'S' });

test('door: only a path under /api/ on our own origin', () => {
  const { json } = showEntry();
  assert.deepEqual(parseShowsFile(file([{ ...json, kind: 'real', ...CALL, door: { endpoint: '/api/door' } }])).shows[0].door, { endpoint: '/api/door' });
  for (const endpoint of ['https://evil.example/api/door', '//evil.example/api/door', '/door', '/api/../x']) {
    assert.equal(parseShowsFile(file([{ ...json, door: { endpoint } }])).rejected[0]?.code, 'bad-field', endpoint);
  }
});

test('a real show\'s call: eventAt, durationMin and seatPrefix are required, checked, and round-trip; samples carry none', () => {
  const real = showEntry({ id: 'screening-1', kind: 'real', title: 'Doorstub screening 1', subtitle: 'Online, 25 minutes', ...CALL, door: { endpoint: '/api/door' } });
  assert.deepEqual([real.json.eventAt, real.json.durationMin, real.json.seatPrefix], ['2026-11-24T13:00:00Z', 25, 'S'], 'the studio writes them');
  const [show] = parseShowsFile(file([real.json])).shows;
  assert.equal(show.eventAt, '2026-11-24T13:00:00Z');
  assert.equal(show.eventAtMs, Date.UTC(2026, 10, 24, 13, 0, 0));
  assert.equal(show.durationMin, 25);
  assert.equal(show.seatPrefix, 'S');
  assert.deepEqual(showToJson(show), real.json, 'writes back byte for byte');

  // Samples: A and B, no call; the writer leaves the fields out.
  for (const [kind, letter] of [['sample-settle', 'A'], ['sample-refund-seat', 'B']]) {
    const { json } = showEntry({ kind });
    assert.equal('eventAt' in json || 'durationMin' in json || 'seatPrefix' in json, false, kind);
    const [sample] = parseShowsFile(file([json])).shows;
    assert.deepEqual([sample.seatPrefix, sample.eventAt, sample.eventAtMs, sample.durationMin], [letter, null, null, null], kind);
    assert.equal(parseShowsFile(file([{ ...json, seatPrefix: 'S' }])).rejected[0]?.code, 'bad-field', `${kind} with its own letter`);
    assert.equal(parseShowsFile(file([{ ...json, eventAt: CALL.eventAt }])).rejected[0]?.code, 'bad-field', `${kind} with a call`);
  }

  const bad = {
    'no eventAt': { eventAt: undefined },
    'local time': { eventAt: '2026-11-24T21:00:00+08:00' },
    'no zone': { eventAt: '2026-11-24T13:00:00' },
    '30 February': { eventAt: '2026-02-30T13:00:00Z' },
    '24:00': { eventAt: '2026-11-24T24:00:00Z' },
    'a number': { eventAt: 1_795_525_200_000 },
    'no durationMin': { durationMin: undefined },
    'zero minutes': { durationMin: 0 },
    '601 minutes': { durationMin: 601 },
    'half a minute': { durationMin: 25.5 },
    'minutes as text': { durationMin: '25' },
    'no seatPrefix': { seatPrefix: undefined },
    'sample letter A': { seatPrefix: 'A' },
    'sample letter B': { seatPrefix: 'B' },
    'lower case': { seatPrefix: 's' },
    'two letters': { seatPrefix: 'S1' },
    'a digit': { seatPrefix: '1' },
  };
  for (const [label, change] of Object.entries(bad)) {
    const loaded = parseShowsFile(file([{ ...real.json, ...change }]));
    assert.equal(loaded.rejected[0]?.code, 'bad-field', label);
  }
  // Minutes and fractions of a second are fine; the string is kept as written.
  assert.equal(parseShowsFile(file([{ ...real.json, eventAt: '2026-11-24T13:00Z' }])).shows[0].eventAtMs, show.eventAtMs);
  assert.equal(parseShowsFile(file([{ ...real.json, eventAt: '2026-11-24T13:00:00.250Z' }])).shows[0].eventAtMs, show.eventAtMs + 250);
});

test('seat letters: A and B for the samples (shared by every instance), one per real show, unique across the file', () => {
  const a1 = showEntry({ id: 'sample-a-1' }).json;
  const a2 = showEntry({ id: 'sample-a-2' }).json;
  const s1 = showEntry({ id: 'screening-1', kind: 'real', ...CALL }).json;
  const s2 = showEntry({ id: 'screening-2', kind: 'real', ...CALL, seatPrefix: 'T' }).json;
  const loaded = parseShowsFile(file([a1, a2, s1, s2]));
  assert.deepEqual(loaded.rejected, []);
  assert.deepEqual(loaded.shows.map((show) => show.seatPrefix), ['A', 'A', 'S', 'T']);
  const twice = parseShowsFile(file([s1, { ...s2, seatPrefix: 'S' }]));
  assert.deepEqual(twice.shows.map((show) => show.id), ['screening-1']);
  assert.equal(twice.rejected[0].code, 'duplicate-seat-prefix');
  // A proof show (a past real show) may name its letter; without one it is P.
  assert.equal(parseShowsFile(file([showEntry({ kind: 'proof' }).json])).shows[0].seatPrefix, 'P');
  assert.equal(parseShowsFile(file([{ ...showEntry({ kind: 'proof' }).json, seatPrefix: 'Q' }])).shows[0].seatPrefix, 'Q');
  assert.equal(parseShowsFile(file([s1, { ...showEntry({ id: 'past', kind: 'proof' }).json, seatPrefix: 'S' }])).rejected[0].code, 'duplicate-seat-prefix');
});
