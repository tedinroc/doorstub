// Pure transaction builders for every Doorstub path. See SPEC.md section 5.
//
// A UTXO is { txid, vout, output }: txid is 32 bytes in display order (as
// explorers show it), vout the output index, output a libauth Output.
//
// Every builder returns { kind, transaction, sourceOutputs, walletInputIndexes, ... }.
// Contract inputs carry their final unlocking bytecode. Inputs listed in
// walletInputIndexes are plain P2PKH coins left with empty unlocking bytecode
// for the owner's wallet to sign. No builder signs anything with a wallet key;
// closeSales asks a caller-supplied callback for the organiser's signature.
import {
  encodeTransaction,
  generateSigningSerializationBch,
  getDustThreshold,
  hash256,
  isArbitraryDataOutput,
  secp256k1,
  sha256,
} from '@bitauth/libauth';
import {
  DEFAULT_FEE_RATE,
  FEE_DUST_FLOOR_SATS,
  LOCKTIME_THRESHOLD,
  MAX_BUY_FUNDING_COINS,
  MAX_BUY_OUTPUTS,
  MAX_DATA_OUTPUT_BYTES,
  MAX_REFUND_COINS,
  MAX_SETTLE_COINS,
  MAX_SOLD_PER_SHARD,
  MAX_STANDARD_TX_BYTES,
  P2PKH_UNLOCK_MAX_BYTES,
  SEQUENCE_FINAL,
  SEQUENCE_LOCKTIME,
  SIGHASH_ALL_UTXOS,
  TOKEN_OUTPUT_SATS,
} from './constants.js';
import {
  DoorstubError,
  assertBytes,
  decodeBoxOfficeCommitment,
  decodeTaggedCommitment,
  encodeBoxOfficeCommitment,
  encodeMarkerCommitment,
  encodeRefundNoticeMessage,
  encodeSeat,
  encodeTicketCommitment,
  p2pkhLockingBytecode,
  sameBytes,
  scopeByte,
} from './encoding.js';
import { showContracts, validateShow } from './contracts.js';

const fail = (code, message) => {
  throw new DoorstubError(code, message);
};

const toInput = (utxo, unlockingBytecode = new Uint8Array(), sequenceNumber = SEQUENCE_FINAL) => {
  assertBytes(utxo.txid, 32, 'utxo.txid');
  if (!Number.isInteger(utxo.vout) || utxo.vout < 0) fail('bad-utxo', 'utxo.vout must be a non-negative integer');
  return {
    outpointTransactionHash: utxo.txid,
    outpointIndex: utxo.vout,
    sequenceNumber,
    unlockingBytecode,
  };
};

const sum = (values) => values.reduce((a, b) => a + b, 0n);

/** Byte length of the transaction once the listed inputs carry unlocking bytecode of the given lengths. */
export const estimateSize = (transaction, placeholderLengths = new Map()) =>
  encodeTransaction({
    ...transaction,
    inputs: transaction.inputs.map((input, i) =>
      placeholderLengths.has(i) ? { ...input, unlockingBytecode: new Uint8Array(placeholderLengths.get(i)) } : input,
    ),
  }).length;

const feeFor = (transaction, placeholders, feeRate) => BigInt(estimateSize(transaction, placeholders)) * BigInt(feeRate);

/**
 * Append a change output when it is worth having; otherwise leave the
 * remainder to the miner. Throws 'insufficient-funds' when inputs cannot pay.
 */
const withChange = ({ transaction, totalIn, changeLockingBytecode, placeholders, feeRate }) => {
  const fixedOut = sum(transaction.outputs.map((o) => o.valueSatoshis));
  if (changeLockingBytecode !== undefined) {
    const change = { lockingBytecode: changeLockingBytecode, valueSatoshis: 0n };
    const withChangeTx = { ...transaction, outputs: [...transaction.outputs, change] };
    const fee = feeFor(withChangeTx, placeholders, feeRate);
    const changeValue = totalIn - fixedOut - fee;
    if (changeValue >= getDustThreshold(change)) {
      const outputs = [...transaction.outputs, { ...change, valueSatoshis: changeValue }];
      return { transaction: { ...transaction, outputs }, fee, change: changeValue };
    }
  }
  const fee = feeFor(transaction, placeholders, feeRate);
  if (totalIn - fixedOut - fee < 0n) {
    fail('insufficient-funds', `inputs are short by ${fixedOut + fee - totalIn} sats`);
  }
  return { transaction, fee: totalIn - fixedOut, change: 0n };
};

