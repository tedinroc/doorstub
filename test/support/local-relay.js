// A minimal local Nostr relay (NIP-01 subset) for WizardConnect tests and
// the simnet E2E, so the real dapp and wallet libraries can pair without the
// public relays. Loopback only; events live in memory.
//
//   const relay = await startLocalRelay();          // ws://127.0.0.1:<port>
//   createWalletSession({ relayUrls: [relay.url] }) // the pairing URI then names this relay
//   sim.pairOverRelay(links.uri)
//   await relay.close();
//
// Supports EVENT (stored, OK, fanned out to matching subscriptions), REQ
// (stored matches, then EOSE, then live events) and CLOSE. Filters: ids,
// authors, kinds, #<tag>, since, until, limit. Signatures are not checked
// here; the clients check them.
import { WebSocketServer } from 'ws';

const matches = (filter, event) => {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith('#') || !Array.isArray(values)) continue;
    const tag = key.slice(1);
    if (!event.tags.some((t) => t[0] === tag && values.includes(t[1]))) return false;
  }
  return true;
};

export const startLocalRelay = ({ port = 0, host = '127.0.0.1', maxEvents = 10_000 } = {}) =>
  new Promise((resolve, reject) => {
    const events = [];
    const server = new WebSocketServer({ port, host });
    const stats = { connections: 0, published: 0 };
    server.on('error', reject);
    server.on('connection', (socket) => {
      stats.connections += 1;
      const subs = new Map();
      const send = (msg) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
      };
      socket.on('message', (data) => {
        let msg;
        try {
          msg = JSON.parse(String(data));
        } catch {
          send(['NOTICE', 'invalid JSON']);
          return;
        }
        if (!Array.isArray(msg)) return;
        const [type, ...rest] = msg;
        if (type === 'EVENT') {
          const event = rest[0];
          if (event === null || typeof event !== 'object' || typeof event.id !== 'string') {
            send(['NOTICE', 'invalid event']);
            return;
          }
          if (!events.some((e) => e.id === event.id)) {
            events.push(event);
            if (events.length > maxEvents) events.shift();
            stats.published += 1;
            for (const client of server.clients) client.emit('doorstub-event', event);
          }
          send(['OK', event.id, true, '']);
        } else if (type === 'REQ') {
          const [subId, ...filters] = rest;
          subs.set(subId, filters);
          for (const filter of filters) {
            const found = events.filter((e) => matches(filter, e));
            const limited = filter.limit !== undefined ? found.slice(-filter.limit) : found;
            for (const e of limited) send(['EVENT', subId, e]);
          }
          send(['EOSE', subId]);
        } else if (type === 'CLOSE') {
          subs.delete(rest[0]);
          send(['CLOSED', rest[0], '']);
        }
      });
      socket.on('doorstub-event', (event) => {
        for (const [subId, filters] of subs) {
          if (filters.some((f) => matches(f, event))) send(['EVENT', subId, event]);
        }
      });
      socket.on('error', () => {});
    });
    server.on('listening', () => {
      const address = server.address();
      resolve({
        url: `ws://${host}:${address.port}`,
        port: address.port,
        stats,
        events,
        close: () =>
          new Promise((done) => {
            for (const client of server.clients) client.terminate();
            server.close(() => done());
          }),
      });
    });
  });
