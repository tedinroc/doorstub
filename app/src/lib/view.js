// View models: plain data the components render. No DOM, no Preact, so the
// wording and state logic are tested in Node (test/app/view.test.js).
import { binToHex, hexToBin } from '@bitauth/libauth';
import {
  blocksUntil,
  callEndsAt,
  estimateTimeOf,
  formatBch,
  formatUsd,
  salesOpen,
  settleOpensAt,
  shortTxid,
  showPhase,
  showSeatLabel,
} from '../../../src/shows/index.js';
import { TOKEN_OUTPUT_SATS, encodeTicketCommitment } from '../../../src/tx/index.js';
import { LABELS, say } from './copy.js';

export const BLOCK_MINUTES = 10;

/** "1,234". */
export const num = (n) => Number(n).toLocaleString('en-US');

/** A balance for the header chip: at most 4 decimals, rounded down ("0.0189 BCH"). */
export const shortBch = (sats) => {
  const s = typeof sats === 'bigint' ? sats : BigInt(sats);
  return formatBch((s / 10_000n) * 10_000n);
};

/** Basis points as a percentage: 0 -> "0%", 150 -> "1.5%". */
export const bpsText = (bps) => `${Number((Number(bps) / 100).toFixed(2))}%`;

/** How long until `minutes` from now: "in 40 min", "in 5 h 50 min", "in 3 days", "now". */
export const etaMinutes = (minutes) => {
  const total = Math.max(0, Math.round(Number(minutes)));
  if (total === 0) return 'now';
  if (total < 60) return `in ${total} min`;
  if (total < 48 * 60) {
    const h = Math.floor(total / 60);
    const m = total % 60;
    return m === 0 ? `in ${h} h` : `in ${h} h ${m} min`;
  }
  return `in ${Math.round(total / (24 * 60))} days`;
};

/** How long until a block `blocks` from now, at ten minutes a block: "in 40 min", "in 5 h 50 min", "in 3 days", "now". Callers say "about". */
export const etaText = (blocks) => etaMinutes(Math.max(0, Math.round(Number(blocks))) * BLOCK_MINUTES);

/** A short countdown for the ticket: "5 h 40 min", "40 min", "3 days", "now". */
export const countdownText = (blocks) => etaText(blocks).replace(/^in /, '');

/**
 * "Tue 24 Nov, 21:00 GMT+8": always English (the page is English), in the
 * reader's own time zone, with the zone named. Built from parts so no
 * browser locale can mix in its own words ("上午06:06").
 */
export const clockText = (date, { timeZone } = {}) => {
  const parts = {};
  try {
    const format = new Intl.DateTimeFormat('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'shortOffset',
      ...(timeZone && { timeZone }),
    });
    for (const p of format.formatToParts(date)) parts[p.type] = p.value;
  } catch {
    // An engine without shortOffset: UTC, named as such.
    return `${date.toUTCString().slice(0, 11).replace(',', '')}, ${date.toISOString().slice(11, 16)} UTC`;
  }
  // A non-breaking hyphen in "GMT‑5", so a line never breaks inside the zone.
  const zone = (parts.timeZoneName ?? 'UTC').replace(/^GMT$|^GMT\+0$|^UTC$/, 'UTC').replace('-', '\u2011');
  return `${parts.weekday} ${parts.day} ${parts.month}, ${parts.hour}:${parts.minute} ${zone}`;
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
 * A real show's call (its `eventAt` and `durationMin` from shows.json, the
 * organiser's plan) at `now`: { phase: 'before' | 'on' | 'over', time, eta,
 * countdown, minutes }, or null when the show has no call time.
 */
export const callOf = (show, { now = Date.now(), timeZone } = {}) => {
  if (show.kind !== 'real' || typeof show.eventAtMs !== 'number' || !Number.isFinite(show.eventAtMs)) return null;
  const start = show.eventAtMs;
  const minutes = Number(show.durationMin ?? 0);
  const end = start + minutes * 60_000;
  const time = clockText(new Date(start), { timeZone });
  if (now < start) {
    const left = Math.ceil((start - now) / 60_000);
    return { phase: 'before', time, minutes, eta: etaMinutes(left), countdown: etaMinutes(left).replace(/^in /, '') };
  }
  if (now < end) return { phase: 'on', time, minutes, eta: 'on now', countdown: null };
  return { phase: 'over', time, minutes, eta: 'over', countdown: null };
};

