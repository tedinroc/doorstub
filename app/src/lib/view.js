// View models: plain data the components render. No DOM, no Preact, so the
// wording and state logic are tested in Node (test/app/view.test.js).
import { binToHex, hexToBin } from '@bitauth/libauth';
import {
  blocksUntil,
  estimateTimeOf,
  formatBch,
  formatUsd,
  salesOpen,
  settleOpensAt,
  shortTxid,
  showPhase,
  showSeatLabel,
} from '../../../src/shows/index.js';
import { encodeTicketCommitment } from '../../../src/tx/index.js';
import { LABELS, say } from './copy.js';

export const BLOCK_MINUTES = 10;

/** "1,234". */
export const num = (n) => Number(n).toLocaleString('en-US');

/** Basis points as a percentage: 0 -> "0%", 150 -> "1.5%". */
export const bpsText = (bps) => `${Number((Number(bps) / 100).toFixed(2))}%`;

/** About how long until a block `blocks` from now: "in about 40 min", "in about 5 h 50 min", "in about 3 days", "now". */
export const etaText = (blocks) => {
  const b = Math.max(0, Math.round(Number(blocks)));
  if (b === 0) return 'now';
  const minutes = b * BLOCK_MINUTES;
  if (minutes < 60) return `in about ${minutes} min`;
  if (minutes < 48 * 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m === 0 ? `in about ${h} h` : `in about ${h} h ${m} min`;
  }
  return `in about ${Math.round(minutes / (24 * 60))} days`;
};

/** "14:30" today, "Tue 14:30" another day (the reader's own time zone). */
export const clockText = (date, { now = Date.now(), locale, timeZone } = {}) => {
  const time = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', ...(timeZone && { timeZone }) });
  const day = (d) => d.toLocaleDateString(locale, { year: 'numeric', month: 'numeric', day: 'numeric', ...(timeZone && { timeZone }) });
  if (day(date) === day(new Date(now))) return time;
  return `${date.toLocaleDateString(locale, { weekday: 'short', ...(timeZone && { timeZone }) })} ${time}`;
};

/** Block, local time and ETA for a future height. */
export const whenText = (height, tip, options = {}) => ({
  block: num(height),
  time: clockText(estimateTimeOf(height, tip, { now: options.now ?? Date.now() }), options),
  eta: etaText(blocksUntil(height, tip)),
});

/** Is this a sample show (nobody walks in)? */
export const isSample = (show) => show.kind === 'sample-settle' || show.kind === 'sample-refund-seat';

/**
 * A show card.
 * @param {object} show verified show object (src/shows)
 * @param {{ tip: number, usd?: number|null, ledger?: object, now?: number, locale?: string, timeZone?: string }} ctx
 */
export const showCardModel = (show, { tip, usd = null, ledger, now = Date.now(), locale, timeZone } = {}) => {
  const start = whenText(show.startHeight, tip, { now, locale, timeZone });
  const settle = whenText(settleOpensAt(show), tip, { now, locale, timeZone });
  return {
    id: show.id,
    kind: show.kind,
    letter: show.seatPrefix,
    title: show.title,
    subtitle: show.subtitle,
    card: show.card,
    sample: isSample(show),
    priceBch: formatBch(show.price),
    priceUsd: formatUsd(show.price, usd),
    startLine: say('showStarts', { start: start.block, time: start.time, eta: start.eta }),
    settleLine: say('showSettles', { settle: settle.block, time: settle.time, eta: settle.eta }),
    feesLine: say('showFees', { handBack: bpsText(show.handBackFeeBps), noShow: bpsText(show.noShowFeeBps), cap: num(show.minerFeeCap) }),
    phase: showPhase(show, tip),
    onSale: salesOpen(show, tip),
    startBlock: start.block,
    startEta: start.eta,
    settleBlock: settle.block,
    sold: ledger?.seatCounts?.sold ?? null,
    shards: show.shards,
    serial: show.categoryHex.slice(0, 8).toUpperCase(),
    category: show.categoryHex,
  };
};

/** The stamp on a finished ticket, or null while it is held. */
export const stampOf = (state) => {
  if (state === 'walkedIn') return { text: LABELS.stampWalkedIn, tone: 'green' };
  if (state === 'refunded') return { text: LABELS.stampRefunded, tone: 'red' };
  if (state === 'handedBack') return { text: LABELS.stampHandedBack, tone: 'blue' };
  return null;
};

const STATE_LABEL = {
  held: LABELS.stateHeld,
  walkedIn: LABELS.stateWalkedIn,
  handedBack: LABELS.stateHandedBack,
  refunded: LABELS.stateRefunded,
  unknown: LABELS.stateUnknown,
};

/** Bits of a commitment, for the barcode on the stub (it is the NFT's own bytes). */
export const commitmentBits = (bytes) => Array.from(bytes, (b) => b.toString(2).padStart(8, '0')).join('');

/** Money that came back to the buyer in a spend, read from the spending transaction's outputs (if known). */
const amountText = (sats) => (sats === null || sats === undefined ? null : formatBch(sats));

