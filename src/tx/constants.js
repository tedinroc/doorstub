// Shared constants for Doorstub transactions. See SPEC.md.

/** Satoshis carried by every token output (ticket, marker, box office, keepsake). */
export const TOKEN_OUTPUT_SATS = 1000n;

/** Dust threshold of a P2PKH output without tokens (BCHN: 3 x (34 + 148)). */
export const P2PKH_DUST_SATS = 546n;

/** Fees (hand-back, no-show) below this are waived by Escrow, since they would be dust. */
export const FEE_DUST_FLOOR_SATS = 546n;

/** Selene refuses inputs whose NFT commitment is longer than this. */
export const MAX_COMMITMENT_BYTES = 40;

export const TAG_TICKET = 0x54; // 'T'
export const TAG_MARKER = 0x45; // 'E'
export const SCOPE_CANCEL_SHOW = 0x43; // 'C'
export const SCOPE_REFUND_SEAT = 0x52; // 'R'

export const STATE_OPEN = 0x01;
export const STATE_CLOSED = 0x00;

/** BoxOffice.buy refuses transactions with more outputs than this. */
export const MAX_BUY_OUTPUTS = 6;

/** toPaddedBytes(sold, 2) fails at 32,768, so a shard can sell at most this many seats. */
export const MAX_SOLD_PER_SHARD = 32767;

/** Default fee rate in satoshis per byte (the relay minimum is 1 sat/byte). */
export const DEFAULT_FEE_RATE = 1n;

/** SIGHASH_ALL | SIGHASH_UTXOS | SIGHASH_FORKID. */
export const SIGHASH_ALL_UTXOS = 0x61;

/** A P2PKH unlock is at most push(73-byte ECDSA sig + type) + push(33-byte key) = 108 bytes. */
export const P2PKH_UNLOCK_MAX_BYTES = 108;

/** Final sequence number (no relative lock, locktime disabled unless another input enables it). */
export const SEQUENCE_FINAL = 0xffffffff;

/** Sequence number that enables nLockTime (needed for CLTV in Escrow.settle). */
export const SEQUENCE_LOCKTIME = 0xfffffffe;

/** nLockTime values below this are block heights. */
export const LOCKTIME_THRESHOLD = 500_000_000;

// ---------------------------------------------------------------- show policy
// The contracts take any parameters; validateShow (and so every builder and
// verifyGenesis) refuses a show outside these bounds. See SPEC.md section 6.

/** Highest minerFeeCap the app accepts, in sats. */
export const MAX_MINER_FEE_CAP = 2_000n;

/** minerFeeCap may also be at most this share of the price, in basis points (20%). */
export const MAX_MINER_FEE_CAP_BPS = 2_000n;

/**
 * Lowest minerFeeCap the app accepts: the largest single-coin Escrow
 * transaction (a check-in, measured in test/limits.test.js) at 1 sat/byte,
 * rounded up. Below it some paths could not pay their own miner fee, and
 * settle and refund cannot take a fee coin from anyone else.
 */
export const MIN_MINER_FEE_CAP = 1_200n;

/** Hand-back and no-show fees are at most this, in basis points (10%). */
export const MAX_POSTED_FEE_BPS = 1_000n;

/** Lowest price the app accepts: the smallest price whose 20% still fits MIN_MINER_FEE_CAP. */
export const MIN_PRICE = (MIN_MINER_FEE_CAP * 10_000n) / MAX_MINER_FEE_CAP_BPS;

// ---------------------------------------------------------------- relay limits

/** BCHN refuses to relay a transaction larger than this (bytes). */
export const MAX_STANDARD_TX_BYTES = 100_000;

/** A data output (OP_RETURN + pushes) may be at most this long; libauth counts length + 1 against 223. */
export const MAX_DATA_OUTPUT_BYTES = 222;

/** buildBuy takes at most this many funding coins (BoxOffice.buy loops over every input). */
export const MAX_BUY_FUNDING_COINS = 50;

/**
 * Most escrow coins in one settle or refund transaction. Size binds first: at
 * the largest show parameters, 100 coins are about 85,200 bytes (settle with a
 * no-show fee) and 88,500 bytes (refund), at about 36% of each input's
 * operation-cost budget (test/limits.test.js). The builders also refuse any
 * transaction over MAX_STANDARD_TX_BYTES.
 */
export const MAX_SETTLE_COINS = 100;
export const MAX_REFUND_COINS = 100;
