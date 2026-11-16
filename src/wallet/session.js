// WizardConnect dapp session for Doorstub: pair over the public relays,
// remember the pairing across reloads, learn the wallet's xpubs, send
// sign-only requests one at a time, cancel, disconnect.
//
// Generalised from probe/src/connect.js. Works in the browser and in Node 22.
// Tests inject `initiateRelay` (an in-process relay from
// test/support/sim-wallet.js) so the real DappConnectionManager runs without
// a network.
import { initiateDappRelay } from '@wizardconnect/core';
import { DappConnectionManager } from '@wizardconnect/dapp';
import { ADDRESS_PREFIX } from '../chain/address.js';
import { WalletError, walletKeysFromPaths } from './hd.js';
import { assertSignOnly } from './request.js';

export const DAPP_NAME = 'Doorstub';
export const RELAY_URLS = Object.freeze(['wss://relay.riften.net:443', 'wss://relay.cauldron.quest:443']);
export const SESSION_KEY = 'doorstub-wizardconnect';
/** How long a sign request may wait for the wallet before we give up on it. */
export const SIGN_TIMEOUT_MS = 5 * 60_000;

/**
 * Late join. @wizardconnect/dapp 0.2.7 waits only 30 s after the relay
 * connects for the wallet's key exchange, then stops without ever sending
 * dapp_ready. A wallet that joins later (a pasted link in Paytaca, a slow QR
 * scan) then waits for the dapp forever, while the dapp waits for the wallet.
 * Once the key exchange completes late, the session re-runs the library's own
 * "connected" handler, which sends dapp_ready at once: at most once per
 * LATE_JOIN_NUDGE_MS, and never for a wallet that joined in time. The library
 * itself is not modified. (Carried over from probe/src/connect.js.)
 */
export const LIBRARY_KEY_EXCHANGE_WAIT_MS = 30_000;
export const LATE_JOIN_NUDGE_MS = 10_000;

/** Link that opens Cashonize's web wallet with the pairing URI. */
export const cashonizeLink = (uri) => `https://cashonize.com/?uri=${encodeURIComponent(uri)}`;

/**
 * Everything the connect dialog shows: the QR text (uppercase WIZ:// for an
 * alphanumeric QR), the raw wiz:// link (Selene, and Copy link for Paytaca
 * and OPTN), and the Cashonize link.
 */
export const connectLinks = ({ uri, qrUri }) => ({ uri, qrUri, selene: uri, cashonize: cashonizeLink(uri), copy: uri });

/** In-memory storage with the Web Storage subset the dapp library uses. */
export const memoryStorage = () => {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
};

const defaultStorage = () => {
  try {
    if (globalThis.localStorage !== undefined) return globalThis.localStorage;
  } catch {
    // storage blocked (private mode, sandbox)
  }
  return memoryStorage();
};

/** Wallet facts from a manager after wallet_ready (or restored from storage). */
export const walletInfoOf = (manager) => {
  const paths = manager.getSessionPaths();
  const keys = walletKeysFromPaths(paths);
  return {
    name: manager.walletName ?? 'Your wallet',
    icon: manager.walletIcon ?? null,
    network: keys.network,
    paths: paths.map((p) => p.name),
    keys,
    hasChange: keys.chains.change !== undefined,
  };
};

/**
 * @param {object} [options]
 * @param {string} [options.dappName] "Doorstub"
 * @param {string} [options.dappIcon] icon URL on our origin
 * @param {string[]} [options.relayUrls] relays, primary first
 * @param {object|false} [options.storage] Web Storage subset; false disables remembering the pairing
 * @param {string} [options.sessionKey]
 * @param {Function} [options.initiateRelay] defaults to @wizardconnect/core initiateDappRelay
 * @param {'mainnet'} [options.expectNetwork] wallets on any other network are refused (wallet-wrong-network)
 * @param {number} [options.lateJoinCheckMs] how often to look for a wallet that joined after the library's wait (0 turns the nudge off)
 * @param {(event: { state, error? }) => void} [options.onStatus]
 * @param {(info) => void} [options.onWalletReady]
 * @param {(reason: string, message?: string) => void} [options.onDisconnect]
 */