/**
 * A ticket card.
 * @param {object} ticket from myTickets / discoverTickets, or the app's own record right after a buy
 * @param {{ tip?: number, now?: number, locale?: string, timeZone?: string, returned?: bigint|null }} [ctx]
 */
export const ticketModel = (ticket, { tip, now = Date.now(), locale, timeZone, returned = null } = {}) => {
  const show = ticket.show;
  const seatBytes = ticket.seat instanceof Uint8Array ? ticket.seat : hexToBin(ticket.seatHex);
  const buyerPkh = hexToBin(ticket.buyerPkhHex);
  const state = ticket.state ?? 'unknown';
  const buyTxid = ticket.buy?.txid ?? null;
  const escrow = ticket.escrowUtxo;
  const escrowTxid = escrow ? (typeof escrow.txid === 'string' ? escrow.txid : binToHex(escrow.txid)) : null;
  const lines = [];
  const value = ticket.value ?? escrow?.output?.valueSatoshis ?? null;
  if (state === 'held') {
    if (escrowTxid !== null) lines.push(say('buyHeld', { price: formatBch(show.price), outpoint: `${shortTxid(escrowTxid)}:${escrow.vout}` }));
    else lines.push(say('ticketMoney'));
    if (ticket.canAct === false && ticket.ticketUtxo !== null && ticket.ticketUtxo !== undefined) lines.push(say('movedAway'));
  } else if (state === 'handedBack') {
    if (returned !== null) lines.push(say('handBackDone', { amount: amountText(returned) }));
  } else if (state === 'refunded') {
    const amount = amountText(returned);
    if (amount !== null) lines.push(say(ticket.refundPath === 'settle' ? 'settleDone' : 'noticeDone', { amount }));
  } else if (state === 'walkedIn') {
    lines.push(say('walkedIn'));
  } else {
    lines.push(say('unknownState'));
  }
  const held = state === 'held';
  const canAct = held && ticket.canAct !== false && escrow !== null && escrow !== undefined;
  const settleAt = settleOpensAt(show);
  const settleWhen = tip === undefined ? null : whenText(settleAt, tip, { now, locale, timeZone });
  return {
    key: `${show.id}:${ticket.seatHex}`,
    showId: show.id,
    kind: show.kind,
    title: show.title,
    letter: show.seatPrefix,
    seat: showSeatLabel(show, seatBytes),
    state,
    stateLabel: STATE_LABEL[state] ?? STATE_LABEL.unknown,
    stamp: stampOf(state),
    lines,
    value,
    valueText: amountText(value),
    buyTxid,
    spendTxid: ticket.spend?.txid ?? null,
    refundPath: ticket.refundPath ?? null,
    escrowOutpoint: escrowTxid === null ? null : { txid: escrowTxid, vout: escrow.vout },
    ticketTxid: ticket.ticketUtxo ? (typeof ticket.ticketUtxo.txid === 'string' ? ticket.ticketUtxo.txid : binToHex(ticket.ticketUtxo.txid)) : buyTxid,
    canHandBack: canAct && show.kind !== 'proof',
    canWalkIn: canAct && show.kind === 'real',
    autoRefund: show.kind === 'sample-refund-seat',
    settleLine: held && show.kind !== 'sample-refund-seat' && settleWhen !== null
      ? say('showSettles', { settle: settleWhen.block, time: settleWhen.time, eta: settleWhen.eta })
      : null,
    settleBlocksLeft: tip === undefined ? null : Math.max(0, settleAt - 1 - tip),
    barcode: commitmentBits(encodeTicketCommitment(seatBytes, buyerPkh)),
    serial: (buyTxid ?? ticket.seatHex).slice(0, 8).toUpperCase(),
    confirmed: (ticket.buy?.height ?? 0) > 0,
    pending: ticket.pending === true,
  };
};

/** Proof strip rows from summariseLedgers(). */
export const proofModel = (summary) => {
  const rows = [
    ['buy', LABELS.buys],
    ['handBack', LABELS.handBacks],
    ['checkIn', LABELS.checkIns],
    ['settle', LABELS.settles2],
    ['refund', LABELS.refunds],
  ].map(([path, label]) => ({
    path,
    label,
    count: summary?.txCounts?.[path] ?? 0,
    latest: summary?.latest?.[path]?.txid ?? null,
    latestConfirmed: (summary?.latest?.[path]?.height ?? 0) > 0,
  }));
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  return { rows, total, seats: summary?.seatCounts ?? null };
};

/** Steps of the sample B refund, for the four-step track. */
export const REFUND_STEPS = Object.freeze([
  { id: 'held', label: LABELS.stepHeld },
  { id: 'notice', label: LABELS.stepNotice },
  { id: 'sent', label: LABELS.stepSent },
  { id: 'back', label: LABELS.stepBack },
]);

/** Which steps are done / active for a refund flow step id. */
export const refundTrack = (step) => {
  const at = REFUND_STEPS.findIndex((s) => s.id === step);
  return REFUND_STEPS.map((s, i) => ({ ...s, done: at >= 0 && (i < at || (step === 'back' && i === at)), active: i === at && step !== 'back' }));
};
