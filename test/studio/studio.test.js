// Studio CLI: keys, plans, BCMR metadata, and the whole genesis flow on simnet
// (keygen into a scratch dir, fund, plan, genesis --broadcast, verifyGenesis on
// the mined genesis, shows.json valid, a ticket sells, close, status). The
// mainnet broadcast gate is tested against a local fake "mainnet" (simnet
// behind a proxy that reports the mainnet genesis hash); no public network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import {
  binToHex,
  binToUtf8,
  createVirtualMachineBch2026,
  decodeAuthenticationInstructions,
  decodeTransaction,
  hexToBin,
  importMetadataRegistry,
  sha256,
  utf8ToBin,
  vmNumberToBigInt,
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
import { parseShowsFile, showSeatLabel } from '../../src/shows/index.js';
import {
  CARDS,
  MAINNET_GENESIS_HASH,
  NFT_FIELD_ORDER,
  addRealDataKey,
  bcmrOpReturn,
  buildRegistry,
  nftParseBytecode,
  startHeightAfterCall,
  close,
  confirmBroadcast,
  genesis,
  keygen,
  loadSecrets,
  makePlan,
  checkPlan,
  publicView,
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
const SCREENINGS = JSON.parse(readFileSync(join(repoRoot, 'studio', 'screenings.example.json'), 'utf8'));

/**
 * Run a show's BCMR NFT parse bytecode over a commitment in the 2026 VM, as a
 * wallet does. Returns the raw altstack (hex) and the decoded field values.
 */
const parseNft = (registry, category, commitment, holderPkh = new Uint8Array(20)) => {
  const snapshot = Object.values(registry.identities[category])[0];
  const { parse } = snapshot.token.nfts;
  const nftUtxo = { lockingBytecode: p2pkhLockingBytecode(holderPkh), valueSatoshis: 1_000n, token: { amount: 0n, category: hexToBin(category), nft: { capability: 'none', commitment } } };
  const parser = { lockingBytecode: hexToBin(parse.bytecode), valueSatoshis: 0n };
  const transaction = {
    version: 2,
    inputs: [
      { outpointTransactionHash: crypto.getRandomValues(new Uint8Array(32)), outpointIndex: 0, sequenceNumber: 0, unlockingBytecode: new Uint8Array() },
      { outpointTransactionHash: new Uint8Array(32), outpointIndex: 0, sequenceNumber: 0, unlockingBytecode: Uint8Array.of(0x51) },
    ],
    outputs: [{ lockingBytecode: Uint8Array.of(0x6a), valueSatoshis: 0n }],
    locktime: 0,
  };
  const state = createVirtualMachineBch2026(true).evaluate({ inputIndex: 1, sourceOutputs: [nftUtxo, parser], transaction });
  assert.equal(state.error, undefined);
  assert.deepEqual(state.stack.map(binToHex), ['01'], 'a single truthy item');
  const [tag, ...values] = state.alternateStack;
  const type = parse.types[binToHex(tag)];
  assert.ok(type, `type ${binToHex(tag)} is listed`);
  const decoded = Object.fromEntries(
    type.fields.map((name, i) => {
      const { encoding } = snapshot.token.nfts.fields[name];
      const value = values[i];
      return [name, encoding.type === 'utf8' ? binToUtf8(value) : encoding.type === 'number' ? Number(vmNumberToBigInt(value, { requireMinimalEncoding: true })) : binToHex(value)];
    }),
  );
  return { raw: state.alternateStack.map(binToHex), type, decoded };
};

/** The seat label a wallet shows from the parsed fields, in the site's form. */
const walletLabel = ({ show, boxOffice, seat }) => `${show}-${boxOffice}-${seat}`;

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

test('keygen writes four distinct keys with owner-only permissions and refuses to overwrite; an older file gets the real-show data key', (t) => {
  const { secretsPath, view, secrets } = studioIn(t);
  assert.equal(statSync(secretsPath).mode & 0o777, 0o600);
  assert.match(view.fundingAddress, /^bitcoincash:q/);
  assert.match(view.identityAddress, /^bitcoincash:q/);
  assert.equal(view.salesPk, binToHex(publicKeyOf(secrets.sales.privateKey)));
  assert.equal(view.dataPk, binToHex(publicKeyOf(secrets.data.privateKey)));
  assert.equal(view.realDataPk, binToHex(publicKeyOf(secrets.realData.privateKey)));
  assert.equal(new Set([view.salesPk, view.dataPk, view.realDataPk, binToHex(secrets.identity.publicKey)]).size, 4);
  for (const key of [secrets.sales, secrets.data, secrets.realData, secrets.identity]) {
    assert.ok(!JSON.stringify(view).includes(binToHex(key.privateKey)), 'the public view holds no private key');
  }
  assert.throws(() => keygen({ secretsPath }), /refusing to overwrite/);
  const body = JSON.parse(readFileSync(secretsPath, 'utf8'));
  assert.match(body.sales.wif, /^[KL]/);
  assert.match(body.note, /never leaves this file/);

  // A studio file from before the real-show data key: loads without it, plans no real show, and can be given one.
  const { realData, ...older } = body;
  writeFileSync(secretsPath, JSON.stringify(older));
  assert.equal(loadSecrets(secretsPath).realData, undefined);
  const oldView = publicView(loadSecrets(secretsPath));
  assert.equal(oldView.realDataPk, null);
  assert.throws(
    () => makePlan({ network: 'simnet', tip: 1_000, studio: oldView, payee: oldView.fundingAddress, count: 0, refundSeatStart: null, schedule: [{ ...SCREENINGS[0], startHeight: '+100' }] }),
    /keygen --add-real-data-key/,
  );
  const added = addRealDataKey({ secretsPath });
  assert.equal(added.salesPk, view.salesPk, 'the other keys stay');
  assert.equal(added.dataPk, view.dataPk);
  assert.match(added.realDataPk, /^0[23][0-9a-f]{64}$/);
  assert.notEqual(added.realDataPk, view.dataPk);
  assert.equal(statSync(secretsPath).mode & 0o777, 0o600);
  assert.throws(() => addRealDataKey({ secretsPath }), /already has/);
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

  assert.deepEqual(plan.shows.map((s) => s.subtitle), ['', '', '', ''], 'no subtitle repeats the card or the start block');
  for (const sample of plan.shows) assert.equal('eventAt' in sample || 'durationMin' in sample || 'seatPrefix' in sample, false, 'samples have no call');

  // A real show from a schedule gets the door endpoint and the real-show data key; relative heights work.
  const call = { eventAt: '2026-11-17T13:00:00Z', durationMin: 25, seatPrefix: 'L' };
  const withReal = makePlan({
    network: 'simnet', tip: 1_000, now, studio: view, payee, count: 0, refundSeatStart: null,
    schedule: [{ id: 'launch-night', title: 'Launch night', card: 'An online event.', startHeight: '+200', price: 50_000, ...call }],
  });
  assert.equal(withReal.shows.length, 1);
  assert.deepEqual(withReal.shows[0].door, { endpoint: '/api/door' });
  assert.equal(withReal.shows[0].params.startHeight, 1_200);
  assert.equal(withReal.shows[0].subtitle, '');
  assert.deepEqual([withReal.shows[0].eventAt, withReal.shows[0].durationMin, withReal.shows[0].seatPrefix], ['2026-11-17T13:00:00Z', 25, 'L']);
  assert.equal(withReal.shows[0].params.organiserDataPk, view.realDataPk, 'a real show\'s data key is not the one the worker holds');
  assert.notEqual(view.realDataPk, view.dataPk);
  assert.equal(withReal.studio.realDataPk, view.realDataPk);

  // The planned screenings: no startHeight in the file, so it is the end of the call plus 6 blocks from the tip and the clock.
  const screenings = makePlan({ network: 'mainnet', tip: 977_577, now, studio: view, payee, count: 0, refundSeatStart: null, schedule: SCREENINGS });
  assert.deepEqual(screenings.shows.map((s) => [s.id, s.seatPrefix, s.subtitle, s.durationMin, s.eventAt]), [
    ['screening-1', 'S', 'Online, 25 minutes', 25, '2026-11-24T13:00:00Z'],
    ['screening-2', 'T', 'Online, 25 minutes', 25, '2026-11-28T13:00:00Z'],
  ]);
  // 24 Nov 13:25 UTC is 11,937 minutes after 16 Nov 06:28: 1,194 blocks (rounded up), then 6 more.
  assert.equal(screenings.shows[0].params.startHeight, 977_577 + 1_194 + 6);
  assert.equal(startHeightAfterCall({ ...SCREENINGS[0], tip: 977_577, now }), 978_777);
  assert.equal(startHeightAfterCall({ ...SCREENINGS[0], tip: 977_600, now: new Date('2026-11-16T10:18:00Z') }), 978_777, 'the same height from a later tip and clock');
  for (const s of screenings.shows) {
    const callEnds = Date.parse(s.eventAt) + s.durationMin * 60_000;
    const salesEnd = Date.parse(s.startsAtEstimate);
    assert.ok(salesEnd - callEnds >= 60 * 60_000 && salesEnd - callEnds < 70 * 60_000, `${s.id}: sales end about an hour after the call (${(salesEnd - callEnds) / 60_000} min)`);
    assert.equal(s.params.organiserDataPk, view.realDataPk);
  }
  assert.doesNotThrow(() => checkPlan(JSON.parse(JSON.stringify(screenings)), view));
  const swapped = JSON.parse(JSON.stringify(screenings));
  swapped.shows[0].params.organiserDataPk = view.dataPk;
  assert.throws(() => checkPlan(swapped, view), /names keys that are not this studio's/, 'a real show planned with the worker\'s key is refused');
  const sameLetter = JSON.parse(JSON.stringify(screenings));
  sameLetter.shows[1].seatPrefix = 'S';
  assert.throws(() => checkPlan(sameLetter, view), /seat letter S is used twice/);

  // A real show's call is required and checked; letters are its own.
  const realBase = { network: 'simnet', tip: 1_000, now, studio: view, payee, count: 0, refundSeatStart: null };
  const entry = { id: 'x', title: 'X', card: 'x', startHeight: '+200', ...call };
  for (const [change, message] of [
    [{ eventAt: undefined }, /eventAt/],
    [{ eventAt: '2026-11-17 13:00' }, /eventAt/],
    [{ durationMin: 0 }, /durationMin/],
    [{ seatPrefix: 'A' }, /belongs to a sample/],
    [{ seatPrefix: 'st' }, /one capital letter/],
  ]) {
    assert.throws(() => makePlan({ ...realBase, schedule: [{ ...entry, ...change }] }), message, JSON.stringify(change));
  }
  assert.throws(() => makePlan({ ...realBase, schedule: [entry, { ...entry, id: 'y' }] }), /seat letter L is already used/);
  assert.throws(() => makePlan({ ...realBase, schedule: [{ ...entry, startHeight: undefined, eventAt: '2026-11-16T05:00:00Z' }] }), /is over/, 'a call that is over');
  assert.throws(() => makePlan({ ...realBase, schedule: [{ ...entry, kind: 'sample-settle', startHeight: undefined, eventAt: undefined, durationMin: undefined, seatPrefix: undefined }] }), /needs startHeight/);
  assert.throws(() => makePlan({ ...realBase, schedule: [{ ...entry, kind: 'sample-settle', seatPrefix: 'Q', eventAt: undefined, durationMin: undefined }] }), /only real shows/);

  const base = { network: 'simnet', tip: 1_000, studio: view, payee, firstStart: '+36' };
  assert.throws(() => makePlan({ ...base, payee: 'bitcoincash:pwxq0gyyjkg34qmendu3nwdkpqlayvgn5yjlqullc32lv9tkm48h7k25r2nek' }), /P2PKH/);
  assert.throws(() => makePlan({ ...base, firstStart: 999 }), /not after the tip/);
  assert.throws(() => makePlan({ ...base, minerFeeCap: 5_000 }), /minerFeeCap/);
  assert.throws(() => makePlan({ ...base, price: 1_000 }), /price/);
  assert.throws(() => makePlan({ ...base, firstStart: undefined }), /first-start/);
  assert.throws(() => makePlan({ ...base, schedule: [{ id: 'sample-b', title: 'x', card: 'x', startHeight: '+10', ...call }] }), /duplicate/);
  const other = studioIn(t).view;
  assert.throws(() => checkPlan(JSON.parse(JSON.stringify(makePlan(base))), other), /other studio keys/);
});

test('BCMR: the NFT parse gives type, show letter, box office, seat and buyer in the 2026 VM, which make the site\'s seat label', (t) => {
  const { view } = studioIn(t);
  const buyer = freshKey();
  const now = new Date('2026-11-16T06:28:00Z');
  const plan = makePlan({ network: 'mainnet', tip: 977_577, now, studio: view, payee: p2pkhAddress(freshKey()), firstStart: '+36', count: 1, schedule: SCREENINGS });
  const seats = [encodeSeat({ shard: 0, sold: 12 }), encodeSeat({ shard: 2, sold: 300 }), encodeSeat({ shard: 0, sold: 0x80 }), encodeSeat({ shard: 200, sold: 32_767 })];
  for (const entry of plan.shows) {
    const category = binToHex(crypto.getRandomValues(new Uint8Array(32)));
    const registry = buildRegistry({ origin: 'https://doorstub.pages.dev', category, entry, revision: plan.createdAt });
    assert.equal(typeof importMetadataRegistry(registry), 'object', `${entry.id}: libauth accepts the registry`);
    const letter = { 'sample-settle': 'A', 'sample-refund-seat': 'B' }[entry.kind] ?? entry.seatPrefix;
    assert.equal(Object.values(registry.identities[category])[0].token.nfts.parse.bytecode, nftParseBytecode(letter));
    for (const seat of seats) {
      for (const [commitment, tag] of [[encodeTicketCommitment(seat, buyer.pkh), '54'], [encodeMarkerCommitment(seat, buyer.pkh), '45']]) {
        const { raw, decoded, type } = parseNft(registry, category, commitment, buyer.pkh);
        assert.equal(raw[0], tag);
        assert.deepEqual(type.fields, [...NFT_FIELD_ORDER]);
        assert.equal(decoded.buyer, binToHex(buyer.pkh));
        assert.equal(walletLabel(decoded), showSeatLabel({ seatPrefix: letter }, seat), `${entry.id}: the wallet's fields make the site's label`);
      }
    }
  }
  assert.deepEqual(parseNft(buildRegistry({ origin: 'https://x.example', category: 'ab'.repeat(32), entry: plan.shows.at(-1), revision: 'r' }), 'ab'.repeat(32), encodeTicketCommitment(encodeSeat({ shard: 2, sold: 300 }), buyer.pkh)).raw, ['54', '54', '02', '2c01', binToHex(buyer.pkh)], "'T', 'T', 2, 300, buyer");
  assert.throws(() => nftParseBytecode('s'), /capital letter/);

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
  // The two planned screenings too, planned as if on 16 Nov (their start heights then follow the simnet's tip).
  const plan = makePlan({ network: 'simnet', tip, now: new Date('2026-11-16T06:28:00Z'), studio: view, payee: p2pkhAddress(payeeKey), firstStart: '+36', count: 2, schedule: SCREENINGS });
  writePlan(planPath, plan);

  // Dry run: nothing sent, nothing written but the preview.
  const before = (await rpc.request('simnet.info', {})).mempool.length;
  const dry = await genesis({ planPath, secretsPath, network: 'simnet', server: simnet.url, showsPath, previewPath, print: silent });
  assert.equal(dry.dryRun, true);
  assert.equal((await rpc.request('simnet.info', {})).mempool.length, before);
  assert.equal(existsSync(showsPath), false);
  assert.ok(existsSync(previewPath));
  assert.equal(dry.txs.length, 10);

  const sent = await genesis({ planPath, secretsPath, network: 'simnet', server: simnet.url, showsPath, previewPath, broadcast: true, mine: true, print: silent });
  assert.deepEqual(sent.txs.map((tx) => tx.txid), dry.txs.map((tx) => tx.txid), 'deterministic: the dry run previews the exact transactions');
  assert.equal(sent.sent.length, 10);

  const doc = validateShowsJson(JSON.parse(readFileSync(showsPath, 'utf8')));
  assert.equal(doc.network, 'simnet');
  assert.equal(doc.origin, 'https://doorstub.pages.dev');
  assert.deepEqual(doc.shows.map((s) => s.kind), ['sample-settle', 'sample-settle', 'sample-refund-seat', 'real', 'real']);
  // The screenings carry their call and seat letter, and their own data key; the samples carry neither.
  assert.deepEqual(doc.shows.map((s) => [s.subtitle, s.eventAt, s.durationMin, s.seatPrefix]), [
    ['', undefined, undefined, undefined],
    ['', undefined, undefined, undefined],
    ['', undefined, undefined, undefined],
    ['Online, 25 minutes', '2026-11-24T13:00:00Z', 25, 'S'],
    ['Online, 25 minutes', '2026-11-28T13:00:00Z', 25, 'T'],
  ]);
  assert.deepEqual(doc.shows.map((s) => s.params.organiserDataPk === view.realDataPk), [false, false, false, true, true]);
  assert.deepEqual(doc.shows.map((s) => s.params.organiserDataPk === view.dataPk), [true, true, true, false, false]);

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

  // A real ticket of screening 1, bought on the simnet: the wallet's BCMR fields (from the registry genesis wrote)
  // make exactly the seat label the site shows for it.
  const loaded = parseShowsFile(readFileSync(showsPath, 'utf8'), { network: 'simnet' });
  assert.deepEqual(loaded.rejected, []);
  const screening = loaded.shows.find((s) => s.id === 'screening-1');
  const realEntry = doc.shows.find((s) => s.id === 'screening-1');
  const realRegistry = JSON.parse(readFileSync(join(dir, 'public', 'bcmr', `${realEntry.params.category}.json`), 'utf8'));
  assert.equal(typeof importMetadataRegistry(realRegistry), 'object', 'libauth accepts the registry genesis committed to');
  const [realShard] = (await coinsAt(rpc, screening.contracts.boxOffice.lockingBytecode)).slice(-1);
  const walker = freshKey();
  const walkerCoin = await fundKey(rpc, walker, 200_000);
  const realBuy = signWallet(
    buildBuy({ show: screening, boxOfficeUtxo: realShard, fundingUtxos: [walkerCoin], buyerPkh: walker.pkh, currentHeight: (await rpc.request('blockchain.headers.subscribe', [])).height, contracts: screening.contracts }),
    walker.privateKey,
  );
  await rpc.request('blockchain.transaction.broadcast', [toHex(realBuy)]);
  const ticketNft = realBuy.transaction.outputs[1].token.nft;
  const { decoded } = parseNft(realRegistry, realEntry.params.category, ticketNft.commitment, walker.pkh);
  const seat = ticketNft.commitment.slice(1, 4);
  assert.match(showSeatLabel(screening, seat), /^S-\d-1$/);
  assert.equal(walletLabel(decoded), showSeatLabel(screening, seat));
  assert.equal(decoded.buyer, binToHex(walker.pkh));

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
  assert.equal(merged.shows.length, 6);

  // A plan whose real show takes a seat letter shows.json already gives another show is refused before anything is sent.
  const taken = makePlan({ network: 'simnet', tip: tip2, now: new Date('2026-11-16T06:28:00Z'), studio: view, payee: p2pkhAddress(payeeKey), count: 0, refundSeatStart: null, schedule: [{ ...SCREENINGS[0], id: 'screening-3', title: 'Doorstub screening 3' }] });
  writePlan(planPath, taken);
  const mempoolBefore = (await rpc.request('simnet.info', {})).mempool.length;
  await assert.rejects(genesis({ planPath, secretsPath, network: 'simnet', server: simnet.url, showsPath, previewPath, broadcast: true, print: silent }), /seat letter S is already used by screening-1/);
  assert.equal((await rpc.request('simnet.info', {})).mempool.length, mempoolBefore);
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
  assert.match(first.stdout, /Real-show data key: {2}0[23][0-9a-f]{64} {2}\(organiserDataPk of real shows; never give it to the worker\)/);

  // A screening schedule (a call two days from now): the plan prints the call and when sales end after it.
  const schedulePath = join(scratch.dir, 'screenings.json');
  const eventAt = new Date(Math.floor(Date.now() / 60_000) * 60_000 + 2 * 86_400_000).toISOString().replace('.000Z', 'Z');
  writeFileSync(schedulePath, JSON.stringify([{ ...SCREENINGS[0], eventAt }]));
  const real = run('plan', '--secrets', secrets, '--tip', '977577', '--payee', p2pkhAddress(freshKey()), '--schedule', schedulePath, '--no-refund-seat', '--out', out);
  assert.equal(real.status, 0, real.stderr);
  assert.match(real.stdout, new RegExp(`call ${eventAt} for 25 min .*seats S-<box office>-<seat>; sales end at block \\d+, about (6\\d|70) min after the call ends`));
  assert.doesNotMatch(real.stdout, /WARNING/);
  const realPlan = JSON.parse(readFileSync(out, 'utf8'));
  assert.deepEqual(realPlan.shows.map((s) => [s.id, s.seatPrefix]), [['screening-1', 'S']]);
  writeFileSync(schedulePath, JSON.stringify([{ ...SCREENINGS[0], eventAt, startHeight: '+10' }]));
  assert.match(run('plan', '--secrets', secrets, '--tip', '977577', '--payee', p2pkhAddress(freshKey()), '--schedule', schedulePath, '--no-refund-seat', '--out', out).stdout, /WARNING: sales would end before the call ends/);
});
