// The app's brain, with no DOM: load and verify the shows, follow the chain,
// pair a wallet, and run every money-moving flow (buy, hand back, walk in,
// the sample B refund, the page-side settle push). Components only read the
// store and call these methods, so the whole flow is tested in Node against
// the simnet with the sim wallet (test/app/controller.test.js).
//
// Nothing reaches the network unless it passed a check: a wallet reply goes
// through assertSignedReply (outputs byte-equal, contract inputs untouched,
// sighash ALL only, VM-valid with OUR source outputs); a settle or refund the
// page pushes goes through checkSignatureFree (VM-valid, no wallet input).
// The pool's broadcastChecked takes nothing else.
import { binToHex, hexToBin } from '@bitauth/libauth';
import { initiateDappRelay } from '@wizardconnect/core';
import {
  BroadcastError,
  checkSignatureFree,
  createFulcrumPool,
  createTxCache,
  discoverTickets,
  fetchShowLedger,
  getSourceOutputs,
  getTransaction,
  liveEscrowUtxos,
  listUnspent,
  outpointKey,
  summariseLedgers,
} from '../../../src/chain/index.js';
import {
  addNotices,
  callEnded,
  parseShowsFile,
  promptForBuilt,
  salesOpen,
  seatNotice,
  showPhase,
  showsOnSale,
  verifyShows,
} from '../../../src/shows/index.js';
import {
  WalletError,
  assertSignedReply,
  buildBuyWithCoins,
  buildSignRequest,
  createWalletSession,
  pathLookup,
  scanWallet,
} from '../../../src/wallet/index.js';
import {
  DoorstubError,
  MAX_SETTLE_COINS,
  buildCheckIn,
  buildHandBack,
  buildRefund,
  buildSettle,
  decodeBoxOfficeCommitment,
  sameBytes,
} from '../../../src/tx/index.js';
import { bchNumber } from '../../../src/shows/format.js';
import { describeError } from './errors.js';
import { createStore } from './store.js';

/**
 * The sample B refund is the moment the judge watches, so each step stays on
 * screen long enough to read: at least STEP_MS each (held, organiser notice,
 * refund sent), and a fresh ticket first finishes printing (PRINT_MS, the
 * card's print animation and scroll). From the buy to "Money back" takes
 * about 5 s when the notice and the broadcast are quick.
 */
export const PRINT_MS = 1_100;
export const STEP_MS = 1_300;
/** After this long without the relay connecting, the dialog offers the other relay (ms). */
export const RELAY_SLOW_MS = 10_000;
/**
 * A paired wallet whose relay hiccuped gets this long to come back before the
 * page gives up on it: a buy then starts a new pairing, and a sign request the
 * relay refused to send says the relay did not answer. The session is never
 * thrown away for a blip.
 */
export const RECONNECT_WAIT_MS = 10_000;
/** Pause before re-reading a show after a notification (several often arrive together). */
export const LEDGER_DEBOUNCE_MS = 300;

const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const ticketKeyOf = (showId, seatHex) => `${showId}:${seatHex}`;

/** Open box-office shards of a show, read from the chain (only minting NFTs of the show's category). */
export const openShards = async (pool, show) =>
  (await listUnspent(pool, show.contracts.boxOffice.lockingBytecode)).filter((u) => {
    const token = u.output.token;
    if (token?.nft?.capability !== 'minting' || !sameBytes(token.category, show.category)) return false;
    try {
      return decodeBoxOfficeCommitment(token.nft.commitment).open;
    } catch {
      return false;
    }
  });

/** What came back to the buyer when an escrow coin was spent: the payout at the coin's own index. */
export const payoutOf = (spendTx, coinTxidHex, vout) => {
  const index = spendTx.inputs.findIndex((i) => binToHex(i.outpointTransactionHash) === coinTxidHex && i.outpointIndex === vout);
  if (index < 0) return null;
  return spendTx.outputs[index]?.valueSatoshis ?? null;
};

/** Where the page keeps its door claim secrets: the browser's storage when it allows it, else memory. */
const defaultClaimStorage = () => {
  try {
    const ls = globalThis.localStorage;
    if (ls !== undefined && ls !== null) {
      ls.getItem('doorstub.probe');
      return ls;
    }
  } catch {
    // storage blocked (private mode, sandbox)
  }
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)) };
};

/** Where the page keeps which tickets it acted on, for this tab: sessionStorage when the browser allows it, else memory. */
const defaultTabStorage = () => {
  try {
    const ss = globalThis.sessionStorage;
    if (ss !== undefined && ss !== null) {
      ss.getItem('doorstub.probe');
      return ss;
    }
  } catch {
    // storage blocked
  }
  return null;
};

const TOUCHED_KEY = 'doorstub.touched';
/** How many acted-on tickets the tab remembers (newest kept). */
const TOUCHED_MAX = 40;

const DOOR_RECORD_PREFIX = 'doorstub.door.';
const PAID_PREFIX = 'doorstub.paid.';

/**
 * What to ask an empty wallet for: what is missing, plus 1,000 sats for the
 * extra input's network fee, rounded up to 0.0001 BCH.
 */
export const topUpFor = (need, have) => {
  const missing = BigInt(need) - BigInt(have) + 1_000n;
  const step = 10_000n;
  return missing <= 0n ? step : ((missing + step - 1n) / step) * step;
};

/** Money a hand-back returns to the buyer (every output to the buyer's address). */
const backToBuyer = (built) => {
  const lock = built.transaction.outputs[0].lockingBytecode;
  return built.transaction.outputs.filter((o) => sameBytes(o.lockingBytecode, lock)).reduce((s, o) => s + o.valueSatoshis, 0n);
};

/**
 * @param {object} options
 * @param {object} options.runtime from app/src/lib/runtime.js
 * @param {object} [options.deps] injected for tests
 */
