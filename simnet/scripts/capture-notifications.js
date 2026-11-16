// Capture real Fulcrum notification envelopes (READ-ONLY): subscribes to
// headers and to a busy address taken from the mempool fixture, waits for one
// notification of each (up to 20 minutes), and saves them under
// test/fixtures/fulcrum-live/. Subscriptions only; no broadcast path.
//
// It also subscribes to the same address by script hash first. Observed on
// 11/16 (Fulcrum 2.1.4): only the address notification ever arrives, so one
// connection holds one subscription per script hash and the last subscribe
// call decides its form. simnet does the same.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { binToHex, cashAddressToLockingBytecode, sha256 } from '@bitauth/libauth';
import { FULCRUM_SERVERS } from '../../probe/src/fulcrum.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', '..', 'test', 'fixtures', 'fulcrum-live');
const server = process.argv[2] ?? FULCRUM_SERVERS[3];
const busy = JSON.parse(readFileSync(join(outDir, 'blockchain.address.get_mempool.json'), 'utf8')).params[0];
const scripthash = binToHex(sha256.hash(cashAddressToLockingBytecode(busy).bytecode).slice().reverse());

const ws = new WebSocket(server);
await new Promise((resolve, reject) => {
  ws.once('open', resolve);
  ws.once('error', reject);
});
const wanted = new Set(['blockchain.headers.subscribe', 'blockchain.address.subscribe']);
const deadline = setTimeout(() => {
  console.log(`timed out; still waiting for ${[...wanted].join(', ')}`);
  process.exit(0);
}, 20 * 60_000);
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.method === undefined || !wanted.has(msg.method)) return;
  wanted.delete(msg.method);
  const body = { method: msg.method, server, capturedAt: new Date().toISOString(), note: 'server notification (no id)', message: msg };
  writeFileSync(join(outDir, `notification.${msg.method}.json`), `${JSON.stringify(body, null, 2)}\n`);
  console.log(`saved notification ${msg.method}`);
  if (wanted.size === 0) {
    clearTimeout(deadline);
    ws.close();
    process.exit(0);
  }
});
const send = (id, method, params) => ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
send(1, 'server.version', ['Doorstub fixture capture', '1.5']);
send(2, 'blockchain.headers.subscribe', []);
send(3, 'blockchain.scripthash.subscribe', [scripthash]);
send(4, 'blockchain.address.subscribe', [busy]);
console.log(`waiting for notifications from ${server}`);
