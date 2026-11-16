// Script pieces the worker needs: minimal pushes, VM numbers, P2PKH and
// P2SH32 locking bytecode, the Escrow and BoxOffice redeem scripts (from the
// compiled artifacts, exactly as src/tx/contracts.js builds them) and the
// Escrow unlocking bytecode for settle, refund and check-in.
//
// The redeem script is the constructor arguments pushed in reverse order,
// then the compiled bytecode (SPEC.md section 4). The worker recomputes it
// from the posted parameters and refuses a show whose shows.json `derived`
// fields differ, as every client must.
import { BoxOfficeArtifact, EscrowArtifact } from '../../src/tx/artifacts.js';
import { concat, equal, hexToBytes, reverse, uint32le, WorkerError } from './bytes.js';
import { hash256, scripthashOf } from './crypto.js';

const OP_0 = 0x00;
const OP_PUSHDATA1 = 0x4c;
const OP_PUSHDATA2 = 0x4d;
const OP_PUSHDATA4 = 0x4e;
const OP_1NEGATE = 0x4f;
const OP_1 = 0x51;
const OP_16 = 0x60;
const OP_DUP = 0x76;
const OP_EQUAL = 0x87;
const OP_EQUALVERIFY = 0x88;
const OP_HASH160 = 0xa9;
const OP_HASH256 = 0xaa;
const OP_CHECKSIG = 0xac;

/** Minimal VM number encoding (as libauth bigIntToVmNumber). */
export const vmNumber = (value) => {
  let n = BigInt(value);
  if (n === 0n) return new Uint8Array();
  const negative = n < 0n;
  if (negative) n = -n;
  const bytes = [];
  while (n > 0n) {
    bytes.push(Number(n & 0xffn));
    n >>= 8n;
  }
  if (bytes[bytes.length - 1] & 0x80) bytes.push(negative ? 0x80 : 0x00);
  else if (negative) bytes[bytes.length - 1] |= 0x80;
  return Uint8Array.from(bytes);
};

/** Minimal push of `data` (as libauth encodeDataPush). */
export const pushData = (data) => {
  const length = data.length;
  if (length === 0) return Uint8Array.of(OP_0);
  if (length === 1 && data[0] >= 1 && data[0] <= 16) return Uint8Array.of(data[0] + 0x50);
  if (length === 1 && data[0] === 0x81) return Uint8Array.of(OP_1NEGATE);
  if (length <= 75) return concat([Uint8Array.of(length), data]);
  if (length <= 0xff) return concat([Uint8Array.of(OP_PUSHDATA1, length), data]);
  if (length <= 0xffff) return concat([Uint8Array.of(OP_PUSHDATA2, length & 0xff, length >> 8), data]);
  return concat([Uint8Array.of(OP_PUSHDATA4), uint32le(length), data]);
};

const pushAll = (items) => concat(items.map(pushData));

/**
 * Read a push-only script into its pushed values (OP_N as its number's
 * bytes). Returns undefined for anything that is not push-only.
 */
export const readPushes = (script) => {
  const out = [];
  let i = 0;
  while (i < script.length) {
    const op = script[i];
    i += 1;
    let length;
    if (op === OP_0) {
      out.push(new Uint8Array());
      continue;
    }
    if (op >= 1 && op <= 75) length = op;
    else if (op === OP_PUSHDATA1) {
      if (i + 1 > script.length) return undefined;
      length = script[i];
      i += 1;
    } else if (op === OP_PUSHDATA2) {
      if (i + 2 > script.length) return undefined;
      length = script[i] | (script[i + 1] << 8);
      i += 2;
    } else if (op === OP_PUSHDATA4) {
      if (i + 4 > script.length) return undefined;
      length = script[i] + (script[i + 1] << 8) + (script[i + 2] << 16) + script[i + 3] * 0x1000000;
      i += 4;
    } else if (op === OP_1NEGATE) {
      out.push(Uint8Array.of(0x81));
      continue;
    } else if (op >= OP_1 && op <= OP_16) {
      out.push(Uint8Array.of(op - 0x50));
      continue;
    } else return undefined;
    if (i + length > script.length) return undefined;
    out.push(script.slice(i, i + length));
    i += length;
  }
  return out;
};

