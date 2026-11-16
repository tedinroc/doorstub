// Wallet addresses from the xpubs a wallet sends in wallet_ready, and a
// gap-limit scan of receive and change over the Fulcrum pool.
//
// WizardConnect sends one xpub per path name ({ name: 'receive' | 'change' |
// 'defi', xpub }); each is the chain node, so address i is its child i.
import { decodeHdPublicKey, deriveHdPublicNodeChild } from '@bitauth/libauth';
import { addressesOfPublicKey, scripthashOf } from '../chain/address.js';
import { listUnspent, mapLimit } from '../chain/queries.js';
import { isPlainCoin } from '../chain/tokens.js';

/** Child index per path name (BCH convention used by WizardConnect). */
export const CHILD = Object.freeze({ receive: 0, change: 1, defi: 7 });

/** Gap limit: stop after this many unused addresses in a row. */
export const GAP_LIMIT = 20;

export class WalletError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WalletError';
    this.code = code;
  }
}

/**
 * Decode wallet_ready paths ([{ name, xpub }]) into chain nodes.
 * Returns { network: 'mainnet' | 'testnet', chains: { receive, change? } }.
 * Refuses a wallet without a receive xpub, or with xpubs of mixed networks.
 */
export const walletKeysFromPaths = (paths) => {
  if (!Array.isArray(paths)) throw new WalletError('bad-wallet', 'wallet sent no paths');
  const chains = {};
  const networks = new Set();
  for (const { name, xpub } of paths) {
    if (name !== 'receive' && name !== 'change') continue;
    const decoded = decodeHdPublicKey(xpub);
    if (typeof decoded === 'string') throw new WalletError('bad-wallet', `wallet sent a bad ${name} xpub: ${decoded}`);
    networks.add(decoded.network);
    chains[name] = decoded.node;
  }
  if (chains.receive === undefined) throw new WalletError('bad-wallet', 'wallet sent no receive xpub');
  if (networks.size !== 1) throw new WalletError('bad-wallet', 'wallet xpubs are for different networks');
  return { network: [...networks][0], chains };
};

/** One wallet address: { path, index, publicKey, pkh, lockingBytecode, address, tokenAddress, scripthash }. */
export const deriveWalletAddress = (keys, path, index, { network = 'mainnet' } = {}) => {
  const node = keys.chains[path];
  if (node === undefined) throw new WalletError('no-path', `wallet has no ${path} xpub`);
  const child = deriveHdPublicNodeChild(node, index);
  if (typeof child === 'string') throw new WalletError('derive-failed', child);
  return { path, index, ...addressesOfPublicKey(child.publicKey, { network }) };
};

/**
 * Gap-limit scan: derive addresses on each chain and ask the pool which ones
 * have history, `gap` at a time, until `gap` unused addresses follow the last
 * used one. Returns { addresses (every derived one, with `used`), used,
 * receive (first unused receive address), change (first unused change
 * address, or receive when the wallet has no change xpub) }.
 */
export const scanAddresses = async ({ pool, keys, gap = GAP_LIMIT, maxIndex = 10_000, network = 'mainnet', concurrency = 20 }) => {
  const all = [];
  const firstUnused = {};
  for (const path of ['receive', 'change']) {
    if (keys.chains[path] === undefined) continue;
    let lastUsed = -1;
    let next = 0;
    const derived = [];
    while (next <= lastUsed + gap && next < maxIndex) {
      const end = Math.min(lastUsed + gap, maxIndex - 1);
      const batch = [];
      for (let index = next; index <= end; index += 1) batch.push(deriveWalletAddress(keys, path, index, { network }));
      const histories = await mapLimit(batch, concurrency, (a) => pool.request('blockchain.scripthash.get_history', [a.scripthash]));
      batch.forEach((a, k) => {
        a.used = Array.isArray(histories[k]) && histories[k].length > 0;
        if (a.used) lastUsed = Math.max(lastUsed, a.index);
      });
      derived.push(...batch);
      next = end + 1;
    }
    firstUnused[path] = derived.find((a) => !a.used && a.index > lastUsed) ?? deriveWalletAddress(keys, path, lastUsed + 1, { network });
    all.push(...derived);
  }
  return {
    addresses: all,
    used: all.filter((a) => a.used),
    receive: firstUnused.receive,
    change: firstUnused.change ?? firstUnused.receive,
  };
};

/**
 * Full wallet scan: addresses, then every coin at the used addresses (tokens
 * included), each tagged with its { path, index }.
 * Returns { ...scanAddresses, utxos, plainCoins, tokenCoins, balance (plain sats, bigint) }.
 */
export const scanWallet = async ({ pool, keys, gap, network = 'mainnet', concurrency = 20 }) => {
  const scanned = await scanAddresses({ pool, keys, gap, network, concurrency });
  const lists = await mapLimit(scanned.used, concurrency, (a) => listUnspent(pool, a.lockingBytecode));
  const utxos = lists.flatMap((list, k) => list.map((u) => ({ ...u, path: scanned.used[k].path, index: scanned.used[k].index })));
  const plainCoins = utxos.filter(isPlainCoin);
  return {
    ...scanned,
    utxos,
    plainCoins,
    tokenCoins: utxos.filter((u) => !isPlainCoin(u)),
    balance: plainCoins.reduce((sum, u) => sum + u.output.valueSatoshis, 0n),
  };
};

/**
 * A lookup from locking bytecode to the wallet path that owns it, for
 * inputPaths: (lockingBytecode) => { path, index } | undefined.
 */
export const pathLookup = (addresses) => {
  const byHash = new Map(addresses.map((a) => [a.scripthash, { path: a.path, index: a.index }]));
  return (lockingBytecode) => byHash.get(scripthashOf(lockingBytecode));
};