const assertShowToken = (utxo, show, capability, name) => {
  const token = utxo.output.token;
  if (token === undefined || !sameBytes(token.category, show.category)) fail('wrong-category', `${name} is not of this show's category`);
  if (token.nft === undefined || token.nft.capability !== capability) {
    fail('wrong-capability', `${name} must be a ${capability} NFT`);
  }
  return token;
};

const assertPlainCoin = (utxo, name) => {
  if (utxo.output.token !== undefined) fail('token-funding', `${name} carries tokens; use a plain BCH coin`);
};

const p2pkhPlaceholders = (indexes) => new Map(indexes.map((i) => [i, P2PKH_UNLOCK_MAX_BYTES]));

/**
 * Refuse a transaction the network would not relay: every output must be at
 * least its dust threshold (0 for an OP_RETURN data output) and never
 * negative, and the transaction (with wallet inputs at their largest signed
 * size) must fit the 100,000-byte standard limit.
 */
const assertRelayable = (transaction, placeholders, what) => {
  transaction.outputs.forEach((output, i) => {
    if (output.valueSatoshis < 0n) fail('negative-output', `${what}: output ${i} would be ${output.valueSatoshis} sats`);
    const dust = getDustThreshold(output);
    if (output.valueSatoshis < dust) {
      fail('dust-output', `${what}: output ${i} would be ${output.valueSatoshis} sats, below its dust threshold of ${dust}`);
    }
  });
  const size = estimateSize(transaction, placeholders);
  if (size > MAX_STANDARD_TX_BYTES) fail('tx-too-large', `${what}: ${size} bytes is over the ${MAX_STANDARD_TX_BYTES}-byte standard limit`);
  return transaction;
};

/** Fee (sats) on a coin of `value` at `bps`, waived (0) when it would be dust. Mirrors Escrow. */
export const feeOnCoin = (value, bps) => {
  const fee = (BigInt(value) * BigInt(bps)) / 10000n;
  return fee < FEE_DUST_FLOOR_SATS ? 0n : fee;
};

/**
 * Genesis (offline): mint the show's token category and its BoxOffice shards.
 * Returns an UNSIGNED template; the organiser's wallet signs and broadcasts it.
 * The first funding coin must be output 0 of its transaction (CashTokens rule):
 * its txid becomes the category.
 *
 * `identityLockingBytecode` (optional) puts a plain 1,000-sat output to the
 * organiser at index 0, before the shards. BCMR wallets follow output 0 from
 * the category's parent transaction to find the token's metadata, and read it
 * from the transaction whose output 0 is still unspent (the authhead). Without
 * this output, output 0 is shard 0, which every buy on that shard spends, so
 * the metadata would move with each sale and any buyer could publish their own.
 * `shardVouts` in the result lists where the shards are.
 */
