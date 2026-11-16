// Simnet speaks Fulcrum: response shapes, error codes and messages,
// notifications and the token-filter default are pinned against real mainnet
// Fulcrum answers saved in test/fixtures/fulcrum-live/ (refresh them with
// `npm run fixtures:fulcrum`, which is read-only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { binToHex, hexToBin, decodeTransaction } from '@bitauth/libauth';
import { p2pkhLockingBytecode } from '../../src/tx/index.js';
import { SimChain, scripthashOf } from '../../simnet/chain.js';
import { connectRpc } from '../../simnet/rpc.js';
import { sortedJson, startSimnet } from '../../simnet/server.js';
import { freshKey } from '../helpers.js';
import { addressOf, fundKey, openSimnet, refused, repoRoot } from './support.js';

const FIXTURES = join(repoRoot, 'test', 'fixtures', 'fulcrum-live');
const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
const live = (name) => fixture(name).message.result;

/** Type skeleton of a JSON value: what must match between Fulcrum and simnet. */
const shape = (value) => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length === 0 ? [] : [shape(value[0])];
  if (typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, shape(value[k])]));
  if (typeof value === 'string') return /^[0-9a-f]{64}$/.test(value) ? 'hex64' : 'string';
  return typeof value;
};

const statusOf = (history) =>
  history.length === 0 ? null : createHash('sha256').update(history.map((h) => `${h.tx_hash}:${h.height}:`).join('')).digest('hex');

const NFT_TOKEN = (category, commitment = '54000100' + '11'.repeat(20)) => ({ category, amount: '0', nft: { capability: 'none', commitment } });

test('Fulcrum writes every JSON object with sorted keys; simnet does the same', () => {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 30, `expected the live fixtures, found ${files.length}`);
  for (const file of files) {
    const { message } = JSON.parse(readFileSync(join(FIXTURES, file), 'utf8'));
    assert.equal(JSON.stringify(message), sortedJson(message), `${file} keeps Fulcrum's key order`);
  }
});

test('the Electrum status rule holds on live data: sha256 of "tx_hash:height:" over the history', () => {
  for (const [history, subscribe] of [
    ['blockchain.address.get_history', 'blockchain.address.subscribe'],
    ['blockchain.scripthash.get_history', 'blockchain.scripthash.subscribe'],
  ]) {
    assert.equal(fixture(history).params[0], fixture(subscribe).params[0]);
    assert.equal(statusOf(live(history)), live(subscribe));
  }
});

test('raw envelopes: results, errors and notifications are byte-for-byte in Fulcrum\'s layout', async (t) => {
  const { simnet } = await openSimnet(t);
  const ws = new WebSocket(simnet.url);
  t.after(() => ws.close());
  await new Promise((resolve) => ws.once('open', resolve));
  const frames = [];
  ws.on('message', (data) => frames.push(data.toString()));
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'server.ping', params: [] }));
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'no.such.method', params: [] }));
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'blockchain.headers.subscribe', params: [] }));
  ws.send(JSON.stringify([{ jsonrpc: '2.0', id: 10, method: 'server.ping' }, { jsonrpc: '2.0', id: 11, method: 'blockchain.relayfee' }]));
  ws.send('not json');
  const waitFor = async (count) => {
    for (let i = 0; i < 200 && frames.length < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(frames.length >= count, `expected ${count} frames, got ${frames.length}`);
  };
  await waitFor(5);
  simnet.chain.mine(1);
  await waitFor(6);
  assert.equal(frames[0], '{"id":7,"jsonrpc":"2.0","result":null}');
  assert.equal(frames[1], '{"error":{"code":-32601,"message":"Unsupported request: no.such.method"},"id":8,"jsonrpc":"2.0"}');
  assert.equal(fixture('error.unknown-method').message.error.message, 'Unsupported request: no.such.method');
  assert.match(frames[2], /^\{"id":9,"jsonrpc":"2\.0","result":\{"height":\d+,"hex":"[0-9a-f]{160}"\}\}$/);
  assert.equal(frames[3], '[{"id":10,"jsonrpc":"2.0","result":null},{"id":11,"jsonrpc":"2.0","result":0.00001}]');
  assert.equal(frames[4], '{"error":{"code":-32700,"message":"Parse error"},"id":null,"jsonrpc":"2.0"}');
  assert.match(frames[5], /^\{"jsonrpc":"2\.0","method":"blockchain\.headers\.subscribe","params":\[\{"height":\d+,"hex":"[0-9a-f]{160}"\}\]\}$/);
  assert.deepEqual(shape(JSON.parse(frames[5])), shape(fixture('notification.blockchain.headers.subscribe').message));
});

