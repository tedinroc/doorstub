// A simulated WizardConnect wallet for tests and the simnet E2E.
// Generalised from probe/test/sim-wallet.js.
//
// - Throwaway mnemonic (fresh by default), never funded on mainnet, NEVER
//   broadcasts: it only signs and answers.
// - Signs only the inputs named in inputPaths, with Schnorr and
//   SIGHASH_ALL | SIGHASH_UTXOS | FORKID (0x61) unless told otherwise.
// - Checks requests the way Selene does: counts, outpoints, sequences and
//   unlocking bytecode must match the source outputs; commitments over 40
//   bytes are refused (strict40); a request without broadcast: false is refused.
// - Exposes its xpubs and addresses (cashaddr, token-aware and plain, pkh,
//   locking bytecode, script hash) so a test can fund it on the simnet.
// - Two ways to pair:
//     inProcessRelay(): an `initiateRelay` for createWalletSession that wires
//       the REAL DappConnectionManager straight to this wallet, no network;
//     pairOverRelay(uri): the real @wizardconnect/wallet manager over the
//       relay named in the URI (the public relays, or any relay the URI names).
//
// This signer is written independently of src/tx/sign.js on purpose, so the
// app's checks run against a second implementation.
import {
  binToHex,
  decodeTransaction,
  deriveHdPath,
  deriveHdPathRelative,
  deriveHdPrivateNodeFromBip39Mnemonic,
  deriveHdPublicNode,
  encodeDataPush,
  encodeHdPublicKey,
  encodeLockingBytecodeP2pkh,
  encodeTransaction,
  flattenBinArray,
  generateBip39Mnemonic,
  generateSigningSerializationBch,
  hash160,
  hash256,
  hexToBin,
  secp256k1,
  sha256,
  utf8ToBin,
} from '@bitauth/libauth';
import {
  PROTOCOL_NAME,
  RelayMsgAction,
  RelayStatus,
  chunkExtensionAdvertisement,
  encodeKeyExchangeURI,
  generateKeyExchangeCredentials,
  toBigInt,
  toUint8Array,
} from '@wizardconnect/core';
import { addressesOfPublicKey } from '../../src/chain/address.js';

export const DEFAULT_SIGHASH = 0x61;
export const CHILD = Object.freeze({ receive: 0, change: 1, defi: 7 });
const PATH_OF_CHILD = { 0: 'receive', 1: 'change', 7: 'defi' };

const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

const must = (value, what) => {
  if (typeof value === 'string') throw new Error(`${what}: ${value}`);
  return value;
};

/** Smallest event emitter: on / off / emit. */
const emitter = () => {
  const handlers = new Map();
  return {
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(fn);
      return this;
    },
    off(event, fn) {
      handlers.get(event)?.delete(fn);
      return this;
    },
    emit(event, ...args) {
      for (const fn of [...(handlers.get(event) ?? [])]) fn(...args);
      return true;
    },
  };
};

/**
 * A @wizardconnect/wallet manager that asks before it shares xpubs, the way
 * Selene does: written from Selene's observed behaviour (its 11/19 connect
 * screen and messages), not from its code.
 */
const askingManager = (Base, askToConnect) =>
  class AskingWalletManager extends Base {
    async pushWalletReady(conn) {
      if (conn.allowed === true) return super.pushWalletReady(conn);
      if (conn.walletReadySentThisCycle) return undefined;
      conn.walletReadySentThisCycle = true;
      // Before the user says yes: the relay key and pairing secret, and no xpubs.
      conn.notificationQueue.push({
        action: RelayMsgAction.WalletReady,
        supported_protocols: [PROTOCOL_NAME],
        wallet_name: this.adapter.walletName,
        wallet_icon: this.adapter.walletIcon,
        time: Math.floor(Date.now() / 1000),
        dapp_discovered: conn.dappDiscovered,
        session: { [PROTOCOL_NAME]: { paths: [] } },
        public_key: conn.walletPublicKeyHex,
        secret: conn.keyExchangeSecret,
        extensions: { chunk: chunkExtensionAdvertisement() },
      });
      this.flushNotificationQueue(conn);
      return undefined;
    }

    async handleDappReady(conn, msg) {
      if (conn.allowed === true) return super.handleDappReady(conn, msg);
      if (msg.dapp_name && !conn.dappName) {
        conn.dappName = msg.dapp_name;
        conn.label = msg.dapp_name;
      }
      if (msg.wallet_discovered) conn.dappDiscovered = true;
      conn.asking ??= Promise.resolve(askToConnect({ dappName: conn.dappName, uri: conn.uri })).then((yes) => {
        if (this.connections.get(conn.id) !== conn) return undefined;
        if (yes !== true) {
          this.disconnect(conn.id);
          return undefined;
        }
        conn.allowed = true;
        conn.walletReadySentThisCycle = false;
        return this.pushWalletReady(conn);
      });
      await conn.asking;
      return undefined;
    }

    handleSignRequest(conn, msg) {
      if (conn.allowed === true) super.handleSignRequest(conn, msg);
    }
  };

