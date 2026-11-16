// The worker's own check of a transaction before it is broadcast or trusted.
//
// `checkEscrowSpend` re-checks a settle or refund the keeper or signer made
// against the Escrow contract's rules for those paths (SPEC.md 3.2), from the
// coins we looked up ourselves: every input is a marker coin of this show at
// its Escrow, unlocked with this show's redeem script; every output is the
// buyer's own payout at the coin's index (and, in a settle, the exact posted
// fee at index k + i); nothing else. It is the guard on the worker's own
// assembler, so a bug there can never send money anywhere else.
//
// `checkCheckIn` is the door's check of a holder-signed check-in.
//
// `vet` runs those rules plus an optional VM check (the Node adapter passes
// the libauth 2026 VM; workerd cannot load it, see RUNTIME.md) and brands the
// result. The worker's chain client broadcasts only branded transactions.
import { MAX_STANDARD_TX_BYTES, SEQUENCE_FINAL, TAG_MARKER, TAG_TICKET, TOKEN_OUTPUT_SATS } from '../../src/tx/constants.js';
import { bytesToHex, equal, WorkerError } from './bytes.js';
import { verifyDataSignature } from './crypto.js';
import { feeOnCoin } from './escrow.js';
import { refundNoticeMessage } from './shows.js';
import { ESCROW_SELECTORS, p2pkhKeyHash, p2pkhLockingBytecode, readPushes, readSmallNumber } from './script.js';
import { dustThreshold, encodeTransaction, serialise } from './tx.js';

const SCOPES = { 0x43: 'C', 0x52: 'R' };

const refuse = (code, message) => {
  throw new WorkerError(code, message, { status: 422 });
};

/** Parse an Escrow coin's marker; refuse anything else. */
const markerOf = (show, output, where) => {
  if (!equal(output.lockingBytecode, show.escrow.lockingBytecode)) refuse('not-escrow', `${where} is not at this show's Escrow`);
  const token = output.token;
  if (token === undefined || !equal(token.category, show.category)) refuse('wrong-category', `${where} carries no token of this show`);
  if (token.amount !== 0n || token.nft?.capability !== 'none') refuse('wrong-token', `${where} is not an immutable NFT`);
  const c = token.nft.commitment;
  if (c.length !== 24 || c[0] !== TAG_MARKER) refuse('not-a-marker', `${where} does not carry a marker`);
  if (output.valueSatoshis < show.price + TOKEN_OUTPUT_SATS) refuse('short-coin', `${where} holds less than price + 1,000 sats`);
  return { seat: c.slice(1, 4), buyerPkh: c.slice(4, 24), value: output.valueSatoshis };
};

/** Parse an Escrow unlock: { selector, args } with this show's redeem script, or refuse. */
const escrowUnlockOf = (show, unlockingBytecode, where) => {
  const pushes = readPushes(unlockingBytecode);
  if (pushes === undefined || pushes.length < 2) refuse('bad-unlock', `${where} is not a contract call`);
  if (!equal(pushes[pushes.length - 1], show.escrow.redeemScript)) refuse('bad-unlock', `${where} does not use this show's Escrow redeem script`);
  const selector = readSmallNumber(pushes[pushes.length - 2]);
  return { selector, args: pushes.slice(0, -2) };
};

const noToken = (output, where) => {
  if (output.token !== undefined) refuse('token-on-payout', `${where} carries a token`);
};

/**
 * Check a settle or refund against Escrow's rules for those paths.
 * @param {object} a
 * @param {object} a.show worker show
 * @param {'settle'|'refund'} a.kind
 * @param {object} a.transaction decoded transaction
 * @param {Array} a.sourceOutputs the outputs it spends, from OUR lookups
 * @param {number} [a.tip] chain tip; a settle must be final in the next block
 */
