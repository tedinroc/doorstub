// Simnet: a local Fulcrum-compatible JSON-RPC-over-WebSocket server backed by
// the in-memory SimChain. It answers the Electrum Cash protocol subset Doorstub
// uses, with Fulcrum's response shapes (pinned by test/simnet against
// test/fixtures/fulcrum-live), plus control methods simnet.fund, simnet.mine,
// simnet.reset and simnet.info. It listens on 127.0.0.1 only by default.
import { WebSocketServer } from 'ws';
import { binToHex } from '@bitauth/libauth';
import { SimChain, SimnetError, lockingBytecodeOfAddress, scripthashOf } from './chain.js';
import { verboseTransaction } from './verbose.js';

export const DEFAULT_PORT = 50021;
export const SERVER_VERSION = 'Fulcrum-compatible Doorstub simnet 1.0';
const PROTOCOL_MIN = '1.4';
const PROTOCOL_MAX = '1.5';
const TOKEN_FILTERS = new Set(['include_tokens', 'exclude_tokens', 'tokens_only']);

/** JSON with object keys sorted, as Fulcrum (Qt) writes it. */
export const sortedJson = (value) =>
  JSON.stringify(value, (key, v) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]));
  });

const invalidParams = (message = 'Invalid params') => new SimnetError(-32602, message);

const protocolNumber = (version) => {
  const [major, minor = '0', patch = '0'] = String(version).split('.');
  return Number(major) * 10_000 + Number(minor) * 100 + Number(patch);
};

/** Pick the protocol version from server.version's second argument, as Fulcrum does. */
const negotiate = (requested) => {
  let min = PROTOCOL_MIN;
  let max = PROTOCOL_MIN;
  if (Array.isArray(requested) && requested.length === 2) [min, max] = requested.map(String);
  else if (requested !== undefined) min = max = String(requested);
  const chosen = protocolNumber(max) >= protocolNumber(PROTOCOL_MAX) ? PROTOCOL_MAX : max;
  if (protocolNumber(chosen) < protocolNumber(min) || protocolNumber(chosen) < protocolNumber(PROTOCOL_MIN)) {
    throw new SimnetError(1, 'Unsupported protocol version');
  }
  return chosen;
};

const asArray = (params) => (params === undefined ? [] : Array.isArray(params) ? params : [params]);
const asObject = (params) => {
  if (params === undefined) return {};
  if (Array.isArray(params)) return params[0] ?? {};
  return params;
};

const scripthashParam = (value) => {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value)) throw new SimnetError(1, 'Invalid scripthash');
  return value.toLowerCase();
};

const heightParam = (value) => {
  const height = Number(value);
  if (!Number.isInteger(height)) throw invalidParams('Invalid height');
  return height;
};

