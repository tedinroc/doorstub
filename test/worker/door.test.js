// POST /api/door: a real check-in on the simnet gets the event link, for one
// claimant per check-in (the first caller's IP or claim secret, so a page that
// retries still gets in); check-ins not on chain, of another show, hand-backs
// and buys are refused. A page that reserves its check-in before sending it
// keeps an observer who reads the txid from the mempool out (A1).
// Forged check-ins that the network would never accept (wrong payee, no
// keepsake, a bad signature) are served by a lying chain to the door's own
// checks, which must refuse them by themselves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeTransaction, hexToBin } from '@bitauth/libauth';
import { buildCheckIn, p2pkhLockingBytecode } from '../../src/tx/index.js';
import { freshKey, signWallet } from '../helpers.js';
import { txidOf } from '../../worker/lib/crypto.js';
import { answerDoor, claimToken } from '../../worker/lib/door.js';
import { ANSWER_TTL_SECONDS, DEFAULT_LIMITS, RESERVE_TTL_SECONDS, createKvClaims, createMemoryClaims, withFallback } from '../../worker/lib/limits.js';
import { parseWorkerShows } from '../../worker/lib/shows.js';
import { decodeTransaction } from '../../worker/lib/tx.js';
import { libauthVmCheck } from '../../worker/node/vm.js';
import { buyTicket, post, send, signedCheckIn, signedHandBack, startWorker, workerSimnet } from './support.js';

const LINK = 'https://example.invalid/live?seat={seat}&checkin={txid}';
const call = (seatPrefix) => ({ eventAt: '2026-11-24T13:00:00Z', durationMin: 25, seatPrefix });

/** A KV namespace in memory that keeps the options of each put. */
const memoryKv = () => {
  const store = new Map();
  return {
    store,
    get: async (key) => store.get(key)?.value ?? null,
    put: async (key, value, options) => {
      store.set(key, { value, options });
    },
  };
};

