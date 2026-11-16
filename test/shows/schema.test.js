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

test('door: only a path under /api/ on our own origin', () => {
  const { json } = showEntry();
  assert.deepEqual(parseShowsFile(file([{ ...json, kind: 'real', door: { endpoint: '/api/door' } }])).shows[0].door, { endpoint: '/api/door' });
  for (const endpoint of ['https://evil.example/api/door', '//evil.example/api/door', '/door', '/api/../x']) {
    assert.equal(parseShowsFile(file([{ ...json, door: { endpoint } }])).rejected[0]?.code, 'bad-field', endpoint);
  }
});

test('seat prefix: A for the settle sample, B for the refund sample, else the title letter', () => {
  const kinds = [['sample-settle', 'A'], ['sample-refund-seat', 'B'], ['real', 'L'], ['proof', 'L']];
  for (const [kind, prefix] of kinds) {
    const { json } = showEntry({ kind, title: 'Launch party' });
    assert.equal(parseShowsFile(file([json])).shows[0].seatPrefix, prefix, kind);
  }
});