export const buildGenesis = ({
  show: showWithoutCategory,
  shards,
  fundingUtxos,
  changeLockingBytecode,
  dataOutput,
  identityLockingBytecode,
  feeRate = DEFAULT_FEE_RATE,
}) => {
  if (!Array.isArray(fundingUtxos) || fundingUtxos.length === 0) fail('no-funding', 'genesis needs a funding coin');
  if (fundingUtxos[0].vout !== 0) fail('genesis-vout', 'the first genesis input must spend output 0 of its transaction');
  if (!Number.isInteger(shards) || shards < 1 || shards > 256) fail('bad-shards', 'shards must be 1-256');
  fundingUtxos.forEach((utxo, i) => assertPlainCoin(utxo, `funding coin ${i}`));
  const show = validateShow({ ...showWithoutCategory, category: fundingUtxos[0].txid.slice() });
  const contracts = showContracts(show);

  const outputs = [];
  if (identityLockingBytecode !== undefined) {
    assertBytes(identityLockingBytecode, undefined, 'identityLockingBytecode');
    outputs.push({ lockingBytecode: identityLockingBytecode, valueSatoshis: TOKEN_OUTPUT_SATS });
  }
  const firstShardVout = outputs.length;
  for (let shard = 0; shard < shards; shard += 1) {
    outputs.push({
      lockingBytecode: contracts.boxOffice.lockingBytecode,
      valueSatoshis: TOKEN_OUTPUT_SATS,
      token: {
        amount: 0n,
        category: show.category,
        nft: { capability: 'minting', commitment: encodeBoxOfficeCommitment({ open: true, shard, sold: 0 }) },
      },
    });
  }
  if (dataOutput !== undefined) {
    assertBytes(dataOutput, undefined, 'dataOutput');
    if (!isArbitraryDataOutput(dataOutput) || dataOutput.length > MAX_DATA_OUTPUT_BYTES) {
      fail('bad-data-output', `dataOutput must be OP_RETURN followed only by pushes, at most ${MAX_DATA_OUTPUT_BYTES} bytes`);
    }
    outputs.push({ lockingBytecode: dataOutput, valueSatoshis: 0n });
  }

  const inputs = fundingUtxos.map((utxo) => toInput(utxo));
  const walletInputIndexes = inputs.map((_, i) => i);
  const built = withChange({
    transaction: { version: 2, inputs, outputs, locktime: 0 },
    totalIn: sum(fundingUtxos.map((u) => u.output.valueSatoshis)),
    changeLockingBytecode,
    placeholders: p2pkhPlaceholders(walletInputIndexes),
    feeRate,
  });
  return {
    kind: 'genesis',
    show,
    contracts,
    transaction: assertRelayable(built.transaction, p2pkhPlaceholders(walletInputIndexes), 'genesis'),
    sourceOutputs: fundingUtxos.map((u) => u.output),
    walletInputIndexes,
    fee: built.fee,
    change: built.change,
    shardVouts: Array.from({ length: shards }, (_, i) => firstShardVout + i),
  };
};

/**
 * Check an organiser refund notice ({ scope: 'C' } or { scope: 'R', seat },
 * with `signature`) against the show's data key, as Escrow.refund would.
 */
export const verifyRefundNotice = ({ show, notice }) => {
  const message = encodeRefundNoticeMessage({ scope: notice.scope, category: show.category, seat: notice.seat });
  const signature = notice.signature;
  if (!(signature instanceof Uint8Array)) return false;
  const digest = sha256.hash(message);
  return signature.length === 64
    ? secp256k1.verifySignatureSchnorr(signature, show.organiserDataPk, digest)
    : secp256k1.verifySignatureDERLowS(signature, show.organiserDataPk, digest);
};

/**
 * Buy one seat. Input 0 is the BoxOffice shard (no signature); inputs 1+ are
 * the buyer's plain coins (the wallet signs them, at most
 * MAX_BUY_FUNDING_COINS). Outputs: shard, ticket, escrow coin, then change if
 * worth having.
 *
 * BCH cannot end sales on chain (a locktime is only a lower bound), so the
 * builder does: `currentHeight` (the chain tip) is required, and the builder
 * refuses at or after startHeight, or once any valid 'C' notice in `notices`
 * cancelled the show. A buy after either would only lose the buyer money.
 */
