// A show's ledger, read from the chain: every escrow coin (one per ticket
// sold), the transaction that made it and the one that spent it, by path.
//
// Source: the history of the show's Escrow address. Every buy pays it and
// every handBack / checkIn / settle / refund spends from it, so its history
// holds the whole story; each transaction is fetched once (and cached) and
// classified by its unlocking bytecode. State comes from the chain, never from
// local storage.
import { binToHex, hexToBin } from '@bitauth/libauth';
import { PATHS, classifyShowTransaction } from './classify.js';
import { createTxCache, getHistory, getTransactions, listUnspent } from './queries.js';
import { outpointKey } from './tokens.js';
import { decodeTaggedCommitment, sameBytes, showContracts } from '../tx/index.js';

/** What happened to a ticket, from its escrow coin's spending path. */
export const STATE_OF_PATH = Object.freeze({
  null: 'held',
  handBack: 'handedBack',
  checkIn: 'walkedIn',
  settle: 'refunded',
  refund: 'refunded',
});

const emptyCounts = () => Object.fromEntries(PATHS.map((p) => [p, 0]));

/**
 * Build the ledger from already-fetched history and transactions (pure).
 * @param {object} args
 * @param {object} args.show
 * @param {object} [args.contracts]
 * @param {Array<{ txidHex, height }>} args.history the Escrow address's history
 * @param {Map<string, { transaction }>} args.transactions by txid hex
 */
export const buildShowLedger = ({ show, contracts = showContracts(show), history, transactions }) => {
  const coins = new Map();
  const classified = [];
  for (const h of history) {
    const entry = transactions.get(h.txidHex);
    if (entry === undefined) continue;
    const c = classifyShowTransaction({ transaction: entry.transaction, show, contracts });
    classified.push({ ...h, ...c });
    for (const made of c.created) {
      coins.set(outpointKey(h.txidHex, made.vout), {
        showId: show.id,
        seat: made.seat,
        seatHex: made.seatHex,
        buyerPkh: made.buyerPkh,
        buyerPkhHex: binToHex(made.buyerPkh),
        value: made.value,
        utxo: { txid: hexToBin(h.txidHex), txidHex: h.txidHex, vout: made.vout, output: made.output },
        buy: { txid: h.txidHex, height: h.height, viaBuy: c.paths.includes('buy') },
        spend: null,
        state: 'held',
      });
    }
  }
  const txCounts = emptyCounts();
  const latest = {};
  const unknownSpends = [];
  for (const c of classified) {
    for (const p of c.paths) {
      if (p in txCounts) {
        txCounts[p] += 1;
        latest[p] = { txid: c.txidHex, height: c.height };
      }
    }
    for (const spend of c.spends) {
      const coin = coins.get(outpointKey(spend.outpoint.txid, spend.outpoint.vout));
      if (coin === undefined) {
        unknownSpends.push({ txid: c.txidHex, ...spend });
        continue;
      }
      coin.spend = { txid: c.txidHex, height: c.height, path: spend.path, ...(spend.scope !== undefined && { scope: spend.scope }) };
      coin.state = STATE_OF_PATH[spend.path];
    }
  }
  const list = [...coins.values()];
  const seatCounts = { sold: list.length, held: 0, handedBack: 0, walkedIn: 0, refunded: 0 };
  for (const coin of list) seatCounts[coin.state] += 1;
  return {
    showId: show.id,
    coins: list,
    bySeat: new Map(list.map((coin) => [coin.seatHex, coin])),
    live: list.filter((coin) => coin.spend === null),
    txCounts,
    seatCounts,
    latest,
    transactions: classified.map(({ txidHex, height, path, paths }) => ({ txid: txidHex, height, path, paths })),
    unknownSpends,
  };
};

/** Fetch a show's Escrow history and build its ledger. */
export const fetchShowLedger = async (pool, show, { contracts = showContracts(show), cache = createTxCache() } = {}) => {
  const history = await getHistory(pool, contracts.escrow.lockingBytecode);
  const transactions = await getTransactions(pool, history.map((h) => h.txidHex), { cache });
  return buildShowLedger({ show, contracts, history, transactions });
};

/** Live escrow coins of a show as builder UTXOs (for settle, refund, hand-back, check-in). */
export const liveEscrowUtxos = (ledger) => ledger.live.map((coin) => ({ txid: coin.utxo.txid, vout: coin.utxo.vout, output: coin.utxo.output }));

/**
 * Proof strip: totals across shows. Returns { txCounts, seatCounts, latest }
 * where latest[path] = { txid, height, showId } is the most recent transaction
 * of that path (unconfirmed counts as most recent).
 */
export const summariseLedgers = (ledgers) => {
  const txCounts = emptyCounts();
  const seatCounts = { sold: 0, held: 0, handedBack: 0, walkedIn: 0, refunded: 0 };
  const latest = {};
  const rank = (h) => (h > 0 ? h : Number.MAX_SAFE_INTEGER);
  for (const ledger of ledgers) {
    for (const p of PATHS) txCounts[p] += ledger.txCounts[p];
    for (const k of Object.keys(seatCounts)) seatCounts[k] += ledger.seatCounts[k];
    for (const [p, l] of Object.entries(ledger.latest)) {
      if (latest[p] === undefined || rank(l.height) >= rank(latest[p].height)) latest[p] = { ...l, showId: ledger.showId };
    }
  }
  return { txCounts, seatCounts, latest };
};

/**
 * Ticket NFTs (and keepsakes) of known shows among wallet coins.
 * Returns [{ show, utxo, seat, seatHex, buyerPkh }].
 */
