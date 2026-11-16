// Studio CLI: keys, plans, BCMR metadata, and the whole genesis flow on simnet
// (keygen into a scratch dir, fund, plan, genesis --broadcast, verifyGenesis on
// the mined genesis, shows.json valid, a ticket sells, close, status). The
// mainnet broadcast gate is tested against a local fake "mainnet" (simnet
// behind a proxy that reports the mainnet genesis hash); no public network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import {
  binToHex,
  createVirtualMachineBch2026,
  decodeAuthenticationInstructions,
  decodeTransaction,
  hexToBin,
  sha256,
  utf8ToBin,
} from '@bitauth/libauth';
import {
  buildBuy,
  buildHandBack,
  encodeMarkerCommitment,
  encodeRefundNoticeMessage,
  encodeSeat,
  encodeTicketCommitment,
  verifyGenesis,
} from '../../src/tx/index.js';
import { publicKeyOf, signDataMessage } from '../../src/tx/sign.js';
import {
  CARDS,
  MAINNET_GENESIS_HASH,
  NFT_PARSE_BYTECODE,
  bcmrOpReturn,
  close,
  confirmBroadcast,
  genesis,
  keygen,
  loadSecrets,
  makePlan,
  checkPlan,
  registryUri,
  showFromParams,
  status,
  validateShowsJson,
  writePlan,
} from '../../studio/index.js';
import { terminalPrompt } from '../../studio/lib/gate.js';
import { openNetwork } from '../../studio/lib/net.js';
import { freshKey, signWallet, utxoAt } from '../helpers.js';
import { addressOf, coinsAt, fundKey, openSimnet, repoRoot, scratchDir, toHex } from '../simnet/support.js';
import { p2pkhLockingBytecode } from '../../src/tx/index.js';

const silent = () => {};
const p2pkhAddress = (key) => addressOf(p2pkhLockingBytecode(key.pkh), false);

const studioIn = (t) => {
  const scratch = scratchDir('test-studio');
  t.after(scratch.cleanup);
  const secretsPath = join(scratch.dir, 'secrets', 'studio.json');
  const view = keygen({ secretsPath });
  return { dir: scratch.dir, secretsPath, view, secrets: loadSecrets(secretsPath) };
};

/** A WebSocket proxy to a simnet that claims to be mainnet (genesis_hash rewritten). Test-only. */
const fakeMainnet = async (t, simnetUrl) => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => wss.once('listening', resolve));
  const sent = [];
  wss.on('connection', (client) => {
    const upstream = new WebSocket(simnetUrl);
    const queue = [];
    upstream.on('open', () => queue.splice(0).forEach((m) => upstream.send(m)));
    client.on('message', (data) => {
      const text = data.toString();
      if (text.includes('blockchain.transaction.broadcast')) sent.push(text);
      if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
      else queue.push(text);
    });
    upstream.on('message', (data) => client.send(data.toString().replace(/"genesis_hash":"[0-9a-f]{64}"/, `"genesis_hash":"${MAINNET_GENESIS_HASH}"`)));
    client.on('close', () => upstream.close());
  });
  t.after(
    () =>
      new Promise((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close(resolve);
      }),
  );
  return { url: `ws://127.0.0.1:${wss.address().port}`, sent };
};

test('keygen writes three distinct keys with owner-only permissions and refuses to overwrite', (t) => {
  const { secretsPath, view, secrets } = studioIn(t);
  assert.equal(statSync(secretsPath).mode & 0o777, 0o600);
  assert.match(view.fundingAddress, /^bitcoincash:q/);
  assert.match(view.identityAddress, /^bitcoincash:q/);
  assert.equal(view.salesPk, binToHex(publicKeyOf(secrets.sales.privateKey)));
  assert.equal(view.dataPk, binToHex(publicKeyOf(secrets.data.privateKey)));
  assert.equal(new Set([view.salesPk, view.dataPk, binToHex(secrets.identity.publicKey)]).size, 3);
  assert.ok(!JSON.stringify(view).includes(binToHex(secrets.sales.privateKey)), 'the public view holds no private key');
  assert.throws(() => keygen({ secretsPath }), /refusing to overwrite/);
  const body = JSON.parse(readFileSync(secretsPath, 'utf8'));
  assert.match(body.sales.wif, /^[KL]/);
});

