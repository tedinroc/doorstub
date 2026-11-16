// Fulcrum pool over an in-memory WebSocket network: failover, timeouts,
// subscriptions across failover, the read-method allowlist, and
// broadcast-to-two that only takes checked transactions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hexToBin } from '@bitauth/libauth';
import {
  BroadcastError,
  PoolError,
  RpcError,
  TransportError,
  checkSignatureFree,
  checkTransaction,
  createFulcrumPool,
  isChecked,
  openElectrum,
  scripthashOf,
} from '../../src/chain/index.js';
import { buildSettle, p2pkhLockingBytecode } from '../../src/tx/index.js';
import { freshKey, randomTxid } from '../helpers.js';
import { makeFakeNetwork, makeMiniChain, rpcError } from '../support/fake-fulcrum.js';
import { buyOne } from '../support/scenario.js';

const A = 'wss://a.example:50004';
const B = 'wss://b.example:50004';
const C = 'wss://c.example:50004';
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const setup = ({ servers = [A, B, C], chain = makeMiniChain(), ...options } = {}) => {
  const net = makeFakeNetwork();
  for (const s of servers) net.addServer(typeof s === "string" ? s : s.url, chain.handler);
  const pool = createFulcrumPool({
    network: 'simnet',
    servers,
    WebSocketImpl: net.WebSocketImpl,
    pingIntervalMs: 0,
    connectTimeoutMs: 200,
    requestTimeoutMs: 200,
    raceWidth: 1,
    ...options,
  });
  return { net, pool, chain };
};

test('openElectrum: hello, request, RPC errors are RpcError, unknown ids ignored', async () => {
  const net = makeFakeNetwork();
  net.addServer(A, async (method) => {
    if (method === 'server.version') return ['Fulcrum test', '1.5'];
    if (method === 'boom') throw rpcError(2, 'daemon error');
    return 42;
  });
  const conn = await openElectrum(A, { WebSocketImpl: net.WebSocketImpl });
  assert.deepEqual(conn.serverVersion, ['Fulcrum test', '1.5']);
  assert.equal(await conn.request('x', []), 42);
  await assert.rejects(conn.request('boom', []), (e) => e instanceof RpcError && e.code === 2 && e.server === A);
  conn.close();
  await assert.rejects(conn.request('x', []), (e) => e instanceof TransportError && e.code === 'closed');
});

test('openElectrum: unreachable server and connect timeout are TransportErrors', async () => {
  const net = makeFakeNetwork();
  await assert.rejects(openElectrum(A, { WebSocketImpl: net.WebSocketImpl }), (e) => e instanceof TransportError && e.code === 'connect-failed');
  net.addServer(B, async () => null, { hangOnConnect: true });
  await assert.rejects(openElectrum(B, { WebSocketImpl: net.WebSocketImpl, connectTimeoutMs: 30 }), (e) => e.code === 'timeout');
});

test('pool: uses the first server that answers; fails over when it is down', async () => {
  const { net, pool } = setup();
  net.servers.get(A).down = true;
  assert.equal((await pool.tip()).height, 977_000);
  assert.equal(pool.status().active, B);
  pool.close();
});

test('pool: a request that times out moves to the next server and still answers', async () => {
  const { net, pool } = setup();
  await pool.connect();
  assert.equal(pool.status().active, A);
  net.servers.get(A).hang = (method) => method === 'blockchain.scripthash.get_history';
  const history = await pool.request('blockchain.scripthash.get_history', ['00'.repeat(32)]);
  assert.deepEqual(history, []);
  assert.equal(pool.status().active, B);
  assert.ok(pool.status().servers.find((s) => s.url === A).coolingDown);
  pool.close();
});

test('pool: all servers down is a TransportError all-down', async () => {
  const { net, pool } = setup();
  for (const url of [A, B, C]) net.servers.get(url).down = true;
  await assert.rejects(pool.tip(), (e) => e instanceof TransportError && e.code === 'all-down');
  pool.close();
});

test('pool: RPC errors are answers, not failovers', async () => {
  const { pool } = setup();
  await assert.rejects(pool.request('blockchain.transaction.get', ['ab'.repeat(32)]), (e) => e instanceof RpcError && e.code === 2);
  assert.equal(pool.status().active, A);
  pool.close();
});

