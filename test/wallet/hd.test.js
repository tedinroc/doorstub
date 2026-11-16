// xpub -> addresses (matching the wallet's own keys) and the gap-limit scan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFulcrumPool } from '../../src/chain/index.js';
import { WalletError, deriveWalletAddress, pathLookup, scanAddresses, scanWallet, walletKeysFromPaths } from '../../src/wallet/index.js';
import { randomTxid } from '../helpers.js';
import { makeFakeNetwork, makeMiniChain } from '../support/fake-fulcrum.js';
import { makeSimWallet } from '../support/sim-wallet.js';

const URL_A = 'wss://a.example:50004';
const poolOver = (chain) => {
  const net = makeFakeNetwork();
  net.addServer(URL_A, chain.handler);
  return { net, pool: createFulcrumPool({ network: 'simnet', servers: [URL_A], WebSocketImpl: net.WebSocketImpl, pingIntervalMs: 0 }) };
};

/** Pay `sats` to a sim wallet address on the mini chain (made-up input). */
const pay = (chain, address, sats, token) =>
  chain.add({
    version: 2,
    inputs: [{ outpointTransactionHash: randomTxid(), outpointIndex: 0, sequenceNumber: 0, unlockingBytecode: new Uint8Array() }],
    outputs: [{ lockingBytecode: address.lockingBytecode, valueSatoshis: BigInt(sats), ...(token && { token }) }],
    locktime: 0,
  });

test('walletKeysFromPaths: addresses from the xpubs equal the wallet\'s own keys', () => {
  const sim = makeSimWallet();
  const keys = walletKeysFromPaths(sim.paths());
  assert.equal(keys.network, 'mainnet');
  for (const [path, index] of [['receive', 0], ['receive', 7], ['change', 0], ['change', 3]]) {
    const mine = deriveWalletAddress(keys, path, index);
    const theirs = sim.addressAt(path, index);
    assert.equal(mine.tokenAddress, theirs.tokenAddress);
    assert.equal(mine.address, theirs.address);
    assert.deepEqual(mine.pkh, sim.pkhAt(path, index));
    assert.match(mine.tokenAddress, /^bitcoincash:z/);
  }
});

test('walletKeysFromPaths: refuses no receive xpub, bad xpubs, mixed networks; reports testnet', () => {
  const sim = makeSimWallet();
  const testnet = makeSimWallet({ xpubNetwork: 'testnet' });
  assert.throws(() => walletKeysFromPaths(sim.paths().filter((p) => p.name !== 'receive')), WalletError);
  assert.throws(() => walletKeysFromPaths([{ name: 'receive', xpub: 'xpubnope' }]), WalletError);
  assert.throws(() => walletKeysFromPaths([sim.paths()[0], testnet.paths()[1]]), /different networks/);
  assert.equal(walletKeysFromPaths(testnet.paths()).network, 'testnet');
  const receiveOnly = walletKeysFromPaths(sim.paths().filter((p) => p.name === 'receive'));
  assert.equal(receiveOnly.chains.change, undefined);
});

test('scanAddresses: gap 20, extends while used, finds first unused receive and change', async () => {
  const chain = makeMiniChain();
  const sim = makeSimWallet();
  pay(chain, sim.addressAt('receive', 0), 10_000);
  pay(chain, sim.addressAt('receive', 19), 10_000);
  pay(chain, sim.addressAt('receive', 33), 10_000);
  pay(chain, sim.addressAt('change', 2), 5_000);
  const { pool } = poolOver(chain);
  const keys = walletKeysFromPaths(sim.paths());
  const scan = await scanAddresses({ pool, keys });
  assert.deepEqual(scan.used.map((a) => `${a.path}/${a.index}`), ['receive/0', 'receive/19', 'receive/33', 'change/2']);
  assert.equal(scan.addresses.filter((a) => a.path === 'receive').length, 54, 'scanned 20 past the last used (33)');
  assert.equal(scan.addresses.filter((a) => a.path === 'change').length, 23);
  assert.equal(scan.receive.index, 34);
  assert.equal(scan.change.path, 'change');
  assert.equal(scan.change.index, 3);
  pool.close();
});

test('scanAddresses: a fresh wallet scans 20 + 20 and offers receive 0 / change 0', async () => {
  const chain = makeMiniChain();
  const sim = makeSimWallet();
  const { pool, net } = poolOver(chain);
  const scan = await scanAddresses({ pool, keys: walletKeysFromPaths(sim.paths()) });
  assert.equal(scan.used.length, 0);
  assert.equal(scan.receive.index, 0);
  assert.equal(scan.change.index, 0);
  assert.equal(net.servers.get(URL_A).calls.filter((c) => c.method === 'blockchain.scripthash.get_history').length, 40);
  const noChange = await scanAddresses({ pool, keys: walletKeysFromPaths(sim.paths().filter((p) => p.name === 'receive')) });
  assert.equal(noChange.change.path, 'receive', 'without a change xpub, change goes to a receive address');
  pool.close();
});

test('scanWallet: coins tagged with their path, plain and token coins apart, balance in plain sats', async () => {
  const chain = makeMiniChain();
  const sim = makeSimWallet();
  pay(chain, sim.addressAt('receive', 1), 30_000);
  pay(chain, sim.addressAt('change', 0), 12_000);
  pay(chain, sim.addressAt('receive', 1), 1_000, { amount: 0n, category: randomTxid(), nft: { capability: 'none', commitment: Uint8Array.of(1) } });
  const { pool } = poolOver(chain);
  const scan = await scanWallet({ pool, keys: walletKeysFromPaths(sim.paths()) });
  assert.equal(scan.utxos.length, 3);
  assert.equal(scan.plainCoins.length, 2);
  assert.equal(scan.tokenCoins.length, 1);
  assert.equal(scan.balance, 42_000n);
  const c = scan.plainCoins.find((u) => u.output.valueSatoshis === 12_000n);
  assert.equal(c.path, 'change');
  assert.equal(c.index, 0);
  const lookup = pathLookup(scan.addresses);
  assert.deepEqual(lookup(sim.addressAt('receive', 1).lockingBytecode), { path: 'receive', index: 1 });
  assert.equal(lookup(sim.addressAt('receive', 900).lockingBytecode), undefined);
  pool.close();
});