test('server and header methods match the live shapes', async (t) => {
  const { rpc } = await openSimnet(t);
  assert.deepEqual(shape(rpc.version), shape(live('server.version')));
  assert.equal(rpc.version[1], '1.5');
  assert.deepEqual(shape(await rpc.request('blockchain.headers.subscribe', [])), shape(live('blockchain.headers.subscribe')));
  const tip = (await rpc.request('blockchain.headers.subscribe', [])).height;
  const header = await rpc.request('blockchain.block.header', [tip]);
  assert.match(header, /^[0-9a-f]{160}$/);
  assert.match(live('blockchain.block.header'), /^[0-9a-f]{160}$/);
  assert.equal(await rpc.request('server.ping', []), live('server.ping'));
  assert.equal(await rpc.request('blockchain.relayfee', []), live('blockchain.relayfee'));
  assert.equal(await rpc.request('blockchain.estimatefee', [2]), live('blockchain.estimatefee'));
  const features = await rpc.request('server.features', []);
  const liveFeatures = live('server.features');
  for (const key of ['cashtokens', 'genesis_hash', 'hash_function', 'protocol_max', 'protocol_min', 'pruning', 'server_version']) {
    assert.ok(key in features, `server.features has ${key}`);
    assert.equal(typeof features[key], typeof liveFeatures[key]);
  }
  assert.notEqual(features.genesis_hash, liveFeatures.genesis_hash, 'simnet never claims the mainnet genesis');
});

test('errors carry Fulcrum\'s codes and messages', async (t) => {
  const { rpc } = await openSimnet(t);
  const tip = (await rpc.request('blockchain.headers.subscribe', [])).height;
  const same = async (name, promise, adapt = (m) => m) => {
    const expected = fixture(name).message.error;
    const error = await refused(assert, promise, /./, expected.code);
    assert.equal(error.message, adapt(expected.message));
  };
  const liveOutOfRange = fixture('error.block.header.out-of-range').params[0];
  await same('error.block.header.out-of-range', rpc.request('blockchain.block.header', [tip + 1000]), (m) => m.replace(String(liveOutOfRange), String(tip + 1000)));
  await same('error.address.invalid', rpc.request('blockchain.address.listunspent', ['bitcoincash:qnotanaddress']));
  await same('error.transaction.get.unknown', rpc.request('blockchain.transaction.get', ['00'.repeat(32)]));
  await same('error.transaction.get.bad-hex', rpc.request('blockchain.transaction.get', ['xyz']));
  await same('error.transaction.get_height.unknown', rpc.request('blockchain.transaction.get_height', ['00'.repeat(32)]));
  await same('error.unknown-method', rpc.request('no.such.method', []));
});

