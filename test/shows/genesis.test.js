// verifyShowGenesis: genesis fetched by txid (hash-checked), verified, and
// required confirmed at the BoxOffice address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { binToHex, encodeTransaction } from '@bitauth/libauth';
import { createFulcrumPool } from '../../src/chain/index.js';
import { parseShowsFile, showToJson, verifyShowGenesis, verifyShows } from '../../src/shows/index.js';
import { buildGenesis, p2pkhLockingBytecode } from '../../src/tx/index.js';
import { fakeCoin, freshKey, sampleShowParams, signWallet } from '../helpers.js';
import { makeFakeNetwork, makeMiniChain } from '../support/fake-fulcrum.js';

const URL_A = 'wss://a.example:50004';

/** A show whose genesis is on the mini chain (mined unless `mined: false`), loaded through shows.json. */
const onChain = ({ mined = true, shards = 3, postedShards = shards } = {}) => {
  const chain = makeMiniChain();
  const organiser = freshKey();
  const dataKey = freshKey();
  const genesis = buildGenesis({
    show: sampleShowParams(organiser, dataKey),
    shards,
    fundingUtxos: [fakeCoin(organiser.pkh, 100_000)],
    changeLockingBytecode: p2pkhLockingBytecode(organiser.pkh),
  });
  const signed = signWallet(genesis, organiser.privateKey);
  const genesisTxid = chain.add(signed.transaction, 0);
  if (mined) chain.mine(1);
  const entry = showToJson({ ...genesis.show, contracts: genesis.contracts, id: 'sample-a-1', kind: 'sample-settle', title: 'A', card: 'c', shards: postedShards, genesisTxid });
  const show = parseShowsFile({ version: 1, network: 'simnet', shows: [entry] }).shows[0];
  const net = makeFakeNetwork();
  net.addServer(URL_A, chain.handler);
  const pool = createFulcrumPool({ network: 'simnet', servers: [URL_A], WebSocketImpl: net.WebSocketImpl, pingIntervalMs: 0 });
  return { chain, show, pool, signed, net };
};

test('a mined, well-formed genesis verifies', async () => {
  const { show, pool, chain } = onChain();
  const result = await verifyShowGenesis(pool, show);
  assert.equal(result.txid, show.genesisTxid);
  assert.equal(result.height, chain.tip);
  assert.deepEqual(result.shards.map((s) => s.shard), [0, 1, 2]);
  pool.close();
});

test('an unconfirmed genesis is refused (the mined one is the real one)', async () => {
  const { show, pool } = onChain({ mined: false });
  await assert.rejects(verifyShowGenesis(pool, show), (e) => e.code === 'genesis-unconfirmed');
  pool.close();
});

test('a genesis the server does not have is refused', async () => {
  const { show, pool } = onChain();
  await assert.rejects(verifyShowGenesis(pool, { ...show, genesisTxid: 'ab'.repeat(32) }), (e) => e.code === 'genesis-missing');
  pool.close();
});

test('a server that answers with other bytes is caught by the hash check', async () => {
  const { show, net, signed } = onChain();
  const liar = makeFakeNetwork();
  const honest = net.servers.get(URL_A).handler;
  liar.addServer(URL_A, async (method, params) => {
    if (method === 'blockchain.transaction.get') return binToHex(encodeTransaction({ ...signed.transaction, locktime: 1 }));
    return honest(method, params);
  });
  const pool = createFulcrumPool({ network: 'simnet', servers: [URL_A], WebSocketImpl: liar.WebSocketImpl, pingIntervalMs: 0 });
  await assert.rejects(verifyShowGenesis(pool, show), (e) => e.code === 'genesis-missing' && /hash/.test(e.message));
  pool.close();
});

test('shows.json must state the shard count the genesis made', async () => {
  const { show, pool } = onChain({ shards: 3, postedShards: 2 });
  await assert.rejects(verifyShowGenesis(pool, show), (e) => e.code === 'genesis-shard-count');
  pool.close();
});

test('a txid that is not this show\'s genesis fails verifyGenesis', async () => {
  const a = onChain();
  const b = onChain();
  // b's genesis bytes added to a's chain, then claimed as a's genesis.
  a.chain.add(b.signed.transaction, 0);
  a.chain.mine(1);
  await assert.rejects(verifyShowGenesis(a.pool, { ...a.show, genesisTxid: b.show.genesisTxid }), (e) => e.code === 'genesis-not-here');
  a.pool.close();
  b.pool.close();
});

test('verifyShows keeps order and splits verified from failed', async () => {
  const { show, pool } = onChain();
  const fake = { ...show, id: 'fake', genesisTxid: 'cd'.repeat(32) };
  const { verified, failed } = await verifyShows(pool, [fake, show]);
  assert.deepEqual(verified.map((s) => s.id), ['sample-a-1']);
  assert.equal(verified[0].genesis.txid, show.genesisTxid);
  assert.deepEqual(failed.map((f) => [f.show.id, f.code]), [['fake', 'genesis-missing']]);
  pool.close();
});
