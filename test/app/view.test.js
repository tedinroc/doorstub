// The site's view models (app/src/lib/view.js): times in English with the
// zone named, countdowns, balances, ticket states and stamps, the refund
// track. Pure functions, no DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hexToBin } from '@bitauth/libauth';
import {
  clockText,
  countdownText,
  etaText,
  listedShows,
  newestFirst,
  proofModel,
  refundTrack,
  shortBch,
  showCardModel,
  stampOf,
  ticketModel,
  whenText,
} from '../../app/src/lib/view.js';

const date = new Date('2026-11-24T13:00:00Z');

test('clockText: English, the reader\'s zone named, never the browser locale\'s words', () => {
  assert.equal(clockText(date, { timeZone: 'Asia/Taipei' }), 'Tue 24 Nov, 21:00 GMT+8');
  assert.equal(clockText(date, { timeZone: 'America/New_York' }), 'Tue 24 Nov, 08:00 GMT\u20115');
  assert.equal(clockText(date, { timeZone: 'Asia/Kolkata' }), 'Tue 24 Nov, 18:30 GMT+5:30');
  assert.equal(clockText(date, { timeZone: 'UTC' }), 'Tue 24 Nov, 13:00 UTC');
  assert.equal(clockText(new Date('2026-11-17T00:05:00Z'), { timeZone: 'Asia/Taipei' }), 'Tue 17 Nov, 08:05 GMT+8');
  // Whatever the process locale, only ASCII English comes out.
  assert.match(clockText(date), /^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}, \d{2}:\d{2} (?:UTC|GMT[+\u2011]\d{1,2}(?::\d{2})?)$/);
});

test('whenText and etaText: block, estimated time, how long', () => {
  const now = Date.parse('2026-11-24T13:00:00Z');
  assert.deepEqual(whenText(977_640, 977_604, { now, timeZone: 'Asia/Taipei' }), { block: '977,640', time: 'Wed 25 Nov, 03:00 GMT+8', eta: 'in 6 h' });
  assert.equal(etaText(0), 'now');
  assert.equal(etaText(4), 'in 40 min');
  assert.equal(etaText(37), 'in 6 h 10 min');
  assert.equal(etaText(6_500), 'in 45 days');
  assert.equal(countdownText(37), '6 h 10 min');
});

test('shortBch rounds a balance down to 4 decimals for the header', () => {
  assert.equal(shortBch(1_897_068n), '0.0189 BCH');
  assert.equal(shortBch(100_000n), '0.001 BCH');
  assert.equal(shortBch(9_999n), '0 BCH');
});

const show = {
  id: 'sample-a-977637',
  kind: 'sample-settle',
  title: 'Sample show A',
  subtitle: 'Starts at block 977,637',
  card: 'Sample show. Nobody checks in at a sample show, so every ticket refunds itself after it starts.',
  seatPrefix: 'A',
  price: 100_000n,
  startHeight: 977_637,
  graceBlocks: 2,
  handBackFeeBps: 0,
  noShowFeeBps: 0,
  minerFeeCap: 1_500n,
  shards: 4,
  categoryHex: 'e835d5159b2d18e5292cf4de287e6963b87841bb8ea4bebfee82effff3327816',
};

test('showCardModel: English times, the studio\'s start-block subtitle dropped, fees in plain words', () => {
  const now = Date.parse('2026-11-16T08:00:00Z');
  const m = showCardModel(show, { tip: 977_603, usd: 207, now, timeZone: 'Asia/Taipei' });
  assert.equal(m.subtitle, '');
  assert.equal(m.priceBch, '0.001 BCH');
  assert.equal(m.priceUsd, '$0.21');
  assert.equal(m.startLine, 'Block 977,637, about Mon 16 Nov, 21:40 GMT+8 (in 5 h 40 min).');
  assert.equal(m.settleLine, 'Settling opens at block 977,640, about Mon 16 Nov, 22:10 GMT+8 (in 6 h 10 min); the refund follows once the keeper or this page sends it.');
  assert.equal(m.feesLine, 'Hand-back fee 0%. No-show fee 0%. Network fee cap 1,500 sats per ticket.');
  assert.equal(m.onSale, true);
  assert.equal(m.serial, 'E835D515');
  assert.equal(showCardModel({ ...show, subtitle: 'Refunded by its organiser right after each sale' }, { tip: 977_603 }).subtitle, 'Refunded by its organiser right after each sale');
  assert.equal(showCardModel(show, { tip: 977_603 }).priceUsd, null, 'no rate, no dollar figure');
});

