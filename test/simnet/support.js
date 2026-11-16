// Shared helpers for simnet tests: start a simnet on a free port, connect,
// read coins back as builder UTXOs, and run a show's genesis on chain.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { binToHex, encodeTransaction, hexToBin, lockingBytecodeToCashAddress } from '@bitauth/libauth';
import { startSimnet } from '../../simnet/server.js';
import { connectRpc } from '../../simnet/rpc.js';
import { scripthashOf } from '../../simnet/chain.js';
import { buildGenesis, p2pkhLockingBytecode } from '../../src/tx/index.js';
import { signP2pkhInputs } from '../../src/tx/sign.js';
import { freshKey, sampleShowParams } from '../helpers.js';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A scratch directory under the repo's .cache (gitignored); removed by the returned cleanup. */
export const scratchDir = (prefix) => {
  mkdirSync(join(repoRoot, '.cache'), { recursive: true });
  const dir = mkdtempSync(join(repoRoot, '.cache', `${prefix}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
};

/** Start a simnet and one client; `t.after` closes both. */
export const openSimnet = async (t, options = {}) => {
  const simnet = await startSimnet({ port: 0, seed: options.seed ?? `test-${Math.random()}`, ...options });
  const rpc = await connectRpc(simnet.url, { timeoutMs: 5_000 });
  t.after(async () => {
    rpc.close();
    await simnet.close();
  });
  return { simnet, rpc, chain: simnet.chain };
};

export const toHex = (resolved) => binToHex(encodeTransaction(resolved.transaction));

export const addressOf = (lockingBytecode, tokenSupport = true) =>
  lockingBytecodeToCashAddress({ bytecode: lockingBytecode, prefix: 'bitcoincash', tokenSupport }).address;

const tokenFromData = (data) => {
  if (data === undefined) return undefined;
  const token = { amount: BigInt(data.amount), category: hexToBin(data.category) };
  if (data.nft) token.nft = { capability: data.nft.capability, commitment: hexToBin(data.nft.commitment) };
  return token;
};

/** listunspent (include_tokens) at a locking bytecode, as builder UTXOs. */
export const coinsAt = async (rpc, lockingBytecode) => {
  const items = await rpc.request('blockchain.scripthash.listunspent', [scripthashOf(lockingBytecode), 'include_tokens']);
  return items.map((item) => ({
    txid: hexToBin(item.tx_hash),
    vout: item.tx_pos,
    height: item.height,
    output: { lockingBytecode, valueSatoshis: BigInt(item.value), token: tokenFromData(item.token_data) },
  }));
};

/** Fund P2PKH(pkh) and return the coin as a builder UTXO. */
export const fundKey = async (rpc, key, sats, { mine = true } = {}) => {
  const lockingBytecode = p2pkhLockingBytecode(key.pkh);
  const funded = await rpc.request('simnet.fund', { address: addressOf(lockingBytecode, false), sats, mine });
  return { txid: hexToBin(funded.txid), vout: 0, output: { lockingBytecode, valueSatoshis: BigInt(sats) } };
};

/**
 * Make a show on simnet: fund the organiser, build, sign and broadcast the
 * genesis (mined unless mine: false). startHeight defaults to tip + 20.
 */
export const showOnSimnet = async (rpc, { shards = 4, overrides = {}, mine = true } = {}) => {
  const organiser = freshKey();
  const dataKey = freshKey();
  const tip = (await rpc.request('blockchain.headers.subscribe', [])).height;
  const coin = await fundKey(rpc, organiser, 100_000);
  const built = buildGenesis({
    show: sampleShowParams(organiser, dataKey, { startHeight: tip + 20, graceBlocks: 2, ...overrides }),
    shards,
    fundingUtxos: [coin],
    changeLockingBytecode: p2pkhLockingBytecode(organiser.pkh),
  });
  const signed = {
    transaction: signP2pkhInputs({
      transaction: built.transaction,
      sourceOutputs: built.sourceOutputs,
      inputIndexes: built.walletInputIndexes,
      privateKey: organiser.privateKey,
    }),
    sourceOutputs: built.sourceOutputs,
  };
  const genesisTxid = await rpc.request('blockchain.transaction.broadcast', [toHex(signed)]);
  if (mine) await rpc.request('simnet.mine', { blocks: 1 });
  const shardUtxos = (await coinsAt(rpc, built.contracts.boxOffice.lockingBytecode)).sort((a, b) => a.vout - b.vout);
  return { organiser, dataKey, show: built.show, contracts: built.contracts, genesisTxid, shardUtxos, signedGenesis: signed };
};

/** Expect an RpcError whose message matches `pattern`; returns the error. */
export const refused = async (assert, promise, pattern, code = 1) => {
  try {
    await promise;
  } catch (error) {
    assert.equal(error.code, code, `error code for: ${error.message}`);
    assert.match(error.message, pattern);
    return error;
  }
  assert.fail(`expected a refusal matching ${pattern}`);
  return undefined;
};