export const buildBuy = ({
  show,
  boxOfficeUtxo,
  fundingUtxos,
  buyerPkh,
  currentHeight,
  notices = [],
  changeLockingBytecode = p2pkhLockingBytecode(buyerPkh),
  feeRate = DEFAULT_FEE_RATE,
  contracts = showContracts(show),
}) => {
  validateShow(show);
  assertBytes(buyerPkh, 20, 'buyerPkh');
  if (!Number.isInteger(currentHeight) || currentHeight < 0) fail('no-height', 'buildBuy needs the current block height (currentHeight)');
  if (BigInt(currentHeight) >= BigInt(show.startHeight)) {
    fail('sales-ended', `the show starts at block ${show.startHeight}; sales end there (BCH cannot enforce this on chain, so the app does)`);
  }
  for (const notice of notices) {
    if (notice?.scope !== 'C') continue;
    if (!verifyRefundNotice({ show, notice })) fail('bad-notice', 'a cancel notice was given but its signature does not verify');
    fail('sales-cancelled', 'the organiser cancelled this show; buying now would only be refunded');
  }
  const { boxOffice, escrow } = contracts;
  if (!sameBytes(boxOfficeUtxo.output.lockingBytecode, boxOffice.lockingBytecode)) {
    fail('wrong-box-office', 'coin is not at this show\'s BoxOffice');
  }
  const token = assertShowToken(boxOfficeUtxo, show, 'minting', 'BoxOffice coin');
  const state = decodeBoxOfficeCommitment(token.nft.commitment);
  if (!state.open) fail('sales-closed', 'sales are closed on this shard');
  if (state.sold >= MAX_SOLD_PER_SHARD) fail('shard-full', 'this shard has sold its last seat');
  if (!Array.isArray(fundingUtxos) || fundingUtxos.length === 0) fail('no-funding', 'buy needs at least one coin');
  if (fundingUtxos.length > MAX_BUY_FUNDING_COINS) {
    fail('too-many-inputs', `buy takes at most ${MAX_BUY_FUNDING_COINS} funding coins (BoxOffice loops over every input)`);
  }
  fundingUtxos.forEach((utxo, i) => assertPlainCoin(utxo, `funding coin ${i}`));

  const sold = state.sold + 1;
  const seat = encodeSeat({ shard: state.shard, sold });
  const ticketCommitment = encodeTicketCommitment(seat, buyerPkh);
  const markerCommitment = encodeMarkerCommitment(seat, buyerPkh);
  const outputs = [
    {
      lockingBytecode: boxOffice.lockingBytecode,
      valueSatoshis: boxOfficeUtxo.output.valueSatoshis,
      token: {
        amount: 0n,
        category: show.category,
        nft: { capability: 'minting', commitment: encodeBoxOfficeCommitment({ open: true, shard: state.shard, sold }) },
      },
    },
    {
      lockingBytecode: p2pkhLockingBytecode(buyerPkh),
      valueSatoshis: TOKEN_OUTPUT_SATS,
      token: { amount: 0n, category: show.category, nft: { capability: 'none', commitment: ticketCommitment } },
    },
    {
      lockingBytecode: escrow.lockingBytecode,
      valueSatoshis: BigInt(show.price) + TOKEN_OUTPUT_SATS,
      token: { amount: 0n, category: show.category, nft: { capability: 'none', commitment: markerCommitment } },
    },
  ];
  const inputs = [
    toInput(boxOfficeUtxo, boxOffice.unlock('buy', [buyerPkh])),
    ...fundingUtxos.map((utxo) => toInput(utxo)),
  ];
  const walletInputIndexes = fundingUtxos.map((_, i) => i + 1);
  const built = withChange({
    transaction: { version: 2, inputs, outputs, locktime: 0 },
    // The shard's own value is passed straight through to output 0.
    totalIn: sum(fundingUtxos.map((u) => u.output.valueSatoshis)) + boxOfficeUtxo.output.valueSatoshis,
    changeLockingBytecode,
    placeholders: p2pkhPlaceholders(walletInputIndexes),
    feeRate,
  });
  if (built.transaction.outputs.length > MAX_BUY_OUTPUTS) fail('too-many-outputs', 'buy allows at most 6 outputs');
  return {
    kind: 'buy',
    transaction: assertRelayable(built.transaction, p2pkhPlaceholders(walletInputIndexes), 'buy'),
    sourceOutputs: [boxOfficeUtxo.output, ...fundingUtxos.map((u) => u.output)],
    walletInputIndexes,
    fee: built.fee,
    change: built.change,
    seat,
    ticketCommitment,
    markerCommitment,
  };
};