test('door: a real check-in on chain gets the link once; not on chain, other show, hand-back and buy are refused', async (t) => {
  const ctx = await workerSimnet(t, {
    name: 'door',
    schedule: [
      { id: 'real-show', kind: 'real', title: 'Real show', card: 'A real show.', startHeight: '+300', ...call('R') },
      { id: 'other-real', kind: 'real', title: 'Other show', card: 'Another real show.', startHeight: '+300', ...call('O') },
    ],
  });
  const [showA] = ctx.byKind('sample-settle');
  const real = ctx.shows.find((s) => s.id === 'real-show');
  const otherReal = ctx.shows.find((s) => s.id === 'other-real');
  const worker = await startWorker(t, ctx, { env: { DOOR_LINKS: JSON.stringify({ 'real-show': LINK }) } });
  const door = (body) => post(worker, '/api/door', body);

  // Buy, walk in (holder signs), send; then ask the door.
  const ticket = await buyTicket(ctx.rpc, real);
  const checkIn = signedCheckIn(real, ticket);
  const checkInTxid = txidOf(encodeTransaction(checkIn.transaction));
  const early = await door({ category: real.categoryHex, txid: checkInTxid });
  assert.equal(early.status, 404, 'not on chain yet');
  assert.equal(early.body.error.code, 'not-on-chain');
  assert.equal(early.body.error.retryable, true);
  assert.equal(await send(ctx.rpc, checkIn), checkInTxid);

  const answer = await door({ category: real.categoryHex, txid: checkInTxid });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.deepEqual(answer.body, {
    show: 'real-show',
    seat: ticket.seatHex,
    seatLabel: 'R-0-1',
    txid: checkInTxid,
    confirmed: false,
    again: false,
    link: `https://example.invalid/live?seat=R-0-1&checkin=${checkInTxid}`,
  });
  // The same claimant (here the same client IP, as a page retrying after a lost answer) gets the same answer again ...
  const retry = await door({ category: real.categoryHex, txid: checkInTxid });
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.body, { ...answer.body, again: true });
  // ... anyone else (here: a claim secret the first caller did not send) does not: one claimant per check-in.
  const second = await door({ category: real.categoryHex, txid: checkInTxid, claim: 'ab'.repeat(32) });
  assert.equal(second.status, 409, 'one claimant per check-in');
  assert.equal(second.body.error.code, 'already-answered');
  assert.equal(second.body.message, second.body.error.message, 'the message is also at the top level');

  // A page that sends a claim secret is recognised by it, not by its IP.
  const claimed = await buyTicket(ctx.rpc, real, { shard: 2 });
  const claimedTxid = await send(ctx.rpc, signedCheckIn(real, claimed));
  const secret = 'cd'.repeat(32);
  assert.equal((await door({ category: real.categoryHex, txid: claimedTxid, claim: secret })).body.again, false);
  assert.equal((await door({ category: real.categoryHex, txid: claimedTxid, claim: secret.toUpperCase() })).body.again, true);
  assert.equal((await door({ category: real.categoryHex, txid: claimedTxid })).status, 409, 'the same IP without the secret is someone else');
  assert.equal((await door({ category: real.categoryHex, txid: claimedTxid, claim: 'ab' })).body.error.code, 'bad-request', 'a claim is 32 to 128 hex');

  // A check-in of another show (sample A, or another real show) is not a check-in of this one.
  const aTicket = await buyTicket(ctx.rpc, showA);
  const aCheckIn = await send(ctx.rpc, signedCheckIn(showA, aTicket));
  const oTicket = await buyTicket(ctx.rpc, otherReal);
  const oCheckIn = await send(ctx.rpc, signedCheckIn(otherReal, oTicket));
  // A hand-back and a buy of this show are not check-ins.
  const hTicket = await buyTicket(ctx.rpc, real);
  const handBack = await send(ctx.rpc, signedHandBack(real, hTicket));
  const buyOnly = await buyTicket(ctx.rpc, real);
  const cases = [
    [{ category: real.categoryHex, txid: aCheckIn }, 422, 'not-escrow'],
    [{ category: real.categoryHex, txid: oCheckIn }, 422, 'not-escrow'],
    [{ category: real.categoryHex, txid: handBack }, 422, 'not-a-check-in'],
    [{ category: real.categoryHex, txid: buyOnly.txid }, 422, 'not-a-check-in'],
    [{ category: showA.categoryHex, txid: aCheckIn }, 403, 'not-a-real-show'],
    [{ category: otherReal.categoryHex, txid: oCheckIn }, 503, 'door-not-configured'],
    [{ category: '22'.repeat(32), txid: checkInTxid }, 404, 'unknown-show'],
    [{ category: real.categoryHex, txid: 'abc' }, 400, 'bad-request'],
  ];
  for (const [body, status, code] of cases) {
    const res = await door(body);
    assert.equal(res.status, status, `${JSON.stringify(body)} -> ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error.code, code);
  }

  // Confirmed check-ins are answered too (and say so).
  const later = await buyTicket(ctx.rpc, real, { shard: 1 });
  const laterTxid = await send(ctx.rpc, signedCheckIn(real, later));
  await ctx.rpc.request('simnet.mine', { blocks: 1 });
  const confirmed = await door({ category: real.categoryHex, txid: laterTxid });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.confirmed, true);
  assert.equal(confirmed.body.seatLabel, 'R-1-1');
});

test('door: forged check-ins served by a lying chain are refused by the door itself (wrong payee, no keepsake, bad signature)', async (t) => {
  const ctx = await workerSimnet(t, { name: 'door-forged', schedule: [{ id: 'real-show', kind: 'real', title: 'Real show', card: 'A real show.', startHeight: '+300', ...call('R') }] });
  const real = ctx.shows.find((s) => s.id === 'real-show');
  const { shows } = parseWorkerShows(ctx.showsText, { network: 'simnet' });
  const ticket = await buyTicket(ctx.rpc, real);
  const honest = signedCheckIn(real, ticket);
  const attacker = p2pkhLockingBytecode(freshKey().pkh);

  // A chain that "knows" whatever we put in it.
  const known = new Map();
  const put = (transaction) => {
    const bytes = encodeTransaction(transaction);
    const txid = txidOf(bytes);
    known.set(txid, { txid, bytes, transaction: decodeTransaction(bytes) });
    return txid;
  };
  put(ticket.transaction);
  const lying = { getTransaction: async (txid) => known.get(txid) ?? null, transactionHeight: async () => 0 };
  const ask = (txid, vmCheck = libauthVmCheck) =>
    answerDoor({ shows, chain: lying, doorLinks: { 'real-show': LINK }, claims: createMemoryClaims(), vmCheck, body: { category: real.categoryHex, txid } });

  const unsigned = buildCheckIn({ show: real, escrowUtxo: ticket.escrowUtxo, ticketUtxo: ticket.ticketUtxo, contracts: real.contracts });
  const resign = (transaction) => signWallet({ ...unsigned, transaction }, ticket.key.privateKey).transaction;
  const [payout, keepsake] = unsigned.transaction.outputs;
  const forged = {
    'wrong-payee': resign({ ...unsigned.transaction, outputs: [{ ...payout, lockingBytecode: attacker }, keepsake] }),
    'short-payout': resign({ ...unsigned.transaction, outputs: [{ ...payout, valueSatoshis: payout.valueSatoshis - 2_000n }, keepsake] }),
    'no-keepsake': resign({ ...unsigned.transaction, outputs: [payout, { lockingBytecode: keepsake.lockingBytecode, valueSatoshis: keepsake.valueSatoshis }] }),
  };
  forged['no-keepsake (sent elsewhere)'] = resign({ ...unsigned.transaction, outputs: [payout, { ...keepsake, lockingBytecode: attacker }] });
  // The ticket moved away from its buyer (a made-up transfer the lying chain vouches for): the holder is not the buyer.
  const moved = put({
    version: 2,
    inputs: [{ outpointTransactionHash: ticket.ticketUtxo.txid, outpointIndex: ticket.ticketUtxo.vout, sequenceNumber: 0xffffffff, unlockingBytecode: new Uint8Array(0) }],
    outputs: [{ ...ticket.ticketUtxo.output, lockingBytecode: attacker }],
    locktime: 0,
  });
  forged['ticket-moved'] = {
    ...unsigned.transaction,
    inputs: [unsigned.transaction.inputs[0], { ...unsigned.transaction.inputs[1], outpointTransactionHash: hexToBin(moved), outpointIndex: 0 }],
  };
  for (const [label, transaction] of Object.entries(forged)) {
    const code = label.split(' ')[0];
    await assert.rejects(ask(put(transaction)), (e) => e.code === code, label);
  }
  // Structurally a perfect check-in, but the holder never signed it: only the VM can tell.
  const badSignature = { ...honest.transaction, inputs: honest.transaction.inputs.map((input, i) => (i === 1 ? { ...input, unlockingBytecode: resign(unsigned.transaction).inputs[1].unlockingBytecode.map((b, j) => (j === 10 ? b ^ 1 : b)) } : input)) };
  await assert.rejects(ask(put(badSignature)), (e) => e.code === 'vm-invalid');
  // The honest one passes the same door.
  const ok = await ask(put(honest.transaction));
  assert.equal(ok.seat, ticket.seatHex);

  // One claimant per check-in, by IP or by claim secret, in memory and in a KV namespace (Pages with DOOR_CLAIMS bound).
  const kv = memoryKv();
  const kvStore = kv.store;
  const kvClaims = createKvClaims(kv);
  for (const claims of [createMemoryClaims(), kvClaims]) {
    const txid = put(honest.transaction);
    const at = (clientIp, claim) => answerDoor({ shows, chain: lying, doorLinks: { 'real-show': LINK }, claims, vmCheck: libauthVmCheck, clientIp, body: { category: real.categoryHex, txid, ...(claim && { claim }) } });
    assert.equal((await at('198.51.100.1')).again, false, claims.kind);
    assert.equal((await at('198.51.100.1')).again, true, `${claims.kind}: same IP, same answer`);
    await assert.rejects(at('198.51.100.2'), (e) => e.code === 'already-answered' && e.status === 409, `${claims.kind}: another IP`);
    await assert.rejects(at('198.51.100.1', 'ef'.repeat(16)), (e) => e.code === 'already-answered', `${claims.kind}: a claim the first caller did not send`);
  }
  const [stored] = [...kvStore.values()];
  assert.match(stored.value, /^a:[0-9a-f]{64}$/, 'KV holds a hash, never the IP');
  assert.equal(stored.options.expirationTtl, ANSWER_TTL_SECONDS);
  // Without an IP or a claim, the first caller wins and nobody can repeat it.
  const anonymous = createMemoryClaims();
  assert.equal(await anonymous.claim('k', claimToken({ clientIp: 'unknown' })), 'first');
  assert.equal(await anonymous.claim('k', null), 'taken');
  // Without the VM (workerd), the door relies on the network having accepted the check-in: the rule check alone passes it.
  const rulesOnly = await ask(put(badSignature), null);
  assert.equal(rulesOnly.seat, ticket.seatHex, 'documented in RUNTIME.md: workerd trusts the network for signatures');
});

test('door reserve: the page reserves its check-in before sending it, so an observer who reads the txid from the mempool gets 409', async (t) => {
  const ctx = await workerSimnet(t, { name: 'door-reserve', schedule: [{ id: 'screening-1', kind: 'real', title: 'Doorstub screening 1', card: 'A real show.', startHeight: '+300', ...call('S') }] });
  const [showA] = ctx.byKind('sample-settle');
  const real = ctx.shows.find((s) => s.id === 'screening-1');
  const worker = await startWorker(t, ctx, { env: { DOOR_LINKS: JSON.stringify({ 'screening-1': LINK }) } });
  const door = (body) => post(worker, '/api/door', body);
  const holder = 'a1'.repeat(32);
  const observer = 'b2'.repeat(32);

  // The holder's page: the wallet signed the check-in, the page knows its txid, nobody else does yet.
  const ticket = await buyTicket(ctx.rpc, real);
  const checkIn = signedCheckIn(real, ticket);
  const txid = txidOf(encodeTransaction(checkIn.transaction));
  const reserve = (claim) => door({ category: real.categoryHex, txid, claim, reserve: true });
  const first = await reserve(holder);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body, { reserved: true, again: false }, 'no chain lookup: the check-in is not even sent yet');
  assert.deepEqual((await reserve(holder.toUpperCase())).body, { reserved: true, again: true }, 'the same claim again');
  const stolen = await reserve(observer);
  assert.equal(stolen.status, 409);
  assert.equal(stolen.body.error.code, 'already-answered');
  assert.equal(stolen.body.message, stolen.body.error.message);

  // Sent. An observer watching the Escrow's mempool asks first, with its own claim or none: refused.
  assert.equal(await send(ctx.rpc, checkIn), txid);
  const mempool = await ctx.rpc.request('blockchain.scripthash.get_mempool', [real.derived.escrowScripthash]);
  assert.ok(mempool.some((item) => item.tx_hash === txid), 'the check-in is public now');
  for (const body of [{ category: real.categoryHex, txid, claim: observer }, { category: real.categoryHex, txid }]) {
    const res = await door(body);
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'already-answered');
  }
  // The holder's page asks with its claim: the link, once the chain checks pass; again on a retry.
  const answer = await door({ category: real.categoryHex, txid, claim: holder });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.deepEqual(answer.body, {
    show: 'screening-1',
    seat: ticket.seatHex,
    seatLabel: 'S-0-1',
    txid,
    confirmed: false,
    again: false,
    link: `https://example.invalid/live?seat=S-0-1&checkin=${txid}`,
  });
  assert.equal((await door({ category: real.categoryHex, txid, claim: holder })).body.again, true);
  assert.equal((await reserve(holder)).body.again, true, 'a late reservation by the holder is harmless');
  assert.equal((await door({ category: real.categoryHex, txid, claim: observer })).status, 409, 'still nobody else');

  // Refusals: not a real show, a bad request, an unknown show.
  const cases = [
    [{ category: showA.categoryHex, txid, claim: holder, reserve: true }, 403, 'not-a-real-show'],
    [{ category: real.categoryHex, txid, reserve: true }, 400, 'bad-request'],
    [{ category: real.categoryHex, txid, claim: holder, reserve: 'yes' }, 400, 'bad-request'],
    [{ category: real.categoryHex, txid, claim: 'ab', reserve: true }, 400, 'bad-request'],
    [{ category: '33'.repeat(32), txid, claim: holder, reserve: true }, 404, 'unknown-show'],
  ];
  for (const [body, status, code] of cases) {
    const res = await door(body);
    assert.equal(res.status, status, `${JSON.stringify(body)} -> ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error.code, code);
  }

  // Without a reservation (an older page), the first caller still wins, as before.
  const plain = await buyTicket(ctx.rpc, real, { shard: 1 });
  const plainTxid = await send(ctx.rpc, signedCheckIn(real, plain));
  assert.equal((await door({ category: real.categoryHex, txid: plainTxid, claim: holder })).status, 200);
  assert.equal((await door({ category: real.categoryHex, txid: plainTxid, claim: holder, reserve: true })).body.again, true);
  assert.equal((await door({ category: real.categoryHex, txid: plainTxid, claim: observer, reserve: true })).status, 409);

  // Each new reservation is a KV write that needs no check-in, so reservations have their own per-IP limit
  // (10 an hour by default; 2 here). Asking the door is not counted against it.
  const tight = await startWorker(t, ctx, { env: { DOOR_LINKS: JSON.stringify({ 'screening-1': LINK }) }, limits: { door: { max: 20, windowMs: 60_000 }, reserve: { max: 2, windowMs: 3_600_000 } } });
  const fresh = (i) => ({ category: real.categoryHex, txid: `${i}`.padStart(2, '0').repeat(32), claim: holder, reserve: true });
  assert.equal((await post(tight, '/api/door', fresh(1))).status, 200);
  assert.equal((await post(tight, '/api/door', fresh(2))).status, 200);
  const third = await post(tight, '/api/door', fresh(3));
  assert.equal(third.status, 429);
  assert.equal(third.body.error.code, 'rate-limited');
  assert.equal((await post(tight, '/api/door', { category: real.categoryHex, txid, claim: holder })).status, 200, 'the holder\'s ask still goes through');
  assert.equal(DEFAULT_LIMITS.reserve.max, 10);
  assert.equal(DEFAULT_LIMITS.reserve.windowMs, 3_600_000);
});

test('door reserve: no chain lookup, a reservation kept as long as an answer, the same rules in memory and in KV, and KV trouble falls back to memory', async () => {
  const shows = [{ id: 'screening-1', kind: 'real', categoryHex: 'cc'.repeat(32), door: { endpoint: '/api/door' } }];
  const noChain = new Proxy({}, { get: () => () => assert.fail('a reservation never reads the chain') });
  const txid = 'dd'.repeat(32);
  const reserveWith = (claims, claim) => answerDoor({ shows, chain: noChain, doorLinks: {}, claims, body: { category: shows[0].categoryHex, txid, claim, reserve: true } });
  const holder = claimToken({ claim: 'a1'.repeat(32) });
  const other = claimToken({ claim: 'b2'.repeat(32) });

  // Reservation and answer in memory, with a clock.
  let clock = 0;
  const memory = createMemoryClaims({ now: () => clock });
  assert.deepEqual(await reserveWith(memory, 'a1'.repeat(32)), { reserved: true, again: false });
  assert.equal(await memory.claim('door:screening-1:' + txid, other), 'taken', 'someone else, before the reservation expires');
  // The check-in's txid stays public on the Escrow's history, so an unanswered reservation (the door down or not set up
  // yet when the page asked) must not lapse before its holder comes back: it is kept as long as an answer, 120 days.
  assert.equal(RESERVE_TTL_SECONDS, ANSWER_TTL_SECONDS);
  assert.equal(ANSWER_TTL_SECONDS, 120 * 24 * 3_600);
  clock += 3 * 3_600_000;
  assert.equal(await memory.claim('door:screening-1:' + txid, other), 'taken', 'three hours later a sweeper still gets nothing');
  assert.equal(await memory.claim('door:screening-1:' + txid, null), 'taken');
  clock = RESERVE_TTL_SECONDS * 1_000 - 1;
  assert.equal(await memory.reserve('door:screening-1:' + txid, other), 'taken');
  assert.equal(await memory.claim('door:screening-1:' + txid, holder), 'first', 'the holder still gets the answer after the door was down for days');
  clock = 0;
  const unanswered = createMemoryClaims({ now: () => clock });
  assert.equal(await unanswered.reserve('u', holder), 'first');
  clock += RESERVE_TTL_SECONDS * 1_000;
  assert.equal(await unanswered.reserve('u', other), 'first', 'a reservation nobody answered goes after 120 days');
  // Answered records stay as long.
  clock = 0;
  assert.equal(await memory.reserve('k', holder), 'first');
  assert.equal(await memory.claim('k', holder), 'first', 'the first answer to the reserving claimant');
  assert.equal(await memory.claim('k', holder), 'same');
  clock += ANSWER_TTL_SECONDS * 1_000 - 1;
  assert.equal(await memory.claim('k', other), 'taken', 'an answered check-in is kept 120 days');
  assert.equal(await memory.claim('k', null), 'taken');

  // The same in a KV namespace: a hash with the state, kept 120 days whether reserved or answered.
  const kv = memoryKv();
  const kvClaims = createKvClaims(kv);
  assert.deepEqual(await reserveWith(kvClaims, 'a1'.repeat(32)), { reserved: true, again: false });
  const key = `door:screening-1:${txid}`;
  assert.equal(kv.store.get(key).value, `r:${holder}`);
  assert.equal(kv.store.get(key).options.expirationTtl, RESERVE_TTL_SECONDS);
  await assert.rejects(reserveWith(kvClaims, 'b2'.repeat(32)), (e) => e.code === 'already-answered' && e.status === 409);
  assert.equal(await kvClaims.claim(key, other), 'taken');
  assert.equal(await kvClaims.claim(key, holder), 'first');
  assert.equal(kv.store.get(key).value, `a:${holder}`);
  assert.equal(kv.store.get(key).options.expirationTtl, ANSWER_TTL_SECONDS);
  assert.equal(await kvClaims.claim(key, holder), 'same');
  assert.equal(await kvClaims.reserve(key, holder), 'same');
  // A record written before reservations existed (a bare hash) reads as answered.
  kv.store.set('old', { value: holder });
  assert.equal(await kvClaims.claim('old', holder), 'same');

  // KV down or over its write quota: the isolate's memory record answers instead, and the log says so.
  const lines = [];
  const broken = createKvClaims({ get: async () => { throw new Error('KV PUT failed: 429 Too Many Requests'); }, put: async () => {} });
  const fallback = withFallback(broken, createMemoryClaims(), (line) => lines.push(line));
  assert.deepEqual(await reserveWith(fallback, 'a1'.repeat(32)), { reserved: true, again: false });
  assert.equal(await fallback.claim(key, holder), 'first');
  assert.equal(await fallback.claim(key, other), 'taken');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /kv reserve failed .*using memory/);
});
