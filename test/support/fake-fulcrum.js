// Test doubles for the chain client (unit tests only; the simnet is the real
// local server). Nothing here touches the network.
//
// makeFakeNetwork(): a WebSocket class whose "servers" are in-memory handlers.
//   Tests can take a server down, make it hang, push notifications, count calls.
// makeMiniChain(): a tiny index over transactions we add by hand (no VM, no
//   consensus): history, listunspent, transaction.get, broadcast, headers,
//   with Fulcrum's response shapes. Enough to drive the pool, ledger and scan.
import { binToHex, decodeTransaction, encodeTransaction, hashTransactionUiOrder, hexToBin, sha256, utf8ToBin } from '@bitauth/libauth';
import { scripthashOf } from '../../src/chain/address.js';
import { utxoToElectrum } from '../../src/chain/tokens.js';

export const makeFakeNetwork = () => {
  const servers = new Map();
  const sockets = new Set();

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      const server = servers.get(url);
      setTimeout(() => {
        if (server === undefined || server.down) {
          this.readyState = 3;
          this.onerror?.({ type: 'error' });
          this.onclose?.({ type: 'close' });
          return;
        }
        if (server.hangOnConnect) return;
        this.readyState = 1;
        this.server = server;
        server.sockets.add(this);
        sockets.add(this);
        this.onopen?.({ type: 'open' });
      }, 0);
    }

    send(text) {
      if (this.readyState !== 1) throw new Error('socket not open');
      const server = this.server;
      const msg = JSON.parse(text);
      server.calls.push({ method: msg.method, params: msg.params });
      if (server.hang?.(msg.method, msg.params)) return;
      setTimeout(async () => {
        if (this.readyState !== 1) return;
        let reply;
        try {
          const result = await server.handler(msg.method, msg.params ?? [], this);
          reply = { jsonrpc: '2.0', id: msg.id, result: result === undefined ? null : result };
        } catch (e) {
          reply = { jsonrpc: '2.0', id: msg.id, error: { code: e.code ?? 1, message: e.message } };
        }
        if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(reply) });
      }, server.latencyMs ?? 0);
    }

    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.server?.sockets.delete(this);
      sockets.delete(this);
      setTimeout(() => this.onclose?.({ type: 'close' }), 0);
    }
  }

  /** handler(method, params, socket) returns a result or throws { code, message }. */
  const addServer = (url, handler, options = {}) => {
    const server = { url, handler, sockets: new Set(), calls: [], down: false, ...options };
    servers.set(url, server);
    return server;
  };

  /** Push a notification to every open socket of a server. */
  const push = (url, method, params) => {
    for (const s of servers.get(url)?.sockets ?? []) s.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', method, params }) });
  };

  /** Drop every open socket of a server (as if it crashed) and keep it down. */
  const kill = (url) => {
    const server = servers.get(url);
    server.down = true;
    for (const s of [...server.sockets]) s.close();
  };

  return { WebSocketImpl: FakeWebSocket, addServer, push, kill, servers, sockets };
};

/** A Fulcrum-like error. */
export const rpcError = (code, message) => Object.assign(new Error(message), { code });