/** Signing digest for one input: hash256 of the BCH signing serialization. */
export const signingDigest = ({ transaction, sourceOutputs, inputIndex, coveredBytecode, sighashType = SIGHASH_ALL_UTXOS }) =>
  hash256(
    generateSigningSerializationBch(
      { inputIndex, sourceOutputs, transaction },
      { coveredBytecode, signingSerializationType: Uint8Array.of(sighashType) },
    ),
  );

/**
 * Close sales on one or more shards (organiser only). Shards are inputs
 * 0..k-1 and come back closed at outputs 0..k-1; the organiser's plain coins
 * pay the fee. `signShard({ digest, inputIndex })` must return the organiser's
 * signature (with its sighash type byte, SIGHASH_ALL_UTXOS) over `digest`.
 */
export const buildCloseSales = ({
  show,
  shardUtxos,
  fundingUtxos,
  changeLockingBytecode,
  signShard,
  feeRate = DEFAULT_FEE_RATE,
  contracts = showContracts(show),
}) => {
  const { boxOffice } = contracts;
  if (!Array.isArray(shardUtxos) || shardUtxos.length === 0) fail('no-shards', 'closeSales needs at least one shard');
  if (typeof signShard !== 'function') fail('no-signer', 'closeSales needs the organiser signer callback');
  fundingUtxos.forEach((utxo, i) => assertPlainCoin(utxo, `funding coin ${i}`));
  const outputs = shardUtxos.map((utxo, i) => {
    if (!sameBytes(utxo.output.lockingBytecode, boxOffice.lockingBytecode)) fail('wrong-box-office', `shard ${i} is not at this BoxOffice`);
    const token = assertShowToken(utxo, show, 'minting', `shard ${i}`);
    const state = decodeBoxOfficeCommitment(token.nft.commitment);
    return {
      lockingBytecode: boxOffice.lockingBytecode,
      valueSatoshis: utxo.output.valueSatoshis,
      token: {
        amount: 0n,
        category: show.category,
        nft: { capability: 'minting', commitment: encodeBoxOfficeCommitment({ ...state, open: false }) },
      },
    };
  });
  const k = shardUtxos.length;
  const inputs = [...shardUtxos.map((utxo) => toInput(utxo)), ...fundingUtxos.map((utxo) => toInput(utxo))];
  const walletInputIndexes = fundingUtxos.map((_, i) => i + k);
  const placeholders = p2pkhPlaceholders(walletInputIndexes);
  const sigPlaceholderLength = boxOffice.unlock('closeSales', [new Uint8Array(73)]).length;
  for (let i = 0; i < k; i += 1) placeholders.set(i, sigPlaceholderLength);
  const built = withChange({
    transaction: { version: 2, inputs, outputs, locktime: 0 },
    totalIn: sum([...shardUtxos, ...fundingUtxos].map((u) => u.output.valueSatoshis)),
    changeLockingBytecode,
    placeholders,
    feeRate,
  });
  const sourceOutputs = [...shardUtxos, ...fundingUtxos].map((u) => u.output);
  const unsigned = built.transaction;
  const signedInputs = unsigned.inputs.map((input, inputIndex) => {
    if (inputIndex >= k) return input;
    const digest = signingDigest({ transaction: unsigned, sourceOutputs, inputIndex, coveredBytecode: boxOffice.redeemScript });
    const signature = signShard({ digest, inputIndex });
    return { ...input, unlockingBytecode: boxOffice.unlock('closeSales', [signature]) };
  });
  return {
    kind: 'closeSales',
    transaction: assertRelayable({ ...unsigned, inputs: signedInputs }, p2pkhPlaceholders(walletInputIndexes), 'closeSales'),
    sourceOutputs,
    walletInputIndexes,
    fee: built.fee,
    change: built.change,
  };
};