/** Parse relay-format source outputs into libauth types. */
export const parseSourceOutputs = (relayOutputs) =>
  relayOutputs.map((so) => ({
    outpointTransactionHash: toUint8Array(so.outpointTransactionHash),
    outpointIndex: so.outpointIndex,
    unlockingBytecode: toUint8Array(so.unlockingBytecode),
    sequenceNumber: so.sequenceNumber,
    lockingBytecode: toUint8Array(so.lockingBytecode),
    valueSatoshis: toBigInt(so.valueSatoshis),
    ...(so.token && {
      token: {
        category: toUint8Array(so.token.category),
        amount: toBigInt(so.token.amount),
        ...(so.token.nft && {
          nft: { capability: so.token.nft.capability, commitment: toUint8Array(so.token.nft.commitment ?? '') },
        }),
      },
    }),
  }));

/**
 * @param {object} [options]
 * @param {string} [options.mnemonic] defaults to a fresh random one
 * @param {'schnorr'|'ecdsa'} [options.algorithm]
 * @param {number} [options.sighash] sighash type byte (default 0x61; negative tests use others)
 * @param {boolean} [options.strict40] refuse commitments over 40 bytes, like Selene
 * @param {'mainnet'|'testnet'} [options.xpubNetwork] network of the xpubs it sends (testnet tests the wrong-network path)
 * @param {(tx: object) => object} [options.tamper] change the signed transaction before returning it (negative tests)
 * @param {(request) => (true | false | string | Promise<true|false|string>)} [options.approve]
 *   decides each request: true signs, false or a string refuses (the string is the error text).
 *   Default: sign everything.
 * @param {string} [options.name]
 */
