// `studio plan`: turn a schedule into studio/plan.json (public keys only, no
// secrets). The default catalogue (ARCHITECTURE.md, "Shows"): rolling sample-settle
// instances every 36 blocks, and one sample-refund-seat show far in the future.
import { binToHex, cashAddressToLockingBytecode, lockingBytecodeToAddressContents } from '@bitauth/libauth';
import { validateShow } from '../../src/tx/index.js';
import { EVENT_FIELDS, readEventFields } from '../../src/shows/event.js';
import { DEFAULT_ORIGIN, NETWORKS, SHOW_KINDS, paramsFromShow, showFromParams } from './shows-json.js';

export const BLOCK_SECONDS = 600;

/**
 * How many blocks after its call ends a real show's sales end on chain (its
 * startHeight): a base plus a share of the blocks until the call ends. Blocks
 * can come early, and the further ahead the call, the earlier they can come:
 * in mainnet headers of the last 200 days, 144 blocks once took 12 hours. With
 * this margin, the block came before the call ended in about 2 to 3% of
 * replays planned 1 to 8 days ahead; with a flat 6 blocks it was about 30%.
 * The page itself stops selling and offering Walk in when the call ends (the
 * reader's clock), so the longer margin sells nothing after the call.
 */
export const REAL_SALES_MARGIN = Object.freeze({ base: 24, share: 0.05 });
export const salesMarginBlocks = (blocksUntilCallEnds) => REAL_SALES_MARGIN.base + Math.ceil(blocksUntilCallEnds * REAL_SALES_MARGIN.share);

/**
 * A real show's default grace: settling opens about a day after its sales end,
 * so even a chain that runs hours early cannot settle a ticket while its call
 * is still on (0 of the replays above). The samples keep 2.
 */
export const REAL_GRACE_BLOCKS = 144;

/** Card texts (exact public wording; see CLAIMS.md section 6). */
export const CARDS = {
  'sample-settle': 'Sample show. Nobody checks in at a sample show, so every ticket refunds itself after it starts.',
  'sample-refund-seat':
    'Sample show. Its organiser refunds every seat right after it is sold, so you can watch a refund arrive without doing anything.',
};

export const SAMPLE_DEFAULTS = {
  step: 36,
  count: 1,
  price: 100_000,
  graceBlocks: 2,
  handBackFeeBps: 0,
  noShowFeeBps: 0,
  minerFeeCap: 1_500,
  shards: 4,
  /** Sample show B starts about 45 days after the tip (about 12/31 when planned on 11/16). */
  refundSeatOffset: 6_500,
};

