// Settle and refund transactions for the keeper and the refund signer, built
// without libauth. They mirror src/tx/builders.js buildSettle and buildRefund
// exactly: the Node tests (test/worker/assemble.test.js) pin them byte for
// byte against those builders over many random coin sets and run every
// result through the libauth 2026 VM.
//
// A coin is { txid (Uint8Array, display order), txidHex, vout, height,
// output: { lockingBytecode, valueSatoshis, token }, seat, seatHex, buyerPkh }.
import {
  DEFAULT_FEE_RATE,
  FEE_DUST_FLOOR_SATS,
  LOCKTIME_THRESHOLD,
  MAX_REFUND_COINS,
  MAX_SETTLE_COINS,
  MAX_STANDARD_TX_BYTES,
  SEQUENCE_FINAL,
  SEQUENCE_LOCKTIME,
  TAG_MARKER,
  TOKEN_OUTPUT_SATS,
} from '../../src/tx/constants.js';
import { bytesToHex, equal, hexToBytes, isHex, WorkerError } from './bytes.js';
import { SCOPE_BYTES } from './shows.js';
import { p2pkhLockingBytecode, refundUnlock, settleUnlock } from './script.js';
import { dustThreshold, encodeTransaction, serialise } from './tx.js';

const fail = (code, message) => {
  throw new WorkerError(code, message, { status: 500 });
};

/** Fee (sats) on a coin of `value` at `bps`, waived when under the dust floor. Mirrors Escrow and src/tx feeOnCoin. */
export const feeOnCoin = (value, bps) => {
  const fee = (BigInt(value) * BigInt(bps)) / 10000n;
  return fee < FEE_DUST_FLOOR_SATS ? 0n : fee;
};

const shareFee = (total, k) => {
  const base = total / BigInt(k);
  const extra = total % BigInt(k);
  return Array.from({ length: k }, (_, i) => base + (BigInt(i) < extra ? 1n : 0n));
};

/**
 * Read a marker (escrow) coin of a show out of a Fulcrum listunspent item.
 * Returns the coin, or { ignored: reason } for anything that is not a live
 * marker of this show's category with at least price + 1,000 sats (look-alike
 * tokens of other categories, plain coins: no Escrow path can spend those).
 */
export const coinFromElectrum = (show, item) => {
  const token = item?.token_data;
  if (token === undefined || token === null) return { ignored: 'no token' };
  if (typeof token.category !== 'string' || token.category.toLowerCase() !== show.categoryHex) return { ignored: 'another category' };
  if (token.nft?.capability !== 'none' || (token.amount !== undefined && String(token.amount) !== '0')) return { ignored: 'not an immutable NFT' };
  if (!isHex(token.nft.commitment, 24)) return { ignored: 'not a 24-byte commitment' };
  const commitment = hexToBytes(token.nft.commitment);
  if (commitment[0] !== TAG_MARKER) return { ignored: 'not a marker' };
  if (!Number.isSafeInteger(item.value) || !Number.isInteger(item.tx_pos) || !isHex(item.tx_hash, 32)) return { ignored: 'bad item' };
  const value = BigInt(item.value);
  if (value < show.price + TOKEN_OUTPUT_SATS) return { ignored: 'below price + 1,000 sats' };
  const seat = commitment.slice(1, 4);
  return {
    txid: hexToBytes(item.tx_hash),
    txidHex: item.tx_hash.toLowerCase(),
    vout: item.tx_pos,
    height: item.height,
    output: {
      lockingBytecode: show.escrow.lockingBytecode,
      valueSatoshis: value,
      token: { amount: 0n, category: show.category, nft: { capability: 'none', commitment } },
    },
    seat,
    seatHex: bytesToHex(seat),
    buyerPkh: commitment.slice(4, 24),
  };
};

const toInput = (coin, unlockingBytecode, sequenceNumber) => ({
  outpointTransactionHash: coin.txid,
  outpointIndex: coin.vout,
  sequenceNumber,
  unlockingBytecode,
});

const assertMinerFee = (share, show, what) => {
  if (share > show.minerFeeCap) fail('miner-fee-cap', `${what} needs ${share} sats of miner fee per coin but the show caps it at ${show.minerFeeCap}`);
};

const assertRelayable = (transaction, what) => {
  transaction.outputs.forEach((output, i) => {
    if (output.valueSatoshis < 0n) fail('negative-output', `${what}: output ${i} would be negative`);
    if (output.valueSatoshis < dustThreshold(output)) fail('dust-output', `${what}: output ${i} would be dust`);
  });
  const size = encodeTransaction(transaction).length;
  if (size > MAX_STANDARD_TX_BYTES) fail('tx-too-large', `${what}: ${size} bytes is over the standard limit`);
  return transaction;
};

const assertCoins = (show, coins, max, what) => {
  if (!Array.isArray(coins) || coins.length === 0) fail('no-coins', `${what} needs at least one escrow coin`);
  if (coins.length > max) fail('batch-too-large', `${what} takes at most ${max} coins per transaction`);
  for (const coin of coins) {
    if (!equal(coin.output.lockingBytecode, show.escrow.lockingBytecode)) fail('wrong-escrow', `${what}: a coin is not at this show's Escrow`);
  }
};

