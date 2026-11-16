// Pin the live Fulcrum response shapes (recorded read-only from mainnet by
// scripts/record-fulcrum-fixture.js) and our conversions to libauth types:
// every token_data in a listunspent answer must equal the token libauth
// decodes from the raw transaction at that output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { binToHex, cashAddressToLockingBytecode, decodeTransaction, hexToBin } from '@bitauth/libauth';
import {
  ShapeError,
  headerFromElectrum,
  historyFromElectrum,
  outpointKey,
  scripthashOf,
  tokenFromElectrum,
  tokenToElectrum,
  utxoFromElectrum,
  utxoToElectrum,
} from '../../src/chain/index.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/fulcrum-mainnet.json', import.meta.url), 'utf8'));
const calls = (method) => fixture.calls.filter((c) => c.method === method);
const rawTx = (txid) => calls('blockchain.transaction.get').find((c) => c.params[0] === txid)?.result;
const lockingOf = (address) => cashAddressToLockingBytecode(address).bytecode;

test('fixture: recorded from Fulcrum speaking protocol 1.5', () => {
  assert.match(fixture.serverVersion[0], /^Fulcrum 2\./);
  assert.equal(fixture.serverVersion[1], '1.5');
});

test('scripthash: sha256 of locking bytecode, reversed, equals the server\'s get_scripthash', () => {
  const c = calls('blockchain.address.get_scripthash')[0];
  assert.equal(scripthashOf(lockingOf(c.params[0])), c.result);
});

test('listunspent: every token_data equals the token libauth decodes from the raw transaction', () => {
  let tokens = 0;
  let nfts = 0;
  let plain = 0;
  for (const c of calls('blockchain.scripthash.listunspent')) {
    for (const item of c.result) {
      const raw = rawTx(item.tx_hash);
      if (raw === undefined) continue;
      const decoded = decodeTransaction(hexToBin(raw));
      assert.notEqual(typeof decoded, 'string');
      const onChain = decoded.outputs[item.tx_pos];
      const utxo = utxoFromElectrum(item, onChain.lockingBytecode);
      assert.equal(utxo.output.valueSatoshis, onChain.valueSatoshis, 'value');
      assert.deepEqual(utxo.output.token, onChain.token, `token of ${item.tx_hash}:${item.tx_pos}`);
      assert.equal(utxo.txidHex, item.tx_hash);
      assert.equal(binToHex(utxo.txid), item.tx_hash, 'txid stays in display order');
      assert.equal(utxo.confirmed, item.height > 0);
      // And back: what a server (or the simnet) must send for this output.
      assert.deepEqual(utxoToElectrum({ ...utxo, height: item.height }), item);
      if (onChain.token === undefined) plain += 1;
      else {
        tokens += 1;
        if (onChain.token.nft !== undefined) nfts += 1;
      }
    }
  }
  assert.ok(plain >= 1, 'a plain coin is pinned');
  assert.ok(nfts >= 3, 'NFT coins are pinned');
  assert.ok(tokens >= 3);
});

test('token_data: amount is a decimal string, category display order, empty commitment allowed', () => {
  const all = calls('blockchain.scripthash.listunspent').flatMap((c) => c.result).filter((u) => u.token_data);
  for (const u of all) assert.equal(typeof u.token_data.amount, 'string');
  const minting = all.find((u) => u.token_data.nft?.capability === 'minting');
  assert.equal(minting.token_data.nft.commitment, '');
  const t = tokenFromElectrum(minting.token_data);
  assert.deepEqual(t.nft, { capability: 'minting', commitment: new Uint8Array() });
  assert.equal(t.amount, 0n);
  const both = all.find((u) => u.token_data.nft !== undefined && u.token_data.amount !== '0');
  assert.ok(both, 'an FT + NFT coin is pinned');
  const tb = tokenFromElectrum(both.token_data);
  assert.equal(tb.amount, BigInt(both.token_data.amount));
  assert.equal(tb.nft.capability, 'mutable');
  assert.deepEqual(tokenToElectrum(tb), both.token_data);
});

test('token_data: refuses bad shapes', () => {
  assert.throws(() => tokenFromElectrum({ amount: '1', category: 'zz' }), ShapeError);
  assert.throws(() => tokenFromElectrum({ amount: '-1', category: '00'.repeat(32) }), ShapeError);
  assert.throws(() => tokenFromElectrum({ amount: '0', category: '00'.repeat(32), nft: { capability: 'owner', commitment: '' } }), ShapeError);
  assert.throws(() => tokenFromElectrum({ amount: '0', category: '00'.repeat(32), nft: { capability: 'none', commitment: 'abc' } }), ShapeError);
  assert.throws(() => utxoFromElectrum({ tx_hash: '00'.repeat(32), tx_pos: -1, height: 1, value: 1 }, new Uint8Array()), ShapeError);
  assert.throws(() => utxoFromElectrum({ tx_hash: '00'.repeat(32), tx_pos: 0, height: 1, value: 1.5 }, new Uint8Array()), ShapeError);
});

test('history, header and outpoint shapes', () => {
  const h = calls('blockchain.scripthash.get_history')[0].result;
  assert.ok(h.length > 0);
  for (const item of h) {
    const parsed = historyFromElectrum(item);
    assert.equal(parsed.txidHex, item.tx_hash);
    assert.equal(parsed.confirmed, item.height > 0);
  }
  // Unconfirmed entries carry height 0 (or -1) and a fee (Electrum protocol).
  assert.deepEqual(historyFromElectrum({ height: 0, tx_hash: 'ab'.repeat(32), fee: 300 }).fee, 300);
  const tip = calls('blockchain.headers.subscribe')[0].result;
  assert.deepEqual(headerFromElectrum(tip), tip);
  assert.equal(tip.hex.length, 160);
  assert.equal(calls('blockchain.block.header')[0].result.length, 160);
  assert.equal(calls('server.ping')[0].result, null);
  assert.equal(typeof calls('blockchain.transaction.get_height')[0].result, 'number');
  assert.equal(outpointKey(hexToBin('ab'.repeat(32)), 3), `${'ab'.repeat(32)}:3`);
});

test('error shapes: unknown transaction (code 2, daemon text) and unknown method (-32601)', () => {
  const missing = calls('blockchain.transaction.get').find((c) => c.error);
  assert.equal(missing.error.code, 2);
  assert.match(missing.error.message, /No such mempool or blockchain transaction/);
  const unknown = calls('blockchain.nosuch')[0];
  assert.equal(unknown.error.code, -32601);
});