const seat = hexToBin('020100');
const ticket = (patch) => ({
  show,
  showId: show.id,
  seat,
  seatHex: '020100',
  buyerPkhHex: '11'.repeat(20),
  state: 'held',
  buy: { txid: 'c035df00'.padEnd(64, '0'), height: 0 },
  spend: null,
  escrowUtxo: { txid: 'c035df00'.padEnd(64, '1'), vout: 2, output: { valueSatoshis: 101_000n } },
  ticketUtxo: { txid: 'c035df00'.padEnd(64, '1'), vout: 1 },
  canAct: true,
  ...patch,
});

test('ticketModel: held ticket with a countdown and a hand-back, then each finished state with its stamp', () => {
  const held = ticketModel(ticket(), { tip: 977_603, now: Date.parse('2026-11-16T08:00:00Z'), timeZone: 'UTC' });
  assert.equal(held.seat, 'A-2-1');
  assert.equal(held.stamp, null);
  assert.equal(held.canHandBack, true);
  assert.equal(held.canWalkIn, false, 'no Walk in on a sample show (CLAIMS.md section 6)');
  assert.equal(held.countdown, '6 h 10 min');
  assert.equal(held.valueText, '0.001 BCH');
  assert.match(held.lines[0], /^Your 0\.001 BCH is held by contract coin c035df\.\.\.1111:2\.$/);
  assert.equal(held.barcode.length, 24 * 8, 'the barcode is the 24-byte ticket commitment');

  const back = ticketModel(ticket({ state: 'handedBack', spend: { txid: 'ab'.repeat(32), path: 'handBack' }, escrowUtxo: null, canAct: false }), { tip: 977_610, returned: 101_029n });
  assert.deepEqual(back.stamp, { text: 'HANDED BACK', tone: 'blue' });
  assert.deepEqual(back.lines, ['Handed back. 0.00101029 BCH came back to your wallet.']);
  assert.equal(back.canHandBack, false);

  const settled = ticketModel(ticket({ state: 'refunded', refundPath: 'settle', escrowUtxo: null, canAct: false }), { tip: 977_650, returned: 100_179n });
  assert.deepEqual(settled.stamp, { text: 'REFUNDED', tone: 'red' });
  assert.deepEqual(settled.lines, ['Refunded by the settle after the show: 0.00100179 BCH to the address that bought it.']);

  const real = { ...show, kind: 'real', seatPrefix: 'S' };
  const walkable = ticketModel(ticket({ show: real }), { tip: 977_603 });
  assert.equal(walkable.canWalkIn, true);
  const walked = ticketModel(ticket({ show: real, state: 'walkedIn', escrowUtxo: null, canAct: false }), { tip: 977_603 });
  assert.deepEqual(walked.stamp, { text: 'WALKED IN', tone: 'green' });
  assert.equal(walked.canWalkIn, false);

  const moved = ticketModel(ticket({ canAct: false }), { tip: 977_603 });
  assert.equal(moved.canHandBack, false);
  assert.match(moved.lines.at(-1), /can no longer check in or hand back/);
  assert.equal(stampOf('held'), null);
});

test('refundTrack walks the four sample B steps', () => {
  const ids = (step) => refundTrack(step).map((s) => (s.done ? 'done' : s.active ? 'active' : '-'));
  assert.deepEqual(ids('held'), ['active', '-', '-', '-']);
  assert.deepEqual(ids('notice'), ['done', 'active', '-', '-']);
  assert.deepEqual(ids('sent'), ['done', 'done', 'active', '-']);
  assert.deepEqual(ids('back'), ['done', 'done', 'done', 'done']);
});

test('proofModel: five paths, counts and latest txids', () => {
  const m = proofModel({ txCounts: { buy: 4, handBack: 1, checkIn: 1, settle: 1, refund: 1 }, latest: { buy: { txid: 'aa', height: 0 } }, seatCounts: { sold: 4 } });
  assert.deepEqual(m.rows.map((r) => [r.path, r.count]), [['buy', 4], ['handBack', 1], ['checkIn', 1], ['settle', 1], ['refund', 1]]);
  assert.equal(m.total, 8);
  assert.equal(m.rows[0].latest, 'aa');
  assert.equal(proofModel(null).total, 0);
});

