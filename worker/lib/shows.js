// shows.json for the worker (no libauth).
//
// Same file and rules as src/shows/schema.js: every show's contracts are
// recomputed from its posted parameters, and a show whose `derived` redeem
// scripts, locking bytecodes or script hashes differ is refused. (Addresses
// are display strings for people; the worker talks to Fulcrum by script hash
// and never needs them.) The policy bounds are the app's (src/tx
// validateShow). Notices are verified against the show's data key.
import {
  MAX_MINER_FEE_CAP,
  MAX_MINER_FEE_CAP_BPS,
  MAX_POSTED_FEE_BPS,
  MIN_MINER_FEE_CAP,
  MIN_PRICE,
  SCOPE_CANCEL_SHOW,
  SCOPE_REFUND_SEAT,
} from '../../src/tx/constants.js';
import { ownsSeatPrefix, readEventFields } from '../../src/shows/event.js';
import { bytesToHex, concat, hexToBytes, isHex, reverse, WorkerError } from './bytes.js';
import { verifyDataSignature } from './crypto.js';
import { boxOfficeScripts, escrowScripts } from './script.js';

export const SHOW_KINDS = Object.freeze(['sample-settle', 'sample-refund-seat', 'real', 'proof']);
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CHECKED_DERIVED = Object.freeze([
  ['escrowRedeemScript', (s) => s.escrow.redeemScript],
  ['escrowLockingBytecode', (s) => s.escrow.lockingBytecode],
  ['escrowScripthash', (s) => s.escrow.scripthash],
  ['boxOfficeRedeemScript', (s) => s.boxOffice.redeemScript],
  ['boxOfficeLockingBytecode', (s) => s.boxOffice.lockingBytecode],
  ['boxOfficeScripthash', (s) => s.boxOffice.scripthash],
]);

const showError = (id, message) => new WorkerError('bad-show', `${id}: ${message}`, { status: 500 });

const hexParam = (value, bytes, name, id) => {
  if (!isHex(value, bytes)) throw showError(id, `${name} must be ${bytes * 2} hex characters`);
  return hexToBytes(value);
};

const intParam = (value, name, id, max = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw showError(id, `${name} must be an integer from 0 to ${max}`);
  return value;
};

/** The app's policy bounds (SPEC.md section 6), as src/tx validateShow. */
const checkPolicy = (show) => {
  const price = BigInt(show.price);
  const cap = BigInt(show.minerFeeCap);
  if (BigInt(show.handBackFeeBps) > MAX_POSTED_FEE_BPS || BigInt(show.noShowFeeBps) > MAX_POSTED_FEE_BPS) throw showError(show.id, 'posted fees above the policy');
  if (price < MIN_PRICE) throw showError(show.id, 'price below the policy');
  if (cap < MIN_MINER_FEE_CAP || cap > MAX_MINER_FEE_CAP || cap * 10000n > price * MAX_MINER_FEE_CAP_BPS) throw showError(show.id, 'minerFeeCap outside the policy');
  if (show.startHeight + show.graceBlocks >= 500_000_000) throw showError(show.id, 'startHeight + graceBlocks must be a block height');
};

/** The message a refund notice signs: 'C' | category (wire order), or 'R' | category | seat. */
export const refundNoticeMessage = ({ scope, category, seat }) => {
  if (scope === 'C') return concat([Uint8Array.of(SCOPE_CANCEL_SHOW), reverse(category)]);
  if (scope === 'R') {
    if (!(seat instanceof Uint8Array) || seat.length !== 3) throw new WorkerError('bad-seat', 'a seat is 3 bytes');
    return concat([Uint8Array.of(SCOPE_REFUND_SEAT), reverse(category), seat]);
  }
  throw new WorkerError('bad-scope', 'scope must be C or R');
};

export const SCOPE_BYTES = Object.freeze({ C: SCOPE_CANCEL_SHOW, R: SCOPE_REFUND_SEAT });

const parseNotice = (show, raw) => {
  if (raw?.scope !== 'C' && raw?.scope !== 'R') throw new Error('scope must be C or R');
  if (!isHex(raw.signature) || raw.signature.length === 0) throw new Error('signature must be hex');
  const notice = { scope: raw.scope, signature: hexToBytes(raw.signature) };
  if (raw.scope === 'R') {
    if (!isHex(raw.seat, 3)) throw new Error('seat must be 6 hex characters');
    notice.seat = hexToBytes(raw.seat);
  }
  if (!verifyDataSignature(notice.signature, show.organiserDataPk, refundNoticeMessage({ ...notice, category: show.category }))) {
    throw new Error('signature does not verify against the show\'s data key');
  }
  return notice;
};

/**
 * One shows.json entry -> a worker show:
 * { id, kind, title, category, categoryHex, price, organiserPk, organiserPkh, organiserDataPk,
 *   startHeight, graceBlocks, handBackFeeBps, noShowFeeBps, minerFeeCap (bigint), shards, genesisTxid,
 *   escrow: { redeemScript, lockingBytecode, scripthash }, boxOffice: {...}, notices, invalidNotices,
 *   cancelled, door, seatPrefix, eventAt, eventAtMs, durationMin }
 * The event fields and the seat letter follow src/shows/event.js, as the app's loader.
 */