export const makeMiniChain = ({ height = 977_000 } = {}) => {
  const txs = new Map();
  const order = [];
  const outputsByHash = new Map();
  const spent = new Map();
  let tip = height;
  let broadcastHook = null;

  const touch = (sh, txid) => {
    if (!outputsByHash.has(sh)) outputsByHash.set(sh, { history: new Set(), utxos: new Set() });
    outputsByHash.get(sh).history.add(txid);
    return outputsByHash.get(sh);
  };

  /** Add a transaction (decoded or raw) at a height (0 = mempool). Returns its txid hex. */
  const add = (transaction, atHeight = 0) => {
    const bytes = transaction instanceof Uint8Array ? transaction : encodeTransaction(transaction);
    const decoded = transaction instanceof Uint8Array ? decodeTransaction(bytes) : transaction;
    const txid = binToHex(hashTransactionUiOrder(bytes));
    if (txs.has(txid)) return txid;
    txs.set(txid, { hex: binToHex(bytes), height: atHeight, decoded });
    order.push(txid);
    decoded.inputs.forEach((input) => {
      const key = `${binToHex(input.outpointTransactionHash)}:${input.outpointIndex}`;
      spent.set(key, txid);
      const parent = txs.get(binToHex(input.outpointTransactionHash));
      const out = parent?.decoded.outputs[input.outpointIndex];
      if (out !== undefined) {
        const entry = touch(scripthashOf(out.lockingBytecode), txid);
        entry.utxos.delete(key);
      }
    });
    decoded.outputs.forEach((output, vout) => {
      const key = `${txid}:${vout}`;
      const entry = touch(scripthashOf(output.lockingBytecode), txid);
      if (!spent.has(key)) entry.utxos.add(key);
    });
    return txid;
  };

  /** Confirm everything in the mempool at the next height (or `atHeight`). */
  const mine = (blocks = 1) => {
    tip += blocks;
    for (const t of txs.values()) if (t.height <= 0) t.height = tip;
    return tip;
  };

  const historyOf = (sh) =>
    [...(outputsByHash.get(sh)?.history ?? [])]
      .map((txid) => ({ txid, height: txs.get(txid).height }))
      .sort((a, b) => (a.height > 0 ? a.height : 1e12) - (b.height > 0 ? b.height : 1e12) || order.indexOf(a.txid) - order.indexOf(b.txid))
      .map(({ txid, height: h }) => (h > 0 ? { height: h, tx_hash: txid } : { fee: 1000, height: 0, tx_hash: txid }));

  const statusOf = (sh) => {
    const h = historyOf(sh);
    if (h.length === 0) return null;
    return binToHex(sha256.hash(utf8ToBin(h.map((e) => `${e.tx_hash}:${e.height}:`).join(''))));
  };

  const handler = async (method, params) => {
    switch (method) {
      case 'server.version':
        return ['Fulcrum mini', '1.5'];
      case 'server.ping':
        return null;
      case 'blockchain.headers.subscribe':
        return { height: tip, hex: '00'.repeat(80) };
      case 'blockchain.scripthash.get_history':
        return historyOf(params[0]);
      case 'blockchain.scripthash.subscribe':
        return statusOf(params[0]);
      case 'blockchain.scripthash.unsubscribe':
        return true;
      case 'blockchain.scripthash.listunspent':
        return [...(outputsByHash.get(params[0])?.utxos ?? [])].map((key) => {
          const [txid, vout] = key.split(':');
          const t = txs.get(txid);
          return utxoToElectrum({ txid, vout: Number(vout), output: t.decoded.outputs[Number(vout)], height: t.height });
        });
      case 'blockchain.transaction.get': {
        const t = txs.get(String(params[0]).toLowerCase());
        if (t === undefined) throw rpcError(2, "daemon error: DaemonError({'code': -5, 'message': 'No such mempool or blockchain transaction. Use gettransaction for wallet transactions.'})");
        return t.hex;
      }
      case 'blockchain.transaction.broadcast': {
        if (broadcastHook) return broadcastHook(params[0]);
        const bytes = hexToBin(params[0]);
        const txid = binToHex(hashTransactionUiOrder(bytes));
        if (txs.has(txid)) throw rpcError(1, 'the transaction was rejected by network rules.\n\ntxn-already-known');
        return add(bytes, 0);
      }
      default:
        throw rpcError(-32601, `Unsupported request: ${method}`);
    }
  };

  return {
    add,
    mine,
    handler,
    get tip() {
      return tip;
    },
    statusOf,
    historyOf,
    txs,
    /** Replace broadcast behaviour (hex) => txid | throw. */
    onBroadcast: (hook) => {
      broadcastHook = hook;
    },
  };
};