export const createWalletSession = ({
  dappName = DAPP_NAME,
  dappIcon,
  relayUrls = RELAY_URLS,
  storage = defaultStorage(),
  sessionKey = SESSION_KEY,
  initiateRelay = initiateDappRelay,
  expectNetwork = 'mainnet',
  signTimeoutMs = SIGN_TIMEOUT_MS,
  lateJoinCheckMs = 1_000,
  onStatus = () => {},
  onWalletReady = () => {},
  onDisconnect = () => {},
} = {}) => {
  let manager = null;
  let relay = null;
  let info = null;
  let state = 'idle';
  let inFlight = null;
  let lastPairing = null;
  let lateJoinTimer = null;

  const setState = (next, error) => {
    state = next;
    try {
      onStatus({ state: next, ...(error && { error }) });
    } catch {
      // ignore
    }
  };

  const sessionOptions = storage === false ? { session: false } : { session: { key: sessionKey, storage } };

  const teardown = async (message) => {
    if (lateJoinTimer !== null) clearInterval(lateJoinTimer);
    lateJoinTimer = null;
    const m = manager;
    const r = relay;
    manager = null;
    relay = null;
    info = null;
    if (m !== null) {
      if (message !== undefined) {
        try {
          await m.sendDisconnect(message);
        } catch {
          // best effort
        }
      }
      await m.destroy();
    }
    r?.cleanup();
  };

  const wire = (m, readyHandler) => {
    m.on('walletready', () => {
      let next;
      try {
        next = walletInfoOf(m);
      } catch (e) {
        setState('error', e.message);
        onDisconnect('bad-wallet', e.message);
        return;
      }
      if (next.network !== expectNetwork) {
        const sentence = `This wallet is on ${next.network}. Doorstub runs on Bitcoin Cash ${expectNetwork}; switch the wallet to ${expectNetwork} and connect again.`;
        info = null;
        m.clearStoredSession();
        setState('wrong-network', sentence);
        onDisconnect('wrong-network', sentence);
        return;
      }
      info = next;
      setState('connected');
      readyHandler?.(info);
      onWalletReady(info);
    });
    m.on('disconnect', (reason, message) => {
      if (manager !== m) return;
      info = null;
      m.clearStoredSession();
      setState('disconnected', message);
      onDisconnect(reason, message);
    });
    m.on('reconnecting', () => {
      if (manager === m && state === 'connected') setState('reconnecting');
    });
  };

  /** Relay state per manager, for the late-join nudge. */
  const relayStatus = (m, late = {}) => (payload) => {
    if (payload.client) late.client = payload.client;
    if (payload.status?.status === 'connected') late.connectedAt = Date.now();
    m.updateConnection(payload.client, payload.status);
    const s = payload.status?.status;
    if (s === 'connected' && state === 'reconnecting' && m.isWalletDiscovered()) setState('connected');
    else if (s === 'reconnecting' && state === 'connected') setState('reconnecting', payload.status.error ?? undefined);
  };

  /** Watch for a key exchange that completes after the library stopped waiting (see LIBRARY_KEY_EXCHANGE_WAIT_MS). */
  const watchLateJoin = (m, late) => {
    if (!(lateJoinCheckMs > 0)) return;
    late.nudgedAt = 0;
    lateJoinTimer = setInterval(() => {
      if (manager !== m || m.isWalletDiscovered()) return;
      const client = late.client;
      if (client == null || !(late.connectedAt > 0)) return;
      if (typeof client.isKeyExchangeComplete !== 'function' || !client.isKeyExchangeComplete()) return;
      const now = Date.now();
      if (now - late.connectedAt < LIBRARY_KEY_EXCHANGE_WAIT_MS || now - late.nudgedAt < LATE_JOIN_NUDGE_MS) return;
      late.nudgedAt = now;
      m.updateConnection(client, { status: 'connected' });
    }, lateJoinCheckMs);
    lateJoinTimer.unref?.();
  };

  const ordered = (primary) => [relayUrls[primary % relayUrls.length], ...relayUrls.filter((_, i) => i !== primary % relayUrls.length)];

  /**
   * Start a fresh pairing (closing any previous one). `relay` picks which relay
   * the link points at (0 = first; use 1 to retry when the first is down).
   * Returns connectLinks({ uri, qrUri }).
   */
  const pair = async ({ relay: primary = 0 } = {}) => {
    await teardown(manager !== null ? 'Doorstub started a new pairing' : undefined);
    const m = new DappConnectionManager(dappName, dappIcon, sessionOptions);
    manager = m;
    wire(m);
    const late = {};
    const r = initiateRelay(relayStatus(m, late), { explicitRelayUrls: ordered(primary) });
    relay = r;
    watchLateJoin(m, late);
    m.attachRelay(r);
    setState('pairing');
    lastPairing = connectLinks({ uri: r.uri, qrUri: r.qrUri });
    return lastPairing;
  };

  /**
   * Reconnect a pairing remembered in storage (after a reload). Returns true
   * if one was found; wallet info from the stored xpubs is available at once,
   * and onWalletReady fires again when the wallet answers.
   */
  const restore = async () => {
    if (storage === false) return false;
    await teardown();
    const m = new DappConnectionManager(dappName, dappIcon, sessionOptions);
    const stored = m.loadStoredSession();
    if (stored === null || stored.walletPublicKey === undefined) {
      await m.destroy();
      return false;
    }
    manager = m;
    wire(m);
    let r;
    const late = {};
    try {
      r = initiateRelay(relayStatus(m, late), {
        explicitRelayUrls: ordered(0),
        existingCredentials: { privateKey: stored.privateKey, secret: stored.secret, walletPublicKey: stored.walletPublicKey },
      });
    } catch (e) {
      m.clearStoredSession();
      await teardown();
      return false;
    }
    relay = r;
    m.attachRelay(r);
    watchLateJoin(m, late);
    try {
      const restored = walletInfoOf(m);
      if (restored.network === expectNetwork) info = restored;
    } catch {
      // no usable stored paths; wait for wallet_ready
    }
    setState(info !== null ? 'connected' : 'pairing');
    return true;
  };

  /**
   * Ask the wallet to sign. One request at a time. Resolves with the signed
   * hex; rejects with WalletError: busy | not-connected | timeout | cancelled |
   * rejected (the wallet's own words in `message`) | relay.
   */
  const sign = async (request, { signal, timeoutMs = signTimeoutMs } = {}) => {
    assertSignOnly(request);
    if (manager === null || info === null) throw new WalletError('not-connected', 'Connect a wallet first.');
    if (inFlight !== null) throw new WalletError('busy', 'Another approval is already waiting in your wallet.');
    const controller = new AbortController();
    let why = null;
    const onAbort = () => {
      why = 'cancelled';
      controller.abort(signal.reason ?? 'Cancelled');
    };
    if (signal?.aborted) throw new WalletError('cancelled', 'Cancelled.');
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      why = 'timeout';
      controller.abort('Doorstub stopped waiting for the wallet');
    }, timeoutMs);
    inFlight = { controller };
    try {
      const response = await manager.signTransaction(request, { signal: controller.signal });
      if (typeof response?.signedTransaction !== 'string' || response.signedTransaction.length === 0) {
        throw new WalletError('rejected', 'The wallet answered without a signed transaction.');
      }
      return response.signedTransaction;
    } catch (e) {
      if (e instanceof WalletError) throw e;
      if (why === 'timeout') throw new WalletError('timeout', 'The wallet did not answer in time. Open your wallet to approve, or send the request again.');
      if (why === 'cancelled') throw new WalletError('cancelled', 'Cancelled.');
      // The send failed: the relay refused it, or the relay client dropped it from its queue when the connection
      // closed before it went out ("Connection closed before message could be sent"). The wallet never saw it.
      if (/not connected|relay|publish|connection closed|queue cleared/i.test(e?.message ?? '')) throw new WalletError('relay', `Could not reach the wallet relay: ${e.message}`);
      throw new WalletError('rejected', e?.message ?? String(e));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      inFlight = null;
    }
  };

  /** Cancel the request in flight (the wallet is told). */
  const cancel = (reason = 'Cancelled') => inFlight?.controller.abort(reason);

  /** Forget the pairing and tell the wallet. */
  const disconnect = async () => {
    manager?.clearStoredSession();
    await teardown('Disconnected from Doorstub');
    setState('idle');
  };

  return {
    pair,
    restore,
    sign,
    cancel,
    disconnect,
    get wallet() {
      return info;
    },
    get state() {
      return state;
    },
    get busy() {
      return inFlight !== null;
    },
    get pairing() {
      return lastPairing;
    },
    get manager() {
      return manager;
    },
    /** cashaddr prefix for the connected wallet's network. */
    get prefix() {
      return ADDRESS_PREFIX[expectNetwork];
    },
  };
};