test('listunspent, history, mempool, balance and subscribe match the live shapes for plain, NFT and fungible coins', async (t) => {
  const { rpc } = await openSimnet(t);
  const key = freshKey();
  const lock = p2pkhLockingBytecode(key.pkh);
  const address = addressOf(lock, true);
  const category = 'ab'.repeat(32);
  await rpc.request('simnet.fund', { address, sats: 5_000, mine: true });
  await rpc.request('simnet.fund', { address, sats: 1_000, token: NFT_TOKEN(category), mine: true });
  await rpc.request('simnet.fund', { address, sats: 1_000, token: { category, amount: '20' } });
  const unspent = await rpc.request('blockchain.address.listunspent', [address, 'include_tokens']);
  assert.equal(unspent.length, 3);
  const [plain, nft, fungible] = unspent;
  assert.deepEqual(shape(plain), shape(live('blockchain.address.listunspent.fungible-default-protocol-1.4')[0]));
  assert.deepEqual(shape(nft), shape(live('blockchain.address.listunspent.nft')[0]));
  assert.deepEqual(shape(fungible), shape(live('blockchain.address.listunspent.include_tokens')[0]));
  assert.equal(fungible.height, 0, 'mempool coins are listed at height 0, last');
  const tokenItems = [nft, fungible, ...live('blockchain.address.listunspent.nft'), ...live('blockchain.address.listunspent.fungible')].filter((u) => u.token_data);
  assert.ok(tokenItems.length >= 4);
  for (const item of tokenItems) {
    assert.match(item.token_data.amount, /^[0-9]+$/, 'token amounts are decimal strings');
    if (item.token_data.nft) assert.match(item.token_data.nft.commitment, /^([0-9a-f]{2})*$/, 'commitments are hex');
  }
  assert.ok(plain.height > 0 && nft.height > plain.height);

  // Token filters.
  assert.equal((await rpc.request('blockchain.address.listunspent', [address, 'exclude_tokens'])).length, 1);
  assert.equal((await rpc.request('blockchain.address.listunspent', [address, 'tokens_only'])).length, 2);
  await refused(assert, rpc.request('blockchain.address.listunspent', [address, 'all']), /Invalid token filter/);

  // History: confirmed entries, then the mempool entry with its fee.
  const history = await rpc.request('blockchain.address.get_history', [address]);
  assert.deepEqual(shape(history[0]), shape(live('blockchain.address.get_history')[0]));
  const liveWithMempool = live('blockchain.scripthash.get_history.with-mempool');
  assert.deepEqual(shape(history[2]), shape(liveWithMempool[liveWithMempool.length - 1]));
  assert.equal(history[2].height, 0);
  assert.deepEqual(shape(await rpc.request('blockchain.address.get_mempool', [address])), shape(live('blockchain.address.get_mempool')));
  const ranged = await rpc.request('blockchain.address.get_history', [address, history[1].height, history[1].height + 1]);
  assert.deepEqual(ranged, [history[1]], 'from_height inclusive, to_height exclusive, no mempool');

  // Status and script hash forms agree with each other and with the rule.
  const scripthash = await rpc.request('blockchain.address.get_scripthash', [address]);
  assert.equal(scripthash, scripthashOf(lock));
  assert.deepEqual(await rpc.request('blockchain.scripthash.listunspent', [scripthash, 'include_tokens']), unspent);
  const status = await rpc.request('blockchain.scripthash.subscribe', [scripthash]);
  assert.equal(status, statusOf(history));
  assert.deepEqual(shape(status), shape(live('blockchain.scripthash.subscribe')));

  // Any spelling of the address: token-aware, plain, without prefix.
  const plainForm = addressOf(lock, false);
  for (const form of [plainForm, plainForm.split(':')[1], address.split(':')[1]]) {
    assert.deepEqual(await rpc.request('blockchain.address.listunspent', [form, 'include_tokens']), unspent, form);
  }

  // Balances: default and include_tokens count token coins' sats once 1.5 is negotiated.
  const liveBalance = live('blockchain.address.get_balance');
  const balance = await rpc.request('blockchain.address.get_balance', [address]);
  assert.deepEqual(shape(balance), shape(liveBalance));
  assert.deepEqual(balance, { confirmed: 6_000, unconfirmed: 1_000 });
  assert.deepEqual(await rpc.request('blockchain.address.get_balance', [address, 'exclude_tokens']), { confirmed: 5_000, unconfirmed: 0 });
  assert.equal(await rpc.request('blockchain.address.subscribe', [addressOf(lock, false)]), status);
  assert.equal(await rpc.request('blockchain.scripthash.subscribe', ['00'.repeat(32)]), null);
});