test('listedShows: shows on sale and an ended show this wallet watches, in shows.json order (the ended instance stays in place)', () => {
  const a1 = { id: 'sample-a-1' };
  const a2 = { id: 'sample-a-2' };
  const b = { id: 'sample-b' };
  const old = { id: 'sample-a-0' };
  const shows = [old, a1, a2, b];
  const onSale = [a2, b];
  const t = (showId, state, seatHex = '010100') => ({ showId, state, seatHex });
  // Nothing held: only the shows on sale.
  assert.deepEqual(listedShows({ shows, onSale, tickets: [] }).map((s) => s.id), ['sample-a-2', 'sample-b']);
  // A held ticket of a show that started: its card stays where it was, and the next instance comes right after it.
  assert.deepEqual(listedShows({ shows, onSale, tickets: [t('sample-a-1', 'held')] }).map((s) => s.id), ['sample-a-1', 'sample-a-2', 'sample-b']);
  // Once refunded it stays only if this page acted on it (the judge watches the refund land), not for old tickets.
  assert.deepEqual(listedShows({ shows, onSale, tickets: [t('sample-a-1', 'refunded'), t('sample-a-0', 'refunded')] }).map((s) => s.id), ['sample-a-2', 'sample-b']);
  assert.deepEqual(
    listedShows({ shows, onSale, tickets: [t('sample-a-1', 'refunded'), t('sample-a-0', 'refunded')], touched: new Set(['sample-a-1:010100']) }).map((s) => s.id),
    ['sample-a-1', 'sample-a-2', 'sample-b'],
  );
});

test('newestFirst: tickets keep their place when their state changes or the list comes back in another order', () => {
  const t = (seatHex, state, height = 0) => ({ showId: 'sample-b', seatHex, state, buy: { txid: seatHex.padEnd(64, '0'), height } });
  const seen = new Map();
  const keys = (list) => list.map((x) => x.seatHex);
  // At load: by the buy's block, the mempool counting as newest.
  assert.deepEqual(keys(newestFirst([t('020001', 'refunded', 0), t('010001', 'refunded', 977_600)], seen)), ['020001', '010001']);
  // A second B buy while the first is still in the mempool: newest on top.
  assert.deepEqual(keys(newestFirst([t('020001', 'refunded'), t('010001', 'refunded', 977_600), t('030001', 'held')], seen)), ['030001', '020001', '010001']);
  // Its refund lands ("Money back") and the list comes back from the chain in another order: nothing moves.
  assert.deepEqual(keys(newestFirst([t('030001', 'refunded'), t('010001', 'refunded', 977_600), t('020001', 'refunded')], seen)), ['030001', '020001', '010001']);
  // Both confirm in the same block: still nothing moves.
  assert.deepEqual(keys(newestFirst([t('020001', 'refunded', 977_601), t('030001', 'refunded', 977_601), t('010001', 'refunded', 977_600)], seen)), ['030001', '020001', '010001']);
});

// A real show as the shows loader exposes it (CONTRACT: eventAt, eventAtMs, durationMin, seatPrefix for kind "real").
const screening = {
  ...show,
  id: 'screening-1',
  kind: 'real',
  title: 'Doorstub screening 1',
  subtitle: 'Online, 25 minutes',
  card: 'Online screening: a 12-minute film on how Doorstub works, then Q&A in the chat. Walk in to get the room link.',
  seatPrefix: 'S',
  startHeight: 978_776,
  eventAt: '2026-11-24T13:00:00Z',
  eventAtMs: Date.parse('2026-11-24T13:00:00Z'),
  durationMin: 25,
};

