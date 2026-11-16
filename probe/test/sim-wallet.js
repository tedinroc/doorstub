// A simulated WizardConnect wallet for probe tests. Throwaway mnemonic, never
// funded, never broadcasts. It parses requests the way the protocol documents
// (hex transaction, relay-format source outputs), checks them the way Selene
// does (counts, outpoints, sequences and unlocking bytecode must match; with
// `strict40`, commitments over 40 bytes are refused), and signs only the
// inputs named in inputPaths, with SIGHASH_ALL | SIGHASH_UTXOS | FORKID unless
// a test asks for another sighash type.
//
// This signer is written independently of src/tx/sign.js on purpose, so the
// probe's checks are exercised against a second implementation.
import {
  binToHex,
  decodeTransaction,
  deriveHdPath,
  deriveHdPathRelative,
  deriveHdPrivateNodeFromBip39Mnemonic,
  deriveHdPublicNode,
  encodeDataPush,
  encodeHdPublicKey,
  encodeLockingBytecodeP2pkh,
  encodeTransaction,
  flattenBinArray,
  generateBip39Mnemonic,
  generateSigningSerializationBch,
  hash160,
  hash256,
  hexToBin,
  secp256k1,
  sha256,
  utf8ToBin,
} from '@bitauth/libauth';
import { toBigInt, toUint8Array } from '@wizardconnect/core';

const DEFAULT_SIGHASH = 0x61;
const CHILD = { receive: 0, change: 1, defi: 7 };

const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

const must = (value, what) => {
  if (typeof value === 'string') throw new Error(`${what}: ${value}`);
  return value;
};

/** Parse relay-format source outputs into libauth types. */
export const parseSourceOutputs = (relayOutputs) =>
  relayOutputs.map((so) => ({
    outpointTransactionHash: toUint8Array(so.outpointTransactionHash),
    outpointIndex: so.outpointIndex,
    unlockingBytecode: toUint8Array(so.unlockingBytecode),
    sequenceNumber: so.sequenceNumber,
    lockingBytecode: toUint8Array(so.lockingBytecode),
    valueSatoshis: toBigInt(so.valueSatoshis),
    ...(so.token && {
      token: {
        category: toUint8Array(so.token.category),
        amount: toBigInt(so.token.amount),
        ...(so.token.nft && {
          nft: { capability: so.token.nft.capability, commitment: toUint8Array(so.token.nft.commitment ?? '') },
        }),
      },
    }),
  }));

/**
 * @param {object} [options]
 * @param {string} [options.mnemonic] defaults to a fresh random one
 * @param {'schnorr'|'ecdsa'} [options.algorithm]
 * @param {boolean} [options.strict40] refuse commitments over 40 bytes, like Selene
 * @param {number} [options.sighash] sighash type byte (default 0x61; negative tests use others)
 * @param {(tx: object) => object} [options.tamper] change the signed transaction before returning it (negative tests)
 */
export const makeSimWallet = ({ mnemonic = generateBip39Mnemonic(), algorithm = 'schnorr', strict40 = true, sighash = DEFAULT_SIGHASH, tamper, name = 'Doorstub sim wallet' } = {}) => {
  const root = deriveHdPrivateNodeFromBip39Mnemonic(mnemonic);
  const account = must(deriveHdPath(root, "m/44'/145'/0'"), 'account');
  const chains = new Map(Object.entries(CHILD).map(([pathName, child]) => [child, must(deriveHdPathRelative(account, String(child)), pathName)]));
  const relaySeed = sha256.hash(utf8ToBin(`relay:${mnemonic}`));

  const privateKeyAt = (child, index) => must(deriveHdPathRelative(chains.get(child), String(index)), 'child').privateKey;
  const publicKeyAt = (child, index) => must(secp256k1.derivePublicKeyCompressed(privateKeyAt(child, index)), 'public key');

  const sign = (request) => {
    const wc = request.transaction;
    if (typeof wc.transaction !== 'string') throw new Error('sim wallet expects a hex transaction');
    const transaction = must(decodeTransaction(hexToBin(wc.transaction)), 'decode');
    const sourceOutputs = parseSourceOutputs(wc.sourceOutputs);
    if (transaction.inputs.length !== sourceOutputs.length) throw new Error('Transaction input and source output counts do not match');
    transaction.inputs.forEach((input, i) => {
      const so = sourceOutputs[i];
      const commitmentTooLong = strict40 && so.token?.nft !== undefined && so.token.nft.commitment.length > 40;
      if (
        !sameBytes(input.outpointTransactionHash, so.outpointTransactionHash) ||
        input.outpointIndex !== so.outpointIndex ||
        input.sequenceNumber !== so.sequenceNumber ||
        !sameBytes(input.unlockingBytecode, so.unlockingBytecode) ||
        commitmentTooLong
      ) {
        throw new Error(`Invalid signing source output at index ${i}`);
      }
    });
    const libauthSources = sourceOutputs.map(({ lockingBytecode, valueSatoshis, token }) => ({ lockingBytecode, valueSatoshis, ...(token && { token }) }));
    let signed = transaction;
    for (const [inputIndex, pathName, addressIndex] of request.inputPaths) {
      const child = CHILD[pathName];
      if (child === undefined) throw new Error(`unknown path ${pathName}`);
      const privateKey = privateKeyAt(child, addressIndex);
      const publicKey = must(secp256k1.derivePublicKeyCompressed(privateKey), 'public key');
      const coveredBytecode = encodeLockingBytecodeP2pkh(hash160(publicKey));
      if (!sameBytes(libauthSources[inputIndex].lockingBytecode, coveredBytecode)) {
        throw new Error(`input ${inputIndex} is not at ${pathName}/${addressIndex}`);
      }
      const digest = hash256(
        generateSigningSerializationBch(
          { inputIndex, sourceOutputs: libauthSources, transaction: signed },
          { coveredBytecode, signingSerializationType: Uint8Array.of(sighash) },
        ),
      );
      const raw = algorithm === 'ecdsa' ? secp256k1.signMessageHashDER(privateKey, digest) : secp256k1.signMessageHashSchnorr(privateKey, digest);
      const signature = Uint8Array.of(...must(raw, 'sign'), sighash);
      const unlockingBytecode = flattenBinArray([encodeDataPush(signature), encodeDataPush(publicKey)]);
      signed = { ...signed, inputs: signed.inputs.map((input, i) => (i === inputIndex ? { ...input, unlockingBytecode } : input)) };
    }
    if (tamper) signed = tamper(signed);
    return binToHex(encodeTransaction(signed));
  };

  const adapter = {
    walletName: name,
    walletIcon: '',
    getRelayPrivateKey: (uri) => sha256.hash(flattenBinArray([relaySeed, utf8ToBin(uri)])),
    getPublicKey: (path, index) => publicKeyAt(path, Number(index)),
    getXpub: (path) => encodeHdPublicKey({ network: 'mainnet', node: deriveHdPublicNode(chains.get(path)) }).hdPublicKey,
    signTransaction: async (request) => ({ signedTransaction: sign(request) }),
  };

  return {
    mnemonic,
    adapter,
    sign,
    publicKeyAt,
    pkhAt: (pathName, index) => hash160(publicKeyAt(CHILD[pathName], index)),
  };
};
