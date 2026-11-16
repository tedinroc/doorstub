// NETWORK tests: read-only queries against public mainnet Fulcrum servers.
// Skipped unless DOORSTUB_NET=1:  DOORSTUB_NET=1 node --test test/chain/network.test.js
// The pool here is read-only (allowBroadcast false): it cannot send anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cashAddressToLockingBytecode } from '@bitauth/libauth';
import { MAINNET_SERVERS, createFulcrumPool, getHistory, getTransaction, listUnspent } from '../../src/chain/index.js';

const skip = process.env.DOORSTUB_NET !== '1' && 'set DOORSTUB_NET=1 to run network tests';
const fixture = JSON.parse(readFileSync(new URL('../fixtures/fulcrum-mainnet.json', import.meta.url), 'utf8'));

test('mainnet pool: tip, listunspent with tokens, history, hash-checked transaction', { skip, timeout: 60_000 }, async () => {
  const pool = createFulcrumPool({ network: 'mainnet', pingIntervalMs: 0 });
  try {
    const tip = await pool.tip();
    assert.ok(tip.height > 977_000);
    const locking = cashAddressToLockingBytecode(fixture.addresses.NFT_P2PKH).bytecode;
    const coins = await listUnspent(pool, locking);
    assert.ok(Array.isArray(coins));
    for (const c of coins) assert.equal(typeof c.output.valueSatoshis, 'bigint');
    const history = await getHistory(pool, locking);
    assert.ok(history.length > 0);
    const tx = await getTransaction(pool, history[0].txidHex);
    assert.equal(tx.txid, history[0].txidHex);
    await assert.rejects(pool.broadcastChecked({}), (e) => e.code === 'broadcast-disabled');
  } finally {
    pool.close();
  }
});

test('every listed mainnet server answers server.version', { skip, timeout: 90_000 }, async () => {
  const results = await Promise.all(
    MAINNET_SERVERS.map(async (s) => {
      const pool = createFulcrumPool({ network: 'mainnet', servers: [s], pingIntervalMs: 0, connectTimeoutMs: 15_000 });
      try {
        await pool.connect();
        return [s.url, pool.status().serverVersion?.[0] ?? '?'];
      } catch (e) {
        return [s.url, `DOWN: ${e.message}`];
      } finally {
        pool.close();
      }
    }),
  );
  const up = results.filter(([, v]) => !v.startsWith('DOWN'));
  assert.ok(up.length >= MAINNET_SERVERS.length - 2, JSON.stringify(results, null, 2));
});