test('pool: only read methods pass; broadcast and subscribe are refused; simnet.* only on the simnet', async () => {
  const { pool } = setup();
  for (const method of ['blockchain.transaction.broadcast', 'blockchain.scripthash.subscribe', 'blockchain.headers.subscribe', 'anything']) {
    await assert.rejects(pool.request(method, []), (e) => e instanceof PoolError && e.code === 'method-not-allowed');
  }
  await assert.rejects(pool.request('simnet.mine', [1]), RpcError, 'simnet.* goes through on the simnet');
  pool.close();
  const mainnet = createFulcrumPool({ network: 'mainnet', WebSocketImpl: makeFakeNetwork().WebSocketImpl, pingIntervalMs: 0 });
  await assert.rejects(mainnet.request('simnet.mine', [1]), (e) => e.code === 'method-not-allowed');
  mainnet.close();
  assert.throws(() => createFulcrumPool({ network: 'simnet' }), (e) => e.code === 'no-servers');
  assert.throws(() => createFulcrumPool({ network: 'testnet', servers: [A] }), (e) => e.code === 'bad-network');
});

test('pool: header notifications reach subscribers; subscriptions survive a failover', async () => {
  const { net, pool, chain } = setup();
  const seen = [];
  pool.subscribeHeaders((h) => seen.push(h.height));
  await tick(20);
  assert.deepEqual(seen, [977_000]);
  net.push(A, 'blockchain.headers.subscribe', [{ height: 977_001, hex: '00'.repeat(80) }]);
  await tick();
  assert.deepEqual(seen, [977_000, 977_001]);
  assert.equal((await pool.tip()).height, 977_001, 'tip comes from the live subscription');

  const payee = freshKey();
  const sh = scripthashOf(p2pkhLockingBytecode(payee.pkh));
  const statuses = [];
  pool.subscribeScripthash(sh, (s) => statuses.push(s));
  await tick(20);
  assert.deepEqual(statuses, [null]);

  // While A is down, the chain moves on and a coin arrives at the address.
  net.kill(A);
  chain.mine(1);
  chain.add({ version: 2, inputs: [{ outpointTransactionHash: randomTxid(), outpointIndex: 0, sequenceNumber: 0, unlockingBytecode: new Uint8Array() }], outputs: [{ lockingBytecode: p2pkhLockingBytecode(payee.pkh), valueSatoshis: 5_000n }], locktime: 0 });
  await tick(50);
  assert.equal(pool.status().active, B, 'reconnected to B on its own');
  assert.equal(seen.at(-1), 977_001, 'resubscribed headers and got the new tip from B');
  assert.equal(statuses.length, 2, 'resubscribed the script hash and reported its new status');
  assert.equal(statuses[1], chain.statusOf(sh));
  const calls = net.servers.get(B).calls.map((c) => c.method);
  assert.ok(calls.includes('blockchain.headers.subscribe'));
  assert.ok(calls.includes('blockchain.scripthash.subscribe'));
  net.push(B, 'blockchain.scripthash.subscribe', [sh, 'abcd']);
  await tick();
  assert.equal(statuses.at(-1), 'abcd');
  pool.close();
});

test('broadcastChecked: refuses anything that did not come out of a check', async () => {
  const { pool } = setup({ allowBroadcast: true });
  const fake = Object.freeze({ kind: 'buy', txid: 'ab'.repeat(32), hex: '0200' });
  await assert.rejects(pool.broadcastChecked(fake), (e) => e instanceof BroadcastError && e.code === 'not-checked');
  await assert.rejects(pool.broadcastChecked('0200000000'), (e) => e.code === 'not-checked');
  assert.equal(isChecked(fake), false);
  pool.close();
});

test('broadcastChecked: a read-only pool (the default) refuses even a checked transaction', async () => {
  const s = await settleScenario();
  const { pool } = setup({ chain: s.chain });
  await assert.rejects(pool.broadcastChecked(s.checked), (e) => e.code === 'broadcast-disabled');
  pool.close();
});

