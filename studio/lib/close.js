// `studio close`: closeSales on every open shard of a show (or of every show
// that has started), signed with the studio sales key; a studio coin pays the
// fee. Same broadcast gate as genesis.
import { binToHex, encodeTransaction, hashTransactionUiOrder } from '@bitauth/libauth';
import {
  DEFAULT_FEE_RATE,
  buildCloseSales,
  describeResult,
  evaluateTransaction,
  sameBytes,
  showContracts,
} from '../../src/tx/index.js';
import { signDigest, signP2pkhInputs } from '../../src/tx/sign.js';
import { confirmBroadcast } from './gate.js';
import { loadSecrets, publicView } from './keys.js';
import { openNetwork } from './net.js';
import { findShow, readShowsJson } from './shows-json.js';

/** Open shards of this show at its BoxOffice (look-alike tokens of other categories are ignored). */
export const openShards = (coins, show) =>
  coins.filter(
    (coin) =>
      coin.output.token !== undefined &&
      sameBytes(coin.output.token.category, show.category) &&
      coin.output.token.nft?.capability === 'minting' &&
      coin.output.token.nft.commitment.length === 4 &&
      coin.output.token.nft.commitment[0] === 0x01,
  );

export const close = async ({
  showsPath = 'app/public/shows.json',
  secretsPath,
  network,
  server,
  showId,
  started = false,
  broadcast = false,
  mine = false,
  feeRate = DEFAULT_FEE_RATE,
  prompt,
  print = console.log,
  servers,
}) => {
  const secrets = loadSecrets(secretsPath);
  const studio = publicView(secrets);
  const doc = readShowsJson(showsPath);
  if (doc === undefined) throw new Error(`${showsPath} not found`);
  if (doc.network !== network) throw new Error(`${showsPath} is for ${doc.network}; you asked for ${network}`);
  if ((showId === undefined) === !started) throw new Error('name one show (--show <id>) or pass --started');

  const net = await openNetwork({ network, server, servers });
  try {
    const tip = await net.tip();
    const targets = started
      ? doc.shows.filter((entry) => entry.kind !== 'proof' && entry.params.startHeight <= tip).map((entry) => findShow(doc, entry.id))
      : [findShow(doc, showId)];
    if (targets.length === 0) print(`no show has started yet (tip ${tip})`);
    for (const { entry } of targets) {
      if (entry.params.organiserPk !== studio.salesPk) throw new Error(`${entry.id} was not made with this studio's sales key`);
    }
    let funding = (await net.unspent(secrets.sales.lockingBytecode))
      .filter((coin) => coin.output.token === undefined)
      .sort((a, b) => Number(b.output.valueSatoshis - a.output.valueSatoshis));
    const txs = [];
    for (const { entry, show } of targets) {
      const shards = openShards(await net.unspent(showContracts(show).boxOffice.lockingBytecode), show);
      if (shards.length === 0) {
        print(`${entry.id}: every shard is already closed`);
        continue;
      }
      if (funding.length === 0) throw new Error(`the studio address ${studio.fundingAddress} has no coin to pay the fee`);
      const built = buildCloseSales({
        show,
        shardUtxos: shards,
        fundingUtxos: [funding[0]],
        changeLockingBytecode: secrets.sales.lockingBytecode,
        signShard: ({ digest }) => signDigest(secrets.sales.privateKey, digest),
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
      const result = evaluateTransaction(signed);
      if (!result.ok) throw new Error(`closeSales for ${entry.id} fails in the 2026 VM: ${describeResult(result)}`);
      const raw = encodeTransaction(signed.transaction);
      const txid = hashTransactionUiOrder(raw);
      txs.push({ label: `close ${entry.id} (${shards.length} shard${shards.length === 1 ? '' : 's'})`, txid: binToHex(txid), hex: binToHex(raw), fee: built.fee });
      // Chain the change into the next close, if any.
      const changeVout = signed.transaction.outputs.length - 1;
      funding = built.change > 0n ? [{ txid, vout: changeVout, output: signed.transaction.outputs[changeVout] }, ...funding.slice(1)] : funding.slice(1);
    }
    if (txs.length === 0) return { network, txs, sent: [], dryRun: !broadcast };
    const summary = [
      `Network: ${network}${network === 'mainnet' ? '  (REAL MONEY)' : ''}`,
      ...txs.map((t) => `  ${t.label}: ${t.hex.length / 2} B, miner fee ${t.fee} sats`),
      `Total miner fees: ${txs.reduce((a, t) => a + t.fee, 0n)} sats, paid from ${studio.fundingAddress}`,
    ].join('\n');
    if (!broadcast) {
      print(summary);
      print('\nDry run: nothing was sent. Add --broadcast to send.');
      return { network, txs, sent: [], dryRun: true };
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
    }
    if (mine && network === 'simnet') await net.mine(1);
    return { network, txs, sent, dryRun: false };
  } finally {
    net.close();
  }
};