/** "+N" means N blocks after the tip; a plain number is an absolute height. */
export const resolveHeight = (value, tip, name) => {
  const text = String(value).trim();
  const relative = text.startsWith('+');
  const n = Number(relative ? text.slice(1) : text);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a block height or +blocks, got "${value}"`);
  return relative ? tip + n : n;
};

/** The pkh of a P2PKH cashaddr (Escrow pays P2PKH(organiserPkh), so the payee must be P2PKH). */
export const payeePkhOf = (address) => {
  const decoded = cashAddressToLockingBytecode(String(address));
  if (typeof decoded === 'string') throw new Error(`payee: ${decoded}`);
  const contents = lockingBytecodeToAddressContents(decoded.bytecode);
  if (contents.type !== 'P2PKH') throw new Error('payee must be a P2PKH address (bitcoincash:q... or bitcoincash:z...)');
  return contents.payload;
};

const estimate = (now, tip, height) => new Date(now.getTime() + (height - tip) * BLOCK_SECONDS * 1000).toISOString();

/**
 * The startHeight of a real show from its call: the block when the call ends,
 * counted from the tip at ten minutes a block, plus `salesMarginBlocks` of
 * that (or `blocksAfterCall`, when given). An estimate: blocks come when they
 * come, so plan close to the day (the studio recomputes it every time you plan).
 */
export const startHeightAfterCall = ({ eventAt, durationMin, tip, now = new Date(), blocksAfterCall }) => {
  const { eventAtMs } = readEventFields({ eventAt, durationMin, seatPrefix: 'S' }, 'real');
  if (blocksAfterCall !== undefined && (!Number.isInteger(blocksAfterCall) || blocksAfterCall < 0)) throw new Error('blocksAfterCall must be a whole number of blocks');
  const callEnds = eventAtMs + durationMin * 60_000;
  if (callEnds <= now.getTime()) throw new Error(`the call at ${eventAt} is over`);
  const blocks = Math.ceil((callEnds - now.getTime()) / (BLOCK_SECONDS * 1000));
  return tip + blocks + (blocksAfterCall ?? salesMarginBlocks(blocks));
};

/**
 * For a planned real show: its call, the estimated end of sales on chain and
 * the opening of settle, and how many minutes after the call ends each comes
 * (negative: before it ends).
 */
export const callTiming = (entry) => {
  const callEnds = Date.parse(entry.eventAt) + entry.durationMin * 60_000;
  const salesEnd = Date.parse(entry.startsAtEstimate);
  const settleBlocks = entry.params.graceBlocks + 1;
  return {
    eventAt: entry.eventAt,
    callEndsAt: new Date(callEnds).toISOString(),
    salesEndBlock: entry.params.startHeight,
    salesEndEstimate: entry.startsAtEstimate,
    minutesAfterCall: Math.round((salesEnd - callEnds) / 60_000),
    settleBlock: entry.params.startHeight + settleBlocks,
    settleMinutesAfterCall: Math.round((salesEnd - callEnds) / 60_000) + settleBlocks * (BLOCK_SECONDS / 60),
  };
};

const checkedParams = (params, where) => {
  try {
    validateShow({ ...showFromParams(params), category: new Uint8Array(32) });
  } catch (error) {
    throw new Error(`${where}: ${error.message}`);
  }
  return paramsFromShow(showFromParams(params));
};

/**
 * Build a plan document.
 * @param {object} o
 * @param {'mainnet'|'simnet'} o.network
 * @param {number} o.tip current chain tip
 * @param {object} o.studio public view of the studio keys (salesPk, dataPk, realDataPk, fundingAddress, identityAddress);
 *   samples get dataPk (the worker's key), real shows realDataPk (the studio's alone) as organiserDataPk
 * @param {string} o.payee organiser payee cashaddr (P2PKH)
 * @param {string|number} [o.firstStart] first sample-settle start height (absolute or "+N"); required when count > 0
 * @param {Array} [o.schedule] extra shows: { id, kind: 'real'|'sample-settle'|'sample-refund-seat', title, subtitle, card, startHeight, price, ... };
 *   a real show also names eventAt (ISO UTC), durationMin and seatPrefix (src/shows/event.js), and may leave out
 *   startHeight: it is then `salesMarginBlocks` (or `blocksAfterCall`) blocks after the call ends, from the tip and `now`;
 *   a real show's graceBlocks defaults to REAL_GRACE_BLOCKS, not the samples' `graceBlocks`
 */
export const makePlan = ({
  network,
  origin = DEFAULT_ORIGIN,
  tip,
  now = new Date(),
  studio,
  payee,
  firstStart,
  step = SAMPLE_DEFAULTS.step,
  count = SAMPLE_DEFAULTS.count,
  price = SAMPLE_DEFAULTS.price,
  graceBlocks = SAMPLE_DEFAULTS.graceBlocks,
  handBackFeeBps = SAMPLE_DEFAULTS.handBackFeeBps,
  noShowFeeBps = SAMPLE_DEFAULTS.noShowFeeBps,
  minerFeeCap = SAMPLE_DEFAULTS.minerFeeCap,
  shards = SAMPLE_DEFAULTS.shards,
  refundSeatStart = `+${SAMPLE_DEFAULTS.refundSeatOffset}`,
  schedule = [],
}) => {
  if (!NETWORKS.includes(network)) throw new Error(`network must be one of ${NETWORKS.join(', ')}`);
  if (!Number.isInteger(tip) || tip < 0) throw new Error('tip must be the current block height');
  if (!/^https?:\/\/[^/]+$/.test(origin)) throw new Error('origin must look like https://host (no path, no trailing slash)');
  const organiserPkh = binToHex(payeePkhOf(payee));
  // Samples use the data key the worker holds (it signs sample B's per-seat notices); real shows use a second
  // data key that only the studio holds, so a leaked worker secret cannot refund a real show's unused tickets.
  const base = {
    organiserPk: studio.salesPk,
    organiserPkh,
    organiserDataPk: studio.dataPk,
  };
  const realBase = () => {
    if (typeof studio.realDataPk !== 'string' || studio.realDataPk.length !== 66) {
      throw new Error('real shows need the studio\'s real-show data key, and this studio file has none; run `npm run studio -- keygen --add-real-data-key`');
    }
    if (studio.realDataPk === studio.dataPk) throw new Error('the real-show data key must differ from the data key the worker holds');
    return { ...base, organiserDataPk: studio.realDataPk };
  };
  const shows = [];
  const add = (entry) => {
    if (entry.params.startHeight <= tip) throw new Error(`${entry.id}: starts at ${entry.params.startHeight}, not after the tip ${tip}`);
    if (shows.some((s) => s.id === entry.id)) throw new Error(`${entry.id}: duplicate show id`);
    if (!SHOW_KINDS.includes(entry.kind) || entry.kind === 'proof') throw new Error(`${entry.id}: plan kinds are sample-settle, sample-refund-seat and real`);
    if (!Number.isInteger(entry.shards) || entry.shards < 1 || entry.shards > 256) throw new Error(`${entry.id}: shards must be 1-256`);
    const call = callFields(entry, entry.id);
    // The page never offers a real show whose call is over, so genesis would pay for a show nobody can buy,
    // whether startHeight came from the call or from the schedule.
    if (entry.kind === 'real' && call.eventAtMs + call.durationMin * 60_000 <= now.getTime()) throw new Error(`${entry.id}: the call at ${entry.eventAt} is over`);
    if (entry.kind === 'real' && shows.some((s) => s.kind === 'real' && s.seatPrefix === call.seatPrefix)) {
      throw new Error(`${entry.id}: seat letter ${call.seatPrefix} is already used by another real show`);
    }
    shows.push({ ...entry, params: checkedParams(entry.params, entry.id), startsAtEstimate: estimate(now, tip, entry.params.startHeight) });
  };

  const sampleCount = Number(count);
  if (sampleCount > 0) {
    if (firstStart === undefined) throw new Error('--first-start is required for the sample-settle catalogue (a height or +blocks)');
    const first = resolveHeight(firstStart, tip, 'first start');
    for (let i = 0; i < sampleCount; i += 1) {
      const startHeight = first + i * Number(step);
      add({
        id: `sample-a-${startHeight}`,
        kind: 'sample-settle',
        title: 'Sample show A',
        subtitle: '',
        card: CARDS['sample-settle'],
        shards: Number(shards),
        door: null,
        params: { ...base, price: Number(price), startHeight, graceBlocks: Number(graceBlocks), handBackFeeBps: Number(handBackFeeBps), noShowFeeBps: Number(noShowFeeBps), minerFeeCap: Number(minerFeeCap) },
      });
    }
  }
  if (refundSeatStart !== null && refundSeatStart !== undefined && refundSeatStart !== false) {
    const startHeight = resolveHeight(refundSeatStart, tip, 'refund-seat start');
    add({
      id: 'sample-b',
      kind: 'sample-refund-seat',
      title: 'Sample show B',
      subtitle: '',
      card: CARDS['sample-refund-seat'],
      shards: Number(shards),
      door: null,
      params: { ...base, price: Number(price), startHeight, graceBlocks: Number(graceBlocks), handBackFeeBps: 0, noShowFeeBps: 0, minerFeeCap: Number(minerFeeCap) },
    });
  }
  for (const item of schedule) {
    const kind = item.kind ?? 'real';
    for (const key of ['id', 'title', 'card']) if (typeof item[key] !== 'string' || item[key].length === 0) throw new Error(`schedule entry needs ${key}`);
    if (item.subtitle !== undefined && typeof item.subtitle !== 'string') throw new Error(`${item.id}: subtitle must be text`);
    const call = callFields(item, item.id, kind);
    let startHeight;
    if (item.startHeight !== undefined) startHeight = resolveHeight(item.startHeight, tip, `${item.id} startHeight`);
    else if (kind === 'real') startHeight = startHeightAfterCall({ eventAt: item.eventAt, durationMin: item.durationMin, tip, now, blocksAfterCall: item.blocksAfterCall });
    else throw new Error(`${item.id}: schedule entry needs startHeight`);
    add({
      id: item.id,
      kind,
      title: item.title,
      subtitle: item.subtitle ?? '',
      card: item.card,
      ...(kind === 'real' && { eventAt: call.eventAt, durationMin: call.durationMin, seatPrefix: call.seatPrefix }),
      shards: Number(item.shards ?? shards),
      door: kind === 'real' && item.door !== false ? { endpoint: '/api/door' } : null,
      params: {
        ...(kind === 'real' ? realBase() : base),
        price: Number(item.price ?? price),
        startHeight,
        graceBlocks: Number(item.graceBlocks ?? (kind === 'real' ? REAL_GRACE_BLOCKS : graceBlocks)),
        handBackFeeBps: Number(item.handBackFeeBps ?? handBackFeeBps),
        noShowFeeBps: Number(item.noShowFeeBps ?? noShowFeeBps),
        minerFeeCap: Number(item.minerFeeCap ?? minerFeeCap),
      },
    });
  }
  if (shows.length === 0) throw new Error('the plan has no shows');
  return {
    version: 1,
    network,
    origin,
    createdAt: now.toISOString(),
    tipAtPlan: tip,
    studio: {
      salesPk: studio.salesPk,
      dataPk: studio.dataPk,
      realDataPk: studio.realDataPk ?? null,
      fundingAddress: studio.fundingAddress,
      identityAddress: studio.identityAddress,
    },
    payee: { address: payee, pkh: organiserPkh },
    shows,
  };
};

/** The call fields of a plan or schedule entry (src/shows/event.js): required for a real show, absent for the samples. */
const callFields = (entry, id, kind = entry.kind) => {
  try {
    return readEventFields(entry, kind);
  } catch (error) {
    throw new Error(`${id}: ${error.message}`);
  }
};

/** Check a plan read back from disk against the studio keys it will be signed with. */
export const checkPlan = (plan, studio) => {
  if (plan.version !== 1 || !Array.isArray(plan.shows)) throw new Error('plan: not a version 1 plan');
  if (plan.studio.salesPk !== studio.salesPk || plan.studio.dataPk !== studio.dataPk || (plan.studio.realDataPk ?? null) !== (studio.realDataPk ?? null)) {
    throw new Error('plan: made with other studio keys than .secrets/studio.json');
  }
  const letters = new Set();
  for (const entry of plan.shows) {
    const dataPk = entry.kind === 'real' ? studio.realDataPk : studio.dataPk;
    if (entry.params.organiserPk !== studio.salesPk || entry.params.organiserDataPk !== dataPk) {
      throw new Error(`plan: ${entry.id} names keys that are not this studio's`);
    }
    const call = callFields(entry, `plan: ${entry.id}`);
    if (entry.kind === 'real') {
      if (letters.has(call.seatPrefix)) throw new Error(`plan: ${entry.id}: seat letter ${call.seatPrefix} is used twice`);
      letters.add(call.seatPrefix);
    }
    checkedParams(entry.params, entry.id);
  }
  return plan;
};

/** The call fields a shows.json entry carries for a plan entry (none for the samples). */
export const planCallFields = (entry) => (entry.kind === 'real' ? Object.fromEntries(EVENT_FIELDS.map((field) => [field, entry[field]])) : {});