test('plan: the default catalogue, its card texts, and the policy and payee checks', (t) => {
  const { view } = studioIn(t);
  const payee = p2pkhAddress(freshKey());
  const now = new Date('2026-11-16T06:28:00Z');
  const plan = makePlan({ network: 'mainnet', tip: 977_577, now, studio: view, payee, firstStart: 977_900, count: 3 });
  assert.deepEqual(plan.shows.map((s) => s.id), ['sample-a-977900', 'sample-a-977936', 'sample-a-977972', 'sample-b']);
  const [a] = plan.shows;
  assert.equal(a.kind, 'sample-settle');
  assert.equal(a.card, CARDS['sample-settle']);
  assert.equal(a.shards, 4);
  assert.deepEqual(
    { price: a.params.price, graceBlocks: a.params.graceBlocks, handBackFeeBps: a.params.handBackFeeBps, noShowFeeBps: a.params.noShowFeeBps, minerFeeCap: a.params.minerFeeCap },
    { price: 100_000, graceBlocks: 2, handBackFeeBps: 0, noShowFeeBps: 0, minerFeeCap: 1_500 },
  );
  assert.equal(a.startsAtEstimate, new Date(now.getTime() + 323 * 600_000).toISOString());
  const b = plan.shows[3];
  assert.equal(b.kind, 'sample-refund-seat');
  assert.equal(b.params.startHeight, 977_577 + 6_500);
  assert.equal(b.card, CARDS['sample-refund-seat']);
  assert.equal(plan.payee.address, payee);
  assert.equal(a.params.organiserPk, view.salesPk);
  assert.equal(a.params.organiserDataPk, view.dataPk);
  assert.equal(a.door, null);
  assert.equal(JSON.stringify(plan).includes('privateKey'), false);
  assert.doesNotThrow(() => checkPlan(JSON.parse(JSON.stringify(plan)), view));

  // A real show from a schedule gets the door endpoint; relative heights work.
  const withReal = makePlan({
    network: 'simnet', tip: 1_000, studio: view, payee, count: 0, refundSeatStart: null,
    schedule: [{ id: 'launch-night', title: 'Launch night', card: 'An online event.', startHeight: '+200', price: 50_000 }],
  });
  assert.equal(withReal.shows.length, 1);
  assert.deepEqual(withReal.shows[0].door, { endpoint: '/api/door' });
  assert.equal(withReal.shows[0].params.startHeight, 1_200);

  const base = { network: 'simnet', tip: 1_000, studio: view, payee, firstStart: '+36' };
  assert.throws(() => makePlan({ ...base, payee: 'bitcoincash:pwxq0gyyjkg34qmendu3nwdkpqlayvgn5yjlqullc32lv9tkm48h7k25r2nek' }), /P2PKH/);
  assert.throws(() => makePlan({ ...base, firstStart: 999 }), /not after the tip/);
  assert.throws(() => makePlan({ ...base, minerFeeCap: 5_000 }), /minerFeeCap/);
  assert.throws(() => makePlan({ ...base, price: 1_000 }), /price/);
  assert.throws(() => makePlan({ ...base, firstStart: undefined }), /first-start/);
  assert.throws(() => makePlan({ ...base, schedule: [{ id: 'sample-b', title: 'x', card: 'x', startHeight: '+10' }] }), /duplicate/);
  const other = studioIn(t).view;
  assert.throws(() => checkPlan(JSON.parse(JSON.stringify(makePlan(base))), other), /other studio keys/);
});