/**
 * A show card.
 * @param {object} show verified show object (src/shows)
 * @param {{ tip: number, usd?: number|null, ledger?: object, now?: number, locale?: string, timeZone?: string }} ctx
 */
export const showCardModel = (show, { tip, usd = null, ledger, now = Date.now(), locale, timeZone } = {}) => {
  const start = whenText(show.startHeight, tip, { now, locale, timeZone });
  const settle = whenText(settleOpensAt(show), tip, { now, locale, timeZone });
  const call = callOf(show, { now, timeZone });
  // A real show sells and lets you walk in until its call ends (the reader's clock); its startHeight, hours later,
  // is only the on-chain backstop. So the Door row names the end of the call and never contradicts the Call row.
  const end = show.kind === 'real' ? callEndsAt(show) : null;
  const real = end !== null;
  const until = real ? { time: clockText(new Date(end), { timeZone }), eta: etaMinutes(Math.ceil((end - now) / 60_000)) } : null;
  let startLine;
  if (!real) startLine = say('showStarts', { start: start.block, time: start.time, eta: start.eta });
  else if (now >= end) startLine = null; // the stub says sales and walk-in closed
  else if (salesOpen(show, tip)) startLine = say('realUntil', until);
  else startLine = `${say('showSalesEnded', { start: start.block })} ${say('walkInUntil', until)}`;
  return {
    id: show.id,
    kind: show.kind,
    letter: show.seatPrefix,
    title: show.title,
    // The studio's default subtitle repeats the start block, which the card already shows with its time.
    subtitle: /^Starts at block /.test(show.subtitle ?? '') ? '' : show.subtitle,
    card: show.card,
    sample: isSample(show),
    priceBch: formatBch(show.price),
    priceUsd: formatUsd(show.price, usd),
    startLabel: real ? LABELS.door : LABELS.starts,
    startLine,
    callLine: call === null ? null : say('callAt', { time: call.time, eta: call.eta, minutes: call.minutes }),
    settleLine: say('showSettles', { settle: settle.block, time: settle.time, eta: settle.eta }),
    feesLine: say('showFees', { handBack: bpsText(show.handBackFeeBps), noShow: bpsText(show.noShowFeeBps), cap: num(show.minerFeeCap) }),
    phase: showPhase(show, tip),
    onSale: salesOpen(show, tip, { now }),
    endedLine: real && now >= end ? say('callSalesEnded') : say('showSalesEnded', { start: start.block }),
    startBlock: start.block,
    startEta: start.eta,
    startTime: start.time,
    settleBlock: settle.block,
    settleTime: settle.time,
    sold: ledger?.seatCounts?.sold ?? null,
    shards: show.shards,
    serial: show.categoryHex.slice(0, 8).toUpperCase(),
    category: show.categoryHex,
  };
};

/**
 * The shows on the page, in shows.json order: those on sale, and any show
 * whose sales ended while this wallet still has a ticket to watch there
 * (held, or one this page acted on). So a sample A ticket does not vanish at
 * the start or jump across the page: its card stays where it was, the next
 * instance comes right after it, and the refund arrives on it.
 */
