// Display helpers: BCH amounts, the optional dollar estimate, seat labels,
// short ids and the prompts a wallet shows on its confirm screen.
//
// Prices are in BCH. A dollar figure is only today's estimate (CLAIMS.md 3);
// callers hide it when no rate is available.
import { decodeSeat } from '../tx/index.js';

export const SATS_PER_BCH = 100_000_000n;

const toBig = (sats) => (typeof sats === 'bigint' ? sats : BigInt(sats));

/** 100000n -> "0.001"; 98500n -> "0.000985"; trailing zeros trimmed, at most 8 decimals. */
export const bchNumber = (sats) => {
  const s = toBig(sats);
  const sign = s < 0n ? '-' : '';
  const abs = s < 0n ? -s : s;
  const whole = abs / SATS_PER_BCH;
  const frac = (abs % SATS_PER_BCH).toString().padStart(8, '0').replace(/0+$/, '');
  return `${sign}${whole}${frac ? `.${frac}` : ''}`;
};

/** "0.001 BCH". */
export const formatBch = (sats) => `${bchNumber(sats)} BCH`;

/** "100,000 sats". */
export const formatSats = (sats) => `${toBig(sats).toLocaleString('en-US')} sats`;

/**
 * Dollar estimate for `sats` at `usdPerBch` (a positive number), e.g. "$0.21";
 * "less than $0.01" for tiny amounts; null when there is no usable rate.
 */
export const formatUsd = (sats, usdPerBch) => {
  if (typeof usdPerBch !== 'number' || !Number.isFinite(usdPerBch) || usdPerBch <= 0) return null;
  const usd = (Number(toBig(sats)) / 1e8) * usdPerBch;
  if (usd > 0 && usd < 0.01) return 'less than $0.01';
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

/** "0.001 BCH, about $0.21" (or just "0.001 BCH" without a rate). */
export const priceLine = (sats, usdPerBch) => {
  const usd = formatUsd(sats, usdPerBch);
  return usd === null ? formatBch(sats) : `${formatBch(sats)}, about ${usd}`;
};

/**
 * Seat label: show letter, shard, seat number, e.g. "A-0-12" (shard 0, the
 * 12th seat it sold). Without a prefix: "0-12".
 */
export const seatLabel = (seat, prefix = '') => {
  const { shard, sold } = decodeSeat(seat);
  return prefix ? `${prefix}-${shard}-${sold}` : `${shard}-${sold}`;
};

/** Seat label of a seat at a show (uses the show's seatPrefix). */
export const showSeatLabel = (show, seat) => seatLabel(seat, show.seatPrefix ?? '');

/** "a7adbe...4eb3". */
export const shortTxid = (txid, keep = 6) => {
  const hex = typeof txid === 'string' ? txid : Array.from(txid, (b) => b.toString(16).padStart(2, '0')).join('');
  return hex.length <= keep * 2 + 3 ? hex : `${hex.slice(0, keep)}...${hex.slice(-4)}`;
};

/** "a7adbe...4eb3:2". */
export const shortOutpoint = (txid, vout) => `${shortTxid(txid)}:${vout}`;

/**
 * What the wallet shows on its confirm screen (`userPrompt`). Each says what
 * the signature does and where the money goes.
 */
export const prompts = {
  buy: (show, seat) =>
    `Doorstub: buy seat ${showSeatLabel(show, seat)} for ${formatBch(show.price)}. The money waits in the show's contract.`,
  handBack: (show, seat, refundSats) =>
    `Doorstub: hand back seat ${showSeatLabel(show, seat)}. ${formatBch(refundSats)} comes back to this wallet.`,
  checkIn: (show, seat, payoutSats) =>
    `Doorstub: walk in with seat ${showSeatLabel(show, seat)}. This pays the organiser ${formatBch(payoutSats)}; your ticket stays as a keepsake.`,
};

/**
 * The prompt for a builder result, with amounts read from its own outputs:
 * buy (price), handBack (every output back to the buyer: the refund, plus the
 * ticket's sats when a fee is due), checkIn (the organiser's payout, output 0).
 */
export const promptForBuilt = (show, built) => {
  if (built.kind === 'buy') return prompts.buy(show, built.seat);
  if (built.kind === 'handBack') {
    const buyerLock = built.transaction.outputs[0].lockingBytecode;
    const same = (a) => a.length === buyerLock.length && a.every((x, i) => x === buyerLock[i]);
    const back = built.transaction.outputs.filter((o) => same(o.lockingBytecode)).reduce((sum, o) => sum + o.valueSatoshis, 0n);
    return prompts.handBack(show, built.seat, back);
  }
  if (built.kind === 'checkIn') return prompts.checkIn(show, built.seat, built.transaction.outputs[0].valueSatoshis);
  throw new Error(`no wallet prompt for ${built.kind}`);
};