/** A settle of one sold ticket, checked in the VM (signature-free). */
const settleScenario = async () => {
  const chain = makeMiniChain();
  const sale = buyOne(assert, chain);
  const built = buildSettle({ show: sale.show, escrowUtxos: [sale.escrowUtxo] });
  return { chain, sale, built, checked: checkSignatureFree(built) };
};

test('broadcastChecked: sends to two servers of different operators; success returns the txid', async () => {
  const s = await settleScenario();
  const servers = [
    { url: A, operator: 'one' },
    { url: B, operator: 'one' },
    { url: C, operator: 'two' },
  ];
  const { net, pool } = setup({ servers, chain: s.chain, allowBroadcast: true });
  const result = await pool.broadcastChecked(s.checked);
  assert.equal(result.txid, s.checked.txid);
  const sentTo = [...net.servers.values()].filter((srv) => srv.calls.some((c) => c.method === 'blockchain.transaction.broadcast')).map((srv) => srv.url);
  assert.deepEqual(sentTo.sort(), [A, C], 'the second server is from another operator');
  // The first answer added it to the mini chain, so the second said "already known": still a success.
  assert.equal(result.acceptedBy.length, 2);
  assert.equal(result.alreadyKnown, true);
  assert.ok(s.chain.txs.has(s.checked.txid));
  pool.close();
});

test('broadcastChecked: both servers refuse -> BroadcastError with their words; conflicts are flagged', async () => {
  const s = await settleScenario();
  s.chain.onBroadcast(() => {
    throw rpcError(1, 'the transaction was rejected by network rules.\n\ntxn-mempool-conflict (code 18)');
  });
  const { pool } = setup({ chain: s.chain, allowBroadcast: true });
  await assert.rejects(pool.broadcastChecked(s.checked), (e) => {
    assert.ok(e instanceof BroadcastError);
    assert.equal(e.code, 'refused');
    assert.equal(e.conflict, true);
    assert.equal(e.errors.length, 2);
    assert.match(e.message, /txn-mempool-conflict/);
    return true;
  });
  pool.close();
});

test('broadcastChecked: an answer lost in transit still succeeds when a server has the transaction', async () => {
  const s = await settleScenario();
  s.chain.onBroadcast((hex) => {
    s.chain.add(hexToBin(hex), 0);
    throw rpcError(1, 'bad-txns-inputs-missingorspent');
  });
  const { pool } = setup({ chain: s.chain, allowBroadcast: true });
  const result = await pool.broadcastChecked(s.checked);
  assert.equal(result.txid, s.checked.txid);
  assert.equal(result.alreadyKnown, true);
  pool.close();
});

test('checkTransaction: refuses a transaction the VM refuses; brands only what passes', async () => {
  const s = await settleScenario();
  const early = { ...s.built.transaction, locktime: 0 };
  assert.throws(() => checkTransaction({ transaction: early, sourceOutputs: s.built.sourceOutputs, kind: 'settle' }), (e) => e.code === 'vm-invalid');
  assert.throws(() => checkTransaction({ transaction: s.built.transaction, sourceOutputs: [], kind: 'settle' }), (e) => e.code === 'bad-source-outputs');
  assert.throws(() => checkSignatureFree({ ...s.built, kind: 'buy' }), (e) => e.code === 'not-signature-free');
  assert.ok(isChecked(s.checked));
  assert.ok(Object.isFrozen(s.checked));
  assert.match(s.checked.txid, /^[0-9a-f]{64}$/);
});

test('pool: with live subscriptions it keeps retrying in the background until a server is back', async () => {
  const { net, pool } = setup({ servers: [A, B], reconnectBaseMs: 10 });
  const seen = [];
  pool.subscribeHeaders((h) => seen.push(h.height));
  await tick(20);
  assert.deepEqual(seen, [977_000]);
  net.servers.get(B).down = true;
  net.kill(A);
  await tick(30);
  assert.equal(pool.status().active, null, 'everything is down');
  // A comes back; the pool finds it on its own (backoff 20 ms, 40 ms, ... in this test).
  net.servers.get(A).down = false;
  await tick(300);
  assert.equal(pool.status().active, A);
  pool.close();
});
