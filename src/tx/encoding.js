// Byte layouts for Doorstub tokens and small helpers. See SPEC.md section 2.
import { encodeLockingBytecodeP2pkh, flattenBinArray, binToHex, utf8ToBin } from '@bitauth/libauth';
import {
  MAX_COMMITMENT_BYTES,
  MAX_SOLD_PER_SHARD,
  SCOPE_CANCEL_SHOW,
  SCOPE_REFUND_SEAT,
  STATE_CLOSED,
  STATE_OPEN,
  TAG_MARKER,
  TAG_TICKET,
} from './constants.js';

export class DoorstubError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DoorstubError';
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new DoorstubError(code, message);
};

export const assertBytes = (value, length, name) => {
  if (!(value instanceof Uint8Array)) fail('bad-type', `${name} must be a Uint8Array`);
  if (length !== undefined && value.length !== length) {
    fail('bad-length', `${name} must be ${length} bytes, got ${value.length}`);
  }
  return value;
};

/** Throw if a commitment is longer than Selene accepts (40 bytes). */
export const assertCommitmentSize = (commitment) => {
  if (commitment.length > MAX_COMMITMENT_BYTES) {
    fail('commitment-too-long', `NFT commitment is ${commitment.length} bytes; the limit is ${MAX_COMMITMENT_BYTES}`);
  }
  return commitment;
};

const uint16le = (n) => Uint8Array.of(n & 0xff, (n >> 8) & 0xff);
const readUint16le = (bytes, offset) => bytes[offset] | (bytes[offset + 1] << 8);

const assertShard = (shard) => {
  if (!Number.isInteger(shard) || shard < 0 || shard > 255) fail('bad-shard', `shard must be 0-255, got ${shard}`);
};

const assertSold = (sold) => {
  if (!Number.isInteger(sold) || sold < 0 || sold > MAX_SOLD_PER_SHARD) {
    fail('bad-sold', `sold must be 0-${MAX_SOLD_PER_SHARD}, got ${sold}`);
  }
};

/** BoxOffice minting NFT commitment, 4 bytes: state | shard | sold (2 bytes LE). */
export const encodeBoxOfficeCommitment = ({ open, shard, sold }) => {
  assertShard(shard);
  assertSold(sold);
  return Uint8Array.of(open ? STATE_OPEN : STATE_CLOSED, shard, ...uint16le(sold));
};

export const decodeBoxOfficeCommitment = (commitment) => {
  if (!(commitment instanceof Uint8Array) || commitment.length !== 4) {
    fail('bad-box-office', 'BoxOffice commitment must be 4 bytes');
  }
  const state = commitment[0];
  if (state !== STATE_OPEN && state !== STATE_CLOSED) fail('bad-box-office', `unknown BoxOffice state ${state}`);
  return { open: state === STATE_OPEN, shard: commitment[1], sold: readUint16le(commitment, 2) };
};

/** Seat id, 3 bytes: shard | sold (2 bytes LE), where sold counts this sale (first seat = 1). */
export const encodeSeat = ({ shard, sold }) => {
  assertShard(shard);
  assertSold(sold);
  return Uint8Array.of(shard, ...uint16le(sold));
};

export const decodeSeat = (seat) => {
  assertBytes(seat, 3, 'seat');
  return { shard: seat[0], sold: readUint16le(seat, 1) };
};

/** Human label for a seat, e.g. "A-0007" for shard 0, sold 7. */
export const seatLabel = (seat) => {
  const { shard, sold } = decodeSeat(seat);
  const prefix = shard < 26 ? String.fromCharCode(65 + shard) : `S${shard}`;
  return `${prefix}-${String(sold).padStart(4, '0')}`;
};

const tagged = (tag, seat, buyerPkh) => {
  assertBytes(seat, 3, 'seat');
  assertBytes(buyerPkh, 20, 'buyerPkh');
  return assertCommitmentSize(flattenBinArray([Uint8Array.of(tag), seat, buyerPkh]));
};

/** Ticket NFT commitment, 24 bytes: 'T' | seat | buyerPkh. */
export const encodeTicketCommitment = (seat, buyerPkh) => tagged(TAG_TICKET, seat, buyerPkh);

/** Escrow marker NFT commitment, 24 bytes: 'E' | seat | buyerPkh. */
export const encodeMarkerCommitment = (seat, buyerPkh) => tagged(TAG_MARKER, seat, buyerPkh);

/** Decode a ticket or marker commitment. Returns { kind: 'ticket'|'marker', seat, buyerPkh }. */
export const decodeTaggedCommitment = (commitment) => {
  if (!(commitment instanceof Uint8Array) || commitment.length !== 24) {
    fail('bad-commitment', 'ticket and marker commitments are 24 bytes');
  }
  const tag = commitment[0];
  if (tag !== TAG_TICKET && tag !== TAG_MARKER) fail('bad-commitment', `unknown commitment tag ${tag}`);
  return {
    kind: tag === TAG_TICKET ? 'ticket' : 'marker',
    seat: commitment.slice(1, 4),
    buyerPkh: commitment.slice(4, 24),
  };
};

/**
 * libauth keeps token categories (and txids) in display order; the VM's
 * OP_UTXOTOKENCATEGORY pushes the reverse (wire order). Escrow's `category`
 * constructor argument and the refund notice messages use the wire order.
 */
export const categoryToVmOrder = (categoryDisplay) => assertBytes(categoryDisplay, 32, 'category').slice().reverse();

export const p2pkhLockingBytecode = (pkh) => encodeLockingBytecodeP2pkh(assertBytes(pkh, 20, 'pkh'));

/** Message the organiser data-signs to refund the whole show ('C') or one seat ('R'). */
export const encodeRefundNoticeMessage = ({ scope, category, seat }) => {
  const categoryVm = categoryToVmOrder(category);
  if (scope === 'C') return flattenBinArray([Uint8Array.of(SCOPE_CANCEL_SHOW), categoryVm]);
  if (scope === 'R') {
    assertBytes(seat, 3, 'seat');
    return flattenBinArray([Uint8Array.of(SCOPE_REFUND_SEAT), categoryVm, seat]);
  }
  return fail('bad-scope', `refund scope must be 'C' or 'R', got ${scope}`);
};

export const scopeByte = (scope) => {
  if (scope === 'C') return Uint8Array.of(SCOPE_CANCEL_SHOW);
  if (scope === 'R') return Uint8Array.of(SCOPE_REFUND_SEAT);
  return fail('bad-scope', `refund scope must be 'C' or 'R', got ${scope}`);
};

export const sameBytes = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);

export const hex = binToHex;
export const text = utf8ToBin;