export const checkEscrowSpend = ({ show, kind, transaction, sourceOutputs, tip }) => {
  const n = transaction.inputs.length;
  if (n === 0 || sourceOutputs.length !== n) refuse('bad-source-outputs', 'need one source output per input');
  if (transaction.version !== 2) refuse('bad-version', 'transactions are version 2');
  const size = encodeTransaction(transaction).length;
  if (size > MAX_STANDARD_TX_BYTES) refuse('tx-too-large', `${size} bytes is over the standard limit`);
  const coins = sourceOutputs.map((output, i) => markerOf(show, output, `input ${i}`));
  const seen = new Set();
  transaction.inputs.forEach((input, i) => {
    const key = `${bytesToHex(input.outpointTransactionHash)}:${input.outpointIndex}`;
    if (seen.has(key)) refuse('duplicate-input', `input ${i} spends a coin twice`);
    seen.add(key);
    const { selector, args } = escrowUnlockOf(show, input.unlockingBytecode, `input ${i}`);
    if (kind === 'settle') {
      if (selector !== ESCROW_SELECTORS.settle || args.length !== 0) refuse('wrong-path', `input ${i} is not a settle`);
      if (input.sequenceNumber === SEQUENCE_FINAL) refuse('final-sequence', `input ${i} has a final sequence number, so the locktime would not count`);
    } else if (kind === 'refund') {
      if (selector !== ESCROW_SELECTORS.refund || args.length !== 2) refuse('wrong-path', `input ${i} is not a refund`);
      const [scopePush, signature] = args;
      const scope = scopePush.length === 1 ? SCOPES[scopePush[0]] : undefined;
      if (scope === undefined) refuse('bad-scope', `input ${i}: scope must be C or R`);
      const message = refundNoticeMessage({ scope, category: show.category, seat: coins[i].seat });
      if (!verifyDataSignature(signature, show.organiserDataPk, message)) refuse('bad-notice', `input ${i}: the notice does not verify for this show${scope === 'R' ? ' and seat' : ''}`);
    } else refuse('wrong-path', `unknown path ${kind}`);
  });

  let feeSlots = 0;
  let feeFreeSeen = false;
  coins.forEach((coin, i) => {
    const fee = kind === 'settle' ? feeOnCoin(coin.value, show.noShowFeeBps) : 0n;
    if (fee > 0n) {
      if (feeFreeSeen) refuse('fee-order', 'coins that owe a fee must come first');
      feeSlots += 1;
    } else feeFreeSeen = true;
    const out = transaction.outputs[i];
    if (out === undefined) refuse('missing-payout', `no payout for input ${i}`);
    noToken(out, `output ${i}`);
    if (!equal(out.lockingBytecode, p2pkhLockingBytecode(coin.buyerPkh))) refuse('wrong-payee', `output ${i} does not pay the buyer of input ${i}`);
    if (out.valueSatoshis > coin.value - fee || out.valueSatoshis < coin.value - fee - show.minerFeeCap) {
      refuse('wrong-amount', `output ${i} is outside the buyer's due less the network-fee cap`);
    }
    if (fee > 0n) {
      const feeOut = transaction.outputs[n + i];
      if (feeOut === undefined) refuse('missing-fee', `no fee output for input ${i}`);
      noToken(feeOut, `output ${n + i}`);
      if (!equal(feeOut.lockingBytecode, p2pkhLockingBytecode(show.organiserPkh)) || feeOut.valueSatoshis !== fee) {
        refuse('wrong-fee', `output ${n + i} is not exactly the posted fee to the organiser`);
      }
    }
  });
  if (transaction.outputs.length !== n + feeSlots) refuse('extra-output', 'the transaction has outputs beyond the payouts and posted fees');
  transaction.outputs.forEach((o, i) => {
    if (o.valueSatoshis < dustThreshold(o)) refuse('dust-output', `output ${i} is dust`);
  });

  if (kind === 'settle') {
    const opens = show.startHeight + show.graceBlocks;
    if (transaction.locktime < opens || transaction.locktime >= 500_000_000) refuse('too-early', `settle needs a locktime of at least block ${opens}`);
    if (tip !== undefined && transaction.locktime > tip) refuse('not-final', `the locktime ${transaction.locktime} is above the tip ${tip}`);
  }
  const totalIn = coins.reduce((a, c) => a + c.value, 0n);
  const totalOut = transaction.outputs.reduce((a, o) => a + o.valueSatoshis, 0n);
  if (totalIn - totalOut < BigInt(size)) refuse('fee-too-low', 'the miner fee is below 1 sat per byte');
  return { coins, size };
};