test('default token filter: exclude_tokens until server.version negotiates 1.5, as live Fulcrum does', async (t) => {
  const { simnet, rpc } = await openSimnet(t);
  const lock = p2pkhLockingBytecode(freshKey().pkh);
  const address = addressOf(lock, true);
  await rpc.request('simnet.fund', { address, sats: 5_000 });
  await rpc.request('simnet.fund', { address, sats: 1_000, token: NFT_TOKEN('cd'.repeat(32)) });
  assert.equal((await rpc.request('blockchain.address.listunspent', [address])).length, 2, '1.5: token coins included');
  const legacy = await connectRpc(simnet.url, { negotiate: false });
  t.after(() => legacy.close());
  assert.equal((await legacy.request('blockchain.address.listunspent', [address])).length, 1, '1.4: token coins hidden');
  assert.equal((await legacy.request('blockchain.address.listunspent', [address, 'include_tokens'])).length, 2);
  // The live pair this pins: the same address with and without negotiation.
  assert.ok(fixture('blockchain.address.listunspent.fungible-default-protocol-1.4').message.result.every((u) => u.token_data === undefined));
  assert.ok(fixture('blockchain.address.listunspent.fungible-default').message.result.some((u) => u.token_data !== undefined));
});

test('transaction.get: raw hex, BCHN-style verbose object, and get_height', async (t) => {
  const { rpc } = await openSimnet(t);
  const key = freshKey();
  const funded = await rpc.request('simnet.fund', { address: addressOf(p2pkhLockingBytecode(key.pkh), true), sats: 2_000, token: NFT_TOKEN('ef'.repeat(32)) });
  assert.equal(await rpc.request('blockchain.transaction.get_height', [funded.txid]), 0);
  const raw = await rpc.request('blockchain.transaction.get', [funded.txid]);
  assert.equal(typeof decodeTransaction(hexToBin(raw)), 'object');
  await rpc.request('simnet.mine', { blocks: 2 });
  const verbose = await rpc.request('blockchain.transaction.get', [funded.txid, true]);
  const liveVerbose = live('blockchain.transaction.get.verbose-token');
  const liveKeys = Object.keys(liveVerbose).filter((k) => k !== 'confirmations_ticks');
  assert.deepEqual(Object.keys(verbose).sort(), liveKeys.sort());
  assert.deepEqual(shape(verbose.vin[0]), shape(liveVerbose.vin[0]));
  const liveTokenOut = liveVerbose.vout.find((o) => o.tokenData?.nft);
  assert.deepEqual(Object.keys(verbose.vout[0]).sort(), Object.keys(liveTokenOut).sort());
  assert.deepEqual(Object.keys(verbose.vout[0].scriptPubKey).sort(), ['addresses', 'asm', 'hex', 'reqSigs', 'type']);
  assert.equal(verbose.vout[0].scriptPubKey.type, 'pubkeyhash');
  assert.equal(verbose.vout[0].value, 0.00002);
  assert.equal(verbose.confirmations, 2);
  assert.equal(verbose.hex, raw);
  const tip = (await rpc.request('blockchain.headers.subscribe', [])).height;
  assert.equal(await rpc.request('blockchain.transaction.get_height', [funded.txid]), tip - 1);
});

