// Addresses, locking bytecode and Electrum script hashes.
//
// Doorstub talks to Fulcrum with the `blockchain.scripthash.*` methods, so
// nothing depends on how a server parses cashaddr; addresses are only for
// people (and for wallets that show them).
import {
  binToHex,
  cashAddressToLockingBytecode,
  encodeLockingBytecodeP2pkh,
  hash160,
  lockingBytecodeToCashAddress,
  sha256,
} from '@bitauth/libauth';

/** cashaddr prefix per network. The simnet mirrors mainnet, so it uses the same prefix. */
export const ADDRESS_PREFIX = Object.freeze({ mainnet: 'bitcoincash', simnet: 'bitcoincash' });

export class AddressError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AddressError';
    this.code = 'bad-address';
  }
}

const prefixOf = (network = 'mainnet') => {
  const prefix = ADDRESS_PREFIX[network];
  if (prefix === undefined) throw new AddressError(`unknown network ${network}`);
  return prefix;
};

/** Electrum script hash: sha256 of the locking bytecode, byte-reversed, as hex. */
export const scripthashOf = (lockingBytecode) => {
  if (!(lockingBytecode instanceof Uint8Array)) throw new AddressError('locking bytecode must be a Uint8Array');
  return binToHex(sha256.hash(lockingBytecode).slice().reverse());
};

/**
 * cashaddr for a locking bytecode. `tokenSupport: true` gives the token-aware
 * form (`z...` for P2PKH, `r...` for P2SH32) that wallets need to receive
 * CashTokens; `false` gives the plain form (`q...`, `p...`).
 */
export const cashAddressOf = (lockingBytecode, { network = 'mainnet', tokenSupport = true } = {}) => {
  const result = lockingBytecodeToCashAddress({ bytecode: lockingBytecode, prefix: prefixOf(network), tokenSupport });
  if (typeof result === 'string') throw new AddressError(result);
  return result.address;
};

/**
 * Decode any cashaddr (with or without prefix, token-aware or plain).
 * Returns { lockingBytecode, tokenSupport, prefix }.
 */
export const decodeCashAddress = (address, { network = 'mainnet' } = {}) => {
  if (typeof address !== 'string' || address.length === 0) throw new AddressError('address must be a non-empty string');
  const expected = prefixOf(network);
  const full = address.includes(':') ? address : `${expected}:${address}`;
  const [prefix] = full.toLowerCase().split(':');
  if (prefix !== expected) throw new AddressError(`address is for ${prefix}, not ${network}`);
  const result = cashAddressToLockingBytecode(full);
  if (typeof result === 'string') throw new AddressError(result);
  return { lockingBytecode: result.bytecode, tokenSupport: result.tokenSupport === true, prefix };
};

/** Both address forms, the locking bytecode and the script hash of a P2PKH payee. */
export const p2pkhAddresses = (pkh, { network = 'mainnet' } = {}) => {
  if (!(pkh instanceof Uint8Array) || pkh.length !== 20) throw new AddressError('pkh must be 20 bytes');
  const lockingBytecode = encodeLockingBytecodeP2pkh(pkh);
  return {
    pkh,
    lockingBytecode,
    address: cashAddressOf(lockingBytecode, { network, tokenSupport: false }),
    tokenAddress: cashAddressOf(lockingBytecode, { network, tokenSupport: true }),
    scripthash: scripthashOf(lockingBytecode),
  };
};

/** Same, from a 33-byte compressed public key. */
export const addressesOfPublicKey = (publicKey, options) => ({ publicKey, ...p2pkhAddresses(hash160(publicKey), options) });

/** Short form for the UI: "bitcoincash:zq00x...4g6" -> "zq00x...s4g6". */
export const shortAddress = (address, keep = 5) => {
  const body = address.includes(':') ? address.split(':')[1] : address;
  return body.length <= keep * 2 + 3 ? body : `${body.slice(0, keep)}...${body.slice(-keep)}`;
};
