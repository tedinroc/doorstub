// A pool over several Fulcrum servers: one active connection with failover,
// request timeouts, a keepalive ping, subscriptions that survive a failover,
// and broadcast of CHECKED transactions to two servers.
//
// Browser and Node 22 (global WebSocket); tests inject `WebSocketImpl`.
//
//   const pool = createFulcrumPool({ network: 'mainnet' });          // read-only
//   const pool = createFulcrumPool({ network: 'mainnet', allowBroadcast: true }); // the app
//   const pool = createFulcrumPool({ network: 'simnet', servers: ['ws://127.0.0.1:50003'], allowBroadcast: true });
//
// `request` only takes read methods (and `simnet.*` on the simnet). The only
// way to send a transaction is `broadcastChecked(checked)`, which takes an
// object made by checkTransaction (src/chain/checked.js), and only when the
// pool was created with `allowBroadcast: true`. Before the first broadcast
// through a connection, the server must say which chain it serves
// (`server.features` genesis_hash): a simnet pool never sends to a mainnet
// server, and a mainnet pool never sends to any other chain.
import { RpcError, TransportError, openElectrum } from './electrum.js';
import { isChecked } from './checked.js';
import { MAINNET_GENESIS_HASH, MAINNET_SERVERS, normaliseServers } from './servers.js';
import { headerFromElectrum } from './tokens.js';

/** Methods `request` passes through. Subscriptions go through subscribeHeaders / subscribeScripthash. */
export const READ_METHODS = Object.freeze(
  new Set([
    'server.version',
    'server.ping',
    'server.features',
    'blockchain.block.header',
    'blockchain.headers.get_tip',
    'blockchain.scripthash.listunspent',
    'blockchain.scripthash.get_history',
    'blockchain.scripthash.get_mempool',
    'blockchain.scripthash.get_balance',
    'blockchain.address.listunspent',
    'blockchain.address.get_history',
    'blockchain.address.get_mempool',
    'blockchain.address.get_balance',
    'blockchain.address.get_scripthash',
    'blockchain.transaction.get',
    'blockchain.transaction.get_height',
    'blockchain.transaction.get_merkle',
  ]),
);

/** Broadcast errors that mean "the network already has this transaction". */
export const ALREADY_KNOWN = /txn-already-(?:known|in-mempool)|already in (?:the )?block ?chain|already have transaction|transaction already exists/i;

/** Broadcast errors that mean "an input is already spent" (for example shard contention). */
export const CONFLICT = /txn-mempool-conflict|missingorspent|missing ?inputs|double.?spend|inputs.?spent/i;

export class BroadcastError extends Error {
  constructor(code, message, { errors = [], txid } = {}) {
    super(message);
    this.name = 'BroadcastError';
    this.code = code;
    this.errors = errors;
    this.txid = txid;
    this.conflict = errors.some((e) => CONFLICT.test(e.message));
  }
}

export class PoolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PoolError';
    this.code = code;
  }
}

const unref = (timer) => {
  timer?.unref?.();
  return timer;
};

/**
 * @param {object} options
 * @param {'mainnet'|'simnet'} [options.network]
 * @param {Array<string|{url, operator}>} [options.servers] defaults to MAINNET_SERVERS on mainnet; required on simnet
 * @param {boolean} [options.allowBroadcast] false unless set; the app sets it, read-only tools do not
 * @param {Function} [options.WebSocketImpl] defaults to the global WebSocket
 * @param {number} [options.connectTimeoutMs] per server
 * @param {number} [options.requestTimeoutMs] per request
 * @param {number} [options.pingIntervalMs] keepalive; 0 disables
 * @param {number} [options.cooldownMs] how long a failed server goes to the back of the line
 * @param {number} [options.raceWidth] how many servers to try at once when connecting
 * @param {number} [options.reconnectBaseMs] background reconnect backoff base (2x per failed try, at most 60 s)
 * @param {(event: {state, server?, error?}) => void} [options.onStatus]
 */
