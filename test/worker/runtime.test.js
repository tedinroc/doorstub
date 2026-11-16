// What may run inside Cloudflare's workerd: nothing reachable from the Pages
// Functions route or the cron Worker may import libauth (it instantiates
// WebAssembly from bytes, which workerd refuses; worker/RUNTIME.md) or any
// node: module. Plus the chain client's guards, on an in-memory network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALREADY_KNOWN as POOL_ALREADY_KNOWN, CONFLICT as POOL_CONFLICT, MAINNET_SERVERS } from '../../src/chain/index.js';
import { makeFakeNetwork } from '../support/fake-fulcrum.js';
import { ALREADY_KNOWN, CONFLICT, createWorkerChain } from '../../worker/lib/chain.js';
import { workerConfig } from '../../worker/lib/config.js';
import { vet } from '../../worker/lib/rules.js';
import { encodeMarkerCommitment } from '../../src/tx/index.js';
import { freshKey, makeShow, randomTxid } from '../helpers.js';
import { bytesToHex } from '../../worker/lib/bytes.js';
import { assembleSettle } from '../../worker/lib/escrow.js';
import { boxOfficeScripts, escrowScripts } from '../../worker/lib/script.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Every file reachable by static or dynamic import from `entry` (relative imports followed, packages listed). */
const importGraph = (entry) => {
  const files = new Set();
  const packages = new Set();
  const visit = (file) => {
    if (files.has(file)) return;
    files.add(file);
    const source = readFileSync(file, 'utf8');
    for (const m of source.matchAll(/(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|^import\s+['"]([^'"]+)['"]/gm)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (spec.startsWith('.')) visit(resolve(dirname(file), spec));
      else packages.add(spec);
    }
  };
  visit(entry);
  return { files: [...files].map((f) => f.slice(root.length + 1)), packages: [...packages] };
};

test('workerd entry points import no libauth and no node: modules', () => {
  for (const entry of ['functions/api/[[route]].js', 'worker/cron.js']) {
    const { files, packages } = importGraph(join(root, entry));
    assert.ok(files.includes('worker/lib/keeper.js') || files.includes('worker/lib/api.js'), `${entry} reaches the worker library`);
    assert.deepEqual(
      packages.filter((p) => !p.startsWith('@noble/')),
      [],
      `${entry} imports only @noble/* packages (got ${packages.join(', ')})`,
    );
    assert.ok(!files.some((f) => f.startsWith('worker/node/')), `${entry} does not reach the Node adapter`);
    for (const f of files) assert.ok(!/@bitauth\/libauth/.test(readFileSync(join(root, f), 'utf8').replace(/^\s*\/\/.*$/gm, '')), `${f} mentions libauth outside comments`);
  }
});

test('chain client patterns match src/chain/pool.js', () => {
  assert.equal(ALREADY_KNOWN.source, POOL_ALREADY_KNOWN.source);
  assert.equal(CONFLICT.source, POOL_CONFLICT.source);
});

test('config: mainnet ignores any Fulcrum override; simnet needs one; secrets are checked', () => {
  const main = workerConfig({ DOORSTUB_FULCRUM: 'ws://127.0.0.1:1', STUDIO_DATA_KEY: '00'.repeat(32), DOOR_LINKS: '{"x":"http://insecure"}' });
  assert.equal(main.network, 'mainnet');
  assert.equal(main.servers, undefined);
  assert.equal(main.dataKey, null);
  assert.equal(main.doorLinks, null);
  assert.equal(main.errors.length, 2);
  const sim = workerConfig({ DOORSTUB_NETWORK: 'simnet', DOORSTUB_FULCRUM: 'ws://127.0.0.1:50021', STUDIO_DATA_KEY: '11'.repeat(32), DOOR_LINKS: '{"real-show":"https://example.invalid/join?s={seat}"}' });
  assert.deepEqual(sim.servers, ['ws://127.0.0.1:50021']);
  assert.equal(sim.dataKey.length, 32);
  assert.deepEqual(sim.doorLinks, { 'real-show': 'https://example.invalid/join?s={seat}' });
  assert.deepEqual(sim.errors, []);
  assert.equal(workerConfig({ DOORSTUB_NETWORK: 'testnet' }).network, 'mainnet');
});

test('chain client: mainnet always uses the fixed server list; broadcast takes only vetted transactions; a simnet worker refuses a mainnet server', async () => {
  const net = makeFakeNetwork();
  const calls = [];
  for (const s of MAINNET_SERVERS) {
    net.addServer(s.url, (method) => {
      calls.push({ url: s.url, method });
      if (method === 'server.version') return ['Fulcrum 2.1.4', '1.5'];
      if (method === 'blockchain.headers.subscribe') return { height: 977_700, hex: '00' };
      if (method === 'server.features') return { genesis_hash: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f' };
      throw Object.assign(new Error('unexpected'), { code: 1 });
    });
  }
  const chain = createWorkerChain({ network: 'mainnet', servers: ['ws://127.0.0.1:9'], WebSocketImpl: net.WebSocketImpl, random: () => 0.99 });
  assert.equal(await chain.tip(), 977_700);
  assert.ok(MAINNET_SERVERS.some((s) => s.url === calls[0].url), 'the given server list was ignored');
  await assert.rejects(chain.broadcast({ kind: 'settle', txid: '00', hex: '00' }), (e) => e.code === 'not-vetted');
  await assert.rejects(chain.request('blockchain.transaction.broadcast', ['00']), (e) => e.code === 'method-not-allowed');
  chain.close();

  // A simnet worker pointed at a server that serves mainnet sends nothing.
  const sim = createWorkerChain({ network: 'simnet', servers: [MAINNET_SERVERS[0].url], WebSocketImpl: net.WebSocketImpl });
  const vetted = vetFromScratch();
  await assert.rejects(sim.broadcast(vetted), (e) => e.code === 'wrong-chain');
  assert.ok(!calls.some((c) => c.method === 'blockchain.transaction.broadcast'), 'nothing was broadcast');
  sim.close();
});

/** A real vetted settle over a made-up coin, to exercise the broadcast guard. */
const vetFromScratch = () => {
  const { show, contracts } = makeShow(assert, { shards: 1, overrides: { startHeight: 1_000, graceBlocks: 2 } });
  const w = { ...show, startHeight: 1_000, graceBlocks: 2, categoryHex: bytesToHex(show.category) };
  w.escrow = escrowScripts(w);
  w.boxOffice = boxOfficeScripts(w, w.escrow.lockingBytecode);
  const pkh = freshKey().pkh;
  const seat = Uint8Array.of(0, 1, 0);
  const coin = {
    txid: randomTxid(),
    vout: 2,
    output: { lockingBytecode: contracts.escrow.lockingBytecode, valueSatoshis: 11_000n, token: { amount: 0n, category: show.category, nft: { capability: 'none', commitment: encodeMarkerCommitment(seat, pkh) } } },
    seat,
    buyerPkh: pkh,
  };
  const built = assembleSettle({ show: w, coins: [coin] });
  return vet({ show: w, kind: 'settle', transaction: built.transaction, sourceOutputs: built.sourceOutputs, tip: 1_002 });
};
