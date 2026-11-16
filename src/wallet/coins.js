// Coin selection: the smallest set of plain BCH coins (no token coins, ever)
// that pays for a transaction. "Smallest" means fewest coins first (each coin
// adds about 150 bytes and one more signature), then the least value locked up.
import { MAX_BUY_FUNDING_COINS, TOKEN_OUTPUT_SATS, buildBuy, p2pkhLockingBytecode } from '../tx/index.js';
import { isPlainCoin } from '../chain/tokens.js';

export class FundsError extends Error {
  /** need and have in sats (bigint); `tokenOnly` when the wallet holds only token coins. */
  constructor({ need, have, plainCoins, tokenCoins }) {
    const tokenOnly = plainCoins === 0 && tokenCoins > 0;
    super(
      tokenOnly
        ? 'Your wallet only has token coins here; it needs plain BCH to pay.'
        : `Not enough BCH: this needs about ${need} sats and the wallet has ${have} sats in plain coins.`,
    );
    this.name = 'FundsError';
    this.code = tokenOnly ? 'only-token-coins' : 'insufficient-funds';
    this.need = need;
    this.have = have;
    this.tokenOnly = tokenOnly;
  }
}

const value = (coin) => coin.output.valueSatoshis;
const total = (coins) => coins.reduce((sum, c) => sum + value(c), 0n);

/**
 * Pick plain coins whose total reaches `need`.
 * @param {Array} coins wallet UTXOs ({ output: { valueSatoshis, token? } }, any extra fields kept)
 * @param {bigint | ((count: number) => bigint)} need sats needed, or a function of the coin count (fees grow per input)
 * @param {{ maxCoins?: number }} [options]
 * @returns {{ selected: Array, total: bigint, need: bigint }}
 * @throws {FundsError}
 */
export const selectCoins = (coins, need, { maxCoins = MAX_BUY_FUNDING_COINS } = {}) => {
  const needFor = typeof need === 'function' ? need : () => BigInt(need);
  const plain = coins.filter(isPlainCoin).sort((a, b) => (value(b) > value(a) ? 1 : value(b) < value(a) ? -1 : 0));
  const limit = Math.min(maxCoins, plain.length);
  for (let k = 1; k <= limit; k += 1) {
    const target = needFor(k);
    const largest = plain.slice(0, k);
    if (total(largest) < target) continue;
    // Keep the k-1 largest and swap the last one for the smallest coin that still reaches the target.
    const base = plain.slice(0, k - 1);
    const baseTotal = total(base);
    let last = plain[k - 1];
    for (let j = plain.length - 1; j >= k - 1; j -= 1) {
      if (baseTotal + value(plain[j]) >= target) {
        last = plain[j];
        break;
      }
    }
    const selected = [...base, last];
    return { selected, total: baseTotal + value(last), need: target };
  }
  throw new FundsError({
    need: needFor(Math.max(1, limit)),
    have: total(plain),
    plainCoins: plain.length,
    tokenCoins: coins.length - plain.length,
  });
};

/**
 * What a buy takes from the wallet with `count` funding coins: the price, the
 * two 1,000-sat token outputs and the miner fee (measured on a dry run of the
 * real builder, with a change output).
 */
export const buyCost = ({ show, boxOfficeUtxo, buyerPkh, currentHeight, contracts, feeRate }, count) => {
  const fake = Array.from({ length: count }, (_, i) => ({
    txid: new Uint8Array(32).fill(i + 1),
    vout: 0,
    output: { lockingBytecode: p2pkhLockingBytecode(buyerPkh), valueSatoshis: 21_000_000n * 100_000_000n },
  }));
  const dry = buildBuy({ show, boxOfficeUtxo, fundingUtxos: fake, buyerPkh, currentHeight, contracts, ...(feeRate !== undefined && { feeRate }) });
  return BigInt(show.price) + 2n * TOKEN_OUTPUT_SATS + dry.fee;
};

/**
 * Build a buy paid by the smallest coin set. Everything buildBuy takes, plus
 * `coins` (the wallet's UTXOs, tokens included; token coins are never used).
 * Returns { built, selected } where selected[k] funds input k + 1.
 * @throws {FundsError} when the plain coins cannot pay
 */
export const buildBuyWithCoins = ({ coins, ...args }) => {
  const costs = new Map();
  const need = (k) => {
    if (!costs.has(k)) costs.set(k, buyCost(args, k));
    return costs.get(k);
  };
  const { selected } = selectCoins(coins, need);
  const built = buildBuy({ ...args, fundingUtxos: selected.map(({ txid, vout, output }) => ({ txid, vout, output })) });
  return { built, selected };
};