test('BCMR: the NFT parse bytecode yields type, box office letter, seat number and buyer in the 2026 VM', () => {
  const vm = createVirtualMachineBch2026(false);
  const buyer = freshKey();
  const category = crypto.getRandomValues(new Uint8Array(32));
  const parse = (commitment) => {
    const nftUtxo = { lockingBytecode: p2pkhLockingBytecode(buyer.pkh), valueSatoshis: 1_000n, token: { amount: 0n, category, nft: { capability: 'none', commitment } } };
    const parser = { lockingBytecode: hexToBin(NFT_PARSE_BYTECODE), valueSatoshis: 0n };
    const transaction = {
      version: 2,
      inputs: [
        { outpointTransactionHash: crypto.getRandomValues(new Uint8Array(32)), outpointIndex: 0, sequenceNumber: 0, unlockingBytecode: new Uint8Array() },
        { outpointTransactionHash: new Uint8Array(32), outpointIndex: 0, sequenceNumber: 0, unlockingBytecode: Uint8Array.of(0x51) },
      ],
      outputs: [{ lockingBytecode: Uint8Array.of(0x6a), valueSatoshis: 0n }],
      locktime: 0,
    };
    const state = vm.evaluate({ inputIndex: 1, sourceOutputs: [nftUtxo, parser], transaction });
    assert.equal(state.error, undefined);
    assert.deepEqual(state.stack.map(binToHex), ['01'], 'a single truthy item');
    return state.alternateStack.map(binToHex);
  };
  const seat = encodeSeat({ shard: 2, sold: 300 });
  assert.deepEqual(parse(encodeTicketCommitment(seat, buyer.pkh)), ['54', '43', '2c01', binToHex(buyer.pkh)], "'T', 'C', 300, buyer");
  assert.deepEqual(parse(encodeMarkerCommitment(encodeSeat({ shard: 0, sold: 12 }), buyer.pkh)), ['45', '41', '0c', binToHex(buyer.pkh)]);
  assert.deepEqual(parse(encodeTicketCommitment(encodeSeat({ shard: 0, sold: 0x80 }), buyer.pkh)).slice(2, 3), ['8000'], 'seat 128 stays positive');

  // Publication output: OP_RETURN 'BCMR' <sha256> <uri without https://>, within the 222-byte limit.
  const uri = registryUri('https://doorstub.pages.dev', 'ab'.repeat(32));
  assert.equal(uri, `doorstub.pages.dev/bcmr/${'ab'.repeat(32)}.json`);
  const output = bcmrOpReturn('{}\n', uri);
  const pushes = decodeAuthenticationInstructions(output);
  assert.equal(pushes[0].opcode, 0x6a);
  assert.equal(new TextDecoder().decode(pushes[1].data), 'BCMR');
  assert.equal(binToHex(pushes[2].data), binToHex(sha256.hash(utf8ToBin('{}\n'))));
  assert.equal(new TextDecoder().decode(pushes[3].data), uri);
  assert.ok(bcmrOpReturn('{}', registryUri('https://a-much-longer-custom-domain-for-doorstub.example', 'ab'.repeat(32))).length <= 222);
});

