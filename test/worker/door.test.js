// POST /api/door: a real check-in on the simnet gets the event link once;
// check-ins not on chain, of another show, hand-backs and buys are refused.
// Forged check-ins that the network would never accept (wrong payee, no
// keepsake, a bad signature) are served by a lying chain to the door's own
// checks, which must refuse them by themselves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeTransaction, hexToBin } from '@bitauth/libauth';
import { buildCheckIn, p2pkhLockingBytecode } from '../../src/tx/index.js';
import { freshKey, signWallet } from '../helpers.js';
import { txidOf } from '../../worker/lib/crypto.js';
import { answerDoor } from '../../worker/lib/door.js';
import { createMemoryClaims } from '../../worker/lib/limits.js';
import { parseWorkerShows } from '../../worker/lib/shows.js';
import { decodeTransaction } from '../../worker/lib/tx.js';
import { libauthVmCheck } from '../../worker/node/vm.js';
import { buyTicket, post, send, signedCheckIn, signedHandBack, startWorker, workerSimnet } from './support.js';

const LINK = 'https://example.invalid/live?seat={seat}&checkin={txid}';

test('door: a real check-in on chain gets the link once; not on chain, other show, hand-back and buy are refused', async (t) => {
  const ctx = await workerSimnet(t, {
    name: 'door',
    schedule: [
      { id: 'real-show', kind: 'real', title: 'Real show', card: 'A real show.', startHeight: '+300' },
      { id: 'other-real', kind: 'real', title: 'Other show', card: 'Another real show.', startHeight: '+300' },
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
    link: `https://example.invalid/live?seat=R-0-1&checkin=${checkInTxid}`,
  });
  const second = await door({ category: real.categoryHex, txid: checkInTxid });
  assert.equal(second.status, 409, 'one answer per check-in');
  assert.equal(second.body.error.code, 'already-answered');

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
  const ctx = await workerSimnet(t, { name: 'door-forged', schedule: [{ id: 'real-show', kind: 'real', title: 'Real show', card: 'A real show.', startHeight: '+300' }] });
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
  // Without the VM (workerd), the door relies on the network having accepted the check-in: the rule check alone passes it.
  const rulesOnly = await ask(put(badSignature), null);
  assert.equal(rulesOnly.seat, ticket.seatHex, 'documented in RUNTIME.md: workerd trusts the network for signatures');
});