/** A small non-negative VM number (at most 4 bytes, minimally encoded), or undefined. */
export const readSmallNumber = (bytes) => {
  if (bytes === undefined || bytes.length > 4) return undefined;
  if (bytes.length === 0) return 0;
  if (bytes[bytes.length - 1] & 0x80) return undefined;
  if (!equal(vmNumber(toNumber(bytes)), bytes)) return undefined;
  return toNumber(bytes);
};

const toNumber = (bytes) => {
  let n = 0;
  for (let i = bytes.length - 1; i >= 0; i -= 1) n = n * 256 + bytes[i];
  return n;
};

export const p2pkhLockingBytecode = (pkh) => {
  if (!(pkh instanceof Uint8Array) || pkh.length !== 20) throw new WorkerError('bad-pkh', 'a key hash is 20 bytes');
  return concat([Uint8Array.of(OP_DUP, OP_HASH160, 20), pkh, Uint8Array.of(OP_EQUALVERIFY, OP_CHECKSIG)]);
};

/** The 20-byte key hash of a P2PKH locking bytecode, or undefined. */
export const p2pkhKeyHash = (lockingBytecode) =>
  lockingBytecode.length === 25 &&
  lockingBytecode[0] === OP_DUP &&
  lockingBytecode[1] === OP_HASH160 &&
  lockingBytecode[2] === 20 &&
  lockingBytecode[23] === OP_EQUALVERIFY &&
  lockingBytecode[24] === OP_CHECKSIG
    ? lockingBytecode.slice(3, 23)
    : undefined;

export const p2sh32LockingBytecode = (redeemScript) => concat([Uint8Array.of(OP_HASH256, 32), hash256(redeemScript), Uint8Array.of(OP_EQUAL)]);

const encodeArgument = (value, type) => (type === 'int' ? vmNumber(value) : value);

const contractFrom = (artifact, args) => {
  const encoded = args.map((value, i) => encodeArgument(value, artifact.constructorInputs[i].type));
  const redeemScript = concat([pushAll([...encoded].reverse()), hexToBytes(artifact.bytecodeHex)]);
  const lockingBytecode = p2sh32LockingBytecode(redeemScript);
  return { redeemScript, lockingBytecode, scripthash: scripthashOf(lockingBytecode) };
};

/** Escrow of a show (show fields as Uint8Array / numbers, category in display order). */
export const escrowScripts = (show) =>
  contractFrom(EscrowArtifact, [
    reverse(show.category),
    show.organiserPkh,
    show.organiserDataPk,
    show.startHeight,
    show.graceBlocks,
    show.handBackFeeBps,
    show.noShowFeeBps,
    show.minerFeeCap,
  ]);

/** BoxOffice of a show (needs the Escrow locking bytecode). */
export const boxOfficeScripts = (show, escrowLockingBytecode) =>
  contractFrom(BoxOfficeArtifact, [reverse(show.category), show.price, show.organiserPk, escrowLockingBytecode]);

const escrowSelector = (name) => {
  const index = EscrowArtifact.abi.findIndex((f) => f.name === name);
  if (index === -1) throw new WorkerError('bad-function', `Escrow has no function ${name}`, { status: 500 });
  return index;
};

export const ESCROW_SELECTORS = Object.freeze({
  handBack: escrowSelector('handBack'),
  checkIn: escrowSelector('checkIn'),
  settle: escrowSelector('settle'),
  refund: escrowSelector('refund'),
});

/** Unlocking bytecode of Escrow.settle(). */
export const settleUnlock = (redeemScript) => pushAll([vmNumber(ESCROW_SELECTORS.settle), redeemScript]);

/** Unlocking bytecode of Escrow.refund(sig, scope): pushes scope, sig, selector, redeem script. */
export const refundUnlock = (redeemScript, signature, scopeByte) =>
  pushAll([Uint8Array.of(scopeByte), signature, vmNumber(ESCROW_SELECTORS.refund), redeemScript]);

/** Unlocking bytecode of Escrow.checkIn(ticketInputIndex). */
export const checkInUnlock = (redeemScript, ticketInputIndex) =>
  pushAll([vmNumber(ticketInputIndex), vmNumber(ESCROW_SELECTORS.checkIn), redeemScript]);