export const createFulcrumPool = ({
  network = 'mainnet',
  servers,
  allowBroadcast = false,
  WebSocketImpl = globalThis.WebSocket,
  connectTimeoutMs = 6_000,
  requestTimeoutMs = 12_000,
  pingIntervalMs = 45_000,
  cooldownMs = 60_000,
  raceWidth = 2,
  reconnectBaseMs = 1_000,
  clientName,
  onStatus = () => {},
} = {}) => {
  if (network !== 'mainnet' && network !== 'simnet') throw new PoolError('bad-network', `unknown network ${network}`);
  if (network === 'simnet' && servers === undefined) throw new PoolError('no-servers', 'the simnet pool needs its server URL');
  const list = normaliseServers(servers ?? MAINNET_SERVERS);
  const cooldown = new Map();
  // listener -> the last value it was given (so a reconnect or a duplicate
  // answer never reports the same tip or status twice in a row)
  const headerListeners = new Map();
  const scripthashListeners = new Map();
  const extras = new Map();
  let active = null;
  let connecting = null;
  let lastHeader = null;
  let headerConn = null;
  let pingTimer = null;
  let reconnectTimer = null;
  let closed = false;

  const report = (event) => {
    try {
      onStatus(event);
    } catch {
      // ignore listener errors
    }
  };

  const openOptions = (holder) => ({
    WebSocketImpl,
    connectTimeoutMs,
    requestTimeoutMs,
    ...(clientName !== undefined && { clientName }),
    onNotification: (method, params) => {
      if (holder.conn !== undefined && holder.conn === active) dispatch(method, params);
    },
    onClose: () => {
      if (holder.conn !== undefined) drop(holder.conn, new TransportError('closed', `${holder.conn.url} closed`));
    },
  });

  const candidates = () => {
    const now = Date.now();
    const fresh = list.filter((s) => !(cooldown.get(s.url) > now));
    const cooling = list.filter((s) => cooldown.get(s.url) > now).sort((a, b) => cooldown.get(a.url) - cooldown.get(b.url));
    return [...fresh, ...cooling];
  };

  /** Open several servers at once; the first to answer wins and the rest are closed. */
  const race = (batch, errors) =>
    new Promise((resolve, reject) => {
      let settled = false;
      let failures = 0;
      for (const server of batch) {
        const holder = {};
        openElectrum(server.url, openOptions(holder)).then(
          (conn) => {
            holder.conn = conn;
            if (settled || closed) {
              conn.close();
              return;
            }
            settled = true;
            resolve(conn);
          },
          (e) => {
            errors.push(`${server.url}: ${e.message}`);
            cooldown.set(server.url, Date.now() + cooldownMs);
            failures += 1;
            if (failures === batch.length && !settled) {
              settled = true;
              reject(e);
            }
          },
        );
      }
    });

  const adopt = async (conn) => {
    active = conn;
    cooldown.delete(conn.url);
    report({ state: 'connected', server: conn.url });
    startPing();
    if (headerListeners.size > 0) {
      try {
        const header = headerFromElectrum(await conn.request('blockchain.headers.subscribe', []));
        headerConn = conn;
        setHeader(header);
      } catch {
        // the next request will notice a dead server
      }
    }
    for (const [scripthash, listeners] of scripthashListeners) {
      try {
        const status = await conn.request('blockchain.scripthash.subscribe', [scripthash]);
        for (const cb of listeners.keys()) deliver(listeners, cb, status ?? null);
      } catch {
        // as above
      }
    }
  };

  const connect = () => {
    if (closed) return Promise.reject(new PoolError('closed', 'the pool is closed'));
    if (active !== null && !active.closed) return Promise.resolve(active);
    if (connecting !== null) return connecting;
    connecting = (async () => {
      const errors = [];
      const order = candidates();
      for (let i = 0; i < order.length; i += raceWidth) {
        try {
          const conn = await race(order.slice(i, i + raceWidth), errors);
          if (closed) {
            conn.close();
            throw new PoolError('closed', 'the pool is closed');
          }
          await adopt(conn);
          return conn;
        } catch (e) {
          if (e instanceof PoolError) throw e;
        }
      }
      report({ state: 'down', error: errors.join('; ') });
      throw new TransportError('all-down', `no Fulcrum server answered (${errors.join('; ')})`);
    })().finally(() => {
      connecting = null;
    });
    return connecting;
  };

  const hasListeners = () => headerListeners.size > 0 || scripthashListeners.size > 0;

  /**
   * With live subscriptions, keep trying to reconnect in the background
   * (2 s, 4 s, ... up to 60 s apart) until a server answers.
   */
  const reconnectSoon = (attempt = 0) => {
    if (closed || reconnectTimer !== null || !hasListeners()) return;
    const delay = attempt === 0 ? 0 : Math.min(60_000, reconnectBaseMs * 2 ** attempt);
    reconnectTimer = unref(
      setTimeout(() => {
        reconnectTimer = null;
        if (closed || active !== null || !hasListeners()) return;
        connect().catch(() => reconnectSoon(attempt + 1));
      }, delay),
    );
  };

  const drop = (conn, error) => {
    if (conn !== active) return;
    active = null;
    stopPing();
    cooldown.set(conn.url, Date.now() + cooldownMs);
    conn.close();
    if (closed) return;
    report({ state: 'reconnecting', server: conn.url, error: error?.message });
    reconnectSoon();
  };

  const startPing = () => {
    stopPing();
    if (!(pingIntervalMs > 0)) return;
    pingTimer = unref(
      setInterval(() => {
        const conn = active;
        if (conn === null) return;
        conn.request('server.ping', [], { timeoutMs: Math.min(requestTimeoutMs, 10_000) }).catch((e) => {
          if (e instanceof TransportError) drop(conn, e);
        });
      }, pingIntervalMs),
    );
  };

  const stopPing = () => {
    if (pingTimer !== null) clearInterval(pingTimer);
    pingTimer = null;
  };

  const safeCall = (cb, value) => {
    try {
      cb(value);
    } catch {
      // ignore listener errors
    }
  };

  const sameValue = (a, b) => (a !== null && typeof a === 'object' && b !== null && typeof b === 'object' ? a.height === b.height && a.hex === b.hex : a === b);

  const deliver = (listeners, cb, value) => {
    if (listeners.has(cb) && listeners.get(cb) !== undefined && sameValue(listeners.get(cb), value)) return;
    listeners.set(cb, value);
    safeCall(cb, value);
  };

  const setHeader = (header) => {
    lastHeader = header;
    for (const cb of headerListeners.keys()) deliver(headerListeners, cb, header);
  };

  const dispatch = (method, params) => {
    if (method === 'blockchain.headers.subscribe') {
      for (const raw of params) {
        try {
          setHeader(headerFromElectrum(raw));
        } catch {
          // ignore malformed pushes
        }
      }
      return;
    }
    if (method === 'blockchain.scripthash.subscribe') {
      const [scripthash, status] = params;
      const listeners = scripthashListeners.get(scripthash);
      if (listeners !== undefined) for (const cb of listeners.keys()) deliver(listeners, cb, status ?? null);
    }
  };

  /** One request with failover; internal (allows subscribe methods). */
  const call = async (method, params, opts) => {
    let lastError;
    for (let attempt = 0; attempt < list.length + 1; attempt += 1) {
      const conn = await connect();
      try {
        return await conn.request(method, params, opts);
      } catch (e) {
        if (!(e instanceof TransportError)) throw e;
        lastError = e;
        drop(conn, e);
      }
    }
    throw lastError;
  };

  const allowed = (method) => READ_METHODS.has(method) || (network === 'simnet' && /^simnet\.[a-z_]+$/i.test(method));

  /** A read request (or a simnet control call on the simnet), with failover. */
  const request = (method, params = [], opts) => {
    if (typeof method !== 'string' || !allowed(method)) {
      return Promise.reject(new PoolError('method-not-allowed', `the pool does not send ${method}; broadcasts go through broadcastChecked`));
    }
    return call(method, params, opts);
  };

  /** Current tip { height, hex }: from the subscription when live, else asked. */
  const tip = async () => {
    if (lastHeader !== null && active !== null && headerConn === active) return lastHeader;
    const header = headerFromElectrum(await call('blockchain.headers.subscribe', []));
    headerConn = active;
    lastHeader = header;
    return header;
  };

  /** Call `cb({ height, hex })` now and on every new tip. Returns unsubscribe. */
  const subscribeHeaders = (cb) => {
    headerListeners.set(cb, undefined);
    call('blockchain.headers.subscribe', [])
      .then((raw) => {
        const header = headerFromElectrum(raw);
        headerConn = active;
        lastHeader = header;
        if (headerListeners.has(cb)) deliver(headerListeners, cb, header);
      })
      .catch(() => {});
    return () => headerListeners.delete(cb);
  };

  /** Call `cb(status)` now and whenever the script hash's history changes. Returns unsubscribe. */
  const subscribeScripthash = (scripthash, cb) => {
    let listeners = scripthashListeners.get(scripthash);
    if (listeners === undefined) {
      listeners = new Map();
      scripthashListeners.set(scripthash, listeners);
    }
    listeners.set(cb, undefined);
    call('blockchain.scripthash.subscribe', [scripthash])
      .then((status) => {
        if (listeners.has(cb)) deliver(listeners, cb, status ?? null);
      })
      .catch(() => {});
    return () => {
      listeners.delete(cb);
      if (listeners.size === 0) {
        scripthashListeners.delete(scripthash);
        active?.request('blockchain.scripthash.unsubscribe', [scripthash]).catch(() => {});
      }
    };
  };

  /** Up to `count` open connections, to servers of different operators when possible. */
  const broadcastTargets = async (count) => {
    const primary = await connect();
    const targets = [primary];
    const primaryOperator = list.find((s) => s.url === primary.url)?.operator;
    const others = candidates().filter((s) => s.url !== primary.url);
    const ordered = [...others.filter((s) => s.operator !== primaryOperator), ...others.filter((s) => s.operator === primaryOperator)];
    for (const server of ordered) {
      if (targets.length >= count) break;
      let conn = extras.get(server.url);
      if (conn === undefined || conn.closed) {
        try {
          conn = await openElectrum(server.url, { WebSocketImpl, connectTimeoutMs, requestTimeoutMs, ...(clientName !== undefined && { clientName }) });
          extras.set(server.url, conn);
        } catch {
          cooldown.set(server.url, Date.now() + cooldownMs);
          continue;
        }
      }
      targets.push(conn);
    }
    return targets;
  };

  // Connection -> promise of its chain check (see assertChain).
  const chainChecks = new WeakMap();

  /**
   * Ask a server which chain it serves before anything is broadcast through
   * it. A simnet pool refuses a server reporting the mainnet genesis hash, so
   * a test or E2E run can never send to mainnet by a wrong URL; a mainnet pool
   * refuses a server reporting any other genesis. A server that does not
   * implement server.features (test doubles) is not refused for that: real
   * Fulcrum servers and the simnet always answer it.
   */
  const assertChain = (conn) => {
    let check = chainChecks.get(conn);
    if (check === undefined) {
      check = conn.request('server.features', []).then(
        (features) => {
          const hash = typeof features?.genesis_hash === 'string' ? features.genesis_hash.toLowerCase() : undefined;
          if (hash === undefined) return;
          if (network === 'simnet' && hash === MAINNET_GENESIS_HASH) {
            throw new BroadcastError('wrong-chain', `${conn.url} serves BCH mainnet; a simnet pool never broadcasts there`);
          }
          if (network === 'mainnet' && hash !== MAINNET_GENESIS_HASH) {
            throw new BroadcastError('wrong-chain', `${conn.url} does not serve BCH mainnet (genesis ${hash})`);
          }
        },
        (e) => {
          if (!(e instanceof RpcError)) throw e;
        },
      );
      chainChecks.set(conn, check);
      // A transport failure may be retried on a new connection; a wrong chain stays refused.
      check.catch((e) => {
        if (e?.code !== 'wrong-chain') chainChecks.delete(conn);
      });
    }
    return check;
  };

  /**
   * Send a checked transaction to two servers. Success if either accepts it
   * or says it already has it. Returns { txid, acceptedBy, alreadyKnown, errors }.
   * Throws BroadcastError with every server's words otherwise (`conflict` is
   * true when an input was already spent, e.g. shard contention), or with
   * code 'wrong-chain' (nothing sent anywhere) when a server serves another chain.
   */
  const broadcastChecked = async (checked) => {
    if (!allowBroadcast) throw new BroadcastError('broadcast-disabled', 'this pool was created read-only (allowBroadcast is false)');
    if (!isChecked(checked)) {
      throw new BroadcastError('not-checked', 'broadcastChecked only takes a transaction returned by checkTransaction, checkSignedReply or checkSignatureFree');
    }
    const targets = await broadcastTargets(2);
    const errors = [];
    const chains = await Promise.allSettled(targets.map(assertChain));
    const wrongChain = chains.find((r) => r.status === 'rejected' && r.reason?.code === 'wrong-chain');
    if (wrongChain !== undefined) throw wrongChain.reason;
    const usable = targets.filter((conn, i) => {
      const r = chains[i];
      if (r.status === 'fulfilled') return true;
      errors.push({ server: conn.url, message: r.reason?.message ?? String(r.reason) });
      if (r.reason instanceof TransportError && conn === active) drop(active, r.reason);
      return false;
    });
    const settled = await Promise.allSettled(usable.map((conn) => conn.request('blockchain.transaction.broadcast', [checked.hex])));
    const acceptedBy = [];
    let alreadyKnown = false;
    settled.forEach((r, i) => {
      const server = usable[i].url;
      if (r.status === 'fulfilled') {
        if (typeof r.value === 'string' && r.value.toLowerCase() === checked.txid) acceptedBy.push(server);
        else errors.push({ server, message: `answered ${JSON.stringify(r.value)} instead of the txid` });
      } else if (r.reason instanceof RpcError && ALREADY_KNOWN.test(r.reason.message)) {
        alreadyKnown = true;
        acceptedBy.push(server);
      } else {
        errors.push({ server, message: r.reason?.message ?? String(r.reason) });
        if (r.reason instanceof TransportError && usable[i] === active) drop(active, r.reason);
      }
    });
    if (acceptedBy.length > 0) return { txid: checked.txid, acceptedBy, alreadyKnown, errors };
    // A server may already have it (for example a retry after a lost answer).
    try {
      const known = await call('blockchain.transaction.get', [checked.txid]);
      if (typeof known === 'string' && known.toLowerCase() === checked.hex) {
        return { txid: checked.txid, acceptedBy: [], alreadyKnown: true, errors };
      }
    } catch {
      // fall through to the refusal
    }
    throw new BroadcastError('refused', errors.map((e) => e.message).join(' | ') || 'no server accepted the transaction', { errors, txid: checked.txid });
  };

  const close = () => {
    closed = true;
    stopPing();
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    headerListeners.clear();
    scripthashListeners.clear();
    active?.close();
    active = null;
    for (const conn of extras.values()) conn.close();
    extras.clear();
  };

  const status = () => ({
    network,
    active: active?.url ?? null,
    serverVersion: active?.serverVersion ?? null,
    tip: lastHeader,
    servers: list.map((s) => ({ ...s, coolingDown: cooldown.get(s.url) > Date.now() })),
  });

  return {
    network,
    allowBroadcast,
    connect: () => connect().then((c) => c.url),
    request,
    tip,
    subscribeHeaders,
    subscribeScripthash,
    broadcastChecked,
    status,
    close,
  };
};
