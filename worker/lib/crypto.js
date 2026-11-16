// Hashes and data signatures for the worker, on @noble/hashes and @noble/curves.
//
// Refund notices are data signatures checked by OP_CHECKDATASIG over
// sha256(message). The worker SIGNS with ECDSA (DER, low S): @noble/curves
// implements it exactly as the VM checks it, with RFC 6979 deterministic
// nonces, so the same notice always gets the same signature (idempotent).
// The worker only VERIFIES BCH Schnorr (the 64-byte signatures the studio
// makes with libauth, for example a 'C' notice in shows.json). BCH Schnorr is
// not BIP-340: the challenge hashes the 33-byte compressed key and R must have
// a square y (Jacobi symbol 1), so it is written out below from the 2019 spec
// and pinned against libauth in test/worker/crypto.test.js.
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2';
import { bytesToHex, concat, reverse, WorkerError } from './bytes.js';

export const sha256 = (bytes) => nobleSha256(bytes);
export const hash256 = (bytes) => nobleSha256(nobleSha256(bytes));

/** Transaction id (display order hex) of encoded transaction bytes. */
export const txidOf = (bytes) => bytesToHex(reverse(hash256(bytes)));

/** Electrum script hash: sha256 of the locking bytecode, byte-reversed, hex. */
export const scripthashOf = (lockingBytecode) => bytesToHex(reverse(sha256(lockingBytecode)));

const { n: N, p: P } = secp256k1.CURVE;
const Point = secp256k1.ProjectivePoint;

// Build the base-point table once when the module loads (about 12 ms), so it
// counts toward a Worker's startup instead of the first request's CPU time.
secp256k1.utils.precompute(8);

const toBigInt = (bytes) => {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
};

const mod = (a, m) => {
  const r = a % m;
  return r >= 0n ? r : r + m;
};

const powMod = (base, exponent, modulus) => {
  let result = 1n;
  let b = mod(base, modulus);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
};

/** 33-byte compressed public key of a 32-byte private key. */
export const publicKeyOf = (privateKey) => secp256k1.getPublicKey(privateKey, true);

/** Is this a valid secp256k1 private key (32 bytes, 1..n-1)? */
export const isPrivateKey = (privateKey) => {
  if (!(privateKey instanceof Uint8Array) || privateKey.length !== 32) return false;
  const d = toBigInt(privateKey);
  return d > 0n && d < N;
};

/** Lengths src/tx accepts for a DER data signature (encodeArgument 'datasig'). */
export const DER_LENGTHS = Object.freeze([70, 71, 72]);

/**
 * ECDSA data signature over sha256(message): DER, low S, as OP_CHECKDATASIG
 * and src/tx verifyRefundNotice accept it. Deterministic (RFC 6979). A DER
 * signature is 70 or 71 bytes, rarely shorter; a short one is re-made with a
 * counter as extra entropy (still deterministic) so its length is one that
 * src/tx's argument encoder takes.
 */
export const signDataEcdsa = (privateKey, message) => {
  if (!isPrivateKey(privateKey)) throw new WorkerError('bad-key', 'the data key is not a valid private key', { status: 500 });
  const digest = sha256(message);
  for (let counter = 0; counter < 256; counter += 1) {
    const extraEntropy = counter === 0 ? undefined : Uint8Array.of(...new Uint8Array(31), counter);
    const signature = secp256k1.sign(digest, privateKey, { lowS: true, ...(extraEntropy !== undefined && { extraEntropy }) });
    const der = signature.toDERRawBytes();
    if (DER_LENGTHS.includes(der.length)) return der;
  }
  throw new WorkerError('sign-failed', 'could not make a data signature of a usable length', { status: 500 });
};

/** Verify a DER ECDSA data signature (low S only) over sha256(message). */
export const verifyDataEcdsa = (signature, publicKey, message) => {
  try {
    const sig = secp256k1.Signature.fromDER(signature);
    if (sig.hasHighS()) return false;
    // Re-encoding must give the same bytes: strict DER, as the VM requires.
    if (bytesToHex(sig.toDERRawBytes()) !== bytesToHex(signature)) return false;
    return secp256k1.verify(sig, sha256(message), publicKey, { lowS: true });
  } catch {
    return false;
  }
};

/** BCH Schnorr verification (2019 spec) of a 64-byte signature over a 32-byte hash. */
export const verifySchnorrBch = (signature, publicKey, messageHash) => {
  try {
    if (!(signature instanceof Uint8Array) || signature.length !== 64 || messageHash.length !== 32) return false;
    const r = toBigInt(signature.slice(0, 32));
    const s = toBigInt(signature.slice(32, 64));
    if (r >= P || s >= N) return false;
    const pub = Point.fromHex(publicKey);
    const compressed = pub.toRawBytes(true);
    const e = mod(toBigInt(sha256(concat([signature.slice(0, 32), compressed, messageHash]))), N);
    const sG = s === 0n ? Point.ZERO : Point.BASE.multiply(s);
    const eP = e === 0n ? Point.ZERO : pub.multiplyUnsafe(e);
    const R = sG.subtract(eP);
    if (R.equals(Point.ZERO)) return false;
    const { x, y } = R.toAffine();
    if (powMod(y, (P - 1n) / 2n, P) !== 1n) return false;
    return x === r;
  } catch {
    return false;
  }
};

/** Verify a data signature as OP_CHECKDATASIG does: 64 bytes is Schnorr, anything else DER ECDSA. */
export const verifyDataSignature = (signature, publicKey, message) =>
  signature.length === 64 ? verifySchnorrBch(signature, publicKey, sha256(message)) : verifyDataEcdsa(signature, publicKey, message);
