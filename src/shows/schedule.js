// Sales windows and timing, by block height (BCH has no clock in these rules).
//
// - Sales are open while tip < startHeight and no valid 'C' notice exists
//   (buildBuy refuses otherwise; the chain cannot enforce it, SPEC 8).
//   The page also ends a real show's sales when its call ends by the
//   reader's clock (`now`): its startHeight is set hours after the call, so
//   blocks that come early cannot close sales before the call ends.
// - Settle opens at block startHeight + graceBlocks + 1 (a locktime of
//   startHeight + graceBlocks can be mined from the next block).

/** About ten minutes per block. */
export const BLOCK_SECONDS = 600;

/** When a real show's call ends (eventAtMs + durationMin), in ms; null for a show without a call. */
export const callEndsAt = (show) =>
  typeof show?.eventAtMs === 'number' && Number.isFinite(show.eventAtMs) && Number.isFinite(Number(show.durationMin))
    ? show.eventAtMs + Number(show.durationMin) * 60_000
    : null;

/** Is a real show's call over at `now` (ms)? Always false for a show without a call. */
export const callEnded = (show, now) => {
  const end = callEndsAt(show);
  return end !== null && Number(now) >= end;
};

/**
 * Sales open: not cancelled and tip < startHeight; with `now` (the page's
 * clock, ms), a real show's sales also end when its call ends.
 */
export const salesOpen = (show, tip, { now } = {}) =>
  !show.cancelled && Number(tip) < Number(show.startHeight) && !(now !== undefined && show.kind === 'real' && callEnded(show, now));

/** First block in which a settle can be mined. */
export const settleOpensAt = (show) => Number(show.startHeight) + Number(show.graceBlocks) + 1;

/** Can a settle be mined in the next block, given the current tip? */
export const settleable = (show, tip) => Number(tip) + 1 >= settleOpensAt(show);

/**
 * Where a show stands:
 * 'on-sale' (tip < start, not cancelled), 'cancelled', 'started' (sales over,
 * settle not open yet), 'settling' (settle can be mined in the next block).
 */
export const showPhase = (show, tip) => {
  if (show.cancelled) return 'cancelled';
  if (salesOpen(show, tip)) return 'on-sale';
  return settleable(show, tip) ? 'settling' : 'started';
};

/**
 * The sample-settle instance to offer now: the open one that starts soonest,
 * with at least `minBlocksLeft` blocks of sales left. null when none is open.
 */
export const nextOpenInstance = (shows, tip, { kind = 'sample-settle', minBlocksLeft = 1 } = {}) => {
  const open = shows
    .filter((s) => s.kind === kind && salesOpen(s, tip) && Number(s.startHeight) - Number(tip) >= minBlocksLeft)
    .sort((a, b) => Number(a.startHeight) - Number(b.startHeight));
  return open[0] ?? null;
};

/**
 * The shows the home page offers for sale: the next open sample-settle
 * instance, every open sample-refund-seat and real show, in that order.
 * With `options.now`, a real show whose call is over is not offered.
 */
export const showsOnSale = (shows, tip, options = {}) => {
  const a = nextOpenInstance(shows, tip, options);
  const rest = shows.filter((s) => (s.kind === 'sample-refund-seat' || s.kind === 'real') && salesOpen(s, tip, { now: options.now }));
  return [...(a === null ? [] : [a]), ...rest];
};

/** Blocks from the tip until `height` (0 when reached). */
export const blocksUntil = (height, tip) => Math.max(0, Number(height) - Number(tip));

/**
 * Rough wall-clock estimate for a block height: now + blocks x 10 minutes.
 * The next block can come any time, so this is "about".
 */
export const estimateTimeOf = (height, tip, { now = Date.now(), blockSeconds = BLOCK_SECONDS } = {}) =>
  new Date(now + blocksUntil(height, tip) * blockSeconds * 1000);
