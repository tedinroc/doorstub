// `studio plan`: turn a schedule into studio/plan.json (public keys only, no
// secrets). The default catalogue (APP-BRIEF section 2): rolling sample-settle
// instances every 36 blocks, and one sample-refund-seat show far in the future.
import { binToHex, cashAddressToLockingBytecode, lockingBytecodeToAddressContents } from '@bitauth/libauth';
import { validateShow } from '../../src/tx/index.js';
import { DEFAULT_ORIGIN, NETWORKS, SHOW_KINDS, paramsFromShow, showFromParams } from './shows-json.js';

export const BLOCK_SECONDS = 600;

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

const formatHeight = (height) => height.toLocaleString('en-US');

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
 * @param {object} o.studio public view of the studio keys (salesPk, dataPk, fundingAddress, identityAddress)
 * @param {string} o.payee organiser payee cashaddr (P2PKH)
 * @param {string|number} [o.firstStart] first sample-settle start height (absolute or "+N"); required when count > 0
 * @param {Array} [o.schedule] extra shows: { id, kind: 'real'|'sample-settle'|'sample-refund-seat', title, subtitle, card, startHeight, price, ... }
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
  const base = {
    organiserPk: studio.salesPk,
    organiserPkh,
    organiserDataPk: studio.dataPk,
  };
  const shows = [];
  const add = (entry) => {
    if (entry.params.startHeight <= tip) throw new Error(`${entry.id}: starts at ${entry.params.startHeight}, not after the tip ${tip}`);
    if (shows.some((s) => s.id === entry.id)) throw new Error(`${entry.id}: duplicate show id`);
    if (!SHOW_KINDS.includes(entry.kind) || entry.kind === 'proof') throw new Error(`${entry.id}: plan kinds are sample-settle, sample-refund-seat and real`);
    if (!Number.isInteger(entry.shards) || entry.shards < 1 || entry.shards > 256) throw new Error(`${entry.id}: shards must be 1-256`);
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
        subtitle: `Starts at block ${formatHeight(startHeight)}`,
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
      subtitle: 'Refunded by its organiser right after each sale',
      card: CARDS['sample-refund-seat'],
      shards: Number(shards),
      door: null,
      params: { ...base, price: Number(price), startHeight, graceBlocks: Number(graceBlocks), handBackFeeBps: 0, noShowFeeBps: 0, minerFeeCap: Number(minerFeeCap) },
    });
  }
  for (const item of schedule) {
    const kind = item.kind ?? 'real';
    for (const key of ['id', 'title', 'card']) if (typeof item[key] !== 'string' || item[key].length === 0) throw new Error(`schedule entry needs ${key}`);
    const startHeight = resolveHeight(item.startHeight, tip, `${item.id} startHeight`);
    add({
      id: item.id,
      kind,
      title: item.title,
      subtitle: item.subtitle ?? `Starts at block ${formatHeight(startHeight)}`,
      card: item.card,
      shards: Number(item.shards ?? shards),
      door: kind === 'real' && item.door !== false ? { endpoint: '/api/door' } : null,
      params: {
        ...base,
        price: Number(item.price ?? price),
        startHeight,
        graceBlocks: Number(item.graceBlocks ?? graceBlocks),
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
      fundingAddress: studio.fundingAddress,
      identityAddress: studio.identityAddress,
    },
    payee: { address: payee, pkh: organiserPkh },
    shows,
  };
};

/** Check a plan read back from disk against the studio keys it will be signed with. */
export const checkPlan = (plan, studio) => {
  if (plan.version !== 1 || !Array.isArray(plan.shows)) throw new Error('plan: not a version 1 plan');
  if (plan.studio.salesPk !== studio.salesPk || plan.studio.dataPk !== studio.dataPk) {
    throw new Error('plan: made with other studio keys than .secrets/studio.json');
  }
  for (const entry of plan.shows) {
    if (entry.params.organiserPk !== studio.salesPk || entry.params.organiserDataPk !== studio.dataPk) {
      throw new Error(`plan: ${entry.id} names keys that are not this studio's`);
    }
    checkedParams(entry.params, entry.id);
  }
  return plan;
};
