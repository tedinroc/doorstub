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
