// The keeper: one pass over every show in shows.json. Safe to run every five
// minutes, from the cron Worker, the Node CLI, or twice at once.
//
// Per show, from the chain tip and the show's live marker coins (Fulcrum
// listunspent at its Escrow, mempool counted):
//   - a valid 'C' notice in shows.json      -> refund every coin under it
//   - tip >= startHeight + graceBlocks      -> settle every coin back to its buyer
//   - kind 'sample-refund-seat' before that -> refund every coin with a fresh 'R' notice
//   - otherwise                             -> nothing yet
// Batches hold at most 100 coins (coins that owe a no-show fee first). Each
// transaction spends only marker coins of that show's Escrow, passes the
// worker's rule check (and the 2026 VM where the runtime has it) and is then
// broadcast. Coins already spent (also in the mempool) are not listed, so a
// second pass finds nothing to do; a race with the page or another keeper
// ends as "conflict", which is fine.
import { MAX_REFUND_COINS, MAX_SETTLE_COINS } from '../../src/tx/constants.js';
import { equal, WorkerError } from './bytes.js';
import { publicKeyOf, signDataEcdsa } from './crypto.js';
import { assembleRefund, assembleSettle, batchCoins, coinFromElectrum } from './escrow.js';
import { vet } from './rules.js';
import { refundNoticeMessage } from './shows.js';

/** How many listunspent requests the keeper keeps in flight. */
export const LIST_CONCURRENCY = 6;

/** Run `fn` over `items`, at most `limit` at once. Returns [{ value } | { error }] in order. */
const mapLimit = async (items, limit, fn) => {
  const results = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      try {
        results[i] = { value: await fn(items[i]) };
      } catch (error) {
        results[i] = { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  return results;
};

/** 'on-sale' | 'started' | 'settling' | 'cancelled', as src/shows showPhase. */
export const phaseOf = (show, tip) => {
  if (show.cancelled) return 'cancelled';
  if (tip < show.startHeight) return 'on-sale';
  return tip >= show.startHeight + show.graceBlocks ? 'settling' : 'started';
};

const plan = (show, phase, dataKeyMatches) => {
  if (phase === 'cancelled') return { path: 'refund', scope: 'C' };
  if (phase === 'settling') return { path: 'settle' };
  if (show.kind === 'sample-refund-seat') return dataKeyMatches ? { path: 'refund', scope: 'R' } : { path: null, why: 'signer-not-configured' };
  return { path: null, why: phase === 'on-sale' ? 'sales-open' : 'grace' };
};

/**
 * @param {object} a
 * @param {Array} a.shows worker shows (parseWorkerShows)
 * @param {object} a.chain worker chain client
 * @param {Uint8Array|null} [a.dataKey] studio data key, for 'R' notices
 * @param {Function} [a.vmCheck] the 2026 VM (Node); absent in workerd
 * @param {boolean} [a.dryRun] build and check, never broadcast
 * @param {Function} [a.log]
 * @returns {Promise<{ network, tip, at, sent, shows: Array, errors: Array }>}
 */
export const runKeeper = async ({ shows, chain, dataKey = null, vmCheck, dryRun = false, now = () => new Date(), log = () => {}, listConcurrency = LIST_CONCURRENCY }) => {
  const tip = await chain.tip();
  const report = { network: chain.network, tip, at: now().toISOString(), dryRun, sent: 0, shows: [], errors: [] };
  const dataPk = dataKey === null ? null : publicKeyOf(dataKey);
  // Every show's coins first, a few requests at a time over the same sockets
  // (a catalogue of 50 shows costs a few round trips, not 50).
  const listed = await mapLimit(shows, listConcurrency, (show) => chain.listUnspent(show.escrow.scripthash));
  for (const [index, show] of shows.entries()) {
    const phase = phaseOf(show, tip);
    const entry = { id: show.id, kind: show.kind, phase, liveCoins: 0, ignored: 0, actions: [] };
    report.shows.push(entry);
    try {
      const { path, scope, why } = plan(show, phase, dataPk !== null && equal(dataPk, show.organiserDataPk));
      if (listed[index].error !== undefined) throw listed[index].error;
      const items = listed[index].value;
      const coins = [];
      for (const item of items) {
        const coin = coinFromElectrum(show, item);
        if (coin.ignored === undefined) coins.push(coin);
        else entry.ignored += 1;
      }
      entry.liveCoins = coins.length;
      if (coins.length === 0) continue;
      if (path === null) {
        entry.waiting = why;
        continue;
      }
      const max = path === 'settle' ? MAX_SETTLE_COINS : MAX_REFUND_COINS;
      for (const batch of batchCoins(show, coins, max, { feeFirst: path === 'settle' })) {
        const action = { path, coins: batch.length, seats: batch.map((c) => c.seatHex) };
        if (scope !== undefined) action.scope = scope;
        entry.actions.push(action);
        try {
          let built;
          if (path === 'settle') built = assembleSettle({ show, coins: batch });
          else {
            const notices =
              scope === 'C'
                ? show.notices.filter((n) => n.scope === 'C').slice(0, 1)
                : batch.map((coin) => ({
                    scope: 'R',
                    seat: coin.seat,
                    signature: signDataEcdsa(dataKey, refundNoticeMessage({ scope: 'R', category: show.category, seat: coin.seat })),
                  }));
            built = assembleRefund({ show, coins: batch, notices });
          }
          const vetted = vet({ show, kind: built.kind, transaction: built.transaction, sourceOutputs: built.sourceOutputs, tip, vmCheck });
          action.txid = vetted.txid;
          action.size = vetted.size;
          action.minerFee = Number(built.fee);
          action.vm = vetted.vm;
          if (dryRun) {
            action.status = 'dry-run';
            continue;
          }
          const sent = await chain.broadcast(vetted);
          action.status = sent.alreadyKnown ? 'already-known' : 'sent';
          action.acceptedBy = sent.acceptedBy;
          report.sent += 1;
          log(`${show.id}: ${path} of ${batch.length} coin(s) ${action.status} ${vetted.txid}`);
        } catch (e) {
          if (e instanceof WorkerError && e.code === 'broadcast-refused' && e.details?.conflict) {
            action.status = 'conflict';
            action.error = 'someone spent these coins first (the page, another keeper or the holder)';
          } else {
            action.status = 'failed';
            action.error = e.message;
            report.errors.push({ show: show.id, path, message: e.message });
          }
        }
      }
    } catch (e) {
      entry.error = e.message;
      report.errors.push({ show: show.id, message: e.message });
    }
  }
  return report;
};

/** One line per show with something to say, for logs. */
export const summariseKeeperReport = (report) => {
  const lines = [`keeper ${report.network} tip ${report.tip}: ${report.sent} transaction(s) sent${report.dryRun ? ' (dry run)' : ''}`];
  for (const s of report.shows) {
    if (s.actions.length === 0 && s.error === undefined && s.liveCoins === 0) continue;
    const acts = s.actions.map((a) => `${a.path}${a.scope ? `/${a.scope}` : ''} x${a.coins} ${a.status}${a.txid ? ` ${a.txid}` : ''}${a.error ? ` (${a.error})` : ''}`);
    lines.push(`  ${s.id} [${s.phase}] live ${s.liveCoins}${s.waiting ? `, waiting: ${s.waiting}` : ''}${acts.length ? `: ${acts.join('; ')}` : ''}${s.error ? ` ERROR ${s.error}` : ''}`);
  }
  return lines.join('\n');
};