/** Parse an escrow coin and check it belongs to this show's Escrow. */
const readEscrowCoin = (utxo, show, escrow, name = 'escrow coin') => {
  if (!sameBytes(utxo.output.lockingBytecode, escrow.lockingBytecode)) fail('wrong-escrow', `${name} is not at this show's Escrow`);
  const token = assertShowToken(utxo, show, 'none', name);
  const marker = decodeTaggedCommitment(token.nft.commitment);
  if (marker.kind !== 'marker') fail('not-a-marker', `${name} does not carry an escrow marker`);
  return { ...marker, value: utxo.output.valueSatoshis };
};

/** Check that a ticket coin matches a marker and sits at the buyer's own address. */
const readTicketCoin = (utxo, show, marker) => {
  const token = assertShowToken(utxo, show, 'none', 'ticket');
  const ticket = decodeTaggedCommitment(token.nft.commitment);
  if (ticket.kind !== 'ticket') fail('not-a-ticket', 'coin does not carry a ticket');
  if (!sameBytes(ticket.seat, marker.seat) || !sameBytes(ticket.buyerPkh, marker.buyerPkh)) {
    fail('ticket-mismatch', 'ticket does not match this escrow coin');
  }
  if (!sameBytes(utxo.output.lockingBytecode, p2pkhLockingBytecode(marker.buyerPkh))) {
    fail('ticket-moved', 'ticket is no longer at the buyer\'s address; only settle or refund can release this coin');
  }
  return { ...ticket, value: utxo.output.valueSatoshis };
};

/** `taken` is what the coin loses beyond its posted fee; Escrow caps it at minerFeeCap. */
const assertMinerFee = (taken, cap, what) => {
  if (taken > cap) fail('miner-fee-cap', `${what} needs ${taken} sats of miner fee but the show caps it at ${cap}`);
};

/**
 * Hand a ticket back (holder's wallet signs the ticket input, index 1).
 * Input 0: escrow coin. Outputs: 0 refund to the buyer; if a hand-back fee is
 * due, 1 returns the ticket's sats to the buyer and 2 pays the fee.
 */
export const buildHandBack = ({ show, escrowUtxo, ticketUtxo, feeRate = DEFAULT_FEE_RATE, contracts = showContracts(show) }) => {
  const { escrow } = contracts;
  const marker = readEscrowCoin(escrowUtxo, show, escrow);
  const ticket = readTicketCoin(ticketUtxo, show, marker);
  const buyerLock = p2pkhLockingBytecode(marker.buyerPkh);
  const cap = BigInt(show.minerFeeCap);
  const fee = feeOnCoin(marker.value, show.handBackFeeBps);
  const inputs = [toInput(escrowUtxo, escrow.unlock('handBack', [1n])), toInput(ticketUtxo)];
  const placeholders = p2pkhPlaceholders([1]);
  const draftOutputs =
    fee === 0n
      ? [{ lockingBytecode: buyerLock, valueSatoshis: 0n }]
      : [
          { lockingBytecode: buyerLock, valueSatoshis: 0n },
          { lockingBytecode: buyerLock, valueSatoshis: ticket.value },
          { lockingBytecode: p2pkhLockingBytecode(show.organiserPkh), valueSatoshis: fee },
        ];
  const draft = { version: 2, inputs, outputs: draftOutputs, locktime: 0 };
  const minerFee = feeFor(draft, placeholders, feeRate);
  const outputs = draftOutputs.slice();
  if (fee === 0n) {
    outputs[0] = { lockingBytecode: buyerLock, valueSatoshis: marker.value + ticket.value - minerFee };
    assertMinerFee(minerFee - ticket.value, cap, 'hand-back');
  } else {
    outputs[0] = { lockingBytecode: buyerLock, valueSatoshis: marker.value - fee - minerFee };
    assertMinerFee(minerFee, cap, 'hand-back');
  }
  return {
    kind: 'handBack',
    transaction: assertRelayable({ ...draft, outputs }, placeholders, 'hand-back'),
    sourceOutputs: [escrowUtxo.output, ticketUtxo.output],
    walletInputIndexes: [1],
    fee: minerFee,
    handBackFee: fee,
    seat: marker.seat,
  };
};