export const createController = ({ runtime, deps = {} }) => {
  const {
    createPool = createFulcrumPool,
    createSession = createWalletSession,
    initiateRelay = initiateDappRelay,
    api,
    fetchShows,
    fetchUsd = async () => null,
    storage,
    dappIcon,
    sleep = sleepDefault,
    random = Math.random,
    keeper = true,
    relayUrls,
    claims = storage ?? defaultClaimStorage(),
    randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
    WebSocketImpl,
    now = () => Date.now(),
    reconnectWaitMs = RECONNECT_WAIT_MS,
    tabStorage = defaultTabStorage(),
  } = deps;
  const network = runtime.network;

  const store = createStore({
    network,
    testHooks: runtime.testHooks === true,
    boot: 'loading',
    bootError: null,
    chain: { status: 'connecting', tip: null, server: null },
    usd: typeof runtime.usd === 'number' && runtime.usd > 0 ? runtime.usd : null,
    shows: [],
    catalogue: [],
    unverified: [],
    rejected: [],
    ledgers: new Map(),
    proof: null,
    wallet: { state: 'idle', name: null, balance: null, scanning: false, error: null, pairing: null, relay: 0, relayStatus: null, relaySlow: false },
    connectOpen: false,
    pendingBuy: null,
    tickets: [],
    returned: {},
    paid: {},
    flows: {},
    keeper: [],
  });
  const get = store.get;
  const set = store.set;

  const cache = createTxCache();
  let pool = null;
  let session = null;
  let lastScan = null;
  let closed = false;
  const local = new Map(); // ticket key -> the app's own record, until the chain shows it
  const boughtAt = new Map(); // ticket key -> the tip when this page bought it (for the countdown bar while the buy is unconfirmed)
  // Ticket keys this page acted on (shown under their show card). Kept for the tab, so a reload keeps finished
  // tickets under their cards (a per-viewer convenience; the page works the same without it).
  const touched = new Set();
  try {
    const saved = JSON.parse(tabStorage?.getItem(TOUCHED_KEY) ?? '[]');
    if (Array.isArray(saved)) for (const k of saved.slice(-TOUCHED_MAX)) if (typeof k === 'string' && /^[\w-]{1,80}:[0-9a-f]{4,20}$/.test(k)) touched.add(k);
  } catch {
    // nothing saved, or storage blocked
  }
  const touch = (key) => {
    touched.delete(key);
    touched.add(key);
    while (touched.size > TOUCHED_MAX) touched.delete(touched.values().next().value);
    try {
      tabStorage?.setItem(TOUCHED_KEY, JSON.stringify([...touched]));
    } catch {
      // storage full or blocked: memory only
    }
  };
  const holding = new Set(); // sample B tickets whose refund steps are on screen: the card stays "held" until "Money back"
  const debounce = new Map();
  const settleTried = new Set();
  const subscriptions = [];
  let relaySlowTimer = null;
  /** An empty wallet: the buy waiting for coins at the wallet's receive address ({ showId, need, have, unsubscribe }). */
  let fundWait = null;

  // ---------------------------------------------------------------- small helpers

  const showById = (id) => get().shows.find((s) => s.id === id);
  const setFlow = (key, flow) => set((s) => ({ flows: { ...s.flows, [key]: flow === null ? undefined : { ...flow, at: now() } } }));
  const flowOf = (key) => get().flows[key];
  const setWallet = (patch) => set((s) => ({ wallet: { ...s.wallet, ...patch } }));
  const busyStep = (flow) => flow !== undefined && ['preparing', 'reconnecting', 'approve', 'sending', 'held', 'notice', 'sent', 'door'].includes(flow.step) && flow.error === undefined;

  const tip = () => get().chain.tip;

  // ---------------------------------------------------------------- chain

  const onPoolStatus = ({ state, server }) => {
    if (state === 'connected') set((s) => ({ chain: { ...s.chain, status: 'connected', server: server ?? s.chain.server } }));
    else if (state === 'reconnecting') set((s) => ({ chain: { ...s.chain, status: 'reconnecting' } }));
    else if (state === 'down') set((s) => ({ chain: { ...s.chain, status: 'down' } }));
  };

  const onHeader = (header) => {
    const before = tip();
    set((s) => ({ chain: { ...s.chain, tip: header.height, status: 'connected' } }));
    if (before !== null && header.height !== before) {
      reverifyPending();
      for (const show of get().shows) maybePushSettle(show);
      if (session?.wallet) refreshWallet().catch(() => {});
    }
  };

  const proofOf = (ledgers) => summariseLedgers([...ledgers.values()]);

  const refreshLedger = async (show) => {
    const ledger = await fetchShowLedger(pool, show, { contracts: show.contracts, cache });
    const ledgers = new Map(get().ledgers);
    ledgers.set(show.id, ledger);
    set({ ledgers, proof: proofOf(ledgers) });
    maybePushSettle(show);
    return ledger;
  };

  const scheduleLedger = (show) => {
    clearTimeout(debounce.get(show.id));
    debounce.set(
      show.id,
      setTimeout(async () => {
        debounce.delete(show.id);
        if (closed) return;
        try {
          await refreshLedger(show);
          if (session?.wallet && get().tickets.some((t) => t.showId === show.id)) await refreshTickets();
        } catch {
          // the next notification or block tries again
        }
      }, LEDGER_DEBOUNCE_MS),
    );
  };

  const watchShow = (show) => {
    let first = true;
    subscriptions.push(
      pool.subscribeScripthash(show.derived.escrowScripthash, () => {
        if (first) {
          first = false;
          return;
        }
        scheduleLedger(show);
      }),
    );
  };

  const addVerified = (verified) => {
    if (verified.length === 0) return;
    const order = get().order ?? new Map();
    const shows = [...get().shows, ...verified.filter((v) => !get().shows.some((s) => s.id === v.id))].sort(
      (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
    );
    set({ shows, unverified: get().unverified.filter((u) => !verified.some((v) => v.id === u.id)) });
    for (const show of verified) watchShow(show);
  };

  const recordFailed = (failed) => {
    if (failed.length === 0) return;
    set((s) => ({
      unverified: [
        ...s.unverified.filter((u) => !failed.some((f) => f.show.id === u.id)),
        ...failed.map((f) => ({ id: f.show.id, title: f.show.title, kind: f.show.kind, code: f.code, message: f.message, show: f.show })),
      ],
    }));
  };

  /** Shows whose genesis was not confirmed yet are checked again on each new block. */
  const reverifyPending = async () => {
    const retry = get().unverified.filter((u) => ['genesis-unconfirmed', 'genesis-unknown', 'genesis-missing'].includes(u.code)).map((u) => u.show);
    if (retry.length === 0) return;
    try {
      const { verified, failed } = await verifyShows(pool, retry, { cache });
      addVerified(verified);
      recordFailed(failed);
      await Promise.all(verified.map((s) => refreshLedger(s).catch(() => {})));
    } catch {
      // next block
    }
  };

  // ---------------------------------------------------------------- boot

  const start = async () => {
    fetchUsd()
      .then((usd) => {
        if (get().usd === null && typeof usd === 'number') set({ usd });
      })
      .catch(() => {});

    let file;
    try {
      file = parseShowsFile(await fetchShows(), { network });
    } catch (e) {
      set({ boot: 'failed', bootError: { key: 'showsFailed', vars: {}, actions: ['reload'], detail: e.message } });
      return;
    }
    // The cards are drawn from shows.json at once; Get a ticket waits until each show's genesis passed its check.
    set({ rejected: file.rejected, catalogue: file.shows, order: new Map(file.shows.map((s, i) => [s.id, i])) });
    pool = createPool({
      network,
      ...(runtime.servers !== undefined && { servers: runtime.servers }),
      // Four servers at once: the first to answer serves the page (a slow pair no longer costs seconds).
      raceWidth: 4,
      allowBroadcast: true,
      onStatus: onPoolStatus,
      ...(WebSocketImpl !== undefined && { WebSocketImpl }),
    });
    pool.subscribeHeaders(onHeader);

    let height;
    for (let attempt = 0; ; attempt += 1) {
      try {
        height = (await pool.tip()).height;
        break;
      } catch (e) {
        set({ bootError: describeError(e), chain: { ...get().chain, status: 'down' } });
        if (closed) return;
        await sleep(Math.min(30_000, 2_000 * 2 ** attempt));
      }
    }
    set((s) => ({ bootError: null, chain: { ...s.chain, tip: s.chain.tip ?? height } }));

    // The shows a visitor can buy first, then the rest (proof strip, older tickets).
    const first = showsOnSale(file.shows, height, { now: now() });
    const rest = file.shows.filter((s) => !first.includes(s));
    const one = await verifyShows(pool, first, { cache });
    addVerified(one.verified);
    recordFailed(one.failed);
    set({ boot: 'ready' });
    restoreWallet().catch(() => {});
    const two = await verifyShows(pool, rest, { cache });
    addVerified(two.verified);
    recordFailed(two.failed);
    await Promise.all(get().shows.map((show) => refreshLedger(show).catch(() => {})));
  };

  // ---------------------------------------------------------------- wallet

  const watchRelay = (cb) => (payload) => {
    const status = payload?.status?.status ?? null;
    if (status === 'connected') {
      clearTimeout(relaySlowTimer);
      setWallet({ relayStatus: 'connected', relaySlow: false });
    } else if (status !== null) setWallet({ relayStatus: status });
    cb(payload);
  };

  const ensureSession = () => {
    if (session !== null) return session;
    session = createSession({
      ...(dappIcon !== undefined && { dappIcon }),
      ...(storage !== undefined && { storage }),
      ...(relayUrls !== undefined && { relayUrls }),
      initiateRelay: (cb, opts) => initiateRelay(watchRelay(cb), opts),
      onStatus: ({ state, error }) => {
        if (state === 'wrong-network') {
          const network2 = /on (\w+)\./.exec(error ?? '')?.[1] ?? 'another network';
          setWallet({ state, error: { key: 'walletWrongNetwork', vars: { network: network2 }, actions: ['connect'] }, name: null, balance: null });
          return;
        }
        if (state === 'disconnected') {
          setWallet({ state, error: { key: 'walletGone', vars: {}, actions: ['connect'] }, name: null, balance: null });
          set({ tickets: [], connectOpen: false });
          lastScan = null;
          stopFundWait();
          return;
        }
        setWallet({ state });
      },
      onWalletReady: (info) => {
        onWalletReady(info).catch(() => {});
      },
    });
    return session;
  };

  const restoreWallet = async () => {
    const s = ensureSession();
    if (await s.restore()) {
      if (s.wallet !== null) await onWalletReady(s.wallet);
    }
  };

  const onWalletReady = async (info) => {
    clearTimeout(relaySlowTimer);
    setWallet({ state: 'connected', name: info.name, error: null, relaySlow: false });
    set({ connectOpen: false });
    await refreshWallet();
    const pending = get().pendingBuy;
    if (pending !== null) {
      set({ pendingBuy: null });
      buy(pending);
    }
  };

  /**
   * Open the connect dialog. A pairing still waiting for its wallet is shown
   * again as it was: a link already pasted into a wallet stays valid (it is
   * never regenerated on a timer or on reopening). `relay` 1 starts a new
   * pairing on the other relay.
   */
  const connect = async ({ relay = 0 } = {}) => {
    const w = get().wallet;
    if (w.state === 'pairing' && w.pairing !== null && w.relay === relay && session !== null) {
      set({ connectOpen: true });
      return w.pairing;
    }
    const s = ensureSession();
    clearTimeout(relaySlowTimer);
    setWallet({ state: 'pairing', pairing: null, relay, relayStatus: null, relaySlow: false, error: null });
    set({ connectOpen: true });
    const links = await s.pair({ relay });
    setWallet({ pairing: links });
    relaySlowTimer = setTimeout(() => {
      if (get().wallet.relayStatus !== 'connected' && get().wallet.state === 'pairing') setWallet({ relaySlow: true });
    }, RELAY_SLOW_MS);
    return links;
  };

  const closeConnect = () => set({ connectOpen: false, pendingBuy: get().wallet.state === 'connected' ? get().pendingBuy : null });

  const disconnect = async () => {
    stopFundWait();
    await session?.disconnect();
    lastScan = null;
    local.clear();
    setWallet({ state: 'idle', name: null, balance: null, pairing: null, error: null });
    set({ tickets: [] });
  };

  const stopFundWait = () => {
    fundWait?.unsubscribe();
    fundWait = null;
  };

  /**
   * The buy found too little plain BCH: show the wallet's receive address and
   * watch it. When coins arrive (a notification for that address, or the
   * next block) and the wallet can pay, the buy runs again by itself; the
   * wallet still has to approve it.
   */
  const waitForFunds = (showId, e) => {
    stopFundWait();
    const target = lastScan?.receive;
    if (target === undefined || pool === null) return null;
    const need = BigInt(e.need ?? 0n);
    const have = BigInt(lastScan.balance ?? e.have ?? 0n);
    const amount = topUpFor(need, have);
    let first = true;
    const unsubscribe = pool.subscribeScripthash(target.scripthash, () => {
      if (first) {
        first = false;
        return;
      }
      rescan().catch(() => {});
    });
    fundWait = { showId, need, have, unsubscribe };
    return { address: target.address, amount: bchNumber(amount), uri: `${target.address}?amount=${bchNumber(amount)}` };
  };

  /** Read the wallet's addresses and coins (no tickets). */
  const rescan = async () => {
    if (session?.wallet == null || pool === null) return null;
    setWallet({ scanning: true });
    try {
      const scan = await scanWallet({ pool, keys: session.wallet.keys, network });
      lastScan = scan;
      setWallet({ balance: scan.balance, scanning: false });
      if (fundWait !== null && scan.balance > fundWait.have && scan.balance >= fundWait.need) {
        const { showId } = fundWait;
        stopFundWait();
        buy(showId);
      }
      return scan;
    } catch (e) {
      setWallet({ scanning: false });
      throw e;
    }
  };

  /** Coins, then tickets. */
  const refreshWallet = async () => {
    const scan = await rescan();
    if (scan !== null) await refreshTickets();
    return scan;
  };

  const returnedFor = (ticket) => {
    if (ticket.spend === null || ticket.spend === undefined) return null;
    const coin = get().ledgers.get(ticket.showId)?.bySeat.get(ticket.seatHex);
    const spendTx = cache.get(ticket.spend.txid);
    if (coin === undefined || spendTx === undefined) return null;
    return payoutOf(spendTx.transaction, coin.utxo.txidHex, coin.utxo.vout);
  };

  const refreshTickets = async () => {
    if (lastScan === null) return;
    const shows = get().shows;
    const found = await discoverTickets({ pool, shows, walletAddresses: lastScan.used, ledgers: get().ledgers, cache });
    const byKey = new Map(found.map((t) => [ticketKeyOf(t.showId, t.seatHex), t]));
    for (const [key, mine] of local) {
      const chain = byKey.get(key);
      // The chain wins once it knows the seat and agrees or is further along (but not while a refund's steps are on screen).
      if (chain !== undefined && !holding.has(key) && (chain.state !== 'held' || mine.state === 'held')) local.delete(key);
      else byKey.set(key, mine);
    }
    const tickets = [...byKey.values()].map((t) => {
      const at = boughtAt.get(ticketKeyOf(t.showId, t.seatHex));
      return at === undefined || t.boughtAtTip !== undefined ? t : { ...t, boughtAtTip: at };
    });
    const returned = {};
    const paid = {};
    for (const t of tickets) {
      const key = ticketKeyOf(t.showId, t.seatHex);
      returned[key] = t.returned ?? returnedFor(t);
      const buyTxid = t.buy?.txid;
      if (buyTxid === undefined || t.boughtByThisWallet !== true) continue;
      const known = knownPaid(buyTxid);
      if (known !== undefined) paid[buyTxid] = known;
      else if (t.state === 'handedBack' || t.state === 'refunded') paidFromChain(buyTxid);
    }
    set((st) => ({ tickets, returned, paid: { ...st.paid, ...paid } }));
    // Sample B: the page asks for the organiser's notice and sends the refund for this wallet's held seats.
    for (const t of tickets) {
      const key = ticketKeyOf(t.showId, t.seatHex);
      if (t.show.kind === 'sample-refund-seat' && t.state === 'held' && t.boughtByThisWallet && flowOf(key) === undefined) refundSeat(key);
    }
  };

  // ---------------------------------------------------------------- what the wallet paid for a ticket

  // What a buy cost the wallet: its coins in, less the change back (the price, the 2,000 sats the
  // ticket and its marker carry, and the network fee). Kept per buy txid; computed from the chain
  // for a ticket this page did not buy in this session.
  const paidByBuy = new Map();
  const rememberPaid = (txid, sats) => {
    paidByBuy.set(txid, sats);
    try {
      claims.setItem(PAID_PREFIX + txid, sats.toString());
    } catch {
      // storage blocked: memory only
    }
  };
  const knownPaid = (txid) => {
    if (paidByBuy.has(txid)) return paidByBuy.get(txid);
    try {
      const saved = claims.getItem(PAID_PREFIX + txid);
      if (typeof saved === 'string' && /^\d+$/.test(saved)) {
        paidByBuy.set(txid, BigInt(saved));
        return paidByBuy.get(txid);
      }
    } catch {
      // storage blocked
    }
    return undefined;
  };
  const paidPending = new Set();
  /** The buy's wallet inputs less its change (outputs from index 3 on), read from the network. */
  const paidFromChain = async (txid) => {
    if (paidPending.has(txid) || pool === null) return;
    paidPending.add(txid);
    try {
      const { transaction } = await getTransaction(pool, txid, { cache });
      const sources = await getSourceOutputs(pool, transaction, { cache });
      const walletIn = sources.slice(1).reduce((sum, o) => sum + o.valueSatoshis, 0n);
      const change = transaction.outputs.slice(3).reduce((sum, o) => sum + o.valueSatoshis, 0n);
      if (walletIn > change) {
        rememberPaid(txid, walletIn - change);
        set((st) => ({ paid: { ...st.paid, [txid]: walletIn - change } }));
      }
    } catch {
      // the line is left out; nothing else depends on it
    } finally {
      paidPending.delete(txid);
    }
  };

  // ---------------------------------------------------------------- relay hiccups

  /**
   * Wait until the paired wallet is back ('connected'), up to `ms`. Resolves
   * true when it is, false when the wait ran out or the session ended.
   */
  const waitConnected = (ms = reconnectWaitMs) =>
    new Promise((resolve) => {
      if (get().wallet.state === 'connected') {
        resolve(true);
        return;
      }
      let timer = null;
      let unsubscribe = null;
      const done = (value) => {
        clearTimeout(timer);
        unsubscribe?.();
        resolve(value);
      };
      unsubscribe = store.subscribe((s) => {
        if (s.wallet.state === 'connected') done(true);
        else if (s.wallet.state !== 'reconnecting') done(false);
      });
      timer = setTimeout(() => done(false), ms);
    });

  /** Show "Reconnecting to your wallet." on `key` while waiting for the relay; true once the wallet is back. */
  const reconnectFor = async (key, kind) => {
    setFlow(key, { ...(flowOf(key) ?? {}), kind, step: 'reconnecting', error: undefined });
    return waitConnected();
  };

  /**
   * session.sign, sent once more only when the send itself failed (a 'relay'
   * error: the relay refused the request or closed before it went out, so the
   * wallet never got it): after the relay is back, a new request. A request
   * that went out is never cancelled or sent again because the relay or the
   * wallet was away for a while: the relay keeps it, and when the wallet comes
   * back (wallet_ready) the WizardConnect library sends it again with the same
   * sequence, which the wallet shows once. Anything else is thrown as it is.
   */
  const signThroughRelay = async (key, kind, request) => {
    try {
      return await session.sign(request);
    } catch (e) {
      if (!(e instanceof WalletError) || (e.code !== 'relay' && e.code !== 'not-connected') || session?.wallet == null) throw e;
      if (!(await reconnectFor(key, kind))) throw e;
      setFlow(key, { ...flowOf(key), step: 'approve' });
      return session.sign(request);
    }
  };

  // ---------------------------------------------------------------- sign, check, send

  /**
   * Ask the wallet to sign `built`, check its reply, then send it.
   * `beforeSend(checked)` runs between the check and the broadcast, when only
   * this page knows the txid (the walk-in reserves its door claim there).
   */
  const signCheckSend = async (key, kind, show, built, { beforeSend } = {}) => {
    const prompt = promptForBuilt(show, built);
    let request;
    try {
      request = buildSignRequest(built, { pathOf: pathLookup(lastScan.addresses), userPrompt: prompt });
    } catch (e) {
      if (!(e instanceof WalletError) || e.code !== 'unknown-coin') throw e;
      await rescan();
      request = buildSignRequest(built, { pathOf: pathLookup(lastScan.addresses), userPrompt: prompt });
    }
    // Sent even while the wallet is 'reconnecting' (a relay blip, or a phone wallet asleep): the relay library queues
    // it or the relay keeps it, and "Approve in {wallet}" tells the person to open the wallet, which brings it back.
    setFlow(key, { ...(flowOf(key) ?? {}), kind, step: 'approve', prompt, wallet: get().wallet.name, error: undefined });
    const signed = await signThroughRelay(key, kind, request);
    setFlow(key, { ...flowOf(key), step: 'sending' });
    const checked = assertSignedReply(built, signed);
    if (beforeSend !== undefined) await beforeSend(checked);
    return pool.broadcastChecked(checked);
  };

  const fail = (key, kind, e, context) => {
    if (e instanceof WalletError && e.code === 'cancelled') {
      setFlow(key, null);
      return;
    }
    setFlow(key, { ...(flowOf(key) ?? {}), kind, error: describeError(e, { ...context, kind }) });
  };

  /**
   * A hand-back or walk-in the network refused as a conflict: read the show's
   * ledger. When the ticket's coin was spent by another transaction (a settle
   * or refund that got there first), refresh the tickets so the card shows
   * what happened, and say so. Returns true when it handled the error.
   */
  const coinSpentFirst = async (key, kind, ticket, e) => {
    if (!(e instanceof BroadcastError && e.conflict)) return false;
    const ledger = await refreshLedger(ticket.show).catch(() => null);
    const coin = ledger?.bySeat.get(ticket.seatHex);
    if (coin?.spend === null || coin?.spend === undefined) return false;
    local.delete(key);
    await refreshTickets().catch(() => {});
    setFlow(key, { kind, step: 'done', error: { key: 'coinSpent', vars: {}, actions: [], detail: e.message } });
    return true;
  };

  // ---------------------------------------------------------------- buy

  const localTicketFromBuy = (show, built, txid, buyer, height) => {
    const seatHex = binToHex(built.seat);
    const txidBytes = hexToBin(txid);
    boughtAt.set(ticketKeyOf(show.id, seatHex), height);
    return {
      boughtAtTip: height,
      show,
      showId: show.id,
      seat: built.seat,
      seatHex,
      buyerPkhHex: binToHex(buyer.pkh),
      boughtByThisWallet: true,
      state: 'held',
      buy: { txid, height: 0 },
      spend: null,
      value: built.transaction.outputs[2].valueSatoshis,
      escrowUtxo: { txid: txidBytes, vout: 2, output: built.transaction.outputs[2] },
      ticketUtxo: { txid: txidBytes, txidHex: txid, vout: 1, output: built.transaction.outputs[1] },
      canAct: true,
      pending: true,
    };
  };

  /**
   * A buy only while the show sells: tip below its startHeight, not cancelled,
   * and for a real show before its call ends by the reader's clock. Checked
   * before the wallet is asked and again right before the broadcast, since an
   * approval can take minutes.
   */
  const assertSalesOpen = (show, height) => {
    if (salesOpen(show, height, { now: now() })) return;
    if (!show.cancelled && show.kind === 'real' && callEnded(show, now())) throw new DoorstubError('call-ended', 'the call is over');
    throw new DoorstubError(show.cancelled ? 'sales-cancelled' : 'sales-ended', 'sales ended');
  };

  /**
   * A real show's walk-in closes when its call ends by the reader's clock, and
   * a cancelled show has none (a check-in would pay its organiser): checked
   * before signing and again right before sending.
   */
  const assertWalkInOpen = (show) => {
    if (show.cancelled) throw new Error('the organiser cancelled this show, so it has no walk-in');
    if (callEnded(show, now())) throw new DoorstubError('call-ended', 'the call is over');
  };

  const upsertLocal = (ticket) => {
    const key = ticketKeyOf(ticket.showId, ticket.seatHex);
    local.set(key, ticket);
    touch(key);
    set((s) => ({ tickets: [...s.tickets.filter((t) => ticketKeyOf(t.showId, t.seatHex) !== key), ticket], returned: { ...s.returned, [key]: ticket.returned ?? s.returned[key] ?? null } }));
  };

  /**
   * Buy a ticket for a show. Without a wallet, opens the connect dialog and
   * buys once the wallet is ready.
   */
  const buy = async (showId, { retrying = false, avoid = new Set(), reason } = {}) => {
    const show = showById(showId);
    if (show === undefined) return;
    // A relay hiccup is not a lost wallet: wait for it to come back before starting a new pairing.
    if (session?.wallet != null && get().wallet.state === 'reconnecting') {
      if (busyStep(flowOf(showId))) return;
      await reconnectFor(showId, 'buy');
      setFlow(showId, null);
    }
    if (session?.wallet == null || get().wallet.state !== 'connected') {
      set({ pendingBuy: showId });
      if (!get().connectOpen) await connect();
      return;
    }
    if (!retrying && busyStep(flowOf(showId))) return;
    if (fundWait?.showId === showId) stopFundWait();
    setFlow(showId, { kind: 'buy', step: 'preparing', retrying, ...(reason !== undefined && { retryReason: reason }) });
    try {
      const height = (await pool.tip()).height;
      assertSalesOpen(show, height);
      const scan = lastScan !== null && retrying ? lastScan : await rescan();
      const shards = (await openShards(pool, show)).filter((u) => !avoid.has(outpointKey(u.txid, u.vout)));
      if (shards.length === 0) throw Object.assign(new Error('no open box-office shard'), { code: 'no-open-shard' });
      const shard = shards[Math.floor(random() * shards.length) % shards.length];
      const { built, selected } = buildBuyWithCoins({
        show,
        boxOfficeUtxo: shard,
        coins: scan.utxos,
        buyerPkh: scan.receive.pkh,
        currentHeight: height,
        notices: show.notices,
        changeLockingBytecode: scan.change.lockingBytecode,
        contracts: show.contracts,
      });
      let sent;
      try {
        // An approval that lands after sales ended (the call is over, or the tip reached the start) is not sent.
        sent = await signCheckSend(showId, 'buy', show, built, { beforeSend: () => assertSalesOpen(show, Math.max(height, tip() ?? height)) });
      } catch (e) {
        if (e instanceof BroadcastError && e.conflict && !retrying) {
          // Which input lost the race? Read the wallet's coins and the open shards again, then ask once more.
          const shardKey = outpointKey(shard.txid, shard.vout);
          setFlow(showId, { kind: 'buy', step: 'preparing', retrying: true });
          await rescan();
          const shardOpen = (await openShards(pool, show)).some((u) => outpointKey(u.txid, u.vout) === shardKey);
          if (!shardOpen) avoid.add(shardKey);
          return buy(showId, { retrying: true, avoid, reason: shardOpen ? 'coinsChanged' : 'shardTaken' });
        }
        throw e;
      }
      const walletIn = selected.reduce((sum, c) => sum + c.output.valueSatoshis, 0n);
      const change = built.transaction.outputs.slice(3).reduce((sum, o) => sum + o.valueSatoshis, 0n);
      rememberPaid(sent.txid, walletIn - change);
      set((st) => ({ paid: { ...st.paid, [sent.txid]: walletIn - change } }));
      const ticket = localTicketFromBuy(show, built, sent.txid, scan.receive, height);
      const key = ticketKeyOf(show.id, ticket.seatHex);
      upsertLocal(ticket);
      setFlow(showId, { ...flowOf(showId), kind: 'buy', step: 'done', ticketKey: key, txid: sent.txid, error: undefined });
      refreshLedger(show)
        .then(() => refreshWallet())
        .catch(() => {});
      if (show.kind === 'sample-refund-seat') refundSeat(key, { fresh: true });
      return { txid: sent.txid, key };
    } catch (e) {
      fail(showId, 'buy', e, { show });
      if (e?.name === 'FundsError') {
        const fund = waitForFunds(showId, e);
        const flow = flowOf(showId);
        if (fund !== null && flow?.error !== undefined) setFlow(showId, { ...flow, error: { ...flow.error, fund } });
      }
      return undefined;
    }
  };

  // ---------------------------------------------------------------- hand back, walk in

  const ticketByKey = (key) => get().tickets.find((t) => ticketKeyOf(t.showId, t.seatHex) === key);

  const handBack = async (key) => {
    const ticket = ticketByKey(key);
    if (ticket === undefined || busyStep(flowOf(key))) return undefined;
    const show = ticket.show;
    touch(key);
    setFlow(key, { kind: 'handBack', step: 'preparing' });
    try {
      if (!ticket.canAct || ticket.escrowUtxo === null || ticket.ticketUtxo === null) throw new Error('this ticket cannot be handed back from this wallet');
      if (lastScan === null) await rescan();
      const built = buildHandBack({ show, escrowUtxo: ticket.escrowUtxo, ticketUtxo: ticket.ticketUtxo, contracts: show.contracts });
      const sent = await signCheckSend(key, 'handBack', show, built);
      const returned = backToBuyer(built);
      upsertLocal({ ...ticket, state: 'handedBack', spend: { txid: sent.txid, height: 0, path: 'handBack' }, escrowUtxo: null, ticketUtxo: null, canAct: false, returned, pending: true });
      setFlow(key, { ...flowOf(key), kind: 'handBack', step: 'done', txid: sent.txid, returned, error: undefined });
      refreshLedger(show)
        .then(() => refreshWallet())
        .catch(() => {});
      return sent;
    } catch (e) {
      if (await coinSpentFirst(key, 'handBack', ticket, e)) return undefined;
      fail(key, 'handBack', e, { show });
      return undefined;
    }
  };

  // The door gives the link to one claimant per check-in: this page, by a
  // random secret it keeps for that check-in (so a retry or a reload gets the
  // link again, and someone who only saw the txid does not).
  const doorRecord = (txid) => {
    try {
      const value = JSON.parse(claims.getItem(DOOR_RECORD_PREFIX + txid) ?? 'null');
      return value !== null && typeof value.claim === 'string' && /^[0-9a-f]{64}$/.test(value.claim) ? value : null;
    } catch {
      return null;
    }
  };
  const saveDoorRecord = (txid, record) => {
    try {
      claims.setItem(DOOR_RECORD_PREFIX + txid, JSON.stringify(record));
    } catch {
      // storage full or blocked: the door still answers this page by its IP
    }
  };
  const doorClaim = (txid) => {
    const known = doorRecord(txid);
    if (known !== null) return known;
    const record = { claim: binToHex(randomBytes(32)) };
    saveDoorRecord(txid, record);
    return record;
  };

  /**
   * Reserve this page's claim on the door's answer, before the check-in is
   * sent. Any failure is only logged: the check-in goes out anyway, and the
   * door still answers this page by its claim when nobody claimed first.
   */
  const reserveDoor = async (show, txid) => {
    const record = doorClaim(txid);
    try {
      const answer = await api.doorReserve({ category: show.categoryHex, txid, claim: record.claim }, { endpoint: show.door?.endpoint ?? '/api/door' });
      saveDoorRecord(txid, { ...record, reserved: true });
      return answer;
    } catch (e) {
      console.warn(`[doorstub] door reservation failed, sending the check-in anyway: ${e?.message ?? e}`);
      return null;
    }
  };

  const askDoor = async (key, show, txid) => {
    setFlow(key, { ...flowOf(key), step: 'door', error: undefined, doorError: undefined });
    try {
      const record = doorClaim(txid);
      const { link } = await api.door({ category: show.categoryHex, txid, claim: record.claim }, { endpoint: show.door?.endpoint ?? '/api/door' });
      saveDoorRecord(txid, { ...record, link });
      setFlow(key, { ...flowOf(key), step: 'done', link, error: undefined });
    } catch (e) {
      // 409: the door already answered another claimant for this check-in. Asking again cannot change that.
      const doorError = e?.alreadyAnswered === true
        ? { key: 'doorTaken', vars: {}, actions: [], detail: e.message }
        : { key: 'doorDown', vars: {}, actions: ['retryDoor'], detail: e?.message };
      setFlow(key, { ...flowOf(key), step: 'done', doorError });
    }
  };

  const walkIn = async (key) => {
    const ticket = ticketByKey(key);
    if (ticket === undefined || busyStep(flowOf(key))) return undefined;
    const show = ticket.show;
    touch(key);
    setFlow(key, { kind: 'walkIn', step: 'preparing' });
    try {
      if (show.kind !== 'real') throw new Error('only a real show has a door');
      // Also reached by Try again on a failed walk-in and by a Walk in button drawn before the call ended.
      assertWalkInOpen(show);
      if (!ticket.canAct) throw new Error('this ticket cannot walk in from this wallet');
      if (lastScan === null) await rescan();
      const built = buildCheckIn({ show, escrowUtxo: ticket.escrowUtxo, ticketUtxo: ticket.ticketUtxo, contracts: show.contracts });
      const sent = await signCheckSend(key, 'walkIn', show, built, {
        // An approval that lands after the call ended is not sent (and the door is not asked).
        beforeSend: (checked) => {
          assertWalkInOpen(show);
          return reserveDoor(show, checked.txid);
        },
      });
      upsertLocal({
        ...ticket,
        state: 'walkedIn',
        spend: { txid: sent.txid, height: 0, path: 'checkIn' },
        escrowUtxo: null,
        ticketUtxo: { txid: hexToBin(sent.txid), txidHex: sent.txid, vout: 1, output: built.transaction.outputs[1] },
        canAct: false,
        pending: true,
      });
      setFlow(key, { ...flowOf(key), kind: 'walkIn', step: 'door', txid: sent.txid, error: undefined });
      refreshLedger(show)
        .then(() => refreshWallet())
        .catch(() => {});
      await askDoor(key, show, sent.txid);
      return sent;
    } catch (e) {
      if (await coinSpentFirst(key, 'walkIn', ticket, e)) return undefined;
      fail(key, 'walkIn', e, { show });
      return undefined;
    }
  };

  /** Ask the door again: after a failed answer, or for a walked-in ticket after a reload (its check-in txid comes from the chain). */
  const retryDoor = async (key) => {
    const ticket = ticketByKey(key);
    const txid = flowOf(key)?.txid ?? (ticket?.spend?.path === 'checkIn' ? ticket.spend.txid : undefined);
    if (txid === undefined || ticket === undefined || ticket.show.kind !== 'real') return;
    if (flowOf(key) === undefined) setFlow(key, { kind: 'walkIn', step: 'door', txid });
    await askDoor(key, ticket.show, txid);
  };

  // ---------------------------------------------------------------- sample B: notice, refund, money back

  /** Wait until `ms` have passed since `since` (a step's minimum time on screen). */
  const holdFor = async (since, ms) => {
    const left = ms - (now() - since);
    if (left > 0) await sleep(left);
  };

  const refundSeat = async (key, { fresh = false } = {}) => {
    const ticket = ticketByKey(key);
    if (ticket === undefined || busyStep(flowOf(key))) return undefined;
    const show = ticket.show;
    touch(key);
    // Keep the card on "held" (no stamp yet) until the money is back, even if the chain is quicker.
    holding.add(key);
    if (!local.has(key)) local.set(key, ticket);
    const stop = (error) => {
      holding.delete(key);
      setFlow(key, { kind: 'refund', step: 'notice', error });
      return undefined;
    };
    setFlow(key, { kind: 'refund', step: 'held' });
    await sleep((fresh ? PRINT_MS : 0) + STEP_MS);
    let since = now();
    setFlow(key, { kind: 'refund', step: 'notice' });
    let signature;
    try {
      ({ signature } = await api.notice({ category: show.categoryHex, seat: ticket.seatHex, ...(ticket.buy?.txid !== undefined && { txid: ticket.buy.txid }) }));
    } catch (e) {
      return stop({ key: 'noticeDown', vars: {}, actions: ['retryRefund'], detail: e.message });
    }
    try {
      const { invalid } = addNotices(show, [{ scope: 'R', seat: ticket.seatHex, signature }]);
      const notice = seatNotice(show, hexToBin(ticket.seatHex));
      if (notice === undefined) throw new Error(`the refund notice did not verify against the show's data key${invalid[0] ? ` (${invalid[0].reason})` : ''}`);
      let escrowUtxo = ticket.escrowUtxo;
      if (escrowUtxo === null || escrowUtxo === undefined) {
        const ledger = await refreshLedger(show);
        const coin = ledger.bySeat.get(ticket.seatHex);
        if (coin === undefined || coin.spend !== null) throw new Error('the seat has no live contract coin');
        escrowUtxo = { txid: coin.utxo.txid, vout: coin.utxo.vout, output: coin.utxo.output };
      }
      const built = buildRefund({ show, escrowUtxos: [escrowUtxo], notices: [notice], contracts: show.contracts });
      const checked = checkSignatureFree(built);
      let txid;
      try {
        txid = (await pool.broadcastChecked(checked)).txid;
      } catch (e) {
        // Someone (the keeper) may have refunded it first.
        const ledger = await refreshLedger(show).catch(() => null);
        const coin = ledger?.bySeat.get(ticket.seatHex);
        if (!(e instanceof BroadcastError && e.conflict && coin?.spend?.path === 'refund')) throw e;
        txid = coin.spend.txid;
      }
      const returned = built.transaction.outputs[0].valueSatoshis;
      await holdFor(since, STEP_MS);
      since = now();
      setFlow(key, { kind: 'refund', step: 'sent', txid, returned });
      await Promise.all([holdFor(since, STEP_MS), refreshLedger(show).catch(() => {})]);
      holding.delete(key);
      upsertLocal({ ...ticket, state: 'refunded', refundPath: 'refund', spend: { txid, height: 0, path: 'refund' }, escrowUtxo: null, canAct: false, returned, pending: true });
      setFlow(key, { kind: 'refund', step: 'back', txid, returned });
      refreshWallet().catch(() => {});
      return txid;
    } catch (e) {
      return stop(describeError(e, { show, kind: 'refund' }));
    }
  };

  const retryRefund = (key) => {
    setFlow(key, null);
    return refundSeat(key);
  };

  // ---------------------------------------------------------------- the page keeper (anyone can push a settle)

  /**
   * A show past its start plus grace with unsettled coins: build the settle
   * (no key needed), check it in the VM and push it. Each coin is tried once
   * per page load; the cron keeper is the backup.
   */
  const maybePushSettle = async (show) => {
    if (!keeper || pool === null) return;
    const height = tip();
    const ledger = get().ledgers.get(show.id);
    if (height === null || ledger === undefined) return;
    if (showPhase(show, height) !== 'settling') return;
    const coins = liveEscrowUtxos(ledger).filter((u) => !settleTried.has(outpointKey(u.txid, u.vout)));
    if (coins.length === 0) return;
    for (const c of coins) settleTried.add(outpointKey(c.txid, c.vout));
    for (let i = 0; i < coins.length; i += MAX_SETTLE_COINS) {
      const batch = coins.slice(i, i + MAX_SETTLE_COINS);
      try {
        const built = buildSettle({ show, escrowUtxos: batch, contracts: show.contracts });
        const sent = await pool.broadcastChecked(checkSignatureFree(built));
        set((s) => ({ keeper: [...s.keeper, { showId: show.id, title: show.title, txid: sent.txid, count: batch.length, at: now() }] }));
      } catch {
        // another page or the keeper got there first; the ledger will say
      }
    }
    scheduleLedger(show);
  };

  const close = async () => {
    closed = true;
    stopFundWait();
    clearTimeout(relaySlowTimer);
    for (const t of debounce.values()) clearTimeout(t);
    for (const unsub of subscriptions) unsub();
    pool?.close();
    // The wallet pairing stays remembered for the next visit.
  };

  return {
    store,
    start,
    connect,
    closeConnect,
    disconnect,
    buy,
    handBack,
    walkIn,
    retryDoor,
    refundSeat,
    retryRefund,
    refreshWallet,
    cancelSign: () => session?.cancel('Cancelled in Doorstub'),
    dismiss: (key) => {
      if (fundWait?.showId === key) stopFundWait();
      setFlow(key, null);
    },
    touched: () => new Set(touched),
    onSale: () => (tip() === null ? [] : showsOnSale(get().shows, tip(), { now: now() })),
    close,
    get pool() {
      return pool;
    },
    get session() {
      return session;
    },
  };
};
