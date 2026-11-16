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
  liveEscrowUtxos,
  listUnspent,
  outpointKey,
  summariseLedgers,
} from '../../../src/chain/index.js';
import {
  addNotices,
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
import { describeError } from './errors.js';
import { createStore } from './store.js';

/** How long the "Ticket held" and "Refund sent" steps stay on screen before the next one (ms). */
export const STEP_PAUSE_MS = 900;
/** After this long without the relay connecting, the dialog offers the other relay (ms). */
export const RELAY_SLOW_MS = 10_000;
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
    WebSocketImpl,
    now = () => Date.now(),
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
    unverified: [],
    rejected: [],
    ledgers: new Map(),
    proof: null,
    wallet: { state: 'idle', name: null, balance: null, scanning: false, error: null, pairing: null, relay: 0, relayStatus: null, relaySlow: false },
    connectOpen: false,
    pendingBuy: null,
    tickets: [],
    returned: {},
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
  const touched = new Set(); // ticket keys this page acted on (shown under their show card)
  const debounce = new Map();
  const settleTried = new Set();
  const subscriptions = [];
  let relaySlowTimer = null;

  // ---------------------------------------------------------------- small helpers

  const showById = (id) => get().shows.find((s) => s.id === id);
  const setFlow = (key, flow) => set((s) => ({ flows: { ...s.flows, [key]: flow === null ? undefined : { ...flow, at: now() } } }));
  const flowOf = (key) => get().flows[key];
  const setWallet = (patch) => set((s) => ({ wallet: { ...s.wallet, ...patch } }));
  const busyStep = (flow) => flow !== undefined && ['preparing', 'approve', 'sending', 'held', 'notice', 'sent', 'door'].includes(flow.step) && flow.error === undefined;

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
    set({ rejected: file.rejected, order: new Map(file.shows.map((s, i) => [s.id, i])) });
    pool = createPool({
      network,
      ...(runtime.servers !== undefined && { servers: runtime.servers }),
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
    const first = showsOnSale(file.shows, height);
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
    await session?.disconnect();
    lastScan = null;
    local.clear();
    setWallet({ state: 'idle', name: null, balance: null, pairing: null, error: null });
    set({ tickets: [] });
  };

  /** Read the wallet's addresses and coins (no tickets). */
  const rescan = async () => {
    if (session?.wallet == null || pool === null) return null;
    setWallet({ scanning: true });
    try {
      const scan = await scanWallet({ pool, keys: session.wallet.keys, network });
      lastScan = scan;
      setWallet({ balance: scan.balance, scanning: false });
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
      // The chain wins once it knows the seat and agrees or is further along.
      if (chain !== undefined && (chain.state !== 'held' || mine.state === 'held')) local.delete(key);
      else byKey.set(key, mine);
    }
    const tickets = [...byKey.values()];
    const returned = {};
    for (const t of tickets) {
      const key = ticketKeyOf(t.showId, t.seatHex);
      returned[key] = t.returned ?? returnedFor(t);
    }
    set({ tickets, returned });
    // Sample B: the page asks for the organiser's notice and sends the refund for this wallet's held seats.
    for (const t of tickets) {
      const key = ticketKeyOf(t.showId, t.seatHex);
      if (t.show.kind === 'sample-refund-seat' && t.state === 'held' && t.boughtByThisWallet && flowOf(key) === undefined) refundSeat(key);
    }
  };

  // ---------------------------------------------------------------- sign, check, send

  const signCheckSend = async (key, kind, show, built) => {
    const prompt = promptForBuilt(show, built);
    let request;
    try {
      request = buildSignRequest(built, { pathOf: pathLookup(lastScan.addresses), userPrompt: prompt });
    } catch (e) {
      if (!(e instanceof WalletError) || e.code !== 'unknown-coin') throw e;
      await rescan();
      request = buildSignRequest(built, { pathOf: pathLookup(lastScan.addresses), userPrompt: prompt });
    }
    setFlow(key, { ...(flowOf(key) ?? {}), kind, step: 'approve', prompt, wallet: get().wallet.name, error: undefined });
    const signed = await session.sign(request);
    setFlow(key, { ...flowOf(key), step: 'sending' });
    const checked = assertSignedReply(built, signed);
    return pool.broadcastChecked(checked);
  };

  const fail = (key, kind, e, context) => {
    if (e instanceof WalletError && e.code === 'cancelled') {
      setFlow(key, null);
      return;
    }
    setFlow(key, { ...(flowOf(key) ?? {}), kind, error: describeError(e, context) });
  };

  // ---------------------------------------------------------------- buy

  const localTicketFromBuy = (show, built, txid, buyer) => {
    const seatHex = binToHex(built.seat);
    const txidBytes = hexToBin(txid);
    return {
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

  const upsertLocal = (ticket) => {
    const key = ticketKeyOf(ticket.showId, ticket.seatHex);
    local.set(key, ticket);
    touched.add(key);
    set((s) => ({ tickets: [...s.tickets.filter((t) => ticketKeyOf(t.showId, t.seatHex) !== key), ticket], returned: { ...s.returned, [key]: ticket.returned ?? s.returned[key] ?? null } }));
  };

  /**
   * Buy a ticket for a show. Without a wallet, opens the connect dialog and
   * buys once the wallet is ready.
   */
  const buy = async (showId, { retrying = false, avoid = new Set() } = {}) => {
    const show = showById(showId);
    if (show === undefined) return;
    if (session?.wallet == null || get().wallet.state !== 'connected') {
      set({ pendingBuy: showId });
      if (!get().connectOpen) await connect();
      return;
    }
    if (!retrying && busyStep(flowOf(showId))) return;
    setFlow(showId, { kind: 'buy', step: 'preparing', retrying });
    try {
      const height = (await pool.tip()).height;
      if (!salesOpen(show, height)) {
        throw new DoorstubError(show.cancelled ? 'sales-cancelled' : 'sales-ended', 'sales ended');
      }
      const scan = lastScan !== null && retrying ? lastScan : await rescan();
      const shards = (await openShards(pool, show)).filter((u) => !avoid.has(outpointKey(u.txid, u.vout)));
      if (shards.length === 0) throw Object.assign(new Error('no open box-office shard'), { code: 'no-open-shard' });
      const shard = shards[Math.floor(random() * shards.length) % shards.length];
      const { built } = buildBuyWithCoins({
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
        sent = await signCheckSend(showId, 'buy', show, built);
      } catch (e) {
        if (e instanceof BroadcastError && e.conflict && !retrying) {
          avoid.add(outpointKey(shard.txid, shard.vout));
          setFlow(showId, { kind: 'buy', step: 'preparing', retrying: true });
          return buy(showId, { retrying: true, avoid });
        }
        throw e;
      }
      const ticket = localTicketFromBuy(show, built, sent.txid, scan.receive);
      const key = ticketKeyOf(show.id, ticket.seatHex);
      upsertLocal(ticket);
      setFlow(showId, { ...flowOf(showId), kind: 'buy', step: 'done', ticketKey: key, txid: sent.txid, error: undefined });
      refreshLedger(show)
        .then(() => refreshWallet())
        .catch(() => {});
      if (show.kind === 'sample-refund-seat') refundSeat(key);
      return { txid: sent.txid, key };
    } catch (e) {
      fail(showId, 'buy', e, { show });
      return undefined;
    }
  };

  // ---------------------------------------------------------------- hand back, walk in

  const ticketByKey = (key) => get().tickets.find((t) => ticketKeyOf(t.showId, t.seatHex) === key);

  const handBack = async (key) => {
    const ticket = ticketByKey(key);
    if (ticket === undefined || busyStep(flowOf(key))) return undefined;
    const show = ticket.show;
    touched.add(key);
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
      fail(key, 'handBack', e, { show });
      return undefined;
    }
  };

  const askDoor = async (key, show, txid) => {
    setFlow(key, { ...flowOf(key), step: 'door', error: undefined });
    try {
      const { link } = await api.door({ category: show.categoryHex, txid }, { endpoint: show.door?.endpoint ?? '/api/door' });
      setFlow(key, { ...flowOf(key), step: 'done', link, error: undefined });
    } catch (e) {
      setFlow(key, { ...flowOf(key), step: 'done', doorError: { key: 'doorDown', vars: {}, actions: ['retryDoor'], detail: e.message } });
    }
  };

  const walkIn = async (key) => {
    const ticket = ticketByKey(key);
    if (ticket === undefined || busyStep(flowOf(key))) return undefined;
    const show = ticket.show;
    touched.add(key);
    setFlow(key, { kind: 'walkIn', step: 'preparing' });
    try {
      if (show.kind !== 'real') throw new Error('only a real show has a door');
      if (!ticket.canAct) throw new Error('this ticket cannot walk in from this wallet');
      if (lastScan === null) await rescan();
      const built = buildCheckIn({ show, escrowUtxo: ticket.escrowUtxo, ticketUtxo: ticket.ticketUtxo, contracts: show.contracts });
      const sent = await signCheckSend(key, 'walkIn', show, built);
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

  const refundSeat = async (key) => {
    const ticket = ticketByKey(key);
    if (ticket === undefined || busyStep(flowOf(key))) return undefined;
    const show = ticket.show;
    touched.add(key);
    setFlow(key, { kind: 'refund', step: 'held' });
    await sleep(STEP_PAUSE_MS);
    setFlow(key, { kind: 'refund', step: 'notice' });
    let signature;
    try {
      ({ signature } = await api.notice({ category: show.categoryHex, seat: ticket.seatHex }));
    } catch (e) {
      setFlow(key, { kind: 'refund', step: 'notice', error: { key: 'noticeDown', vars: {}, actions: ['retryRefund'], detail: e.message } });
      return undefined;
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
      setFlow(key, { kind: 'refund', step: 'sent', txid, returned });
      upsertLocal({ ...ticket, state: 'refunded', refundPath: 'refund', spend: { txid, height: 0, path: 'refund' }, escrowUtxo: null, canAct: false, returned, pending: true });
      await sleep(STEP_PAUSE_MS);
      await refreshLedger(show).catch(() => {});
      await refreshWallet().catch(() => {});
      setFlow(key, { kind: 'refund', step: 'back', txid, returned });
      return txid;
    } catch (e) {
      setFlow(key, { kind: 'refund', step: 'notice', error: describeError(e, { show }) });
      return undefined;
    }
  };

  const retryRefund = (key) => {
    setFlow(key, null);
    return refundSeat(key);
  };

  // ---------------------------------------------------------------- the page keeper (APP-BRIEF 5.4)

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
    dismiss: (key) => setFlow(key, null),
    touched: () => new Set(touched),
    onSale: () => (tip() === null ? [] : showsOnSale(get().shows, tip())),
    close,
    get pool() {
      return pool;
    },
    get session() {
      return session;
    },
  };
};
