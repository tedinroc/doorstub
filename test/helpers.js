// Test fixtures: fresh, never-funded keys and made-up outpoints only.
import { encodeTransaction, generatePrivateKey, hashTransactionUiOrder } from '@bitauth/libauth';
import { buildGenesis, describeResult, evaluateTransaction, p2pkhLockingBytecode } from '../src/tx/index.js';
import { pkhOf, publicKeyOf, signP2pkhInputs } from '../src/tx/sign.js';

export const freshKey = () => {
  const privateKey = generatePrivateKey();
  return { privateKey, publicKey: publicKeyOf(privateKey), pkh: pkhOf(privateKey) };
};

export const randomTxid = () => crypto.getRandomValues(new Uint8Array(32));

/** A made-up plain coin at P2PKH(pkh). */
export const fakeCoin = (pkh, valueSatoshis, vout = 0) => ({
  txid: randomTxid(),
  vout,
  output: { lockingBytecode: p2pkhLockingBytecode(pkh), valueSatoshis: BigInt(valueSatoshis) },
});

export const txidOf = (transaction) => hashTransactionUiOrder(encodeTransaction(transaction));

/** The UTXO created at `vout` by `transaction`. */
export const utxoAt = (transaction, vout) => ({ txid: txidOf(transaction), vout, output: transaction.outputs[vout] });

/** Assert a built transaction is valid in the 2026 VM in both standard and consensus mode. */
export const assertValid = (assert, resolved, label = 'transaction') => {
  const result = evaluateTransaction(resolved);
  assert.equal(describeResult(result), 'ok', `${label} should be valid`);
  assert.equal(result.standard.ok, true);
  assert.equal(result.consensus.ok, true);
  return result;
};

export const signWallet = (built, privateKey) => ({
  transaction: signP2pkhInputs({
    transaction: built.transaction,
    sourceOutputs: built.sourceOutputs,
    inputIndexes: built.walletInputIndexes,
    privateKey,
  }),
  sourceOutputs: built.sourceOutputs,
});

/** Parameters of a sample show (category is set at genesis). */
export const sampleShowParams = (organiser, dataKey, overrides = {}) => ({
  price: 10_000n,
  organiserPk: organiser.publicKey,
  organiserPkh: organiser.pkh,
  organiserDataPk: dataKey.publicKey,
  startHeight: 930_000,
  graceBlocks: 144,
  handBackFeeBps: 0,
  noShowFeeBps: 0,
  minerFeeCap: 5_000n,
  ...overrides,
});

/** Build, sign (test key) and check a genesis; returns the show and its shard coins. */
export const makeShow = (assert, { shards = 4, overrides = {} } = {}) => {
  const organiser = freshKey();
  const dataKey = freshKey();
  const genesis = buildGenesis({
    show: sampleShowParams(organiser, dataKey, overrides),
    shards,
    fundingUtxos: [fakeCoin(organiser.pkh, 100_000)],
    changeLockingBytecode: p2pkhLockingBytecode(organiser.pkh),
  });
  const signed = signWallet(genesis, organiser.privateKey);
  assertValid(assert, signed, 'genesis');
  const shardUtxos = Array.from({ length: shards }, (_, i) => utxoAt(signed.transaction, i));
  return { organiser, dataKey, genesis, signedGenesis: signed, show: genesis.show, contracts: genesis.contracts, shardUtxos };
};