export const parseWorkerShow = (raw) => {
  if (raw === null || typeof raw !== 'object') throw new WorkerError('bad-show', 'show must be an object', { status: 500 });
  const id = typeof raw.id === 'string' && SLUG.test(raw.id) ? raw.id : null;
  if (id === null) throw new WorkerError('bad-show', 'show id must be a lowercase slug', { status: 500 });
  if (!SHOW_KINDS.includes(raw.kind)) throw showError(id, `kind must be one of ${SHOW_KINDS.join(', ')}`);
  const p = raw.params;
  if (p === null || typeof p !== 'object') throw showError(id, 'params missing');
  const show = {
    id,
    kind: raw.kind,
    title: typeof raw.title === 'string' ? raw.title : '',
    category: hexParam(p.category, 32, 'params.category', id),
    price: BigInt(intParam(p.price, 'params.price', id)),
    organiserPk: hexParam(p.organiserPk, 33, 'params.organiserPk', id),
    organiserPkh: hexParam(p.organiserPkh, 20, 'params.organiserPkh', id),
    organiserDataPk: hexParam(p.organiserDataPk, 33, 'params.organiserDataPk', id),
    startHeight: intParam(p.startHeight, 'params.startHeight', id, 499_999_999),
    graceBlocks: intParam(p.graceBlocks, 'params.graceBlocks', id, 499_999_999),
    handBackFeeBps: intParam(p.handBackFeeBps, 'params.handBackFeeBps', id, 10_000),
    noShowFeeBps: intParam(p.noShowFeeBps, 'params.noShowFeeBps', id, 10_000),
    minerFeeCap: BigInt(intParam(p.minerFeeCap, 'params.minerFeeCap', id)),
    shards: intParam(raw.shards, 'shards', id, 256),
    genesisTxid: bytesToHex(hexParam(raw.genesisTxid, 32, 'genesisTxid', id)),
  };
  show.categoryHex = bytesToHex(show.category);
  try {
    Object.assign(show, readEventFields(raw, show.kind));
  } catch (e) {
    throw showError(id, e.message);
  }
  checkPolicy(show);
  show.escrow = escrowScripts(show);
  show.boxOffice = boxOfficeScripts(show, show.escrow.lockingBytecode);
  if (raw.derived === null || typeof raw.derived !== 'object') throw showError(id, 'derived missing');
  for (const [field, mine] of CHECKED_DERIVED) {
    const posted = raw.derived[field];
    const expected = typeof mine(show) === 'string' ? mine(show) : bytesToHex(mine(show));
    if (typeof posted !== 'string' || posted.toLowerCase() !== expected) {
      throw new WorkerError('derived-mismatch', `${id}: derived.${field} does not match the contract recomputed from the posted parameters`, { status: 500 });
    }
  }
  show.notices = [];
  show.invalidNotices = [];
  for (const n of Array.isArray(raw.notices) ? raw.notices : []) {
    try {
      show.notices.push(parseNotice(show, n));
    } catch (e) {
      show.invalidNotices.push({ notice: n, reason: e.message });
    }
  }
  show.cancelled = show.notices.some((n) => n.scope === 'C');
  show.door = raw.door !== null && typeof raw.door === 'object' && typeof raw.door.endpoint === 'string' ? { endpoint: raw.door.endpoint } : null;
  return show;
};

/**
 * Parse a whole shows.json (text or object) for the worker's network.
 * Returns { network, origin, shows, rejected }. A bad show is left out and listed
 * in `rejected`; the rest still load.
 */
export const parseWorkerShows = (input, { network }) => {
  let json = input;
  if (typeof input === 'string') {
    try {
      json = JSON.parse(input);
    } catch {
      throw new WorkerError('bad-shows', 'shows.json is not JSON', { status: 500 });
    }
  }
  if (json === null || typeof json !== 'object' || json.version !== 1 || !Array.isArray(json.shows)) {
    throw new WorkerError('bad-shows', 'shows.json is not a version 1 catalogue', { status: 500 });
  }
  if (json.network !== network) throw new WorkerError('wrong-network', `shows.json is for ${json.network}; this worker runs on ${network}`, { status: 500 });
  const shows = [];
  const rejected = [];
  const seen = new Set();
  const letters = new Set();
  for (const raw of json.shows) {
    try {
      const show = parseWorkerShow(raw);
      if (seen.has(show.id) || seen.has(show.categoryHex)) throw showError(show.id, 'id or category appears twice');
      const ownLetter = ownsSeatPrefix(show.kind, raw);
      if (ownLetter && letters.has(show.seatPrefix)) throw showError(show.id, `seat letter ${show.seatPrefix} appears twice`);
      seen.add(show.id);
      seen.add(show.categoryHex);
      if (ownLetter) letters.add(show.seatPrefix);
      shows.push(show);
    } catch (e) {
      rejected.push({ id: raw?.id ?? null, code: e.code ?? 'bad-show', message: e.message });
    }
  }
  return { network: json.network, origin: typeof json.origin === 'string' ? json.origin : null, shows, rejected };
};

/** Seat label as the app prints it: "B-0-12" (letter, shard, seat number). */
export const seatLabelOf = (show, seat) => `${show.seatPrefix}-${seat[0]}-${seat[1] | (seat[2] << 8)}`;