test('notifications: headers on mining, status by script hash or by address (the last subscribe wins), none after unsubscribe', async (t) => {
  const { simnet, rpc } = await openSimnet(t);
  const notes = [];
  rpc.onNotification((method, params) => notes.push({ method, params }));
  const keyA = freshKey();
  const keyB = freshKey();
  const shA = scripthashOf(p2pkhLockingBytecode(keyA.pkh));
  const addressB = addressOf(p2pkhLockingBytecode(keyB.pkh), false);
  await rpc.request('blockchain.headers.subscribe', []);
  assert.equal(await rpc.request('blockchain.scripthash.subscribe', [shA]), null);
  assert.equal(await rpc.request('blockchain.address.subscribe', [addressB]), null);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

  await fundKey(rpc, keyA, 3_000, { mine: false });
  await settle();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].method, 'blockchain.scripthash.subscribe');
  assert.deepEqual(notes[0].params, [shA, simnet.chain.status(shA)]);

  await fundKey(rpc, keyB, 3_000, { mine: false });
  await settle();
  assert.equal(notes[1].method, 'blockchain.address.subscribe');
  assert.equal(notes[1].params[0], addressB, 'the address as the client spelled it');
  assert.deepEqual(shape({ jsonrpc: '2.0', method: notes[1].method, params: notes[1].params }), shape(fixture('notification.blockchain.address.subscribe').message));

  notes.length = 0;
  await rpc.request('simnet.mine', { blocks: 1 });
  await settle();
  const methods = notes.map((n) => n.method).sort();
  assert.deepEqual(methods, ['blockchain.address.subscribe', 'blockchain.headers.subscribe', 'blockchain.scripthash.subscribe']);

  // Subscribing to A by address replaces the script hash subscription.
  const addressA = addressOf(p2pkhLockingBytecode(keyA.pkh), true);
  await rpc.request('blockchain.address.subscribe', [addressA]);
  notes.length = 0;
  await fundKey(rpc, keyA, 4_000, { mine: false });
  await settle();
  assert.deepEqual(notes.map((n) => [n.method, n.params[0]]), [['blockchain.address.subscribe', addressA]]);

  assert.equal(await rpc.request('blockchain.address.unsubscribe', [addressA]), true);
  assert.equal(await rpc.request('blockchain.headers.unsubscribe', []), true);
  notes.length = 0;
  await fundKey(rpc, keyA, 5_000, { mine: true });
  await settle();
  assert.deepEqual(notes, []);
});

test('deterministic for a seed; reset returns to the start', async (t) => {
  const a = new SimChain({ seed: 'same' });
  const b = new SimChain({ seed: 'same' });
  const lock = binToHex(p2pkhLockingBytecode(new Uint8Array(20).fill(7)));
  assert.equal(a.fund({ lockingBytecode: lock, sats: 1_000 }).txid, b.fund({ lockingBytecode: lock, sats: 1_000 }).txid);
  assert.equal(a.mine(3).hash, b.mine(3).hash);
  const other = new SimChain({ seed: 'other' });
  assert.notEqual(other.fund({ lockingBytecode: lock, sats: 1_000 }).txid, new SimChain({ seed: 'same' }).fund({ lockingBytecode: lock, sats: 1_000 }).txid);

  const simnet = await startSimnet({ port: 0, seed: 'reset-test', height: 500_000 });
  const rpc = await connectRpc(simnet.url);
  t.after(async () => {
    rpc.close();
    await simnet.close();
  });
  assert.equal((await rpc.request('blockchain.headers.subscribe', [])).height, 500_000);
  await rpc.request('simnet.fund', { lockingBytecode: lock, sats: 1_000, mine: true });
  const info = await rpc.request('simnet.info', {});
  assert.equal(info.height, 500_001);
  assert.equal(info.network, 'simnet');
  const reset = await rpc.request('simnet.reset', {});
  assert.equal(reset.height, 500_000);
  assert.deepEqual(await rpc.request('blockchain.scripthash.get_history', [scripthashOf(hexToBin(lock))]), []);
  assert.equal(info.genesisHash, reset.genesisHash);
});

test('transaction.subscribe: height now (null unknown, 0 in the mempool) and a notification when it confirms', async (t) => {
  const { rpc } = await openSimnet(t);
  const notes = [];
  rpc.onNotification((method, params) => notes.push({ method, params }));
  assert.equal(await rpc.request('blockchain.transaction.subscribe', ['11'.repeat(32)]), null);
  const funded = await fundKey(rpc, freshKey(), 3_000, { mine: false });
  const txid = binToHex(funded.txid);
  assert.equal(await rpc.request('blockchain.transaction.subscribe', [txid]), 0);
  const mined = await rpc.request('simnet.mine', { blocks: 1 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(notes.filter((n) => n.method === 'blockchain.transaction.subscribe'), [{ method: 'blockchain.transaction.subscribe', params: [txid, mined.height] }]);
  assert.equal(await rpc.request('blockchain.transaction.unsubscribe', [txid]), true);
});
