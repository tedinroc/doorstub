// Read queries over a pool (anything with `request(method, params)` and `tip()`).
// Everything goes by script hash, computed locally from locking bytecode.
import { binToHex, decodeTransaction, hashTransactionUiOrder, hexToBin } from '@bitauth/libauth';
import { scripthashOf } from './address.js';
import { ShapeError, historyFromElectrum, outpointKey, utxoFromElectrum } from './tokens.js';

/** Run `fn` over `items` with at most `limit` in flight; keeps order. */
export const mapLimit = async (items, limit, fn) => {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

const shOf = (target) => (typeof target === 'string' ? target : scripthashOf(target));

/**
 * Unspent coins at a locking bytecode (or a script hash), tokens included, as
 * builder UTXOs { txid, txidHex, vout, height, confirmed, output }.
 * `output.lockingBytecode` is set only when a locking bytecode was given.
 */
export const listUnspent = async (pool, target) => {
  const items = await pool.request('blockchain.scripthash.listunspent', [shOf(target), 'include_tokens']);
  if (!Array.isArray(items)) throw new ShapeError('listunspent must return an array');
  const lockingBytecode = typeof target === 'string' ? undefined : target;
  return items.map((item) => utxoFromElectrum(item, lockingBytecode));
};

/** History of a locking bytecode (or script hash): confirmed first by height, then unconfirmed. */
export const getHistory = async (pool, target) => {
  const items = await pool.request('blockchain.scripthash.get_history', [shOf(target)]);
  if (!Array.isArray(items)) throw new ShapeError('get_history must return an array');
  const rank = (h) => (h.height > 0 ? h.height : Number.MAX_SAFE_INTEGER - (h.height === 0 ? 1 : 0));
  return items.map(historyFromElectrum).sort((a, b) => rank(a) - rank(b));
};

/** Has this locking bytecode ever been used? */
export const isUsed = async (pool, target) => (await pool.request('blockchain.scripthash.get_history', [shOf(target)])).length > 0;

/** A cache of decoded transactions by txid hex. Transactions never change, so it never expires. */
export const createTxCache = () => new Map();

/**
 * Fetch and decode one transaction, checking that its hash is the txid we
 * asked for (a server cannot hand us a different transaction).
 * Returns { txid (hex), bytes, transaction }.
 */
export const getTransaction = async (pool, txid, { cache } = {}) => {
  const txidHex = (typeof txid === 'string' ? txid : binToHex(txid)).toLowerCase();
  const cached = cache?.get(txidHex);
  if (cached !== undefined) return cached;
  const hex = await pool.request('blockchain.transaction.get', [txidHex]);
  if (typeof hex !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(hex)) throw new ShapeError('transaction.get must return hex');
  const bytes = hexToBin(hex);
  if (binToHex(hashTransactionUiOrder(bytes)) !== txidHex) throw new ShapeError(`server sent a transaction whose hash is not ${txidHex}`);
  const transaction = decodeTransaction(bytes);
  if (typeof transaction === 'string') throw new ShapeError(`transaction ${txidHex} does not decode: ${transaction}`);
  const entry = { txid: txidHex, bytes, transaction };
  cache?.set(txidHex, entry);
  return entry;
};

/** Fetch many transactions (deduplicated, at most 16 in flight). Returns a Map by txid hex. */
export const getTransactions = async (pool, txids, { cache, limit = 16 } = {}) => {
  const unique = [...new Set(txids.map((t) => (typeof t === 'string' ? t : binToHex(t)).toLowerCase()))];
  const entries = await mapLimit(unique, limit, (t) => getTransaction(pool, t, { cache }));
  return new Map(entries.map((e) => [e.txid, e]));
};

/** The outputs a transaction spends, fetched from their parent transactions (ours, not the sender's). */
export const getSourceOutputs = async (pool, transaction, { cache } = {}) => {
  const parents = await getTransactions(
    pool,
    transaction.inputs.map((input) => input.outpointTransactionHash),
    { cache },
  );
  return transaction.inputs.map((input) => {
    const parent = parents.get(binToHex(input.outpointTransactionHash));
    const output = parent?.transaction.outputs[input.outpointIndex];
    if (output === undefined) throw new ShapeError(`input spends ${outpointKey(input.outpointTransactionHash, input.outpointIndex)}, which does not exist`);
    return output;
  });
};

/**
 * Height of `txid` as seen in the history of `lockingBytecode` (an address the
 * transaction pays or spends): > 0 confirmed at that height, 0 or -1 in the
 * mempool, null when the server does not list it there.
 */
export const heightInHistory = async (pool, txid, lockingBytecode) => {
  const txidHex = (typeof txid === 'string' ? txid : binToHex(txid)).toLowerCase();
  const history = await getHistory(pool, lockingBytecode);
  const entry = history.find((h) => h.txidHex === txidHex);
  return entry === undefined ? null : entry.height;
};
