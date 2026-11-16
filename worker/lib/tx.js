// BCH transaction encoding and decoding with CashTokens, for the worker.
//
// Shapes follow libauth so the Node tests can compare byte for byte:
//   transaction: { version, inputs, outputs, locktime }
//   input:  { outpointTransactionHash (32 bytes, display order), outpointIndex, sequenceNumber, unlockingBytecode }
//   output: { lockingBytecode, valueSatoshis (bigint), token?: { category (display order), amount (bigint),
//             nft?: { capability: 'none'|'mutable'|'minting', commitment } } }
// On the wire the outpoint hash and the token category are byte-reversed
// (CashTokens token prefix: 0xef | category | bitfield | [commitment] | [amount]).
import { compactSize, concat, reader, reverse, uint32le, uint64le, WorkerError } from './bytes.js';
import { txidOf } from './crypto.js';

const PREFIX_TOKEN = 0xef;
const HAS_AMOUNT = 0x10;
const HAS_NFT = 0x20;
const HAS_COMMITMENT_LENGTH = 0x40;
const RESERVED_BIT = 0x80;
const CAPABILITIES = ['none', 'mutable', 'minting'];
const MAX_TOKEN_AMOUNT = 9223372036854775807n;
/** The 2026 rules allow commitments up to 128 bytes (Doorstub's are at most 40). */
const MAX_COMMITMENT_LENGTH = 128;

const bad = (message) => new WorkerError('bad-transaction', message);

export const encodeTokenPrefix = (token) => {
  if (token === undefined || (token.nft === undefined && token.amount < 1n)) return new Uint8Array();
  const capability = token.nft === undefined ? 0 : CAPABILITIES.indexOf(token.nft.capability);
  if (capability === -1) throw bad(`unknown NFT capability ${token.nft.capability}`);
  const hasCommitment = token.nft !== undefined && token.nft.commitment.length > 0;
  const bitfield = (token.nft === undefined ? 0 : HAS_NFT) | (hasCommitment ? HAS_COMMITMENT_LENGTH : 0) | (token.amount > 0n ? HAS_AMOUNT : 0) | capability;
  return concat([
    Uint8Array.of(PREFIX_TOKEN),
    reverse(token.category),
    Uint8Array.of(bitfield),
    ...(hasCommitment ? [compactSize(token.nft.commitment.length), token.nft.commitment] : []),
    ...(token.amount > 0n ? [compactSize(token.amount)] : []),
  ]);
};

export const encodeOutput = (output) => {
  const script = concat([encodeTokenPrefix(output.token), output.lockingBytecode]);
  return concat([uint64le(output.valueSatoshis), compactSize(script.length), script]);
};

const encodeInput = (input) =>
  concat([
    reverse(input.outpointTransactionHash),
    uint32le(input.outpointIndex),
    compactSize(input.unlockingBytecode.length),
    input.unlockingBytecode,
    uint32le(input.sequenceNumber),
  ]);

export const encodeTransaction = (tx) =>
  concat([
    uint32le(tx.version),
    compactSize(tx.inputs.length),
    ...tx.inputs.map(encodeInput),
    compactSize(tx.outputs.length),
    ...tx.outputs.map(encodeOutput),
    uint32le(tx.locktime),
  ]);

/** Split a locking-bytecode field into { token, lockingBytecode } (CHIP-2022-02-CashTokens). */
export const decodeTokenPrefix = (field) => {
  if (field.length === 0 || field[0] !== PREFIX_TOKEN) return { lockingBytecode: field };
  const r = reader(field);
  r.u8();
  const category = reverse(r.bytes(32));
  const bitfield = r.u8();
  if (bitfield & RESERVED_BIT) throw bad('token prefix uses the reserved bit');
  const capabilityIndex = bitfield & 0x0f;
  const hasNft = (bitfield & HAS_NFT) !== 0;
  const hasCommitment = (bitfield & HAS_COMMITMENT_LENGTH) !== 0;
  const hasAmount = (bitfield & HAS_AMOUNT) !== 0;
  if (capabilityIndex > 2) throw bad('token prefix has an unknown capability');
  if (!hasNft && (capabilityIndex !== 0 || hasCommitment)) throw bad('token prefix has NFT fields without an NFT');
  if (!hasNft && !hasAmount) throw bad('token prefix carries neither an NFT nor an amount');
  let commitment = new Uint8Array();
  if (hasCommitment) {
    const length = r.compactNumber(MAX_COMMITMENT_LENGTH);
    if (length === 0) throw bad('token prefix has an empty commitment with its length bit set');
    commitment = r.bytes(length);
  }
  let amount = 0n;
  if (hasAmount) {
    amount = r.compact();
    if (amount < 1n || amount > MAX_TOKEN_AMOUNT) throw bad('token amount is out of range');
  }
  const token = { amount, category };
  if (hasNft) token.nft = { capability: CAPABILITIES[capabilityIndex], commitment };
  return { token, lockingBytecode: field.slice(r.offset) };
};

/** Decode transaction bytes. Throws WorkerError('bad-transaction') on anything malformed or with trailing bytes. */
export const decodeTransaction = (bytes) => {
  try {
    const r = reader(bytes);
    const version = r.u32();
    const inputCount = r.compactNumber(100_000);
    const inputs = [];
    for (let i = 0; i < inputCount; i += 1) {
      const outpointTransactionHash = reverse(r.bytes(32));
      const outpointIndex = r.u32();
      const unlockingBytecode = r.bytes(r.compactNumber(100_000));
      const sequenceNumber = r.u32();
      inputs.push({ outpointTransactionHash, outpointIndex, sequenceNumber, unlockingBytecode });
    }
    const outputCount = r.compactNumber(100_000);
    const outputs = [];
    for (let i = 0; i < outputCount; i += 1) {
      const valueSatoshis = r.u64();
      const { token, lockingBytecode } = decodeTokenPrefix(r.bytes(r.compactNumber(100_000)));
      outputs.push(token === undefined ? { lockingBytecode, valueSatoshis } : { lockingBytecode, valueSatoshis, token });
    }
    const locktime = r.u32();
    if (!r.done) throw bad('trailing bytes after the transaction');
    return { version, inputs, outputs, locktime };
  } catch (e) {
    if (e instanceof WorkerError && e.code === 'bad-transaction') throw e;
    throw bad(`transaction does not decode: ${e.message}`);
  }
};

/** Bytes, id (display hex) and size of a transaction. */
export const serialise = (tx) => {
  const bytes = encodeTransaction(tx);
  return { bytes, txid: txidOf(bytes), size: bytes.length };
};

const DUST_P2PKH_INPUT_LENGTH = 148n;

/** Dust threshold of an output at 1,000 sats/kB (as BCHN and libauth getDustThreshold). OP_RETURN outputs: 0. */
export const dustThreshold = (output) => {
  if (output.lockingBytecode[0] === 0x6a) return 0n;
  const length = BigInt(encodeOutput(output).length) + DUST_P2PKH_INPUT_LENGTH;
  const fee = (length * 1000n) / 1000n;
  return 3n * (fee === 0n ? 1n : fee);
};
