// The worker's Fulcrum client. It runs in workerd and in Node 22 (both have a
// global WebSocket) on src/chain/electrum.js (one JSON-RPC connection, no
// libauth). In workerd a socket belongs to the request that opened it, so
// every request or cron run opens its own client and closes it at the end.
//
// Reads fail over across servers. `broadcast` takes only a transaction branded
// by `vet` (worker/lib/rules.js), asks each server which chain it serves
// first (server.features genesis_hash: a simnet worker never sends to
// mainnet, a mainnet worker never sends anywhere else), and sends to two
// servers of different operators when it can. "Already known" is success.
import { RpcError, TransportError, openElectrum } from '../../src/chain/electrum.js';
import { MAINNET_GENESIS_HASH, MAINNET_SERVERS, normaliseServers } from '../../src/chain/servers.js';
import { hexToBytes, isHex, WorkerError } from './bytes.js';
import { txidOf } from './crypto.js';
import { isVetted } from './rules.js';
import { decodeTransaction } from './tx.js';

/** Same patterns as src/chain/pool.js (pinned equal by test/worker/chain.test.js). */
export const ALREADY_KNOWN = /txn-already-(?:known|in-mempool)|already in (?:the )?block ?chain|already have transaction|transaction already exists/i;
export const CONFLICT = /txn-mempool-conflict|missingorspent|missing ?inputs|double.?spend|inputs.?spent/i;

const READ_METHODS = new Set([
  'server.features',
  'blockchain.headers.subscribe',
  'blockchain.scripthash.listunspent',
  'blockchain.scripthash.get_history',
  'blockchain.transaction.get',
  'blockchain.transaction.get_height',
]);

export const CLIENT_NAME = 'Doorstub worker';

/**
 * @param {object} o
 * @param {'mainnet'|'simnet'} o.network
 * @param {Array} [o.servers] required on simnet; mainnet always uses MAINNET_SERVERS
 */
