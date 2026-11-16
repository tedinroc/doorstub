// Capture real Fulcrum responses (READ-ONLY) so simnet and the chain client can
// pin their shapes: `node simnet/scripts/capture-fulcrum.js [wss://server]`.
// It can only call the methods in READ_ONLY; there is no broadcast path.
// Fixtures land in test/fixtures/fulcrum-live/, each { method, params, server,
// capturedAt, message } where `message` is the server's JSON envelope as sent.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { binToHex, cashAddressToLockingBytecode, decodeTransaction, hexToBin, lockingBytecodeToCashAddress, sha256 } from '@bitauth/libauth';
import { FULCRUM_SERVERS } from '../../probe/src/fulcrum.js';

const READ_ONLY = new Set([
  'server.version', 'server.features', 'server.ping', 'server.banner',
  'blockchain.headers.subscribe', 'blockchain.block.header', 'blockchain.relayfee', 'blockchain.estimatefee',
  'blockchain.transaction.get', 'blockchain.transaction.get_height', 'blockchain.transaction.id_from_pos',
  'blockchain.address.listunspent', 'blockchain.address.get_history', 'blockchain.address.get_mempool',
  'blockchain.address.get_balance', 'blockchain.address.subscribe', 'blockchain.address.get_scripthash',
  'blockchain.scripthash.listunspent', 'blockchain.scripthash.get_history', 'blockchain.scripthash.subscribe',
  'blockchain.scripthash.get_balance', 'blockchain.scripthash.get_mempool',
  'no.such.method',
]);

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', '..', 'test', 'fixtures', 'fulcrum-live');
const server = process.argv[2] ?? FULCRUM_SERVERS[3];
const capturedAt = new Date().toISOString();

const ws = new WebSocket(server);
await new Promise((resolve, reject) => {
  ws.once('open', resolve);
  ws.once('error', reject);
});
let nextId = 1;
const pending = new Map();
ws.on('message', (data) => {
  const parsed = JSON.parse(data.toString());
  for (const msg of Array.isArray(parsed) ? parsed : [parsed]) {
    const entry = pending.get(msg.id);
    if (entry) {
      pending.delete(msg.id);
      entry(msg);
    }
  }
});
const guard = (method) => {
  if (!READ_ONLY.has(method)) throw new Error(`capture refuses to call ${method}`);
};
const call = (method, params = []) => {
  guard(method);
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
};
const TIMEOUT_MS = 15_000;
const batch = (calls) => {
  calls.forEach(([method]) => guard(method));
  const ids = calls.map(() => nextId++);
  const results = ids.map(
    (id) =>
      new Promise((resolve) => {
        pending.set(id, resolve);
        setTimeout(() => {
          if (pending.delete(id)) resolve({ id, timeout: true });
        }, TIMEOUT_MS).unref();
      }),
  );
  ws.send(JSON.stringify(calls.map(([method, params], i) => ({ jsonrpc: '2.0', id: ids[i], method, params }))));
  return Promise.all(results);
};

