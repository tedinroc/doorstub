// Coin selection: smallest plain-coin set, never token coins; buy built on top.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FundsError, buildBuyWithCoins, buyCost, selectCoins } from '../../src/wallet/index.js';
import { TOKEN_OUTPUT_SATS, evaluateTransaction, describeResult } from '../../src/tx/index.js';
import { fakeCoin, freshKey, makeShow, randomTxid, saleHeight, signWallet } from '../helpers.js';

const coin = (sats, token) => ({ ...fakeCoin(new Uint8Array(20), sats), ...(token && { output: { lockingBytecode: new Uint8Array(25), valueSatoshis: BigInt(sats), token } }) });
const values = (r) => r.selected.map((c) => c.output.valueSatoshis);
const nft = { amount: 0n, category: new Uint8Array(32), nft: { capability: 'none', commitment: Uint8Array.of(1) } };

test('selectCoins: one coin when one is enough, the smallest such coin', () => {
  const coins = [coin(5_000), coin(200_000), coin(120_000), coin(110_000)];
  assert.deepEqual(values(selectCoins(coins, 105_000n)), [110_000n]);
  assert.deepEqual(values(selectCoins(coins, 150_000n)), [200_000n]);
});

test('selectCoins: fewest coins first, then the least excess', () => {
  const coins = [coin(60_000), coin(50_000), coin(40_000), coin(10_000), coin(9_000)];
  assert.deepEqual(values(selectCoins(coins, 100_000n)), [60_000n, 40_000n]);
  assert.deepEqual(values(selectCoins(coins, 115_000n)), [60_000n, 50_000n, 9_000n]);
});

test('selectCoins: the need may grow with the coin count (fees per input)', () => {
  const coins = [coin(60_000), coin(45_000)];
  // 1 coin needs 100k (no), 2 coins need 104k: 105k works.
  const r = selectCoins(coins, (k) => 100_000n + 2_000n * BigInt(k));
  assert.equal(r.selected.length, 2);
  assert.equal(r.need, 104_000n);
});

test('selectCoins: token coins are never used; FundsError says need, have and token-only', () => {
  const tokenCoin = coin(500_000, nft);
  assert.throws(() => selectCoins([tokenCoin, coin(1_000)], 50_000n), (e) => {
    assert.ok(e instanceof FundsError);
    assert.equal(e.code, 'insufficient-funds');
    assert.equal(e.need, 50_000n);
    assert.equal(e.have, 1_000n);
    return true;
  });
  assert.throws(() => selectCoins([tokenCoin], 50_000n), (e) => e.code === 'only-token-coins' && e.tokenOnly);
  assert.throws(() => selectCoins([], 1n), (e) => e.code === 'insufficient-funds');
});

test('buyCost: price + two token outputs + the measured miner fee', () => {
  const { show, contracts, shardUtxos } = makeShow(assert);
  const buyer = freshKey();
  const args = { show, boxOfficeUtxo: shardUtxos[0], buyerPkh: buyer.pkh, currentHeight: saleHeight(show), contracts };
  const one = buyCost(args, 1);
  const two = buyCost(args, 2);
  assert.ok(one > BigInt(show.price) + 2n * TOKEN_OUTPUT_SATS + 800n && one < BigInt(show.price) + 2n * TOKEN_OUTPUT_SATS + 1_200n, `${one}`);
  assert.ok(two - one >= 140n && two - one <= 160n, 'about 149 bytes more per coin');
});

test('buildBuyWithCoins: pays from the smallest set and the signed buy passes the VM', () => {
  const { show, contracts, shardUtxos } = makeShow(assert);
  const buyer = freshKey();
  const at = (sats) => ({ ...fakeCoin(buyer.pkh, sats), path: 'receive', index: 0 });
  const coins = [at(3_000), at(9_000), at(7_000), { ...at(1_000), output: { ...at(1_000).output, token: { ...nft, category: randomTxid() } } }];
  const args = { show, boxOfficeUtxo: shardUtxos[0], buyerPkh: buyer.pkh, currentHeight: saleHeight(show), contracts };
  const { built, selected } = buildBuyWithCoins({ ...args, coins });
  assert.deepEqual(values({ selected }), [9_000n, 7_000n], 'two coins: 10,000 price + 2,000 + fee needs more than 9,000');
  assert.equal(built.walletInputIndexes.length, 2);
  assert.equal(selected[0].path, 'receive', 'path tags are kept for inputPaths');
  const result = evaluateTransaction(signWallet(built, buyer.privateKey));
  assert.equal(describeResult(result), 'ok');
  assert.throws(() => buildBuyWithCoins({ ...args, coins: [at(3_000)] }), FundsError);
  assert.throws(() => buildBuyWithCoins({ ...args, coins: [at(30_000)], currentHeight: Number(show.startHeight) }), (e) => e.code === 'sales-ended');
});
