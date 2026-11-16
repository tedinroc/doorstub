// `studio genesis`: for each planned show not yet in shows.json, a prep
// transaction (studio coin -> studio address at output 0, change chained to
// the next prep) and the genesis (identity output, shards, BCMR OP_RETURN),
// both signed with the studio sales key, both valid in the 2026 VM, and the
// genesis checked with verifyGenesis. Nothing is sent without `broadcast`;
// on mainnet the gate asks for BROADCAST first.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { binToHex, encodeTransaction } from '@bitauth/libauth';
import {
  DEFAULT_FEE_RATE,
  P2PKH_UNLOCK_MAX_BYTES,
  TOKEN_OUTPUT_SATS,
  buildGenesis,
  describeResult,
  estimateSize,
  evaluateTransaction,
  verifyGenesis,
} from '../../src/tx/index.js';
import { signP2pkhInputs } from '../../src/tx/sign.js';
import { bcmrOpReturn, buildRegistry, registryHash, registryPath, registryText, registryUri } from './bcmr.js';
import { confirmBroadcast } from './gate.js';
import { loadSecrets, publicView } from './keys.js';
import { openNetwork } from './net.js';
import { buildSignedPayment } from './payment.js';
import { checkPlan } from './plan.js';
import { deriveShow, paramsFromShow, readShowsJson, showFromParams, validateShowsJson } from './shows-json.js';

const sum = (values) => values.reduce((a, b) => a + b, 0n);
const bch = (sats) => `${(Number(sats) / 1e8).toFixed(8)} BCH`;

const checkVm = (resolved, label) => {
  const result = evaluateTransaction(resolved);
  if (!result.ok) throw new Error(`${label} fails in the 2026 VM: ${describeResult(result)}`);
};

/** Miner fee of a genesis with these outputs (size does not depend on the category). */
const genesisFee = ({ params, shards, origin, identityLockingBytecode, salesLockingBytecode, feeRate }) => {
  const placeholderCategory = '00'.repeat(32);
  const dataOutput = bcmrOpReturn('placeholder', registryUri(origin, placeholderCategory));
  const draft = buildGenesis({
    show: showFromParams(params),
    shards,
    fundingUtxos: [{ txid: new Uint8Array(32), vout: 0, output: { lockingBytecode: salesLockingBytecode, valueSatoshis: 100_000_000n } }],
    dataOutput,
    identityLockingBytecode,
  });
  return BigInt(estimateSize(draft.transaction, new Map([[0, P2PKH_UNLOCK_MAX_BYTES]]))) * BigInt(feeRate);
};

/**
 * Build (and with `broadcast`, send) the genesis of every planned show that
 * shows.json does not list yet.
 * Returns { network, entries, txs, files, cost, sent, dryRun }.
 */
