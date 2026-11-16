// Read-only Fulcrum (Electrum protocol 1.5) client over WSS, used to find the
// wallet's real coins for shape A-real. It can only call the methods in
// READ_ONLY_METHODS; anything else throws before a byte leaves the page.
import { binToHex, hexToBin, sha256 } from '@bitauth/libauth';

/** Public mainnet Fulcrum WSS servers that answered on 11/12 (tried in order). */
export const FULCRUM_SERVERS = [
  'wss://bch.imaginary.cash:50004',
  'wss://electrum.imaginary.cash:50004',
  'wss://fulcrum.pat.mn:50004',
  'wss://blackie.c3-soft.com:50004',
  'wss://electroncash.dk:50004',
  'wss://bch.soul-dev.com:50004',
];

export const READ_ONLY_METHODS = new Set(['server.version', 'blockchain.scripthash.listunspent']);

/** Electrum script hash: sha256 of the locking bytecode, byte-reversed, as hex. */
export const scriptHash = (lockingBytecode) => binToHex(sha256.hash(lockingBytecode).slice().reverse());

const withTimeout = (promise, ms, what) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });

/** Open one server. Resolves to { url, request(method, params), close() }. */
export const openFulcrum = (url, { timeoutMs = 8000 } = {}) =>
  withTimeout(
    new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const pending = new Map();
      let nextId = 1;
      ws.onerror = () => reject(new Error(`cannot reach ${url}`));
      ws.onclose = () => {
        for (const { reject: rej } of pending.values()) rej(new Error(`${url} closed`));
        pending.clear();
      };
      ws.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data));
        } catch {
          return;
        }
        const entry = pending.get(msg.id);
        if (entry === undefined) return;
        pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        else entry.resolve(msg.result);
      };
      ws.onopen = () => {
        const request = (method, params = []) => {
          if (!READ_ONLY_METHODS.has(method)) return Promise.reject(new Error(`probe refuses to call ${method}`));
          const id = nextId++;
          const p = new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
          ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
          return withTimeout(p, timeoutMs, method);
        };
        resolve({ url, request, close: () => ws.close() });
      };
    }),
    timeoutMs,
    `connect ${url}`,
  );

/** Try the servers in order; resolve with the first that answers server.version. */
export const connectAnyFulcrum = async (servers = FULCRUM_SERVERS, onProgress = () => {}) => {
  const errors = [];
  for (const url of servers) {
    onProgress(`trying ${url}`);
    try {
      const client = await openFulcrum(url);
      const version = await client.request('server.version', ['Doorstub probe', '1.5']);
      return { client, version };
    } catch (e) {
      errors.push(`${url}: ${e.message}`);
    }
  }
  throw new Error(`no Fulcrum server answered (${errors.join('; ')})`);
};

/**
 * List the unspent coins of the given addresses.
 * @param {Array<{ path: string, index: number, lockingBytecode: Uint8Array }>} addresses
 * @returns {Promise<{ server: string, coins: Array, tokenCoins: number }>} plain coins only in `coins`
 *   (each { txid, vout, value, height, lockingBytecode, path, index }); `tokenCoins` counts skipped token coins.
 */
export const scanCoins = async (addresses, { servers, onProgress = () => {} } = {}) => {
  const { client } = await connectAnyFulcrum(servers, onProgress);
  try {
    onProgress(`asking ${client.url} about ${addresses.length} addresses`);
    const lists = await Promise.all(
      addresses.map((a) => client.request('blockchain.scripthash.listunspent', [scriptHash(a.lockingBytecode), 'include_tokens'])),
    );
    const coins = [];
    let tokenCoins = 0;
    lists.forEach((list, k) => {
      for (const item of list ?? []) {
        if (item.token_data !== undefined) {
          tokenCoins += 1;
          continue;
        }
        coins.push({
          txid: hexToBin(item.tx_hash),
          vout: item.tx_pos,
          value: BigInt(item.value),
          height: item.height,
          lockingBytecode: addresses[k].lockingBytecode,
          path: addresses[k].path,
          index: addresses[k].index,
        });
      }
    });
    return { server: client.url, coins, tokenCoins };
  } finally {
    client.close();
  }
};
