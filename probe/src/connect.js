// WizardConnect dapp side for the probe: pair over the public relays, learn
// the wallet's xpubs, send sign-only requests. Works in the browser and in
// Node 22 (global WebSocket), so the self-test drives this same module.
import { encodeLockingBytecodeP2pkh, hash160, lockingBytecodeToCashAddress } from '@bitauth/libauth';
import { initiateDappRelay } from '@wizardconnect/core';
import { DappConnectionManager } from '@wizardconnect/dapp';
import { assertSignOnly } from './wire.js';

export const DAPP_NAME = 'Doorstub probe';
export const RELAY_URLS = ['wss://relay.riften.net:443', 'wss://relay.cauldron.quest:443'];

const CHILD = { receive: 0, change: 1 };

/** Link that opens Cashonize's web wallet with the pairing URI. */
export const cashonizeLink = (uri) => `https://cashonize.com/?uri=${encodeURIComponent(uri)}`;

/**
 * Start a new pairing. Returns { uri, qrUri, manager, close() }.
 * Events: onStatus(statusCode, error), onWalletReady(info), onDisconnect(reason, message).
 */
export const startPairing = ({ onStatus = () => {}, onWalletReady = () => {}, onDisconnect = () => {} } = {}) => {
  const manager = new DappConnectionManager(DAPP_NAME, undefined, { session: false });
  const relay = initiateDappRelay(
    (payload) => {
      manager.updateConnection(payload.client, payload.status);
      onStatus(payload.status.status, payload.status.error);
    },
    { explicitRelayUrls: RELAY_URLS },
  );
  manager.on('walletready', () => {
    try {
      onWalletReady(walletInfo(manager));
    } catch (e) {
      onDisconnect('bad-wallet-ready', e.message);
    }
  });
  manager.on('disconnect', (reason, message) => onDisconnect(reason, message));
  manager.on('reconnecting', () => onStatus('reconnecting', null));
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await manager.sendDisconnect('Doorstub probe closed');
    } catch {
      // best effort
    }
    await manager.destroy();
    relay.cleanup();
  };
  return { uri: relay.uri, qrUri: relay.qrUri, manager, close };
};

/** Address (token-aware and plain) and P2PKH bytecode for one public key. */
export const addressOf = (publicKey, prefix) => {
  const pkh = hash160(publicKey);
  const lockingBytecode = encodeLockingBytecodeP2pkh(pkh);
  const at = (tokenSupport) => {
    const r = lockingBytecodeToCashAddress({ bytecode: lockingBytecode, prefix, tokenSupport });
    if (typeof r === 'string') throw new Error(r);
    return r.address;
  };
  return { pkh, lockingBytecode, tokenAddress: at(true), address: at(false) };
};

/** What the page needs from wallet_ready: name, network, receive index 0. */
export const walletInfo = (manager) => {
  const paths = manager.getSessionPaths();
  const testnet = paths.some((p) => /^tpub/.test(p.xpub));
  const prefix = testnet ? 'bchtest' : 'bitcoincash';
  const publicKey = manager.getPubkey(CHILD.receive, 0n);
  if (publicKey === undefined) throw new Error('wallet sent no receive xpub');
  return {
    name: manager.walletName ?? '(no name)',
    network: testnet ? 'testnet/chipnet' : 'mainnet',
    prefix,
    paths: paths.map((p) => p.name),
    receive0: { ...addressOf(publicKey, prefix), publicKey },
  };
};

/** Receive and change addresses 0..last (for the read-only coin scan). */
export const scanAddresses = (manager, prefix, last = 20) => {
  const out = [];
  for (const path of ['receive', 'change']) {
    if (!manager.hasPath(CHILD[path])) continue;
    for (let index = 0; index <= last; index += 1) {
      const publicKey = manager.getPubkey(CHILD[path], BigInt(index));
      if (publicKey === undefined) continue;
      out.push({ path, index, ...addressOf(publicKey, prefix) });
    }
  }
  return out;
};

/** Send one sign-only request; resolves with the wallet's signed hex, rejects with its error. */
export const requestSignature = async (manager, request, { signal } = {}) => {
  assertSignOnly(request);
  const response = await manager.signTransaction(request, { signal });
  return response.signedTransaction;
};