test('real show card: the call in the reader\'s own zone with its length, and sales and walk-in until the start block', () => {
  const now = Date.parse('2026-11-16T13:00:00Z');
  const taipei = showCardModel(screening, { tip: 977_700, now, timeZone: 'Asia/Taipei' });
  assert.equal(taipei.callLine, 'Tue 24 Nov, 21:00 GMT+8 (in 8 days), for 25 minutes.');
  assert.equal(showCardModel(screening, { tip: 977_700, now, timeZone: 'America/New_York' }).callLine, 'Tue 24 Nov, 08:00 GMT\u20115 (in 8 days), for 25 minutes.');
  assert.equal(showCardModel(screening, { tip: 977_700, now, timeZone: 'UTC' }).callLine, 'Tue 24 Nov, 13:00 UTC (in 8 days), for 25 minutes.');
  assert.equal(taipei.startLabel, 'Door');
  assert.equal(taipei.startLine, 'Buy and walk in until the call ends, Tue 24 Nov, 21:25 GMT+8 (in 8 days).', 'the Door row names the end of the call, never a block that could come first');
  assert.equal(taipei.onSale, true);
  // During the call it still sells; after it, neither Get a ticket nor the Door row, and the stub says why.
  const card = (iso, tip = 978_700) => showCardModel(screening, { tip, now: Date.parse(iso), timeZone: 'UTC' });
  assert.equal(card('2026-11-24T13:10:00Z').startLine, 'Buy and walk in until the call ends, Tue 24 Nov, 13:25 UTC (in 15 min).');
  assert.equal(card('2026-11-24T13:10:00Z').onSale, true);
  const over = card('2026-11-24T13:25:00Z');
  assert.equal(over.onSale, false, 'sales end with the call, by the reader\'s clock');
  assert.equal(over.startLine, null);
  assert.equal(over.endedLine, 'Sales and walk-in for this show closed when its call ended.');
  // Blocks came early: the start block ended sales during the call; walking in still works until it ends.
  const early = card('2026-11-24T13:10:00Z', 978_776);
  assert.equal(early.onSale, false);
  assert.equal(early.startLine, 'Sales for this show ended at block 978,776. Walk in until the call ends, Tue 24 Nov, 13:25 UTC (in 15 min).');
  assert.equal(early.endedLine, 'Sales for this show ended at block 978,776.');
  assert.equal(taipei.subtitle, 'Online, 25 minutes', 'a real show\'s subtitle carries no time');
  // An hour before, during and after the call.
  const at = (iso) => showCardModel(screening, { tip: 978_700, now: Date.parse(iso), timeZone: 'UTC' }).callLine;
  assert.equal(at('2026-11-24T12:00:00Z'), 'Tue 24 Nov, 13:00 UTC (in 1 h), for 25 minutes.');
  assert.equal(at('2026-11-24T13:10:00Z'), 'Tue 24 Nov, 13:00 UTC (on now), for 25 minutes.');
  assert.equal(at('2026-11-24T13:30:00Z'), 'Tue 24 Nov, 13:00 UTC (over), for 25 minutes.');
  // A sample show has no call and keeps "Starts".
  const sample = showCardModel(show, { tip: 977_603 });
  assert.equal(sample.callLine, null);
  assert.equal(sample.startLabel, 'Starts');
  // A real show without a call time (an older shows.json) still renders.
  const plain = { ...screening };
  delete plain.eventAt;
  delete plain.eventAtMs;
  delete plain.durationMin;
  assert.equal(showCardModel(plain, { tip: 977_700 }).callLine, null);
});

