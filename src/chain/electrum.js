// One Electrum-protocol (Fulcrum) JSON-RPC connection over a WebSocket.
//
// Runs in the browser and in Node 22, both of which have a global WebSocket.
// Tests inject `WebSocketImpl` (an in-memory socket). Requests are pipelined
// over the one socket, so many concurrent queries cost one round trip.

export const CLIENT_NAME = 'Doorstub';
export const PROTOCOL_VERSION = '1.5';

/** The server answered, with an error object. Not retried on another server. */
export class RpcError extends Error {
  constructor({ code, message }, { server, method }) {
    super(typeof message === 'string' ? message : JSON.stringify(message));
    this.name = 'RpcError';
    this.code = code;
    this.server = server;
    this.method = method;
  }
}

/** The server did not answer (cannot connect, closed, timed out). Worth failing over. */
export class TransportError extends Error {
  constructor(code, message, { server, method } = {}) {
    super(message);
    this.name = 'TransportError';
    this.code = code;
    this.server = server;
    this.method = method;
  }
}

const decodeFrame = (data) => {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  return String(data);
};

/**
 * Open a connection and say hello (`server.version`).
 * Resolves to { url, serverVersion, request, close, closed, pending }.
 * `onNotification(method, params)` receives subscription pushes;
 * `onClose(reason)` fires once when the socket goes away (not after close()).
 */
export const openElectrum = (
  url,
  {
    WebSocketImpl = globalThis.WebSocket,
    connectTimeoutMs = 8_000,
    requestTimeoutMs = 12_000,
    clientName = CLIENT_NAME,
    protocolVersion = PROTOCOL_VERSION,
    onNotification = () => {},
    onClose = () => {},
  } = {},
) =>
  new Promise((resolve, reject) => {
    if (typeof WebSocketImpl !== 'function') {
      reject(new TransportError('no-websocket', 'this runtime has no WebSocket', { server: url }));
      return;
    }
    let socket;
    try {
      socket = new WebSocketImpl(url);
    } catch (e) {
      reject(new TransportError('connect-failed', `cannot open ${url}: ${e.message}`, { server: url }));
      return;
    }
    const pending = new Map();
    let nextId = 1;
    let opened = false;
    let closedByUs = false;
    let closed = false;

    const failAll = (error) => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      pending.clear();
    };

    const connectTimer = setTimeout(() => {
      if (opened) return;
      closed = true;
      try {
        socket.close();
      } catch {
        // ignore
      }
      reject(new TransportError('timeout', `${url} did not answer within ${connectTimeoutMs} ms`, { server: url }));
    }, connectTimeoutMs);

    const request = (method, params = [], { timeoutMs = requestTimeoutMs } = {}) => {
      if (closed) return Promise.reject(new TransportError('closed', `${url} is closed`, { server: url, method }));
      const id = nextId++;
      return new Promise((res, rej) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          rej(new TransportError('timeout', `${method} on ${url} timed out after ${timeoutMs} ms`, { server: url, method }));
        }, timeoutMs);
        pending.set(id, { resolve: res, reject: rej, timer, method });
        try {
          socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
        } catch (e) {
          clearTimeout(timer);
          pending.delete(id);
          rej(new TransportError('closed', `cannot send to ${url}: ${e.message}`, { server: url, method }));
        }
      });
    };

    const handleMessage = (msg) => {
      if (msg === null || typeof msg !== 'object') return;
      if (Array.isArray(msg)) {
        msg.forEach(handleMessage);
        return;
      }
      if (msg.id !== undefined && msg.id !== null && pending.has(msg.id)) {
        const entry = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error !== undefined && msg.error !== null) {
          entry.reject(new RpcError(typeof msg.error === 'object' ? msg.error : { code: 0, message: String(msg.error) }, { server: url, method: entry.method }));
        } else {
          entry.resolve(msg.result);
        }
        return;
      }
      if (typeof msg.method === 'string') {
        try {
          onNotification(msg.method, Array.isArray(msg.params) ? msg.params : []);
        } catch {
          // a listener's bug must not break the connection
        }
      }
    };

    socket.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(decodeFrame(event.data));
      } catch {
        return;
      }
      handleMessage(msg);
    };

    socket.onerror = () => {
      if (!opened) {
        clearTimeout(connectTimer);
        closed = true;
        reject(new TransportError('connect-failed', `cannot reach ${url}`, { server: url }));
      }
    };

    socket.onclose = () => {
      const wasClosed = closed;
      closed = true;
      clearTimeout(connectTimer);
      failAll(new TransportError('closed', `${url} closed the connection`, { server: url }));
      if (!opened) {
        reject(new TransportError('connect-failed', `cannot reach ${url}`, { server: url }));
        return;
      }
      if (!closedByUs && !wasClosed) onClose('closed');
    };

    socket.onopen = async () => {
      const connection = {
        url,
        serverVersion: null,
        request,
        get closed() {
          return closed;
        },
        get pending() {
          return pending.size;
        },
        close: () => {
          if (closed) return;
          closedByUs = true;
          closed = true;
          failAll(new TransportError('closed', `${url} closed by client`, { server: url }));
          try {
            socket.close();
          } catch {
            // ignore
          }
        },
      };
      try {
        connection.serverVersion = await request('server.version', [clientName, protocolVersion], { timeoutMs: connectTimeoutMs });
        opened = true;
        clearTimeout(connectTimer);
        resolve(connection);
      } catch (e) {
        clearTimeout(connectTimer);
        connection.close();
        reject(e instanceof TransportError ? e : new TransportError('handshake-failed', `${url} refused server.version: ${e.message}`, { server: url }));
      }
    };
  });