test('end to end on simnet: keygen, fund, plan, genesis --broadcast, verifyGenesis on the mined genesis, a sale, close, status', async (t) => {
  const { rpc, simnet } = await openSimnet(t, { seed: 'studio-e2e' });
  const { dir, secretsPath, view, secrets } = studioIn(t);
  const showsPath = join(dir, 'public', 'shows.json');
  const planPath = join(dir, 'plan.json');
  const previewPath = join(dir, 'preview.json');
  await rpc.request('simnet.fund', { address: view.fundingAddress, sats: 1_000_000, mine: true });
  const tip = (await rpc.request('blockchain.headers.subscribe', [])).height;
  const payeeKey = freshKey();
  const plan = makePlan({ network: 'simnet', tip, studio: view, payee: p2pkhAddress(payeeKey), firstStart: '+36', count: 2 });
  writePlan(planPath, plan);

  // Dry run: nothing sent, nothing written but the preview.
  const before = (await rpc.request('simnet.info', {})).mempool.length;
  const dry = await genesis({ planPath, secretsPath, network: 'simnet', server: simnet.url, showsPath, previewPath, print: silent });
  assert.equal(dry.dryRun, true);
  assert.equal((await rpc.request('simnet.info', {})).mempool.length, before);
  assert.equal(existsSync(showsPath), false);
  assert.ok(existsSync(previewPath));
  assert.equal(dry.txs.length, 6);

  const sent = await genesis({ planPath, secretsPath, network: 'simnet', server: simnet.url, showsPath, previewPath, broadcast: true, mine: true, print: silent });
  assert.deepEqual(sent.txs.map((tx) => tx.txid), dry.txs.map((tx) => tx.txid), 'deterministic: the dry run previews the exact transactions');
  assert.equal(sent.sent.length, 6);

  const doc = validateShowsJson(JSON.parse(readFileSync(showsPath, 'utf8')));
  assert.equal(doc.network, 'simnet');
  assert.equal(doc.origin, 'https://doorstub.pages.dev');
  assert.deepEqual(doc.shows.map((s) => s.kind), ['sample-settle', 'sample-settle', 'sample-refund-seat']);

  // validateShowsJson recomputes "derived" and checks cancel notices against the data key.
  const copy = () => JSON.parse(JSON.stringify(doc));
  const tampered = copy();
  tampered.shows[0].derived.escrowAddress = tampered.shows[1].derived.escrowAddress;
  assert.throws(() => validateShowsJson(tampered), /derived\.escrowAddress does not match/);
  const cancelMessage = (entry) => encodeRefundNoticeMessage({ scope: 'C', category: hexToBin(entry.params.category) });
  const cancelled = copy();
  cancelled.shows[0].notices = [{ scope: 'C', signature: binToHex(signDataMessage(secrets.data.privateKey, cancelMessage(cancelled.shows[0]))) }];
  assert.doesNotThrow(() => validateShowsJson(cancelled));
  cancelled.shows[0].notices = [{ scope: 'C', signature: binToHex(signDataMessage(freshKey().privateKey, cancelMessage(cancelled.shows[0]))) }];
  assert.throws(() => validateShowsJson(cancelled), /cancel notice does not verify/);

  for (const entry of doc.shows) {
    const show = showFromParams(entry.params);
    // The genesis as the chain has it, confirmed, checked against the posted params and the mined txid.
    assert.ok((await rpc.request('blockchain.transaction.get_height', [entry.genesisTxid])) > 0);
    const raw = hexToBin(await rpc.request('blockchain.transaction.get', [entry.genesisTxid]));
    const verified = verifyGenesis({ show, transaction: raw, txid: entry.genesisTxid });
    assert.deepEqual(verified.shards.map((s) => s.vout), [1, 2, 3, 4], 'shards follow the identity output');
    const tx = decodeTransaction(raw);
    assert.equal(binToHex(tx.inputs[0].outpointTransactionHash), entry.params.category, 'genesis spends output 0 of the prep (category)');
    assert.equal(tx.outputs[0].token, undefined);
    assert.equal(binToHex(tx.outputs[0].lockingBytecode), binToHex(secrets.identity.lockingBytecode), 'output 0: the BCMR identity output');
    // BCMR: the OP_RETURN hashes the registry file written next to shows.json.
    const pushes = decodeAuthenticationInstructions(tx.outputs[5].lockingBytecode);
    const file = readFileSync(join(dir, 'public', 'bcmr', `${entry.params.category}.json`), 'utf8');
    assert.equal(binToHex(pushes[2].data), binToHex(sha256.hash(utf8ToBin(file))));
    assert.equal(new TextDecoder().decode(pushes[3].data), `doorstub.pages.dev/bcmr/${entry.params.category}.json`);
    const registry = JSON.parse(file);
    const snapshot = Object.values(registry.identities[entry.params.category])[0];
    assert.equal(snapshot.name, `Doorstub ticket: ${entry.title}`);
    assert.equal(snapshot.token.category, entry.params.category);
    assert.match(snapshot.token.symbol, /^[A-Z0-9-]+$/);
    // Coins sit at the derived addresses.
    const shards = await rpc.request('blockchain.address.listunspent', [entry.derived.boxOfficeTokenAddress, 'include_tokens']);
    assert.equal(shards.length, 4);
    assert.ok(shards.every((s) => s.token_data.category === entry.params.category && s.token_data.nft.capability === 'minting'));
  }

  // The shows sell: buy and hand back on the first sample using coins found at its derived address.
  const entry = doc.shows[0];
  const show = showFromParams(entry.params);
  const [shard] = await coinsAt(rpc, hexToBin(entry.derived.boxOfficeLockingBytecode));
  const buyer = freshKey();
  const coin = await fundKey(rpc, buyer, 200_000);
  const bought = signWallet(
    buildBuy({ show, boxOfficeUtxo: shard, fundingUtxos: [coin], buyerPkh: buyer.pkh, currentHeight: (await rpc.request('blockchain.headers.subscribe', [])).height }),
    buyer.privateKey,
  );
  await rpc.request('blockchain.transaction.broadcast', [toHex(bought)]);
  const handBack = signWallet(buildHandBack({ show, escrowUtxo: utxoAt(bought.transaction, 2), ticketUtxo: utxoAt(bought.transaction, 1) }), buyer.privateKey);
  await rpc.request('blockchain.transaction.broadcast', [toHex(handBack)]);

  // Status reads it back from the chain.
  const report = await status({ showsPath, network: 'simnet', server: simnet.url, print: silent });
  const row = report.rows.find((r) => r.id === entry.id);
  assert.equal(row.genesis.startsWith('confirmed'), true);
  assert.deepEqual([row.shardsOpen, row.shardsClosed, row.sold, row.escrowCoins, row.buy, row.handBack], [4, 0, 1, 0, 1, 1]);

  // Close sales on the refund-seat show: its shards come back closed and buildBuy refuses them.
  const closed = await close({ showsPath, secretsPath, network: 'simnet', server: simnet.url, showId: 'sample-b', broadcast: true, mine: true, print: silent });
  assert.equal(closed.sent.length, 1);
  const b = doc.shows.find((s) => s.id === 'sample-b');
  const bShards = await coinsAt(rpc, hexToBin(b.derived.boxOfficeLockingBytecode));
  assert.equal(bShards.length, 4);
  assert.ok(bShards.every((s) => s.output.token.nft.commitment[0] === 0));
  const late = freshKey();
  const lateCoin = await fundKey(rpc, late, 200_000);
  assert.throws(
    () => buildBuy({ show: showFromParams(b.params), boxOfficeUtxo: bShards[0], fundingUtxos: [lateCoin], buyerPkh: late.pkh, currentHeight: 1 }),
    /sales are closed/,
  );
  const again = await close({ showsPath, secretsPath, network: 'simnet', server: simnet.url, showId: 'sample-b', broadcast: true, print: silent });
  assert.equal(again.txs.length, 0, 'nothing left to close');

  // A planned show whose start has passed is skipped, not created.
  const pastPlanPath = join(dir, 'past-plan.json');
  const tipNow = (await rpc.request('blockchain.headers.subscribe', [])).height;
  const pastPlan = makePlan({ network: 'simnet', tip: tipNow, studio: view, payee: p2pkhAddress(payeeKey), firstStart: '+1', count: 1, refundSeatStart: null });
  writePlan(pastPlanPath, pastPlan);
  await rpc.request('simnet.mine', { blocks: 1 });
  const skipped = await genesis({ planPath: pastPlanPath, secretsPath, network: 'simnet', server: simnet.url, showsPath, previewPath, broadcast: true, print: silent });
  assert.equal(skipped.txs.length, 0);

  // Running genesis again does nothing; a new plan adds shows to the same shows.json.
  assert.equal((await genesis({ planPath, secretsPath, network: 'simnet', server: simnet.url, showsPath, previewPath, broadcast: true, print: silent })).txs.length, 0);
  const tip2 = (await rpc.request('blockchain.headers.subscribe', [])).height;
  writePlan(planPath, makePlan({ network: 'simnet', tip: tip2, studio: view, payee: p2pkhAddress(payeeKey), firstStart: '+108', count: 1, refundSeatStart: null }));
  await genesis({ planPath, secretsPath, network: 'simnet', server: simnet.url, showsPath, previewPath, broadcast: true, mine: true, print: silent });
  const merged = validateShowsJson(JSON.parse(readFileSync(showsPath, 'utf8')));
  assert.equal(merged.shows.length, 4);
  // The studio's change still pays for later work.
  const left = await coinsAt(rpc, secrets.sales.lockingBytecode);
  assert.ok(left.some((c) => c.output.valueSatoshis > 100_000n));
});