export const listedShows = ({ shows, onSale, tickets, touched = new Set() }) => {
  const watching = (show) => tickets.some((t) => t.showId === show.id && (t.state === 'held' || touched.has(`${t.showId}:${t.seatHex}`)));
  return shows.filter((show) => onSale.includes(show) || watching(show));
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
export const ticketModel = (ticket, { tip, now = Date.now(), locale, timeZone, returned = null, paid = null } = {}) => {
  const show = ticket.show;
  const seatBytes = ticket.seat instanceof Uint8Array ? ticket.seat : hexToBin(ticket.seatHex);
  const buyerPkh = hexToBin(ticket.buyerPkhHex);
  const state = ticket.state ?? 'unknown';
  const buyTxid = ticket.buy?.txid ?? null;
  const escrow = ticket.escrowUtxo;
  const escrowTxid = escrow ? (typeof escrow.txid === 'string' ? escrow.txid : binToHex(escrow.txid)) : null;
  const lines = [];
  const value = ticket.value ?? escrow?.output?.valueSatoshis ?? null;
  // A real show's Walk in closes when its call ends (the reader's clock); the ticket then refunds by the settle.
  const callOver = show.kind === 'real' && callOf(show, { now, timeZone })?.phase === 'over';
  if (state === 'held') {
    if (escrowTxid !== null) lines.push(say('buyHeld', { price: formatBch(show.price), outpoint: `${shortTxid(escrowTxid)}:${escrow.vout}` }));
    else lines.push(say('ticketMoney'));
    if (ticket.canAct === false && ticket.ticketUtxo !== null && ticket.ticketUtxo !== undefined) lines.push(say('movedAway'));
    else if (callOver) lines.push(say('callOverHeld'));
  } else if (state === 'handedBack') {
    if (returned !== null) lines.push(say('handBackDone', { amount: amountText(returned) }));
    // Why more came back than the price: the ticket's and the marker's 1,000 sats each. Only when no posted fee was taken.
    if (returned !== null && paid !== null && Number(show.handBackFeeBps) === 0 && paid >= returned) {
      lines.push(say('paidHandBack', { paid: formatBch(paid), amount: formatBch(returned) }));
    }
  } else if (state === 'refunded') {
    const amount = amountText(returned);
    if (amount !== null) lines.push(say(ticket.refundPath === 'settle' ? 'settleDone' : 'noticeDone', { amount }));
    const kept = ticket.ticketUtxo?.output?.valueSatoshis ?? TOKEN_OUTPUT_SATS;
    const feeFree = ticket.refundPath !== 'settle' || Number(show.noShowFeeBps) === 0;
    if (returned !== null && paid !== null && feeFree && paid >= returned + kept) {
      lines.push(say('paidRefund', { paid: formatBch(paid), amount: formatBch(returned), kept: formatBch(kept) }));
    }
  } else if (state === 'walkedIn') {
    lines.push(say('walkedIn'));
    const c = callOf(show, { now, timeZone });
    if (c?.phase === 'before') lines.push(say('callStarts', { time: c.time, eta: c.eta }));
    else if (c?.phase === 'on') lines.push(say('callOn'));
  } else {
    lines.push(say('unknownState'));
  }
  const held = state === 'held';
  const canAct = held && ticket.canAct !== false && escrow !== null && escrow !== undefined;
  const settleAt = settleOpensAt(show);
  const settleWhen = tip === undefined ? null : whenText(settleAt, tip, { now, locale, timeZone });
  const call = held ? callOf(show, { now, timeZone }) : null;
  // The bar runs from the block the ticket was bought in (or the tip when the page bought it) to the settle.
  const from = (ticket.buy?.height ?? 0) > 0 ? ticket.buy.height : ticket.boughtAtTip ?? null;
  const progress = tip === undefined || from === null || settleAt - 1 <= from ? null : Math.min(1, Math.max(0, (tip - from) / (settleAt - 1 - from)));
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
    valueText: formatBch(show.price),
    buyTxid,
    spendTxid: ticket.spend?.txid ?? null,
    refundPath: ticket.refundPath ?? null,
    escrowOutpoint: escrowTxid === null ? null : { txid: escrowTxid, vout: escrow.vout },
    ticketTxid: ticket.ticketUtxo ? (typeof ticket.ticketUtxo.txid === 'string' ? ticket.ticketUtxo.txid : binToHex(ticket.ticketUtxo.txid)) : buyTxid,
    canHandBack: canAct && show.kind !== 'proof',
    canWalkIn: canAct && show.kind === 'real' && !callOver,
    autoRefund: show.kind === 'sample-refund-seat',
    settleLine: held && show.kind !== 'sample-refund-seat' && settleWhen !== null
      ? say('showSettles', { settle: settleWhen.block, time: settleWhen.time, eta: settleWhen.eta })
      : null,
    // Under the big settle countdown: where and when, without the countdown again.
    settleSmall: held && show.kind !== 'sample-refund-seat' && settleWhen !== null ? say('settleSmall', { settle: settleWhen.block, time: settleWhen.time }) : null,
    settleBlocksLeft: tip === undefined ? null : Math.max(0, settleAt - 1 - tip),
    countdown: tip === undefined ? null : countdownText(Math.max(0, settleAt - tip)),
    progress,
    // A held real ticket counts down to the call instead (the settle stays as small print).
    call: call === null || call.phase === 'over' ? null : { phase: call.phase, countdown: call.countdown, line: call.phase === 'before' ? say('callTime', { time: call.time, minutes: call.minutes }) : say('callOn') },
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
