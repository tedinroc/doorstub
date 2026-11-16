// shows.json: the shared contract between the studio (writes it) and the
// app, worker and keeper (read it).
//
// {
//   "version": 1, "network": "mainnet" | "simnet", "origin": "https://doorstub.pages.dev", "generatedAt": "<ISO>",
//   "shows": [ {
//     "id": "<slug>", "kind": "sample-settle" | "sample-refund-seat" | "real" | "proof",
//     "title", "subtitle", "card", "startsAtEstimate": "<ISO, informational>",
//     "params": { "category": "<64 hex, display order>", "price": <sats>, "organiserPk": "<66 hex>",
//                 "organiserPkh": "<40 hex>", "organiserDataPk": "<66 hex>", "startHeight", "graceBlocks",
//                 "handBackFeeBps", "noShowFeeBps", "minerFeeCap" },
//     "shards": <int>, "genesisTxid": "<64 hex>",
//     "derived": { boxOffice/escrow Address, TokenAddress, LockingBytecode, RedeemScript, Scripthash },
//     "notices": [ { "scope": "C", "signature": "<hex>" } ],
//     "door": null | { "endpoint": "/api/door" }
//   } ]
// }
//
// The loader turns each show into the object src/tx expects (Uint8Array
// fields, sats as bigint), recomputes both contracts from the posted
// parameters, checks the policy (validateShow) and refuses the show when any
// `derived` field differs from the recomputation. A bad show is dropped and
// listed in `rejected`; the rest of the file still loads.
import { binToHex, hexToBin } from '@bitauth/libauth';
import { DoorstubError, showContracts, verifyRefundNotice } from '../tx/index.js';
import { ADDRESS_PREFIX, cashAddressOf, scripthashOf } from '../chain/address.js';

export const SHOWS_VERSION = 1;
export const SHOW_KINDS = Object.freeze(['sample-settle', 'sample-refund-seat', 'real', 'proof']);
export const NETWORKS = Object.freeze(['mainnet', 'simnet']);
export const DERIVED_FIELDS = Object.freeze([
  'boxOfficeAddress',
  'boxOfficeTokenAddress',
  'boxOfficeLockingBytecode',
  'boxOfficeRedeemScript',
  'boxOfficeScripthash',
  'escrowAddress',
  'escrowTokenAddress',
  'escrowLockingBytecode',
  'escrowRedeemScript',
  'escrowScripthash',
]);