test('mainnet gate: nothing is sent unless BROADCAST is typed; then it goes to two servers', async (t) => {
  const { rpc, simnet } = await openSimnet(t, { seed: 'gate' });
  const fake = await fakeMainnet(t, simnet.url);
  const { dir, secretsPath, view } = studioIn(t);
  await rpc.request('simnet.fund', { address: view.fundingAddress, sats: 500_000, mine: true });
  const tip = (await rpc.request('blockchain.headers.subscribe', [])).height;
  const planPath = join(dir, 'plan.json');
  const showsPath = join(dir, 'public', 'shows.json');
  writePlan(planPath, makePlan({ network: 'mainnet', tip, studio: view, payee: view.fundingAddress, firstStart: '+36', count: 1, refundSeatStart: null }));
  const common = { planPath, secretsPath, network: 'mainnet', servers: [fake.url, fake.url], showsPath, previewPath: join(dir, 'p.json'), print: silent };

  const asked = [];
  await assert.rejects(
    genesis({ ...common, broadcast: true, prompt: async (q) => (asked.push(q), 'yes') }),
    /not confirmed; nothing was sent/,
  );
  assert.equal(asked.length, 1);
  assert.equal(fake.sent.length, 0);
  assert.equal((await rpc.request('simnet.info', {})).mempool.length, 0);
  assert.equal(existsSync(showsPath), false);

  const printed = [];
  const result = await genesis({ ...common, broadcast: true, prompt: async () => 'BROADCAST', print: (line) => printed.push(line) });
  assert.match(printed[0], /Network: mainnet {2}\(REAL MONEY\)/);
  assert.match(printed[0], /Total cost: \d+ sats/);
  assert.equal(result.sent.length, 2);
  assert.equal(fake.sent.length, 4, 'each transaction went to two servers');
  assert.equal((await rpc.request('simnet.info', {})).mempool.length, 2);
  assert.equal(validateShowsJson(JSON.parse(readFileSync(showsPath, 'utf8'))).network, 'mainnet');

  // The gate itself.
  await assert.rejects(confirmBroadcast({ network: 'mainnet', summary: 's', prompt: async () => 'broadcast', print: silent }), /not confirmed/);
  await confirmBroadcast({ network: 'mainnet', summary: 's', prompt: async () => ' BROADCAST\n', print: silent });
  await confirmBroadcast({ network: 'simnet', summary: 's', prompt: async () => assert.fail('simnet never asks'), print: silent });
  await assert.rejects(confirmBroadcast({ network: 'testnet', summary: 's', print: silent }), /unknown network/);
  if (!process.stdin.isTTY) await assert.rejects(terminalPrompt('?'), /interactive terminal/);
});

