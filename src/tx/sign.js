// Signing helpers for TEST keys and organiser tooling. Builders never call
// these; tests use them with freshly generated, never-funded keys.
import { encodeDataPush, flattenBinArray, hash160, secp256k1, sha256 } from '@bitauth/libauth';
import { SIGHASH_ALL_UTXOS } from './constants.js';
import { DoorstubError, p2pkhLockingBytecode } from './encoding.js';
import { signingDigest } from './builders.js';

const ok = (result, what) => {
  if (typeof result === 'string') throw new DoorstubError('sign-failed', `${what}: ${result}`);
  return result;
};

export const publicKeyOf = (privateKey) => ok(secp256k1.derivePublicKeyCompressed(privateKey), 'derive public key');

export const pkhOf = (privateKey) => hash160(publicKeyOf(privateKey));

/** Schnorr transaction signature over `digest`, with the sighash type byte appended. */
export const signDigest = (privateKey, digest, sighashType = SIGHASH_ALL_UTXOS) =>
  Uint8Array.of(...ok(secp256k1.signMessageHashSchnorr(privateKey, digest), 'sign'), sighashType);

/** Return a copy of `transaction` with P2PKH input `inputIndex` signed by `privateKey`. */
export const signP2pkhInput = ({ transaction, sourceOutputs, inputIndex, privateKey, sighashType = SIGHASH_ALL_UTXOS }) => {
  const publicKey = publicKeyOf(privateKey);
  const coveredBytecode = p2pkhLockingBytecode(hash160(publicKey));
  const digest = signingDigest({ transaction, sourceOutputs, inputIndex, coveredBytecode, sighashType });
  const signature = signDigest(privateKey, digest, sighashType);
  const unlockingBytecode = flattenBinArray([encodeDataPush(signature), encodeDataPush(publicKey)]);
  return {
    ...transaction,
    inputs: transaction.inputs.map((input, i) => (i === inputIndex ? { ...input, unlockingBytecode } : input)),
  };
};

/** Sign every listed P2PKH input with the same key. */
export const signP2pkhInputs = ({ transaction, sourceOutputs, inputIndexes, privateKey }) =>
  inputIndexes.reduce(
    (tx, inputIndex) => signP2pkhInput({ transaction: tx, sourceOutputs, inputIndex, privateKey }),
    transaction,
  );

/** 64-byte Schnorr data signature, as OP_CHECKDATASIG verifies it (over sha256(message)). */
export const signDataMessage = (privateKey, message) =>
  ok(secp256k1.signMessageHashSchnorr(privateKey, sha256.hash(message)), 'data sign');
