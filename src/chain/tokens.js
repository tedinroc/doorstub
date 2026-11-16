// Fulcrum JSON <-> libauth types.
//
// Shapes pinned against live mainnet Fulcrum 2.1.x on 11/16 (test/fixtures/fulcrum-mainnet.json):
//   listunspent item: { height, tx_hash, tx_pos, value, token_data? }
//     height 0 (or -1) = unconfirmed; value is a JSON number of sats.
//   token_data: { category: <64 hex, display order>, amount: "<decimal string>",
//                 nft?: { capability: "none" | "mutable" | "minting", commitment: "<hex, may be empty>" } }
//   Token coins in listunspent: with protocol 1.5 negotiated (server.version, as
//   openElectrum does) they are included by default; on a session that never
//   sent server.version (protocol 1.4) they are left out unless the second
//   param is "include_tokens". We always pass "include_tokens".
// libauth keeps categories and txids in display order too, so no byte reversal happens here.
import { binToHex, hexToBin } from '@bitauth/libauth';

export class ShapeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ShapeError';
    this.code = 'bad-server-shape';
  }
}

const fail = (message) => {
  throw new ShapeError(message);
};

const HEX = /^(?:[0-9a-f]{2})*$/i;
const CAPABILITIES = new Set(['none', 'mutable', 'minting']);

/** 64 hex characters -> 32 bytes. */
export const hexToHash = (hex, what = 'hash') => {
  if (typeof hex !== 'string' || hex.length !== 64 || !HEX.test(hex)) fail(`${what} must be 64 hex characters`);
  return hexToBin(hex);
};

const hexToBytes = (hex, what) => {
  if (typeof hex !== 'string' || !HEX.test(hex)) fail(`${what} must be hex`);
  return hexToBin(hex);
};

const toSats = (value, what) => {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) fail(`${what} must be a non-negative integer`);
    return BigInt(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'bigint' && value >= 0n) return value;
  return fail(`${what} must be a non-negative integer`);
};

/** Fulcrum `token_data` -> libauth `Output['token']`. */
export const tokenFromElectrum = (tokenData) => {
  if (tokenData === undefined || tokenData === null) return undefined;
  if (typeof tokenData !== 'object') fail('token_data must be an object');
  const token = {
    amount: toSats(tokenData.amount ?? '0', 'token_data.amount'),
    category: hexToHash(tokenData.category, 'token_data.category'),
  };
  if (tokenData.nft !== undefined && tokenData.nft !== null) {
    const { capability, commitment = '' } = tokenData.nft;
    if (!CAPABILITIES.has(capability)) fail(`unknown NFT capability ${capability}`);
    token.nft = { capability, commitment: hexToBytes(commitment, 'token_data.nft.commitment') };
  }
  return token;
};

/** libauth `Output['token']` -> Fulcrum `token_data` (what a server would send). */
export const tokenToElectrum = (token) => {
  if (token === undefined) return undefined;
  const out = { amount: token.amount.toString(), category: binToHex(token.category) };
  if (token.nft !== undefined) out.nft = { capability: token.nft.capability, commitment: binToHex(token.nft.commitment) };
  return out;
};

/**
 * One listunspent item at `lockingBytecode` -> a builder UTXO
 * `{ txid, vout, output }` (txid in display order, as src/tx expects),
 * plus `txidHex`, `height` and `confirmed`.
 */
export const utxoFromElectrum = (item, lockingBytecode) => {
  if (item === null || typeof item !== 'object') fail('listunspent item must be an object');
  if (!Number.isInteger(item.tx_pos) || item.tx_pos < 0) fail('tx_pos must be a non-negative integer');
  if (!Number.isInteger(item.height)) fail('height must be an integer');
  const token = tokenFromElectrum(item.token_data);
  const output = { lockingBytecode, valueSatoshis: toSats(item.value, 'value') };
  if (token !== undefined) output.token = token;
  return {
    txid: hexToHash(item.tx_hash, 'tx_hash'),
    txidHex: item.tx_hash.toLowerCase(),
    vout: item.tx_pos,
    height: item.height,
    confirmed: item.height > 0,
    output,
  };
};

/** A builder UTXO (with optional height) -> a listunspent item. */
export const utxoToElectrum = ({ txid, vout, output, height = 0 }) => {
  const item = { height, tx_hash: typeof txid === 'string' ? txid : binToHex(txid), tx_pos: vout, value: Number(output.valueSatoshis) };
  if (output.token !== undefined) item.token_data = tokenToElectrum(output.token);
  return item;
};

/** One get_history item -> { txid, txidHex, height, confirmed, fee? }. */
export const historyFromElectrum = (item) => {
  if (item === null || typeof item !== 'object') fail('history item must be an object');
  if (!Number.isInteger(item.height)) fail('history height must be an integer');
  return {
    txid: hexToHash(item.tx_hash, 'tx_hash'),
    txidHex: item.tx_hash.toLowerCase(),
    height: item.height,
    confirmed: item.height > 0,
    ...(item.fee !== undefined && { fee: item.fee }),
  };
};

/** Header notification or headers.subscribe result -> { height, hex }. */
export const headerFromElectrum = (header) => {
  if (header === null || typeof header !== 'object' || !Number.isInteger(header.height) || typeof header.hex !== 'string') {
    fail('header must be { height, hex }');
  }
  return { height: header.height, hex: header.hex };
};

/** Is this a plain BCH coin (no token)? */
export const isPlainCoin = (utxo) => utxo.output.token === undefined;

/** Outpoint key used across the client: "<txid hex>:<vout>". */
export const outpointKey = (txid, vout) => `${typeof txid === 'string' ? txid.toLowerCase() : binToHex(txid)}:${vout}`;