export const createWorkerChain = ({
  network,
  servers,
  WebSocketImpl = globalThis.WebSocket,
  connectTimeoutMs = 5_000,
  requestTimeoutMs = 10_000,
  random = Math.random,
} = {}) => {
  if (network !== 'mainnet' && network !== 'simnet') throw new WorkerError('bad-network', `unknown network ${network}`, { status: 500 });
  if (network === 'simnet' && (servers === undefined || servers.length === 0)) throw new WorkerError('no-servers', 'a simnet worker needs its Fulcrum URL', { status: 500 });
  // Mainnet ignores any server list it is handed: the production server set is fixed in code.
  const list = normaliseServers(network === 'mainnet' ? MAINNET_SERVERS : servers);
  // Spread load: start at a random server, keep the order after it.
  const start = Math.floor(random() * list.length);
  const order = [...list.slice(start), ...list.slice(0, start)];
  const failed = new Set();
  const open = new Map();
  const chainChecks = new Map();
  let active = null;
  let closed = false;

  const connectTo = async (server) => {
    const existing = open.get(server.url);
    if (existing !== undefined && !existing.closed) return existing;
    const conn = await openElectrum(server.url, { WebSocketImpl, connectTimeoutMs, requestTimeoutMs, clientName: CLIENT_NAME });
    if (closed) {
      conn.close();
      throw new WorkerError('closed', 'the chain client is closed', { status: 503, retryable: true });
    }
    open.set(server.url, conn);
    return conn;
  };

  const connect = async () => {
    if (active !== null && !active.closed) return active;
    const errors = [];
    for (const server of order) {
      if (failed.has(server.url)) continue;
      try {
        active = await connectTo(server);
        return active;
      } catch (e) {
        failed.add(server.url);
        errors.push(`${server.url}: ${e.message}`);
      }
    }
    throw new WorkerError('chain-down', `no Fulcrum server answered (${errors.join('; ')})`, { status: 503, retryable: true });
  };

  const request = async (method, params = []) => {
    if (!READ_METHODS.has(method)) throw new WorkerError('method-not-allowed', `the worker does not send ${method}`, { status: 500 });
    for (let attempt = 0; attempt <= list.length; attempt += 1) {
      const conn = await connect();
      try {
        return await conn.request(method, params);
      } catch (e) {
        if (!(e instanceof TransportError)) throw e;
        failed.add(conn.url);
        conn.close();
        if (active === conn) active = null;
      }
    }
    throw new WorkerError('chain-down', 'every Fulcrum server failed', { status: 503, retryable: true });
  };

  /** Current tip height. */
  const tip = async () => {
    const header = await request('blockchain.headers.subscribe', []);
    if (!Number.isInteger(header?.height)) throw new WorkerError('bad-server-shape', 'headers.subscribe gave no height', { status: 502 });
    return header.height;
  };

  /** Unspent coins (tokens included, mempool counted) at a script hash, as Fulcrum items. */
  const listUnspent = async (scripthash) => {
    const items = await request('blockchain.scripthash.listunspent', [scripthash, 'include_tokens']);
    if (!Array.isArray(items)) throw new WorkerError('bad-server-shape', 'listunspent must return a list', { status: 502 });
    return items;
  };

  /**
   * Fetch a transaction the network knows (mempool or chain), checking it
   * hashes to `txid`. Returns { txid, bytes, transaction } or null when unknown.
   */
  const getTransaction = async (txid) => {
    if (!isHex(txid, 32)) throw new WorkerError('bad-txid', 'a txid is 64 hex characters');
    const id = txid.toLowerCase();
    let hex;
    try {
      hex = await request('blockchain.transaction.get', [id]);
    } catch (e) {
      if (e instanceof RpcError) return null;
      throw e;
    }
    if (!isHex(hex) || hex.length === 0) throw new WorkerError('bad-server-shape', 'transaction.get must return hex', { status: 502 });
    const bytes = hexToBytes(hex);
    if (txidOf(bytes) !== id) throw new WorkerError('bad-server-shape', `the server sent a transaction that is not ${id}`, { status: 502 });
    return { txid: id, bytes, transaction: decodeTransaction(bytes) };
  };

  /** Height of a known transaction: > 0 confirmed, 0 in the mempool, null unknown. */
  const transactionHeight = async (txid) => {
    try {
      const h = await request('blockchain.transaction.get_height', [txid.toLowerCase()]);
      return Number.isInteger(h) ? h : null;
    } catch (e) {
      if (e instanceof RpcError) return null;
      throw e;
    }
  };

  const assertChain = (conn) => {
    let check = chainChecks.get(conn);
    if (check === undefined) {
      check = conn.request('server.features', []).then((features) => {
        const hash = typeof features?.genesis_hash === 'string' ? features.genesis_hash.toLowerCase() : undefined;
        if (hash === undefined) throw new WorkerError('wrong-chain', `${conn.url} does not say which chain it serves`, { status: 503 });
        if (network === 'simnet' && hash === MAINNET_GENESIS_HASH) throw new WorkerError('wrong-chain', `${conn.url} serves BCH mainnet; a simnet worker never broadcasts there`, { status: 500 });
        if (network === 'mainnet' && hash !== MAINNET_GENESIS_HASH) throw new WorkerError('wrong-chain', `${conn.url} does not serve BCH mainnet`, { status: 500 });
      });
      chainChecks.set(conn, check);
    }
    return check;
  };

  /**
   * Send a vetted transaction to up to two servers (different operators first).
   * Returns { txid, acceptedBy, alreadyKnown }. Throws WorkerError 'broadcast-refused'
   * with every server's words (`details.conflict` when an input is already spent).
   */
  const broadcast = async (vetted) => {
    if (!isVetted(vetted)) throw new WorkerError('not-vetted', 'the worker broadcasts only transactions that passed its own checks', { status: 500 });
    const primary = await connect();
    const primaryOperator = list.find((s) => s.url === primary.url)?.operator;
    const others = order.filter((s) => s.url !== primary.url && !failed.has(s.url));
    const targets = [primary];
    for (const server of [...others.filter((s) => s.operator !== primaryOperator), ...others.filter((s) => s.operator === primaryOperator)]) {
      if (targets.length >= 2) break;
      try {
        targets.push(await connectTo(server));
      } catch {
        failed.add(server.url);
      }
    }
    const checks = await Promise.allSettled(targets.map(assertChain));
    const wrong = checks.find((r) => r.status === 'rejected' && r.reason?.code === 'wrong-chain');
    if (wrong !== undefined) throw wrong.reason;
    const errors = [];
    const usable = targets.filter((conn, i) => {
      if (checks[i].status === 'fulfilled') return true;
      errors.push({ server: conn.url, message: `chain check failed: ${checks[i].reason?.message ?? checks[i].reason}` });
      return false;
    });
    const settled = await Promise.allSettled(usable.map((conn) => conn.request('blockchain.transaction.broadcast', [vetted.hex])));
    const acceptedBy = [];
    let alreadyKnown = false;
    settled.forEach((r, i) => {
      const server = usable[i].url;
      if (r.status === 'fulfilled' && typeof r.value === 'string' && r.value.toLowerCase() === vetted.txid) acceptedBy.push(server);
      else if (r.status === 'rejected' && r.reason instanceof RpcError && ALREADY_KNOWN.test(r.reason.message)) {
        alreadyKnown = true;
        acceptedBy.push(server);
      } else errors.push({ server, message: r.status === 'rejected' ? r.reason?.message ?? String(r.reason) : `answered ${JSON.stringify(r.value)}` });
    });
    if (acceptedBy.length > 0) return { txid: vetted.txid, acceptedBy, alreadyKnown };
    const conflict = errors.some((e) => CONFLICT.test(e.message));
    throw new WorkerError('broadcast-refused', errors.map((e) => e.message).join(' | ') || 'no server accepted the transaction', {
      status: 502,
      retryable: !conflict,
      details: { conflict, errors },
    });
  };

  const close = () => {
    closed = true;
    for (const conn of open.values()) conn.close();
    open.clear();
    active = null;
  };

  return { network, tip, listUnspent, getTransaction, transactionHeight, broadcast, close, request };
};
