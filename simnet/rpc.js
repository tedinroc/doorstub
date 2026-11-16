// Minimal Electrum-protocol JSON-RPC client over WebSocket for Node (the `ws`
// package), used by the studio CLI and by simnet tests. The browser and the
// worker use the full chain client in src/chain instead.
//
// With readOnly: true it refuses blockchain.transaction.broadcast and every
// simnet.* control method before a byte is sent.
import WebSocket from 'ws';

const WRITE_METHODS = new Set(['blockchain.transaction.broadcast']);

export class RpcError extends Error {
  constructor(code, message, method) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.method = method;
  }
}

/**
 * Connect to one server and negotiate protocol 1.5 (unless negotiate: false).
 * Resolves to { url, version, request(method, params),
 * batch([[method, params], ...]), onNotification(fn), close() }.
 * `request` rejects with RpcError carrying the server's code and message.
 */
export const connectRpc = (url, { timeoutMs = 15_000, readOnly = false, clientName = 'Doorstub', protocol = '1.5', negotiate = true } = {}) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    const listeners = new Set();
    let nextId = 1;
    const connectTimer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`connect ${url} timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    const guard = (method) => {
      if (readOnly && (WRITE_METHODS.has(method) || method.startsWith('simnet.'))) {
        throw new Error(`read-only connection refuses ${method}`);
      }
    };

    const track = (id, method) =>
      new Promise((res, rej) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          rej(new Error(`${method} timed out after ${timeoutMs} ms (${url})`));
        }, timeoutMs);
        pending.set(id, { res, rej, timer, method });
      });

    const settle = (msg) => {
      const entry = pending.get(msg.id);
      if (entry === undefined) return;
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.rej(new RpcError(msg.error.code, msg.error.message, entry.method));
      else entry.res(msg.result);
    };

    ws.on('message', (data) => {
      let parsed;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }
      for (const msg of Array.isArray(parsed) ? parsed : [parsed]) {
        if (msg.id === undefined || msg.id === null) {
          if (typeof msg.method === 'string') for (const fn of listeners) fn(msg.method, msg.params);
        } else {
          settle(msg);
        }
      }
    });
    ws.on('close', () => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.rej(new Error(`${url} closed`));
      }
      pending.clear();
    });
    ws.once('error', (error) => {
      clearTimeout(connectTimer);
      reject(new Error(`cannot reach ${url}: ${error.message}`));
    });
    ws.once('open', async () => {
      clearTimeout(connectTimer);
      const request = (method, params = []) => {
        try {
          guard(method);
        } catch (error) {
          return Promise.reject(error);
        }
        const id = nextId++;
        const promise = track(id, method);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
        return promise;
      };
      const batch = (calls) => {
        try {
          calls.forEach(([method]) => guard(method));
        } catch (error) {
          return Promise.reject(error);
        }
        const ids = calls.map(() => nextId++);
        const promises = calls.map(([method], i) => track(ids[i], method));
        ws.send(JSON.stringify(calls.map(([method, params = []], i) => ({ jsonrpc: '2.0', id: ids[i], method, params }))));
        return Promise.all(promises);
      };
      const client = {
        url,
        request,
        batch,
        onNotification: (fn) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        close: () => ws.close(),
      };
      try {
        // Fulcrum treats a connection as protocol 1.4 (token coins hidden by
        // default) until server.version negotiates 1.5.
        if (negotiate) client.version = await request('server.version', [clientName, protocol]);
        resolve(client);
      } catch (error) {
        ws.terminate();
        reject(error);
      }
    });
  });