/**
 * Check in (holder's wallet signs the ticket input, index 1). Input 0: escrow
 * coin. Outputs: 0 pays the organiser; 1 returns the ticket to the holder as a
 * keepsake stub (same commitment, its own 1,000 sats, no escrow money).
 */
export const buildCheckIn = ({ show, escrowUtxo, ticketUtxo, feeRate = DEFAULT_FEE_RATE, contracts = showContracts(show) }) => {
  const { escrow } = contracts;
  const marker = readEscrowCoin(escrowUtxo, show, escrow);
  const ticket = readTicketCoin(ticketUtxo, show, marker);
  const inputs = [toInput(escrowUtxo, escrow.unlock('checkIn', [1n])), toInput(ticketUtxo)];
  const keepsake = {
    lockingBytecode: p2pkhLockingBytecode(marker.buyerPkh),
    valueSatoshis: ticket.value,
    token: ticketUtxo.output.token,
  };
  const payee = p2pkhLockingBytecode(show.organiserPkh);
  const draft = { version: 2, inputs, outputs: [{ lockingBytecode: payee, valueSatoshis: 0n }, keepsake], locktime: 0 };
  const minerFee = feeFor(draft, p2pkhPlaceholders([1]), feeRate);
  assertMinerFee(minerFee, BigInt(show.minerFeeCap), 'check-in');
  return {
    kind: 'checkIn',
    transaction: assertRelayable(
      { ...draft, outputs: [{ lockingBytecode: payee, valueSatoshis: marker.value - minerFee }, keepsake] },
      p2pkhPlaceholders([1]),
      'check-in',
    ),
    sourceOutputs: [escrowUtxo.output, ticketUtxo.output],
    walletInputIndexes: [1],
    fee: minerFee,
    seat: marker.seat,
  };
};

/** Split a miner fee across k coins: the first coins pay the rounding remainder. */
const shareFee = (total, k) => {
  const base = total / BigInt(k);
  const extra = total % BigInt(k);
  return Array.from({ length: k }, (_, i) => base + (BigInt(i) < extra ? 1n : 0n));
};

/**
 * Settle unused tickets after startHeight + graceBlocks (anyone may push).
 * Inputs 0..k-1: escrow coins (coins owing a no-show fee first). Outputs
 * 0..k-1: refunds to each buyer; k+i: the no-show fee of coin i, if any.
 * `locktime` defaults to startHeight + graceBlocks and must not exceed the
 * current height when broadcast.
 */