test('network guards: simnet refuses a server that reports the mainnet genesis; mainnet refuses simnet', async (t) => {
  const { simnet } = await openSimnet(t, { seed: 'guards' });
  const fake = await fakeMainnet(t, simnet.url);
  await assert.rejects(openNetwork({ network: 'simnet', server: fake.url }), /is a mainnet server/);
  await assert.rejects(openNetwork({ network: 'mainnet', servers: [simnet.url] }), /not a mainnet server/);
  await assert.rejects(openNetwork({ network: 'mainnet', servers: [fake.url], forBroadcast: true }), /two healthy servers/);
  const readOnly = await openNetwork({ network: 'mainnet', servers: [fake.url] });
  t.after(() => readOnly.close());
  await assert.rejects(readOnly.broadcastRaw('00'), /broadcast refused|read-only/);
  await assert.rejects(readOnly.mine(1), /simnet-only/);
});

test('CLI: help, keygen refuses to overwrite, plan writes a file from a given tip', (t) => {
  const scratch = scratchDir('test-studio-cli');
  t.after(scratch.cleanup);
  const cli = join(repoRoot, 'studio', 'cli.js');
  const secrets = join(scratch.dir, 'studio.json');
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: repoRoot, encoding: 'utf8' });
  assert.match(execFileSync(process.execPath, [cli, 'help'], { encoding: 'utf8' }), /Doorstub studio/);
  const first = run('keygen', '--secrets', secrets);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Fund the studio at: {2}bitcoincash:q/);
  assert.ok(!first.stdout.includes(JSON.parse(readFileSync(secrets, 'utf8')).sales.privateKey), 'never prints a private key');
  const second = run('keygen', '--secrets', secrets);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /refusing to overwrite/);
  const out = join(scratch.dir, 'plan.json');
  const planned = run('plan', '--secrets', secrets, '--tip', '977577', '--payee', p2pkhAddress(freshKey()), '--first-start', '+36', '--count', '2', '--out', out);
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(plan.shows.map((s) => s.id), ['sample-a-977613', 'sample-a-977649', 'sample-b']);
  assert.equal(plan.network, 'simnet');
  const bad = run('plan', '--secrets', secrets, '--tip', '977577', '--first-start', '+36', '--out', out);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--payee/);
});