test('real ticket: held counts down to the call with the settle as small print; walked in says when the call starts', () => {
  const now = Date.parse('2026-11-23T13:00:00Z');
  const held = ticketModel(ticket({ show: screening }), { tip: 978_630, now, timeZone: 'Asia/Taipei' });
  assert.deepEqual(held.call, { phase: 'before', countdown: '24 h', line: 'The call starts Tue 24 Nov, 21:00 GMT+8, for 25 minutes.' });
  assert.match(held.settleLine, /^Settling opens at block 978,779, about .+; the refund follows once the keeper or this page sends it\.$/);
  assert.equal(held.seat, 'S-2-1');
  assert.equal(held.canWalkIn, true);
  const during = ticketModel(ticket({ show: screening }), { tip: 978_700, now: Date.parse('2026-11-24T13:05:00Z'), timeZone: 'UTC' });
  assert.deepEqual(during.call, { phase: 'on', countdown: null, line: 'The call is on now.' });
  const after = ticketModel(ticket({ show: screening }), { tip: 978_770, now: Date.parse('2026-11-24T14:00:00Z'), timeZone: 'UTC' });
  assert.equal(after.call, null, 'after the call the ticket counts down to the settle again');
  assert.equal(after.canWalkIn, false, 'Walk in closes when the call ends');
  assert.equal(after.canHandBack, true);
  assert.equal(after.lines.at(-1), 'The call is over, so Walk in is closed.');
  assert.equal(ticketModel(ticket({ show: screening }), { tip: 978_700, now: Date.parse('2026-11-24T13:24:00Z') }).canWalkIn, true, 'a late arrival walks in during the call');

  const walked = ticketModel(ticket({ show: screening, state: 'walkedIn', escrowUtxo: null, canAct: false }), { tip: 978_630, now, timeZone: 'Asia/Taipei' });
  assert.deepEqual(walked.lines, [
    'Walked in. Your ticket stays in your wallet as a keepsake stub with no money behind it.',
    'The call starts Tue 24 Nov, 21:00 GMT+8 (in 24 h).',
  ]);
  const walkedDuring = ticketModel(ticket({ show: screening, state: 'walkedIn', escrowUtxo: null, canAct: false }), { tip: 978_700, now: Date.parse('2026-11-24T13:05:00Z') });
  assert.equal(walkedDuring.lines.at(-1), 'The call is on now.');
  // A sample ticket has no call.
  assert.equal(ticketModel(ticket(), { tip: 977_603 }).call, null);
});

test('settle countdown: the place and time once (not the countdown again), and a bar from the purchase to the settle', () => {
  const now = Date.parse('2026-11-16T08:00:00Z');
  const fresh = ticketModel(ticket({ boughtAtTip: 977_603 }), { tip: 977_603, now, timeZone: 'UTC' });
  assert.equal(fresh.countdown, '6 h 10 min');
  assert.equal(fresh.settleSmall, 'At block 977,640, about Mon 16 Nov, 14:10 UTC; the refund follows once the keeper or this page sends it.');
  assert.equal(fresh.progress, 0);
  const later = ticketModel(ticket({ buy: { txid: 'c035df00'.padEnd(64, '0'), height: 977_603 } }), { tip: 977_621, now, timeZone: 'UTC' });
  assert.equal(later.progress, 0.5);
  assert.equal(ticketModel(ticket(), { tip: 977_603 }).progress, null, 'no purchase height known: no bar');
});

test('a finished ticket says what was paid, what came back and where the rest went (no posted fee)', () => {
  const back = ticketModel(ticket({ state: 'handedBack', escrowUtxo: null, ticketUtxo: null, canAct: false }), { tip: 977_610, returned: 101_029n, paid: 102_932n });
  assert.deepEqual(back.lines, [
    'Handed back. 0.00101029 BCH came back to your wallet.',
    'You paid 0.00102932 BCH; 0.00101029 BCH came back; the rest was network fees.',
  ]);
  const refunded = ticketModel(ticket({ state: 'refunded', refundPath: 'refund', escrowUtxo: null, canAct: false, ticketUtxo: { txid: 'aa'.repeat(32), vout: 1, output: { valueSatoshis: 1_000n } } }), { tip: 977_610, returned: 100_179n, paid: 102_932n });
  assert.equal(refunded.lines[1], 'You paid 0.00102932 BCH; 0.00100179 BCH came back and 0.00001 BCH stays with the ticket NFT; the rest was network fees.');
  // A posted fee would be part of "the rest": the line is left out.
  const withFee = { ...show, handBackFeeBps: 200 };
  assert.equal(ticketModel(ticket({ show: withFee, state: 'handedBack', escrowUtxo: null, canAct: false }), { tip: 977_610, returned: 99_000n, paid: 102_932n }).lines.length, 1);
  const settledWithFee = { ...show, noShowFeeBps: 500 };
  assert.equal(ticketModel(ticket({ show: settledWithFee, state: 'refunded', refundPath: 'settle', escrowUtxo: null, canAct: false }), { tip: 977_650, returned: 95_000n, paid: 102_932n }).lines.length, 1);
  // Unknown payment: no line.
  assert.equal(ticketModel(ticket({ state: 'handedBack', escrowUtxo: null, canAct: false }), { tip: 977_610, returned: 101_029n }).lines.length, 1);
});