export const buildSettle = ({
  show,
  escrowUtxos,
  locktime = Number(BigInt(show.startHeight) + BigInt(show.graceBlocks)),
  feeRate = DEFAULT_FEE_RATE,
  contracts = showContracts(show),
}) => {
  const { escrow } = contracts;
  if (!Array.isArray(escrowUtxos) || escrowUtxos.length === 0) fail('no-coins', 'settle needs at least one escrow coin');
  if (escrowUtxos.length > MAX_SETTLE_COINS) {
    fail('batch-too-large', `settle takes at most ${MAX_SETTLE_COINS} coins per transaction; send several`);
  }
  if (!Number.isInteger(locktime) || locktime < 0 || locktime >= LOCKTIME_THRESHOLD) fail('bad-locktime', 'locktime must be a block height');
  if (BigInt(locktime) < BigInt(show.startHeight) + BigInt(show.graceBlocks)) {
    fail('too-early', 'settle opens at startHeight + graceBlocks');
  }
  const coins = escrowUtxos
    .map((utxo, i) => ({ utxo, marker: readEscrowCoin(utxo, show, escrow, `escrow coin ${i}`) }))
    .map((coin) => ({ ...coin, fee: feeOnCoin(coin.marker.value, show.noShowFeeBps) }))
    // Coins that owe a fee go first, so their fee outputs (at k+i) are contiguous.
    .sort((a, b) => Number(b.fee > 0n) - Number(a.fee > 0n));
  const k = coins.length;
  const inputs = coins.map((coin) => toInput(coin.utxo, escrow.unlock('settle'), SEQUENCE_LOCKTIME));
  const payee = p2pkhLockingBytecode(show.organiserPkh);
  const refundOutputs = coins.map((coin) => ({ lockingBytecode: p2pkhLockingBytecode(coin.marker.buyerPkh), valueSatoshis: 0n }));
  const feeOutputs = coins.filter((coin) => coin.fee > 0n).map((coin) => ({ lockingBytecode: payee, valueSatoshis: coin.fee }));
  const draft = { version: 2, inputs, outputs: [...refundOutputs, ...feeOutputs], locktime };
  const shares = shareFee(feeFor(draft, new Map(), feeRate), k);
  const cap = BigInt(show.minerFeeCap);
  shares.forEach((share) => assertMinerFee(share, cap, 'settle'));
  const outputs = [
    ...coins.map((coin, i) => ({ ...refundOutputs[i], valueSatoshis: coin.marker.value - coin.fee - shares[i] })),
    ...feeOutputs,
  ];
  return {
    kind: 'settle',
    transaction: assertRelayable({ ...draft, outputs }, new Map(), 'settle'),
    sourceOutputs: coins.map((coin) => coin.utxo.output),
    walletInputIndexes: [],
    fee: sum(shares),
    seats: coins.map((coin) => coin.marker.seat),
  };
};

/**
 * Refund escrow coins under an organiser notice (anyone may push).
 * `notices` is a list of { scope: 'C' } or { scope: 'R', seat } with a
 * `signature` (64-byte Schnorr data signature). A 'C' notice covers every
 * coin; an 'R' notice covers the coin with that seat. Inputs 0..k-1: coins;
 * outputs 0..k-1: refunds to each buyer.
 */
export const buildRefund = ({ show, escrowUtxos, notices, feeRate = DEFAULT_FEE_RATE, contracts = showContracts(show) }) => {
  const { escrow } = contracts;
  if (!Array.isArray(escrowUtxos) || escrowUtxos.length === 0) fail('no-coins', 'refund needs at least one escrow coin');
  if (escrowUtxos.length > MAX_REFUND_COINS) {
    fail('batch-too-large', `refund takes at most ${MAX_REFUND_COINS} coins per transaction; send several`);
  }
  const coins = escrowUtxos.map((utxo, i) => {
    const marker = readEscrowCoin(utxo, show, escrow, `escrow coin ${i}`);
    const notice =
      notices.find((n) => n.scope === 'R' && n.seat !== undefined && sameBytes(n.seat, marker.seat)) ??
      notices.find((n) => n.scope === 'C');
    if (notice === undefined) fail('no-notice', `no refund notice covers escrow coin ${i}`);
    return { utxo, marker, notice };
  });
  const k = coins.length;
  const inputs = coins.map((coin) =>
    toInput(coin.utxo, escrow.unlock('refund', [coin.notice.signature, scopeByte(coin.notice.scope)])),
  );
  const draftOutputs = coins.map((coin) => ({ lockingBytecode: p2pkhLockingBytecode(coin.marker.buyerPkh), valueSatoshis: 0n }));
  const draft = { version: 2, inputs, outputs: draftOutputs, locktime: 0 };
  const shares = shareFee(feeFor(draft, new Map(), feeRate), k);
  shares.forEach((share) => assertMinerFee(share, BigInt(show.minerFeeCap), 'refund'));
  return {
    kind: 'refund',
    transaction: assertRelayable(
      { ...draft, outputs: coins.map((coin, i) => ({ ...draftOutputs[i], valueSatoshis: coin.marker.value - shares[i] })) },
      new Map(),
      'refund',
    ),
    sourceOutputs: coins.map((coin) => coin.utxo.output),
    walletInputIndexes: [],
    fee: sum(shares),
    seats: coins.map((coin) => coin.marker.seat),
  };
};
