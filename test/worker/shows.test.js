// The worker's shows.json loader (no libauth) agrees with src/shows: it
// recomputes every contract, refuses a show whose `derived` fields differ or
// that breaks the policy, and verifies notices against the show's data key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { binToHex } from '@bitauth/libauth';
import { encodeRefundNoticeMessage } from '../../src/tx/index.js';
import { signDataMessage } from '../../src/tx/sign.js';
import { parseShowsFile, showToJson } from '../../src/shows/index.js';
import { makeShow, randomTxid } from '../helpers.js';
import { bytesToHex } from '../../worker/lib/bytes.js';
import { signDataEcdsa } from '../../worker/lib/crypto.js';
import { parseWorkerShows, refundNoticeMessage, seatLabelOf } from '../../worker/lib/shows.js';

const catalogue = (network = 'simnet') => {
  const a = makeShow(assert, { overrides: { startHeight: 978_000, graceBlocks: 2, price: 100_000n } });
  const b = makeShow(assert, { overrides: { startHeight: 984_000, graceBlocks: 2, price: 100_000n }, organiser: a.organiser, dataKey: a.dataKey });
  const entry = (made, id, kind, title) => showToJson({ ...made.show, id, kind, title, subtitle: '', card: 'Sample.', shards: 4, genesisTxid: binToHex(randomTxid()), notices: [], door: null }, { network });
  return {
    a,
    b,
    doc: { version: 1, network, origin: 'https://doorstub.pages.dev', generatedAt: new Date().toISOString(), shows: [entry(a, 'sample-a-978000', 'sample-settle', 'Sample show A'), entry(b, 'sample-b', 'sample-refund-seat', 'Sample show B')] },
  };
};

test('worker shows: same contracts as src/shows from the same file', () => {
  const { doc } = catalogue();
  const mine = parseWorkerShows(JSON.stringify(doc), { network: 'simnet' });
  const theirs = parseShowsFile(JSON.stringify(doc), { network: 'simnet' });
  assert.deepEqual(mine.rejected, []);
  assert.equal(mine.shows.length, 2);
  mine.shows.forEach((show, i) => {
    const ref = theirs.shows[i];
    assert.equal(show.id, ref.id);
    assert.equal(bytesToHex(show.escrow.lockingBytecode), ref.derived.escrowLockingBytecode);
    assert.equal(bytesToHex(show.escrow.redeemScript), ref.derived.escrowRedeemScript);
    assert.equal(show.escrow.scripthash, ref.derived.escrowScripthash);
    assert.equal(bytesToHex(show.boxOffice.lockingBytecode), ref.derived.boxOfficeLockingBytecode);
    assert.equal(show.boxOffice.scripthash, ref.derived.boxOfficeScripthash);
    assert.equal(show.seatPrefix, ref.seatPrefix);
  });
  assert.equal(seatLabelOf(mine.shows[1], Uint8Array.of(2, 12, 1)), 'B-2-268');
});

test('worker shows: a wrong derived field, a policy breach or the wrong network is refused', () => {
  const { doc } = catalogue();
  const tampered = structuredClone(doc);
  tampered.shows[0].derived.escrowLockingBytecode = tampered.shows[1].derived.escrowLockingBytecode;
  const r1 = parseWorkerShows(tampered, { network: 'simnet' });
  assert.deepEqual(r1.shows.map((s) => s.id), ['sample-b']);
  assert.equal(r1.rejected[0].code, 'derived-mismatch');

  const greedy = structuredClone(doc);
  greedy.shows[1].params.noShowFeeBps = 5_000;
  const r2 = parseWorkerShows(greedy, { network: 'simnet' });
  assert.deepEqual(r2.shows.map((s) => s.id), ['sample-a-978000']);
  assert.match(r2.rejected[0].message, /policy/);

  assert.throws(() => parseWorkerShows(doc, { network: 'mainnet' }), (e) => e.code === 'wrong-network');
  assert.throws(() => parseWorkerShows('{', { network: 'simnet' }), (e) => e.code === 'bad-shows');
});

test('worker shows: notices are verified against the show\'s data key (Schnorr from the studio, ECDSA from the worker)', () => {
  const { doc, b } = catalogue();
  const category = b.show.category;
  const cancel = binToHex(signDataMessage(b.dataKey.privateKey, encodeRefundNoticeMessage({ scope: 'C', category })));
  const seat = Uint8Array.of(0, 1, 0);
  const seatSig = bytesToHex(signDataEcdsa(b.dataKey.privateKey, refundNoticeMessage({ scope: 'R', category, seat })));
  const withNotices = structuredClone(doc);
  withNotices.shows[1].notices = [
    { scope: 'C', signature: cancel },
    { scope: 'R', seat: '000100', signature: seatSig },
    { scope: 'R', seat: '000200', signature: seatSig },
    { scope: 'C', signature: 'ab'.repeat(64) },
  ];
  const [, show] = parseWorkerShows(withNotices, { network: 'simnet' }).shows;
  assert.deepEqual(show.notices.map((n) => n.scope), ['C', 'R']);
  assert.equal(show.invalidNotices.length, 2);
  assert.equal(show.cancelled, true);
  // A cancel notice for show B does not cancel show A, though both share the studio's data key.
  withNotices.shows[0].notices = [{ scope: 'C', signature: cancel }];
  const [a] = parseWorkerShows(withNotices, { network: 'simnet' }).shows;
  assert.equal(a.cancelled, false);
});