export const genesis = async ({
  planPath = 'studio/plan.json',
  secretsPath,
  network,
  server,
  showsPath = 'app/public/shows.json',
  publicDir = dirname(showsPath),
  broadcast = false,
  mine = false,
  previewPath = '.cache/studio/genesis-preview.json',
  iconPath,
  feeRate = DEFAULT_FEE_RATE,
  now = new Date(),
  prompt,
  print = console.log,
  servers,
}) => {
  const secrets = loadSecrets(secretsPath);
  const studio = publicView(secrets);
  if (!existsSync(planPath)) throw new Error(`${planPath} not found; run \`npm run studio -- plan\` first`);
  const plan = checkPlan(JSON.parse(readFileSync(planPath, 'utf8')), studio);
  if (plan.network !== network) throw new Error(`the plan is for ${plan.network}; you asked for ${network}`);
  const existing = readShowsJson(showsPath);
  if (existing !== undefined && existing.network !== network) throw new Error(`${showsPath} is for ${existing.network}; refusing to mix in ${network} shows`);
  if (existing !== undefined && existing.origin !== plan.origin) throw new Error(`${showsPath} uses origin ${existing.origin}; the plan uses ${plan.origin}`);
  const notYet = plan.shows.filter((entry) => !existing?.shows.some((s) => s.id === entry.id));
  if (notYet.length === 0) {
    print(`every show in ${planPath} is already in ${showsPath}; nothing to do`);
    return { network, entries: [], txs: [], files: [], cost: 0n, sent: [], dryRun: !broadcast };
  }

  const net = await openNetwork({ network, server, servers });
  try {
    // A show whose start has passed could never sell (buildBuy refuses at the start): skip it.
    const tip = await net.tip();
    const pending = notYet.filter((entry) => entry.params.startHeight > tip);
    for (const entry of notYet) if (entry.params.startHeight <= tip) print(`skipping ${entry.id}: it starts at ${entry.params.startHeight}, and the tip is already ${tip}`);
    if (pending.length === 0) {
      print('no planned show is still in the future; make a new plan');
      return { network, entries: [], txs: [], files: [], cost: 0n, sent: [], dryRun: !broadcast };
    }
    const salesLock = secrets.sales.lockingBytecode;
    const coins = (await net.unspent(salesLock)).filter((coin) => coin.output.token === undefined);
    const balance = sum(coins.map((c) => c.output.valueSatoshis));
    if (coins.length === 0) throw new Error(`the studio address ${studio.fundingAddress} has no coins; fund it first`);

    // The registry revision is the plan's time, so a dry run previews the exact transactions --broadcast sends.
    const revision = plan.createdAt;
    const entries = [];
    const txs = [];
    const files = [];
    let funding = coins;
    let cost = 0n;
    for (const planned of pending) {
      const fee = genesisFee({
        params: planned.params,
        shards: planned.shards,
        origin: plan.origin,
        identityLockingBytecode: secrets.identity.lockingBytecode,
        salesLockingBytecode: salesLock,
        feeRate,
      });
      const need = TOKEN_OUTPUT_SATS * BigInt(planned.shards + 1) + fee;
      let prep;
      try {
        prep = buildSignedPayment({
          coins: funding,
          outputs: [{ lockingBytecode: salesLock, valueSatoshis: need }],
          changeLockingBytecode: salesLock,
          privateKey: secrets.sales.privateKey,
          feeRate,
        });
      } catch (error) {
        const perShow = need + 300n;
        throw new Error(
          `${error.message}. The studio has ${balance} sats; ${pending.length} shows need about ${perShow * BigInt(pending.length) + 1000n} sats. Fund ${studio.fundingAddress}.`,
        );
      }
      checkVm(prep, `prep for ${planned.id}`);
      const category = binToHex(prep.txid);
      const registry = buildRegistry({ origin: plan.origin, category, entry: planned, iconPath, revision });
      const text = registryText(registry);
      const built = buildGenesis({
        show: showFromParams(planned.params),
        shards: planned.shards,
        fundingUtxos: [{ txid: prep.txid, vout: 0, output: prep.transaction.outputs[0] }],
        changeLockingBytecode: salesLock,
        dataOutput: bcmrOpReturn(text, registryUri(plan.origin, category)),
        identityLockingBytecode: secrets.identity.lockingBytecode,
        feeRate,
      });
      const signed = {
        transaction: signP2pkhInputs({
          transaction: built.transaction,
          sourceOutputs: built.sourceOutputs,
          inputIndexes: built.walletInputIndexes,
          privateKey: secrets.sales.privateKey,
        }),
        sourceOutputs: built.sourceOutputs,
      };
      checkVm(signed, `genesis for ${planned.id}`);
      const raw = encodeTransaction(signed.transaction);
      const verified = verifyGenesis({ show: built.show, transaction: raw });
      if (verified.shards.length !== planned.shards) throw new Error(`genesis for ${planned.id}: verifyGenesis found ${verified.shards.length} shards`);
      const genesisTxid = binToHex(verified.txid);

      entries.push({
        id: planned.id,
        kind: planned.kind,
        title: planned.title,
        subtitle: planned.subtitle,
        card: planned.card,
        startsAtEstimate: planned.startsAtEstimate,
        params: paramsFromShow(built.show),
        shards: planned.shards,
        genesisTxid,
        derived: deriveShow(built.show),
        notices: [],
        door: planned.door ?? null,
      });
      files.push({ path: join(publicDir, registryPath(category)), text, hash: registryHash(text) });
      txs.push({ label: `prep ${planned.id}`, txid: category, hex: binToHex(encodeTransaction(prep.transaction)), fee: prep.fee });
      txs.push({ label: `genesis ${planned.id}`, txid: genesisTxid, hex: binToHex(raw), fee: built.fee });
      cost += prep.fee + need; // need = shard and identity sats + the genesis miner fee
      funding = [{ txid: prep.txid, vout: 1, output: prep.transaction.outputs[1] }];
    }

    const summary = [
      `Network: ${network}${network === 'mainnet' ? '  (REAL MONEY)' : ''}`,
      `Studio address: ${studio.fundingAddress}  balance ${balance} sats (${bch(balance)})`,
      `Shows (${entries.length}):`,
      ...entries.map((e) => `  ${e.id}  ${e.kind}  start ${e.params.startHeight}  price ${e.params.price} sats  ${e.shards} shards  category ${e.params.category}`),
      `Transactions (${txs.length}): ${txs.map((t) => `${t.label} ${t.hex.length / 2} B`).join(', ')}`,
      `Total cost: ${cost} sats (${bch(cost)}): miner fees ${sum(txs.map((t) => t.fee))} sats, plus 1,000 sats in each shard and identity output`,
      `Writes: ${showsPath} and ${files.length} BCMR file(s) under ${join(publicDir, 'bcmr')}`,
    ].join('\n');

    if (!broadcast) {
      mkdirSync(dirname(previewPath), { recursive: true });
      writeFileSync(previewPath, `${JSON.stringify({ network, summary, entries, txs: txs.map(({ fee, ...t }) => ({ ...t, fee: Number(fee) })), bcmr: files }, null, 2)}\n`);
      print(summary);
      print(`\nDry run: nothing was sent and ${showsPath} is unchanged. Preview: ${previewPath}. Add --broadcast to send.`);
      return { network, entries, txs, files, cost, sent: [], dryRun: true };
    }

    await confirmBroadcast({ network, summary, prompt, print });
    const sender = network === 'mainnet' ? await openNetwork({ network, servers, forBroadcast: true }) : net;
    const sent = [];
    try {
      for (const tx of txs) {
        await sender.broadcastRaw(tx.hex);
        sent.push(tx.txid);
        print(`sent ${tx.label}: ${tx.txid}`);
      }
    } finally {
      if (sender !== net) sender.close();
      // Keep every show whose genesis was accepted, even if a later one failed.
      const accepted = entries.filter((entry) => sent.includes(entry.genesisTxid));
      if (accepted.length > 0) writeOutputs({ showsPath, existing, plan, network, now, accepted, files: files.filter((f) => accepted.some((e) => f.path.includes(e.params.category))) });
    }
    if (mine && network === 'simnet') await net.mine(1);
    print(`\nWrote ${showsPath} (${entries.length} new show(s)) and ${files.length} BCMR file(s).`);
    return { network, entries, txs, files, cost, sent, dryRun: false };
  } finally {
    net.close();
  }
};

const writeOutputs = ({ showsPath, existing, plan, network, now, accepted, files }) => {
  const doc = validateShowsJson({
    version: 1,
    network,
    origin: plan.origin,
    generatedAt: now.toISOString(),
    shows: [...(existing?.shows ?? []), ...accepted],
  });
  mkdirSync(dirname(showsPath), { recursive: true });
  writeFileSync(showsPath, `${JSON.stringify(doc, null, 2)}\n`);
  for (const file of files) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.text);
  }
};