export class ShowsError extends Error {
  constructor(code, message, showId) {
    super(showId === undefined ? message : `${showId}: ${message}`);
    this.name = 'ShowsError';
    this.code = code;
    if (showId !== undefined) this.showId = showId;
  }
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

const hexField = (value, bytes, name, id) => {
  if (typeof value !== 'string' || value.length !== bytes * 2 || !/^[0-9a-f]*$/i.test(value)) {
    throw new ShowsError('bad-field', `${name} must be ${bytes * 2} hex characters`, id);
  }
  return hexToBin(value);
};

const intField = (value, name, id, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new ShowsError('bad-field', `${name} must be an integer from ${min} to ${max}`, id);
  return value;
};

const textField = (value, name, id, { optional = false } = {}) => {
  if (value === undefined && optional) return '';
  if (typeof value !== 'string' || value.length > 2_000) throw new ShowsError('bad-field', `${name} must be a string`, id);
  return value;
};

/** Every derived field, recomputed from the contracts. */
export const deriveFields = (contracts, network) => {
  const out = {};
  for (const [name, c] of [['boxOffice', contracts.boxOffice], ['escrow', contracts.escrow]]) {
    out[`${name}Address`] = cashAddressOf(c.lockingBytecode, { network, tokenSupport: false });
    out[`${name}TokenAddress`] = cashAddressOf(c.lockingBytecode, { network, tokenSupport: true });
    out[`${name}LockingBytecode`] = binToHex(c.lockingBytecode);
    out[`${name}RedeemScript`] = binToHex(c.redeemScript);
    out[`${name}Scripthash`] = scripthashOf(c.lockingBytecode);
  }
  return out;
};

/** Letter used in seat labels: A for the settle sample, B for the refund sample, else the title's first letter. */
export const seatPrefixOf = (kind, title) => {
  if (kind === 'sample-settle') return 'A';
  if (kind === 'sample-refund-seat') return 'B';
  const letter = /[A-Za-z]/.exec(title ?? '')?.[0];
  return letter === undefined ? 'S' : letter.toUpperCase();
};

/**
 * Parse refund notices for a show: hex signatures to bytes, each verified
 * against the show's data key (as Escrow.refund would). Returns { valid, invalid }.
 * Accepts { scope: 'C', signature } and { scope: 'R', seat, signature }.
 */
export const parseNotices = (show, raw = []) => {
  const valid = [];
  const invalid = [];
  if (!Array.isArray(raw)) return { valid, invalid: [{ reason: 'notices must be a list' }] };
  for (const n of raw) {
    try {
      if (n?.scope !== 'C' && n?.scope !== 'R') throw new Error('scope must be C or R');
      if (typeof n.signature !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(n.signature)) throw new Error('signature must be hex');
      const notice = { scope: n.scope, signature: hexToBin(n.signature) };
      if (n.scope === 'R') notice.seat = typeof n.seat === 'string' ? hexField(n.seat, 3, 'seat') : n.seat;
      if (!verifyRefundNotice({ show, notice })) throw new Error('signature does not verify against the show\'s data key');
      valid.push(notice);
    } catch (e) {
      invalid.push({ notice: n, reason: e.message });
    }
  }
  return { valid, invalid };
};

/**
 * Add live notices (for example an 'R' notice the worker just signed) to a
 * show object: each is verified, duplicates are skipped, and `cancelled` is
 * updated. Returns { added, invalid }.
 */
export const addNotices = (show, raw) => {
  const { valid, invalid } = parseNotices(show, raw);
  const key = (n) => `${n.scope}:${n.seat === undefined ? '' : binToHex(n.seat)}`;
  const have = new Set(show.notices.map(key));
  const added = valid.filter((n) => !have.has(key(n)));
  show.notices = [...show.notices, ...added];
  show.cancelled = show.notices.some((n) => n.scope === 'C');
  return { added, invalid };
};

/** The valid 'R' notice for one seat, if the show has one. */
export const seatNotice = (show, seat) => show.notices.find((n) => n.scope === 'R' && n.seat !== undefined && binToHex(n.seat) === binToHex(seat));

/** A notice as shows.json / the worker writes it. */
export const noticeToJson = (notice) => ({
  scope: notice.scope,
  ...(notice.scope === 'R' && { seat: binToHex(notice.seat) }),
  signature: binToHex(notice.signature),
});

/**
 * Parse one show entry into a show object for src/tx, plus:
 * { id, kind, title, subtitle, card, startsAtEstimate, shards, genesisTxid (hex),
 *   categoryHex, network, notices (valid only), invalidNotices, cancelled, door,
 *   contracts, derived, seatPrefix }.
 */
export const parseShow = (raw, { network }) => {
  if (raw === null || typeof raw !== 'object') throw new ShowsError('bad-show', 'show must be an object');
  const id = raw.id;
  if (typeof id !== 'string' || !SLUG.test(id)) throw new ShowsError('bad-id', 'id must be a lowercase slug', typeof id === 'string' ? id : undefined);
  if (!SHOW_KINDS.includes(raw.kind)) throw new ShowsError('bad-kind', `kind must be one of ${SHOW_KINDS.join(', ')}`, id);
  const p = raw.params;
  if (p === null || typeof p !== 'object') throw new ShowsError('bad-field', 'params missing', id);
  const show = {
    id,
    kind: raw.kind,
    title: textField(raw.title, 'title', id),
    subtitle: textField(raw.subtitle, 'subtitle', id, { optional: true }),
    card: textField(raw.card, 'card', id),
    startsAtEstimate: textField(raw.startsAtEstimate, 'startsAtEstimate', id, { optional: true }),
    category: hexField(p.category, 32, 'params.category', id),
    price: BigInt(intField(p.price, 'params.price', id)),
    organiserPk: hexField(p.organiserPk, 33, 'params.organiserPk', id),
    organiserPkh: hexField(p.organiserPkh, 20, 'params.organiserPkh', id),
    organiserDataPk: hexField(p.organiserDataPk, 33, 'params.organiserDataPk', id),
    startHeight: intField(p.startHeight, 'params.startHeight', id, { max: 499_999_999 }),
    graceBlocks: intField(p.graceBlocks, 'params.graceBlocks', id, { max: 499_999_999 }),
    handBackFeeBps: intField(p.handBackFeeBps, 'params.handBackFeeBps', id, { max: 10_000 }),
    noShowFeeBps: intField(p.noShowFeeBps, 'params.noShowFeeBps', id, { max: 10_000 }),
    minerFeeCap: BigInt(intField(p.minerFeeCap, 'params.minerFeeCap', id)),
    shards: intField(raw.shards, 'shards', id, { min: 1, max: 256 }),
    genesisTxid: binToHex(hexField(raw.genesisTxid, 32, 'genesisTxid', id)),
    network,
  };
  show.categoryHex = binToHex(show.category);
  show.seatPrefix = seatPrefixOf(show.kind, show.title);

  let contracts;
  try {
    contracts = showContracts(show);
  } catch (e) {
    throw new ShowsError(e instanceof DoorstubError ? e.code : 'bad-show', `posted parameters refused: ${e.message}`, id);
  }
  const derived = deriveFields(contracts, network);
  if (raw.derived === null || typeof raw.derived !== 'object') throw new ShowsError('bad-field', 'derived missing', id);
  for (const field of DERIVED_FIELDS) {
    const posted = raw.derived[field];
    const mine = derived[field];
    const same = typeof posted === 'string' && (field.endsWith('Address') ? posted === mine : posted.toLowerCase() === mine);
    if (!same) throw new ShowsError('derived-mismatch', `derived.${field} does not match the contract recomputed from the posted parameters`, id);
  }
  show.contracts = contracts;
  show.derived = derived;

  const { valid, invalid } = parseNotices(show, raw.notices ?? []);
  show.notices = valid;
  show.invalidNotices = invalid;
  show.cancelled = valid.some((n) => n.scope === 'C');

  if (raw.door === undefined || raw.door === null) show.door = null;
  else if (typeof raw.door === 'object' && typeof raw.door.endpoint === 'string' && /^\/api\/[a-z0-9/_-]+$/i.test(raw.door.endpoint)) {
    show.door = { endpoint: raw.door.endpoint };
  } else throw new ShowsError('bad-field', 'door.endpoint must be a path on our own origin under /api/', id);
  return show;
};

/**
 * Parse a whole shows.json (string or object).
 * @param {object} [options]
 * @param {'mainnet'|'simnet'} [options.network] refuse a file for another network
 * @returns {{ version, network, origin, generatedAt, shows: object[], rejected: Array<{ id, code, message }> }}
 */
export const parseShowsFile = (input, { network: expected } = {}) => {
  let json = input;
  if (typeof input === 'string') {
    try {
      json = JSON.parse(input);
    } catch (e) {
      throw new ShowsError('bad-json', `shows.json is not JSON: ${e.message}`);
    }
  }
  if (json === null || typeof json !== 'object') throw new ShowsError('bad-file', 'shows.json must be an object');
  if (json.version !== SHOWS_VERSION) throw new ShowsError('bad-version', `shows.json version ${json.version} is not ${SHOWS_VERSION}`);
  if (!NETWORKS.includes(json.network)) throw new ShowsError('bad-network', `network must be ${NETWORKS.join(' or ')}`);
  if (expected !== undefined && json.network !== expected) throw new ShowsError('wrong-network', `shows.json is for ${json.network}, this build runs on ${expected}`);
  if (!Array.isArray(json.shows)) throw new ShowsError('bad-file', 'shows must be a list');
  const shows = [];
  const rejected = [];
  const ids = new Set();
  const categories = new Set();
  for (const raw of json.shows) {
    try {
      const show = parseShow(raw, { network: json.network });
      if (ids.has(show.id)) throw new ShowsError('duplicate-id', 'id appears twice', show.id);
      if (categories.has(show.categoryHex)) throw new ShowsError('duplicate-category', 'category appears twice', show.id);
      ids.add(show.id);
      categories.add(show.categoryHex);
      shows.push(show);
    } catch (e) {
      rejected.push({ id: raw?.id ?? null, code: e.code ?? 'bad-show', message: e.message });
    }
  }
  return {
    version: json.version,
    network: json.network,
    origin: typeof json.origin === 'string' ? json.origin : null,
    generatedAt: typeof json.generatedAt === 'string' ? json.generatedAt : null,
    prefix: ADDRESS_PREFIX[json.network],
    shows,
    rejected,
  };
};

/**
 * The JSON entry for a show object (what the studio writes). Round-trips with
 * parseShow; `derived` is recomputed, never copied.
 */
export const showToJson = (show, { network = show.network ?? 'mainnet' } = {}) => {
  const contracts = show.contracts ?? showContracts(show);
  return {
    id: show.id,
    kind: show.kind,
    title: show.title,
    subtitle: show.subtitle ?? '',
    card: show.card,
    startsAtEstimate: show.startsAtEstimate ?? '',
    params: {
      category: binToHex(show.category),
      price: Number(show.price),
      organiserPk: binToHex(show.organiserPk),
      organiserPkh: binToHex(show.organiserPkh),
      organiserDataPk: binToHex(show.organiserDataPk),
      startHeight: Number(show.startHeight),
      graceBlocks: Number(show.graceBlocks),
      handBackFeeBps: Number(show.handBackFeeBps),
      noShowFeeBps: Number(show.noShowFeeBps),
      minerFeeCap: Number(show.minerFeeCap),
    },
    shards: show.shards,
    genesisTxid: typeof show.genesisTxid === 'string' ? show.genesisTxid : binToHex(show.genesisTxid),
    derived: deriveFields(contracts, network),
    notices: (show.notices ?? []).map(noticeToJson),
    door: show.door ?? null,
  };
};
