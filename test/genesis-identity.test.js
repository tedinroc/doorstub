// buildGenesis with an identity output at index 0 (for BCMR): the shards move
// to indexes 1..N, the default layout is unchanged, every transaction is valid
// in the 2026 VM in both modes, and verifyGenesis accepts it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBuy, buildGenesis, decodeBoxOfficeCommitment, p2pkhLockingBytecode, sameBytes, verifyGenesis } from '../src/tx/index.js';
import { assertValid, fakeCoin, freshKey, saleHeight, sampleShowParams, signWallet, utxoAt } from './helpers.js';

test('genesis with an identity output: output 0 is a plain 1,000-sat coin to the identity key, shards follow', () => {
  const organiser = freshKey();
  const identity = freshKey();
  const built = buildGenesis({
    show: sampleShowParams(organiser, freshKey()),
    shards: 3,
    fundingUtxos: [fakeCoin(organiser.pkh, 50_000)],
    changeLockingBytecode: p2pkhLockingBytecode(organiser.pkh),
    identityLockingBytecode: p2pkhLockingBytecode(identity.pkh),
  });
  assert.deepEqual(built.shardVouts, [1, 2, 3]);
  const signed = signWallet(built, organiser.privateKey);
  assertValid(assert, signed, 'genesis with identity output');
  const [first, ...rest] = signed.transaction.outputs;
  assert.ok(sameBytes(first.lockingBytecode, p2pkhLockingBytecode(identity.pkh)));
  assert.equal(first.valueSatoshis, 1000n);
  assert.equal(first.token, undefined);
  rest.slice(0, 3).forEach((out, shard) => assert.deepEqual(decodeBoxOfficeCommitment(out.token.nft.commitment), { open: true, shard, sold: 0 }));
  const verified = verifyGenesis({ show: built.show, transaction: signed.transaction });
  assert.deepEqual(verified.shards, [{ vout: 1, shard: 0 }, { vout: 2, shard: 1 }, { vout: 3, shard: 2 }]);

  // A shard at index 1 sells like any other.
  const buyer = freshKey();
  const sale = buildBuy({ show: built.show, boxOfficeUtxo: utxoAt(signed.transaction, 1), fundingUtxos: [fakeCoin(buyer.pkh, 50_000)], buyerPkh: buyer.pkh, currentHeight: saleHeight(built.show) });
  assertValid(assert, signWallet(sale, buyer.privateKey), 'buy from a shard at index 1');
});

test('genesis without an identity output keeps the original layout', () => {
  const organiser = freshKey();
  const built = buildGenesis({
    show: sampleShowParams(organiser, freshKey()),
    shards: 2,
    fundingUtxos: [fakeCoin(organiser.pkh, 50_000)],
    changeLockingBytecode: p2pkhLockingBytecode(organiser.pkh),
  });
  assert.deepEqual(built.shardVouts, [0, 1]);
  assert.equal(built.transaction.outputs[0].token.nft.capability, 'minting');
});