export const makeSimWallet = ({
  mnemonic = generateBip39Mnemonic(),
  algorithm = 'schnorr',
  sighash = DEFAULT_SIGHASH,
  strict40 = true,
  xpubNetwork = 'mainnet',
  tamper,
  approve = () => true,
  name = 'Doorstub sim wallet',
} = {}) => {
  const root = deriveHdPrivateNodeFromBip39Mnemonic(mnemonic);
  const account = must(deriveHdPath(root, "m/44'/145'/0'"), 'account');
  const chains = new Map(Object.entries(CHILD).map(([pathName, child]) => [child, must(deriveHdPathRelative(account, String(child)), pathName)]));
  const relaySeed = sha256.hash(utf8ToBin(`relay:${mnemonic}`));
  const log = [];

  const privateKeyAt = (child, index) => must(deriveHdPathRelative(chains.get(child), String(index)), 'child').privateKey;
  const publicKeyAt = (child, index) => must(secp256k1.derivePublicKeyCompressed(privateKeyAt(child, index)), 'public key');
  const xpubOf = (child) => encodeHdPublicKey({ network: xpubNetwork, node: deriveHdPublicNode(chains.get(child)) }).hdPublicKey;

  /** { path, index, publicKey, pkh, lockingBytecode, address, tokenAddress, scripthash } */
  const addressAt = (path, index, { network = 'mainnet' } = {}) => ({ path, index, ...addressesOfPublicKey(publicKeyAt(CHILD[path], index), { network }) });

  /** The xpubs it sends in wallet_ready. */
  const paths = () => [
    { name: 'receive', xpub: xpubOf(CHILD.receive) },
    { name: 'change', xpub: xpubOf(CHILD.change) },
    { name: 'defi', xpub: xpubOf(CHILD.defi) },
  ];

  /** Sign a request body ({ transaction: {...}, inputPaths }). Throws with a Selene-like message to refuse. */
  const sign = (request) => {
    const wc = request.transaction;
    if (wc?.broadcast !== false) throw new Error('sim wallet: request did not say broadcast: false');
    if (typeof wc.transaction !== 'string') throw new Error('sim wallet expects a hex transaction');
    const transaction = must(decodeTransaction(hexToBin(wc.transaction)), 'decode');
    const sourceOutputs = parseSourceOutputs(wc.sourceOutputs);
    if (transaction.inputs.length !== sourceOutputs.length) throw new Error('Transaction input and source output counts do not match');
    transaction.inputs.forEach((input, i) => {
      const so = sourceOutputs[i];
      const commitmentTooLong = strict40 && so.token?.nft !== undefined && so.token.nft.commitment.length > 40;
      if (
        !sameBytes(input.outpointTransactionHash, so.outpointTransactionHash) ||
        input.outpointIndex !== so.outpointIndex ||
        input.sequenceNumber !== so.sequenceNumber ||
        !sameBytes(input.unlockingBytecode, so.unlockingBytecode) ||
        commitmentTooLong
      ) {
        throw new Error(`Invalid signing source output at index ${i}`);
      }
    });
    const libauthSources = sourceOutputs.map(({ lockingBytecode, valueSatoshis, token }) => ({ lockingBytecode, valueSatoshis, ...(token && { token }) }));
    let signed = transaction;
    for (const [inputIndex, pathName, addressIndex] of request.inputPaths) {
      const child = CHILD[pathName];
      if (child === undefined) throw new Error(`unknown path ${pathName}`);
      const privateKey = privateKeyAt(child, addressIndex);
      const publicKey = must(secp256k1.derivePublicKeyCompressed(privateKey), 'public key');
      const coveredBytecode = encodeLockingBytecodeP2pkh(hash160(publicKey));
      if (!sameBytes(libauthSources[inputIndex].lockingBytecode, coveredBytecode)) {
        throw new Error(`input ${inputIndex} is not at ${pathName}/${addressIndex}`);
      }
      const digest = hash256(
        generateSigningSerializationBch(
          { inputIndex, sourceOutputs: libauthSources, transaction: signed },
          { coveredBytecode, signingSerializationType: Uint8Array.of(sighash) },
        ),
      );
      const raw = algorithm === 'ecdsa' ? secp256k1.signMessageHashDER(privateKey, digest) : secp256k1.signMessageHashSchnorr(privateKey, digest);
      const signature = Uint8Array.of(...must(raw, 'sign'), sighash);
      const unlockingBytecode = flattenBinArray([encodeDataPush(signature), encodeDataPush(publicKey)]);
      signed = { ...signed, inputs: signed.inputs.map((input, i) => (i === inputIndex ? { ...input, unlockingBytecode } : input)) };
    }
    if (tamper) signed = tamper(signed);
    return binToHex(encodeTransaction(signed));
  };

  /** Decide, then sign or refuse. Resolves { signedTransaction } or { error }. */
  const answer = async (request) => {
    const entry = { at: Date.now(), userPrompt: request.transaction?.userPrompt, inputPaths: request.inputPaths };
    log.push(entry);
    try {
      const verdict = await approve(request);
      if (verdict !== true) {
        entry.outcome = 'refused';
        return { error: typeof verdict === 'string' ? verdict : 'User rejected the request' };
      }
      const signedTransaction = sign(request);
      entry.outcome = 'signed';
      return { signedTransaction };
    } catch (e) {
      entry.outcome = 'refused';
      return { error: e.message };
    }
  };

  const adapter = {
    walletName: name,
    walletIcon: '',
    getRelayPrivateKey: (uri) => sha256.hash(flattenBinArray([relaySeed, utf8ToBin(uri)])),
    getPublicKey: (path, index) => publicKeyAt(path, Number(index)),
    getXpub: (path) => xpubOf(path),
    signTransaction: async (request) => {
      const r = await answer(request);
      if (r.error !== undefined) throw new Error(r.error);
      return { signedTransaction: r.signedTransaction };
    },
  };

  // ------------------------------------------------------------ in-process pairing

  const sessions = new Map();
  const cancels = [];
  /** Sequences of the sign requests it received (in-process mode), repeats it dropped not counted. */
  const requests = [];
  let paused = false;

  /**
   * An `initiateRelay` for createWalletSession({ initiateRelay }) that connects
   * the dapp's real DappConnectionManager to this wallet in memory. It honours
   * `existingCredentials` (restore after reload) by reconnecting to the same
   * session. `pause()` / `resume()` hold the wallet's answers (a wallet that is
   * not looking at its screen). With `holdKeyExchange`, the relay connects but
   * the wallet's key exchange completes only when `joinLate()` is called (a
   * wallet that scans or pastes the link late).
   */
  const inProcessRelay = ({ holdKeyExchange = false } = {}) => (statusCallback, options = {}) => {
    const credentials = options.existingCredentials
      ? { privateKey: options.existingCredentials.privateKey, publicKey: '00'.repeat(32), secret: options.existingCredentials.secret }
      : generateKeyExchangeCredentials();
    const { uri, qrUri } = options.existingCredentials
      ? { uri: 'wiz://in-process', qrUri: 'WIZ://IN-PROCESS' }
      : encodeKeyExchangeURI(credentials.publicKey, credentials.secret, { hostname: 'in-process.invalid', port: 443, protocol: 'wss' });
    const events = emitter();
    const client = emitter();
    let sequence = 1000;
    let open = true;
    let walletReadySent = false;
    let exchanged = !holdKeyExchange;
    /** While a blip is on: { refuse } (true: sends fail; false: they are lost without a word). */
    let down = null;
    const walletPublicKey = sha256.hash(flattenBinArray([relaySeed, utf8ToBin(credentials.privateKey)]));
    const held = [];
    /** Sequences the wallet holds or is answering: like the real wallet library, it drops a repeat of one of these. */
    const active = new Set();
    const deliverToDapp = (msg) => {
      setTimeout(() => {
        if (open) client.emit('message', { time: Math.floor(Date.now() / 1000), ...msg });
      }, 0);
    };
    const walletReady = () => ({
      action: RelayMsgAction.WalletReady,
      wallet_name: name,
      wallet_icon: '',
      supported_protocols: ['hdwalletv1'],
      session: { hdwalletv1: { paths: paths() } },
      public_key: binToHex(walletPublicKey),
      secret: credentials.secret,
    });
    const answerRequest = async (msg) => {
      const r = await answer(msg);
      active.delete(msg.sequence);
      deliverToDapp({
        action: RelayMsgAction.SignTransactionResponse,
        sequence: msg.sequence,
        signedTransaction: r.signedTransaction ?? '',
        ...(r.error !== undefined && { error: r.error }),
      });
    };
    const handle = async (msg) => {
      if (!open) return;
      switch (msg.action) {
        case RelayMsgAction.DappReady:
          if (!msg.wallet_discovered && !walletReadySent) {
            walletReadySent = true;
            deliverToDapp({ ...walletReady(), dapp_discovered: true });
          }
          break;
        case RelayMsgAction.SignTransactionRequest:
          // The dapp sends pending requests again after a reconnect: a repeat of one still on screen is dropped.
          if (active.has(msg.sequence)) break;
          active.add(msg.sequence);
          requests.push(msg.sequence);
          if (paused) held.push(msg);
          else await answerRequest(msg);
          break;
        case RelayMsgAction.Ping:
          deliverToDapp({ action: RelayMsgAction.Pong });
          break;
        case RelayMsgAction.SignCancel: {
          cancels.push({ sequence: msg.sequence, reason: msg.reason });
          const i = held.findIndex((h) => h.sequence === msg.sequence);
          if (i !== -1) held.splice(i, 1);
          active.delete(msg.sequence);
          break;
        }
        case RelayMsgAction.Disconnect:
          sessions.get(credentials.privateKey)?.onDisconnect?.(msg);
          break;
        default:
          break;
      }
    };
    Object.assign(client, {
      relay: async (msg) => {
        if (!open) throw new Error('in-process relay closed');
        if (down !== null) {
          if (down.refuse) throw new Error(typeof down.refuse === 'string' ? down.refuse : 'relay publish failed: not connected');
          return; // lost on the way, as a relay that drops a message
        }
        setTimeout(() => handle(JSON.parse(JSON.stringify(msg))), 0);
      },
      isKeyExchangeComplete: () => open && exchanged,
      nextSequence: () => ++sequence,
      setPeerCapabilities: () => {},
      setPairedPublicKey: () => {},
    });
    const session = {
      credentials,
      /** Wallet-initiated disconnect, as when the user removes the dapp in the wallet. */
      disconnect: (message = 'Wallet disconnected') =>
        deliverToDapp({ action: RelayMsgAction.Disconnect, reason: 'user_disconnect', message }),
      releaseHeld: () => {
        for (const msg of held.splice(0)) answerRequest(msg);
      },
      /**
       * The wallet app is opened again after it went quiet: it says wallet_ready
       * (the dapp then sends its pending requests again with the same sequence).
       */
      wake: () => deliverToDapp({ ...walletReady(), dapp_discovered: true }),
      /**
       * A relay hiccup: the dapp hears "reconnecting", whatever it sends meanwhile
       * is lost (or, with `refuse`, fails to send, with `refuse` as the error's
       * words when it is a string), and after `ms` the relay is back and says
       * "connected" (the dapp then sends dapp_ready again).
       */
      blip: ({ ms = 60, refuse = false } = {}) => {
        down = { refuse };
        statusCallback({ client, status: RelayStatus.reconnecting('in-process blip') });
        setTimeout(() => {
          down = null;
          if (open) statusCallback({ client, status: RelayStatus.connected() });
        }, ms).unref?.();
      },
      joinLate: () => {
        if (!open || exchanged) return;
        exchanged = true;
        events.emit('keyexchangecomplete', walletPublicKey);
      },
    };
    sessions.set(credentials.privateKey, session);
    setTimeout(() => {
      if (!open) return;
      statusCallback({ client, status: RelayStatus.connected() });
      if (exchanged) events.emit('keyexchangecomplete', walletPublicKey);
    }, 0);
    return {
      client,
      uri,
      qrUri,
      credentials,
      events,
      cleanup: () => {
        open = false;
        sessions.delete(credentials.privateKey);
      },
    };
  };

  // ------------------------------------------------------------ real relay pairing

  /**
   * Pair over the relay named in a wiz:// URI with the real
   * @wizardconnect/wallet manager (Node: needs network access to that relay).
   * With `askToConnect` it pairs the way Selene does (seen 11/19): its first
   * wallet_ready carries only its relay key (no xpubs); it asks the user once
   * the dapp's dapp_ready has named the dapp (`askToConnect({ dappName, uri })`
   * resolves true to connect, anything else refuses and disconnects); then it
   * sends wallet_ready again with the xpubs. It ignores sign requests until then.
   * Returns { manager, close() }.
   */
  const pairOverRelay = async (uri, { askToConnect } = {}) => {
    const { installWsCloseGuard } = await import('./node-ws-guard.js');
    installWsCloseGuard();
    const { WalletConnectionManager: Base } = await import('@wizardconnect/wallet');
    const WalletConnectionManager = askToConnect === undefined ? Base : askingManager(Base, askToConnect);
    const manager = new WalletConnectionManager(adapter);
    manager.on('pendingSignRequest', async ({ connectionId, request }) => {
      const r = await answer(request);
      if (r.error !== undefined) manager.sendSignError(connectionId, request.sequence, r.error);
      else manager.sendSignResponse(connectionId, request.sequence, r.signedTransaction);
    });
    manager.connect(uri);
    return { manager, close: () => manager.disconnectAll() };
  };

  return {
    mnemonic,
    name,
    adapter,
    sign,
    paths,
    xpubs: () => Object.fromEntries(paths().map((p) => [p.name, p.xpub])),
    addressAt,
    publicKeyAt,
    pkhAt: (pathName, index) => hash160(publicKeyAt(CHILD[pathName], index)),
    /** Requests it has seen: [{ at, userPrompt, inputPaths, outcome }]. */
    log,
    /** sign_cancel messages it received (in-process mode): [{ sequence, reason }]. */
    cancels,
    /** Sequences of the sign requests it received (in-process mode). */
    requests,
    inProcessRelay,
    pairOverRelay,
    sessions,
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
      for (const s of sessions.values()) s.releaseHeld();
    },
    /** The wallet app opened again: wallet_ready on every in-process session, then held requests are answered. */
    wake: () => {
      paused = false;
      for (const s of sessions.values()) s.wake();
      setTimeout(() => {
        for (const s of sessions.values()) s.releaseHeld();
      }, 20);
    },
    /** A relay hiccup on every in-process session (see the session's `blip`). */
    blip: (options) => {
      for (const s of sessions.values()) s.blip(options);
    },
    /** Complete the key exchange of sessions opened with inProcessRelay({ holdKeyExchange: true }). */
    joinLate: () => {
      for (const s of sessions.values()) s.joinLate();
    },
    pathOfChild: (child) => PATH_OF_CHILD[child],
  };
};