mkdirSync(outDir, { recursive: true });
const MAX_ITEMS = 6;
const save = (name, method, params, message, note) => {
  let trimmedFrom;
  if (Array.isArray(message.result) && message.result.length > MAX_ITEMS) {
    trimmedFrom = message.result.length;
    message = { ...message, result: message.result.slice(0, MAX_ITEMS) };
  }
  const body = { method, params, server, capturedAt, ...(note ? { note } : {}), ...(trimmedFrom ? { trimmedFrom } : {}), message };
  writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify(body, null, 2)}\n`);
  console.log(`saved ${name}`);
};
const capture = async (name, method, params = [], note) => {
  const message = await call(method, params);
  save(name, method, params, message, note);
  return message;
};
const scripthashOf = (address) => {
  const decoded = cashAddressToLockingBytecode(address);
  return binToHex(sha256.hash(decoded.bytecode).slice().reverse());
};

await capture('server.version', 'server.version', ['Doorstub fixture capture', '1.5']);
await capture('server.features', 'server.features');
await capture('server.ping', 'server.ping');
const tipMsg = await capture('blockchain.headers.subscribe', 'blockchain.headers.subscribe');
const tip = tipMsg.result.height;
await capture('blockchain.block.header', 'blockchain.block.header', [tip - 1]);
await capture('error.block.header.out-of-range', 'blockchain.block.header', [tip + 1000]);
await capture('error.unknown-method', 'no.such.method', []);
await capture('blockchain.relayfee', 'blockchain.relayfee');
await capture('blockchain.estimatefee', 'blockchain.estimatefee', [2]);
await capture('error.transaction.get.unknown', 'blockchain.transaction.get', ['00'.repeat(32)]);
await capture('error.transaction.get.bad-hex', 'blockchain.transaction.get', ['xyz']);
await capture('error.transaction.get_height.unknown', 'blockchain.transaction.get_height', ['00'.repeat(32)]);
await capture('error.address.invalid', 'blockchain.address.listunspent', ['bitcoincash:qnotanaddress']);

// Find recent token transactions to pin token_data shapes.
const candidates = [];
for (let height = tip; height > tip - 4 && candidates.length < 60; height -= 1) {
  const ids = await batch(Array.from({ length: 200 }, (_, i) => ['blockchain.transaction.id_from_pos', [height, i + 1]]));
  const txids = ids.filter((m) => typeof m.result === 'string').map((m) => m.result);
  const raws = await batch(txids.map((txid) => ['blockchain.transaction.get', [txid]]));
  raws.forEach((m, i) => {
    if (typeof m.result !== 'string') return;
    const tx = decodeTransaction(hexToBin(m.result));
    tx.outputs.forEach((output, vout) => {
      if (output.token === undefined) return;
      const encoded = lockingBytecodeToCashAddress({ bytecode: output.lockingBytecode, prefix: 'bitcoincash', tokenSupport: true });
      candidates.push({ height, txid: txids[i], vout, address: encoded.address, token: output.token, p2pkh: output.lockingBytecode.length === 25 });
    });
  });
}
console.log(`found ${candidates.length} token outputs`);
const nftWithCommitment = candidates.find((c) => c.token.nft && c.token.nft.commitment.length > 0 && c.token.amount === 0n);
const fungible = candidates.find((c) => c.token.amount > 0n && c.token.nft === undefined);
const p2pkhToken = candidates.find((c) => c.p2pkh);

if (nftWithCommitment) {
  await capture('blockchain.transaction.get.raw-token', 'blockchain.transaction.get', [nftWithCommitment.txid]);
  await capture('blockchain.transaction.get.verbose-token', 'blockchain.transaction.get', [nftWithCommitment.txid, true]);
  await capture('blockchain.transaction.get_height', 'blockchain.transaction.get_height', [nftWithCommitment.txid]);
}

// A P2PKH token address with a small history: listunspent with each token filter.
const smallAddresses = [];
const tried = new Set();
for (const c of candidates.filter((x) => x.p2pkh)) {
  if (tried.has(c.address) || tried.size >= 25) continue;
  tried.add(c.address);
  const [history, unspent] = await batch([
    ['blockchain.address.get_history', [c.address]],
    ['blockchain.address.listunspent', [c.address, 'include_tokens']],
  ]);
  const small = Array.isArray(history.result) && history.result.length <= 30;
  const holds = Array.isArray(unspent.result) && unspent.result.some((u) => u.token_data !== undefined);
  if (small && holds) smallAddresses.push({ ...c, historyLength: history.result.length });
  if (smallAddresses.length >= 3) break;
}
const tokenAddress = smallAddresses[0] ?? p2pkhToken;
if (tokenAddress) {
  const a = tokenAddress.address;
  await capture('blockchain.address.listunspent.include_tokens', 'blockchain.address.listunspent', [a, 'include_tokens']);
  await capture('blockchain.address.listunspent.default', 'blockchain.address.listunspent', [a]);
  await capture('blockchain.address.listunspent.tokens_only', 'blockchain.address.listunspent', [a, 'tokens_only']);
  await capture('blockchain.address.listunspent.exclude_tokens', 'blockchain.address.listunspent', [a, 'exclude_tokens']);
  await capture('blockchain.address.get_history', 'blockchain.address.get_history', [a]);
  await capture('blockchain.address.get_balance', 'blockchain.address.get_balance', [a]);
  await capture('blockchain.address.subscribe', 'blockchain.address.subscribe', [a]);
  await capture('blockchain.address.get_scripthash', 'blockchain.address.get_scripthash', [a]);
  const sh = scripthashOf(a);
  await capture('blockchain.scripthash.listunspent.include_tokens', 'blockchain.scripthash.listunspent', [sh, 'include_tokens']);
  await capture('blockchain.scripthash.get_history', 'blockchain.scripthash.get_history', [sh]);
  await capture('blockchain.scripthash.subscribe', 'blockchain.scripthash.subscribe', [sh]);
  // The non-token-aware form of the same address must answer the same.
  const plain = lockingBytecodeToCashAddress({ bytecode: cashAddressToLockingBytecode(a).bytecode, prefix: 'bitcoincash', tokenSupport: false }).address;
  await capture('blockchain.address.listunspent.plain-form', 'blockchain.address.listunspent', [plain, 'include_tokens']);
  await capture('blockchain.address.listunspent.no-prefix', 'blockchain.address.listunspent', [plain.split(':')[1], 'include_tokens']);
}
if (fungible) {
  const f = fungible.address;
  await capture('blockchain.address.listunspent.fungible', 'blockchain.address.listunspent', [f, 'include_tokens'], 'address holding fungible tokens; trimmed');
  await capture('blockchain.address.listunspent.fungible-default', 'blockchain.address.listunspent', [f], 'same address, no token filter: Fulcrum defaults to exclude_tokens');
  await capture('blockchain.address.get_balance.include_tokens', 'blockchain.address.get_balance', [f, 'include_tokens']);
  await capture('blockchain.address.get_balance.default', 'blockchain.address.get_balance', [f], 'default excludes token coins');
  await capture('blockchain.address.get_history.range', 'blockchain.address.get_history', [f, tip - 20, tip - 1], 'protocol 1.5 from_height/to_height');
}
if (nftWithCommitment) {
  await capture('blockchain.address.listunspent.nft', 'blockchain.address.listunspent', [nftWithCommitment.address, 'tokens_only'], 'address holding NFTs with commitments; trimmed');
}

// Mempool shapes: look for any candidate address with unconfirmed activity.
let mempoolDone = false;
const seen = new Set();
for (let round = 0; round < 6 && !mempoolDone; round += 1) {
  for (const c of candidates) {
    if (seen.has(c.address) && round === 0) continue;
    seen.add(c.address);
    const m = await call('blockchain.address.get_mempool', [c.address]);
    if (Array.isArray(m.result) && m.result.length > 0) {
      save('blockchain.address.get_mempool', 'blockchain.address.get_mempool', [c.address], m);
      const sh = scripthashOf(c.address);
      const h = await call('blockchain.scripthash.get_history', [sh]);
      // Keep only the tail (the mempool entries are last).
      save('blockchain.scripthash.get_history.with-mempool', 'blockchain.scripthash.get_history', [sh], { ...h, result: Array.isArray(h.result) ? h.result.slice(-MAX_ITEMS) : h.result }, 'tail of the history, mempool entries last');
      const u = await call('blockchain.scripthash.listunspent', [sh, 'include_tokens']);
      save('blockchain.scripthash.listunspent.with-mempool', 'blockchain.scripthash.listunspent', [sh, 'include_tokens'], { ...u, result: Array.isArray(u.result) ? u.result.filter((x) => x.height <= 0).concat(u.result.filter((x) => x.height > 0).slice(0, 2)) : u.result }, 'mempool entries plus two confirmed');
      mempoolDone = true;
      break;
    }
  }
  if (!mempoolDone) await new Promise((r) => setTimeout(r, 5000));
}
if (!mempoolDone) console.log('no mempool activity found; mempool fixtures not refreshed');
ws.close();

// Before server.version negotiates protocol 1.5, Fulcrum answers as 1.4: the
// default token filter is then exclude_tokens (after 1.5 it is include_tokens).
if (fungible) {
  const legacy = new WebSocket(server);
  await new Promise((resolve, reject) => {
    legacy.once('open', resolve);
    legacy.once('error', reject);
  });
  const message = await new Promise((resolve) => {
    legacy.once('message', (data) => resolve(JSON.parse(data.toString())));
    legacy.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'blockchain.address.listunspent', params: [fungible.address] }));
  });
  save('blockchain.address.listunspent.fungible-default-protocol-1.4', 'blockchain.address.listunspent', [fungible.address], message, 'no server.version sent: protocol 1.4, token coins excluded by default');
  legacy.close();
}
process.exit(0);