const result = (kind, transaction, sourceOutputs, fee, seats) => ({ kind, transaction, sourceOutputs, fee, seats, ...serialise(transaction) });

/**
 * Settle: inputs are escrow coins (coins owing a no-show fee first), outputs
 * refund each buyer, then each due fee. Same bytes as src/tx buildSettle.
 */
export const assembleSettle = ({ show, coins, locktime = show.startHeight + show.graceBlocks, feeRate = DEFAULT_FEE_RATE }) => {
  assertCoins(show, coins, MAX_SETTLE_COINS, 'settle');
  if (!Number.isInteger(locktime) || locktime < 0 || locktime >= LOCKTIME_THRESHOLD) fail('bad-locktime', 'locktime must be a block height');
  if (locktime < show.startHeight + show.graceBlocks) fail('too-early', 'settle opens at startHeight + graceBlocks');
  const ordered = coins
    .map((coin) => ({ coin, fee: feeOnCoin(coin.output.valueSatoshis, show.noShowFeeBps) }))
    .sort((a, b) => Number(b.fee > 0n) - Number(a.fee > 0n));
  const unlock = settleUnlock(show.escrow.redeemScript);
  const inputs = ordered.map(({ coin }) => toInput(coin, unlock, SEQUENCE_LOCKTIME));
  const payee = p2pkhLockingBytecode(show.organiserPkh);
  const refunds = ordered.map(({ coin }) => ({ lockingBytecode: p2pkhLockingBytecode(coin.buyerPkh), valueSatoshis: 0n }));
  const fees = ordered.filter((c) => c.fee > 0n).map((c) => ({ lockingBytecode: payee, valueSatoshis: c.fee }));
  const draft = { version: 2, inputs, outputs: [...refunds, ...fees], locktime };
  const shares = shareFee(BigInt(encodeTransaction(draft).length) * BigInt(feeRate), ordered.length);
  shares.forEach((share) => assertMinerFee(share, show, 'settle'));
  const outputs = [
    ...ordered.map(({ coin, fee }, i) => ({ ...refunds[i], valueSatoshis: coin.output.valueSatoshis - fee - shares[i] })),
    ...fees,
  ];
  const transaction = assertRelayable({ ...draft, outputs }, 'settle');
  return result(
    'settle',
    transaction,
    ordered.map(({ coin }) => coin.output),
    shares.reduce((a, b) => a + b, 0n),
    ordered.map(({ coin }) => coin.seat),
  );
};

/**
 * Refund under organiser notices: each coin uses the 'R' notice for its seat
 * if given, else the 'C' notice. Same bytes as src/tx buildRefund.
 * `notices`: [{ scope: 'C' | 'R', seat?: Uint8Array, signature: Uint8Array }].
 */
export const assembleRefund = ({ show, coins, notices, feeRate = DEFAULT_FEE_RATE }) => {
  assertCoins(show, coins, MAX_REFUND_COINS, 'refund');
  const covered = coins.map((coin, i) => {
    const notice =
      notices.find((n) => n.scope === 'R' && n.seat !== undefined && equal(n.seat, coin.seat)) ?? notices.find((n) => n.scope === 'C');
    if (notice === undefined) fail('no-notice', `no refund notice covers escrow coin ${i}`);
    return { coin, notice };
  });
  const inputs = covered.map(({ coin, notice }) =>
    toInput(coin, refundUnlock(show.escrow.redeemScript, notice.signature, SCOPE_BYTES[notice.scope]), SEQUENCE_FINAL),
  );
  const refunds = covered.map(({ coin }) => ({ lockingBytecode: p2pkhLockingBytecode(coin.buyerPkh), valueSatoshis: 0n }));
  const draft = { version: 2, inputs, outputs: refunds, locktime: 0 };
  const shares = shareFee(BigInt(encodeTransaction(draft).length) * BigInt(feeRate), covered.length);
  shares.forEach((share) => assertMinerFee(share, show, 'refund'));
  const transaction = assertRelayable(
    { ...draft, outputs: covered.map(({ coin }, i) => ({ ...refunds[i], valueSatoshis: coin.output.valueSatoshis - shares[i] })) },
    'refund',
  );
  return result(
    'refund',
    transaction,
    covered.map(({ coin }) => coin.output),
    shares.reduce((a, b) => a + b, 0n),
    covered.map(({ coin }) => coin.seat),
  );
};

/**
 * Split coins into batches of at most `max`, coins that owe a no-show fee
 * first (so each settle batch also has them first, as Escrow requires).
 */
export const batchCoins = (show, coins, max, { feeFirst = false } = {}) => {
  const ordered = feeFirst
    ? coins
        .map((coin) => ({ coin, owes: feeOnCoin(coin.output.valueSatoshis, show.noShowFeeBps) > 0n }))
        .sort((a, b) => Number(b.owes) - Number(a.owes))
        .map((c) => c.coin)
    : coins.slice();
  const batches = [];
  for (let i = 0; i < ordered.length; i += max) batches.push(ordered.slice(i, i + max));
  return batches;
};