/**
 * The door's check of a check-in (SPEC.md 3.2 checkIn, section 7 "Ticket"):
 * input 0 spends a marker coin of this show at its Escrow with checkIn(1);
 * input 1 is the matching ticket at P2PKH(buyerPkh); output 0 pays the
 * organiser payee at least the coin's value less the cap; output 1 returns the
 * ticket's exact NFT to the buyer as a keepsake. Source outputs come from our
 * own lookups. Returns { seat, buyerPkh, payout }.
 */
export const checkCheckIn = ({ show, transaction, sourceOutputs }) => {
  if (transaction.inputs.length !== 2 || transaction.outputs.length !== 2) refuse('not-a-check-in', 'a check-in has exactly two inputs and two outputs');
  if (sourceOutputs.length !== 2) refuse('bad-source-outputs', 'need both source outputs');
  const coin = markerOf(show, sourceOutputs[0], 'input 0');
  const { selector, args } = escrowUnlockOf(show, transaction.inputs[0].unlockingBytecode, 'input 0');
  if (selector !== ESCROW_SELECTORS.checkIn || args.length !== 1 || readSmallNumber(args[0]) !== 1) refuse('not-a-check-in', 'input 0 is not a check-in with the ticket at input 1');
  const ticket = sourceOutputs[1];
  const t = ticket.token;
  if (t === undefined || !equal(t.category, show.category) || t.amount !== 0n || t.nft?.capability !== 'none') refuse('no-ticket', 'input 1 is not a ticket of this show');
  const c = t.nft.commitment;
  if (c.length !== 24 || c[0] !== TAG_TICKET || !equal(c.slice(1, 4), coin.seat) || !equal(c.slice(4), coin.buyerPkh)) refuse('ticket-mismatch', 'input 1 is not the ticket of this seat');
  const holderPkh = p2pkhKeyHash(ticket.lockingBytecode);
  if (holderPkh === undefined || !equal(holderPkh, coin.buyerPkh)) refuse('ticket-moved', 'the ticket is not at its buyer\'s address');
  const [payout, keepsake] = transaction.outputs;
  if (payout.token !== undefined || !equal(payout.lockingBytecode, p2pkhLockingBytecode(show.organiserPkh))) refuse('wrong-payee', 'output 0 does not pay the organiser');
  if (payout.valueSatoshis < coin.value - show.minerFeeCap) refuse('short-payout', 'output 0 pays less than the coin less the network-fee cap');
  const k = keepsake.token;
  if (
    !equal(keepsake.lockingBytecode, p2pkhLockingBytecode(coin.buyerPkh)) ||
    k === undefined ||
    !equal(k.category, show.category) ||
    k.amount !== 0n ||
    k.nft?.capability !== 'none' ||
    !equal(k.nft.commitment, c)
  ) {
    refuse('no-keepsake', 'output 1 does not return the ticket to its holder');
  }
  if (keepsake.valueSatoshis > ticket.valueSatoshis) refuse('fat-keepsake', 'the keepsake takes more than the ticket held');
  return { seat: coin.seat, buyerPkh: coin.buyerPkh, payout: payout.valueSatoshis };
};

const VETTED = new WeakSet();

/**
 * Run the rule check (and the VM check when the runtime has one) and brand
 * the transaction as broadcastable.
 * `vmCheck({ kind, transaction, sourceOutputs, hex })` returns { ok, reason }.
 */
export const vet = ({ show, kind, transaction, sourceOutputs, tip, vmCheck }) => {
  checkEscrowSpend({ show, kind, transaction, sourceOutputs, tip });
  const { bytes, txid, size } = serialise(transaction);
  const hex = bytesToHex(bytes);
  let vm = 'not-available';
  if (typeof vmCheck === 'function') {
    const r = vmCheck({ kind, transaction, sourceOutputs, hex });
    if (r?.ok !== true) throw new WorkerError('vm-invalid', `the 2026 VM refuses this ${kind}: ${r?.reason ?? 'no reason given'}`, { status: 500 });
    vm = 'ok';
  }
  const vetted = Object.freeze({ kind, txid, hex, size, vm });
  VETTED.add(vetted);
  return vetted;
};

export const isVetted = (value) => value !== null && typeof value === 'object' && VETTED.has(value);