export const findTicketCoins = ({ utxos, shows }) => {
  const found = [];
  for (const utxo of utxos) {
    const token = utxo.output.token;
    if (token?.nft === undefined || token.nft.capability !== 'none' || token.amount !== 0n) continue;
    const show = shows.find((s) => sameBytes(s.category, token.category));
    if (show === undefined) continue;
    let tagged;
    try {
      tagged = decodeTaggedCommitment(token.nft.commitment);
    } catch {
      continue;
    }
    if (tagged.kind !== 'ticket') continue;
    found.push({ show, utxo, seat: tagged.seat, seatHex: binToHex(tagged.seat), buyerPkh: tagged.buyerPkh });
  }
  return found;
};

/**
 * "My tickets": every ticket of a known show bought by one of the wallet's
 * keys (from the ledgers) or held as an NFT in the wallet, with its live state.
 *
 * state: 'held' (escrow coin exists) | 'walkedIn' (keepsake; checked in) |
 *        'handedBack' (ticket burned, money back) | 'refunded' (settle or notice refund)
 * `canAct` is true when the ticket sits at the buyer's own address next to a
 * live escrow coin, so hand-back and check-in can be built.
 *
 * @param {object} args
 * @param {Array} args.shows show objects
 * @param {Map<string, object>} args.ledgers by show id
 * @param {Uint8Array[]} args.walletPkhs every key hash of the wallet
 * @param {Array} args.walletUtxos the wallet's coins (tokens included)
 */
export const myTickets = ({ shows, ledgers, walletPkhs, walletUtxos }) => {
  const mine = new Set(walletPkhs.map((p) => binToHex(p)));
  const ticketCoins = findTicketCoins({ utxos: walletUtxos, shows });
  const out = new Map();
  const add = (show, coin, ticketUtxo) => {
    const key = `${show.id}:${coin?.seatHex ?? ticketUtxo.seatHex}`;
    const prev = out.get(key);
    if (prev !== undefined) {
      if (ticketUtxo !== undefined && prev.ticketUtxo === null) prev.ticketUtxo = ticketUtxo.utxo;
      return;
    }
    const seatHex = coin?.seatHex ?? ticketUtxo.seatHex;
    const buyerPkhHex = coin?.buyerPkhHex ?? binToHex(ticketUtxo.buyerPkh);
    out.set(key, {
      show,
      showId: show.id,
      seat: coin?.seat ?? ticketUtxo.seat,
      seatHex,
      buyerPkhHex,
      boughtByThisWallet: mine.has(buyerPkhHex),
      state: coin?.state ?? 'unknown',
      refundPath: coin?.state === 'refunded' ? coin.spend.path : undefined,
      buy: coin?.buy ?? null,
      spend: coin?.spend ?? null,
      value: coin?.value ?? null,
      escrowUtxo: coin !== undefined && coin.spend === null ? { txid: coin.utxo.txid, vout: coin.utxo.vout, output: coin.utxo.output } : null,
      ticketUtxo: ticketUtxo?.utxo ?? null,
    });
  };
  for (const show of shows) {
    const ledger = ledgers.get(show.id);
    if (ledger === undefined) continue;
    for (const coin of ledger.coins) if (mine.has(coin.buyerPkhHex)) add(show, coin, undefined);
  }
  for (const t of ticketCoins) add(t.show, ledgers.get(t.show.id)?.bySeat.get(t.seatHex), t);
  const list = [...out.values()];
  for (const ticket of list) {
    const atOwnAddress =
      ticket.ticketUtxo !== null &&
      ticket.ticketUtxo.output.lockingBytecode !== undefined &&
      ticket.boughtByThisWallet &&
      ticket.ticketUtxo.output.lockingBytecode.length === 25 &&
      binToHex(ticket.ticketUtxo.output.lockingBytecode.slice(3, 23)) === ticket.buyerPkhHex;
    ticket.canAct = ticket.state === 'held' && ticket.escrowUtxo !== null && atOwnAddress;
  }
  const order = { held: 0, walkedIn: 1, refunded: 2, handedBack: 3, unknown: 4 };
  const recency = (t) => {
    const h = t.spend?.height ?? t.buy?.height ?? 0;
    return h > 0 ? h : Number.MAX_SAFE_INTEGER;
  };
  return list.sort((a, b) => order[a.state] - order[b.state] || recency(b) - recency(a));
};

/** Ledgers of several shows (in parallel), as a Map by show id. Shows whose fetch fails are left out and listed in `errors`. */
export const fetchLedgers = async (pool, shows, { cache = createTxCache() } = {}) => {
  const ledgers = new Map();
  const errors = [];
  await Promise.all(
    shows.map(async (show) => {
      try {
        ledgers.set(show.id, await fetchShowLedger(pool, show, { contracts: show.contracts, cache }));
      } catch (e) {
        errors.push({ showId: show.id, message: e.message });
      }
    }),
  );
  return Object.assign(ledgers, { errors });
};

/**
 * Discover a wallet's Doorstub tickets: fetch the shows' ledgers and the
 * wallet's coins (tokens included), then join them (see myTickets).
 * `walletAddresses` is a list of { pkh, lockingBytecode } (every address the
 * wallet scan found used, receive and change).
 */
export const discoverTickets = async ({ pool, shows, walletAddresses, ledgers, cache = createTxCache() }) => {
  const [resolvedLedgers, utxoLists] = await Promise.all([
    ledgers ?? fetchLedgers(pool, shows, { cache }),
    Promise.all(walletAddresses.map((a) => listUnspent(pool, a.lockingBytecode))),
  ]);
  return myTickets({
    shows,
    ledgers: resolvedLedgers,
    walletPkhs: walletAddresses.map((a) => a.pkh),
    walletUtxos: utxoLists.flat(),
  });
};