/** Start a simnet server. Resolves to { url, port, chain, close() }. */
export const startSimnet = async ({
  port = DEFAULT_PORT,
  host = '127.0.0.1',
  seed,
  height,
  time,
  autoMineMs,
  log = () => {},
} = {}) => {
  const chain = new SimChain({ seed, height, time });
  const wss = new WebSocketServer({ host, port });
  await new Promise((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });
  const actualPort = wss.address().port;
  const clients = new Set();

  const send = (ctx, message) => {
    if (ctx.ws.readyState === ctx.ws.OPEN) ctx.ws.send(sortedJson(message));
  };

  /** Height of a transaction for transaction.subscribe: block height, 0 in the mempool, null if unknown. */
  const txHeightOrNull = (txid) => {
    const entry = chain.txs.get(txid);
    return entry === undefined ? null : entry.height ?? 0;
  };

  /** After any change: header notification if the tip moved, status notifications where the status changed. */
  const notify = ({ tip }) => {
    for (const ctx of clients) {
      if (tip && ctx.headers) {
        const header = chain.tip();
        if (header.height !== ctx.lastHeaderHeight || header.hex !== ctx.lastHeaderHex) {
          ctx.lastHeaderHeight = header.height;
          ctx.lastHeaderHex = header.hex;
          send(ctx, { jsonrpc: '2.0', method: 'blockchain.headers.subscribe', params: [header] });
        }
      }
      for (const [txid, last] of ctx.txSubscriptions) {
        const height = txHeightOrNull(txid);
        if (height === last) continue;
        ctx.txSubscriptions.set(txid, height);
        send(ctx, { jsonrpc: '2.0', method: 'blockchain.transaction.subscribe', params: [txid, height] });
      }
      for (const [scripthash, sub] of ctx.subscriptions) {
        const status = chain.status(scripthash);
        if (status === sub.status) continue;
        sub.status = status;
        if (sub.address === undefined) send(ctx, { jsonrpc: '2.0', method: 'blockchain.scripthash.subscribe', params: [scripthash, status] });
        else send(ctx, { jsonrpc: '2.0', method: 'blockchain.address.subscribe', params: [sub.address, status] });
      }
    }
  };
  chain.onChange(notify);

  const tokenFilterOf = (ctx, value) => {
    if (value === undefined || value === null) {
      // Fulcrum: before protocol 1.5 is negotiated token coins are excluded by default.
      return protocolNumber(ctx.protocol) >= protocolNumber('1.5') ? 'include_tokens' : 'exclude_tokens';
    }
    if (!TOKEN_FILTERS.has(value)) throw new SimnetError(1, `Invalid token filter: ${value}`);
    return value;
  };

  // One subscription per script hash per connection, as in Fulcrum: the last
  // subscribe call (by address, in the client's spelling, or by script hash)
  // decides which notification the client gets
  // (test/fixtures/fulcrum-live/notification.*).
  const subscribe = (ctx, scripthash, { address } = {}) => {
    const status = chain.status(scripthash);
    ctx.subscriptions.set(scripthash, { status, address });
    return status;
  };

  const unsubscribe = (ctx, scripthash) => ctx.subscriptions.delete(scripthash);

  // Shared bodies of blockchain.address.* and blockchain.scripthash.*.
  const scripthashMethods = {
    listunspent: (ctx, sh, rest) => chain.unspent(sh, tokenFilterOf(ctx, rest[0])),
    get_history: (ctx, sh, rest) =>
      chain.history(sh, {
        fromHeight: rest[0] === undefined ? 0 : heightParam(rest[0]),
        toHeight: rest[1] === undefined ? -1 : heightParam(rest[1]),
      }),
    get_mempool: (ctx, sh) => chain.mempoolHistory(sh),
    get_balance: (ctx, sh, rest) => chain.balance(sh, tokenFilterOf(ctx, rest[0])),
  };

  const handlers = {
    'server.version': (ctx, params) => {
      const [, requested] = asArray(params);
      ctx.protocol = negotiate(requested);
      return [SERVER_VERSION, ctx.protocol];
    },
    'server.features': () => ({
      cashtokens: true,
      dsproof: false,
      genesis_hash: chain.info().genesisHash,
      hash_function: 'sha256',
      hosts: {},
      protocol_max: PROTOCOL_MAX,
      protocol_min: PROTOCOL_MIN,
      pruning: null,
      server_version: SERVER_VERSION,
    }),
    'server.ping': () => null,
    'server.banner': () => 'Doorstub simnet: a local test chain. Nothing here is real money.',
    'blockchain.headers.subscribe': (ctx) => {
      ctx.headers = true;
      const header = chain.tip();
      ctx.lastHeaderHeight = header.height;
      ctx.lastHeaderHex = header.hex;
      return header;
    },
    'blockchain.headers.unsubscribe': (ctx) => {
      const was = ctx.headers;
      ctx.headers = false;
      return was;
    },
    'blockchain.block.header': (ctx, params) => {
      const [height, cpHeight = 0] = asArray(params);
      if (Number(cpHeight) !== 0) throw new SimnetError(1, 'simnet does not serve checkpoint proofs (cp_height must be 0)');
      return binToHex(chain.block(heightParam(height)).header);
    },
    'blockchain.block.headers': (ctx, params) => {
      const [start, count, cpHeight = 0] = asArray(params);
      if (Number(cpHeight) !== 0) throw new SimnetError(1, 'simnet does not serve checkpoint proofs (cp_height must be 0)');
      const first = heightParam(start);
      const wanted = Math.min(Math.max(heightParam(count), 0), 2016);
      if (first < 0 || first > chain.tipHeight) throw new SimnetError(1, `Height ${first} is out of range`);
      const last = Math.min(first + wanted - 1, chain.tipHeight);
      const headers = [];
      for (let h = first; h <= last; h += 1) headers.push(binToHex(chain.block(h).header));
      return { count: headers.length, hex: headers.join(''), max: 2016 };
    },
    'blockchain.estimatefee': () => 0.00001,
    'blockchain.relayfee': () => 0.00001,
    'blockchain.transaction.get': (ctx, params) => {
      const [txid, verbose = false] = asArray(params);
      const entry = chain.transaction(txid);
      return verbose ? verboseTransaction(chain, txid.toLowerCase(), entry) : binToHex(entry.raw);
    },
    'blockchain.transaction.get_height': (ctx, params) => chain.transactionHeight(asArray(params)[0]),
    'blockchain.transaction.subscribe': (ctx, params) => {
      const txid = asArray(params)[0];
      if (typeof txid !== 'string' || !/^[0-9a-fA-F]{64}$/.test(txid)) throw new SimnetError(1, 'Invalid tx hash');
      const height = txHeightOrNull(txid.toLowerCase());
      ctx.txSubscriptions.set(txid.toLowerCase(), height);
      return height;
    },
    'blockchain.transaction.unsubscribe': (ctx, params) => ctx.txSubscriptions.delete(String(asArray(params)[0]).toLowerCase()),
    'blockchain.transaction.broadcast': (ctx, params) => {
      const txid = chain.broadcast(asArray(params)[0]);
      log(`broadcast accepted ${txid}`);
      return txid;
    },
    'blockchain.address.get_scripthash': (ctx, params) => scripthashOf(lockingBytecodeOfAddress(asArray(params)[0])),
    'blockchain.address.subscribe': (ctx, params) => {
      const address = asArray(params)[0];
      return subscribe(ctx, scripthashOf(lockingBytecodeOfAddress(address)), { address });
    },
    'blockchain.address.unsubscribe': (ctx, params) => unsubscribe(ctx, scripthashOf(lockingBytecodeOfAddress(asArray(params)[0]))),
    'blockchain.scripthash.subscribe': (ctx, params) => subscribe(ctx, scripthashParam(asArray(params)[0])),
    'blockchain.scripthash.unsubscribe': (ctx, params) => unsubscribe(ctx, scripthashParam(asArray(params)[0])),

    'simnet.info': () => chain.info(),
    'simnet.fund': (ctx, params) => {
      const result = chain.fund(asObject(params));
      log(`fund ${result.sats} sats -> ${result.txid}:0`);
      return result;
    },
    'simnet.mine': (ctx, params) => {
      const { blocks = 1 } = asObject(params);
      const result = chain.mine(Number(blocks));
      log(`mined to ${result.height} (${result.mined.length} txs)`);
      return result;
    },
    'simnet.reset': (ctx, params) => {
      const result = chain.reset(asObject(params));
      log(`reset to ${result.height}`);
      return result;
    },
  };
  for (const [name, body] of Object.entries(scripthashMethods)) {
    handlers[`blockchain.scripthash.${name}`] = (ctx, params) => {
      const [sh, ...rest] = asArray(params);
      return body(ctx, scripthashParam(sh), rest);
    };
    handlers[`blockchain.address.${name}`] = (ctx, params) => {
      const [address, ...rest] = asArray(params);
      return body(ctx, scripthashOf(lockingBytecodeOfAddress(address)), rest);
    };
  }

  const answer = (ctx, request) => {
    if (request === null || typeof request !== 'object' || Array.isArray(request) || typeof request.method !== 'string') {
      return { error: { code: -32600, message: 'Invalid request' }, id: request?.id ?? null, jsonrpc: '2.0' };
    }
    const { id = null, method, params } = request;
    const handler = handlers[method];
    if (handler === undefined) return { error: { code: -32601, message: `Unsupported request: ${method}` }, id, jsonrpc: '2.0' };
    try {
      return { id, jsonrpc: '2.0', result: handler(ctx, params) };
    } catch (error) {
      const code = error instanceof SimnetError ? error.code : 1;
      return { error: { code, message: error.message }, id, jsonrpc: '2.0' };
    }
  };

  wss.on('connection', (ws) => {
    const ctx = { ws, protocol: PROTOCOL_MIN, headers: false, subscriptions: new Map(), txSubscriptions: new Map() };
    clients.add(ctx);
    ws.on('close', () => clients.delete(ctx));
    ws.on('message', (data) => {
      let parsed;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        send(ctx, { error: { code: -32700, message: 'Parse error' }, id: null, jsonrpc: '2.0' });
        return;
      }
      if (Array.isArray(parsed)) {
        if (parsed.length === 0) {
          send(ctx, { error: { code: -32600, message: 'Invalid request' }, id: null, jsonrpc: '2.0' });
          return;
        }
        send(ctx, parsed.map((request) => answer(ctx, request)));
      } else {
        send(ctx, answer(ctx, parsed));
      }
    });
  });

  const timer = autoMineMs ? setInterval(() => chain.mine(1), autoMineMs) : undefined;

  const close = () =>
    new Promise((resolve) => {
      if (timer) clearInterval(timer);
      for (const ctx of clients) ctx.ws.terminate();
      wss.close(() => resolve());
    });

  return { url: `ws://${host}:${actualPort}`, port: actualPort, chain, close };
};
