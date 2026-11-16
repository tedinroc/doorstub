// POST /api/door: the door for real shows.
//
// 1. Reserve (`reserve: true`). The page has the holder's signed check-in and
//    its txid, which nobody else knows yet, and reserves that txid with its
//    `claim` secret BEFORE it sends the check-in. No chain lookup: the door
//    stores a hash of the claim for this show and txid if nothing is stored
//    yet (expires after 3 hours unless answered).
// 2. Ask. After sending, the page asks with the same claim. The door reads the
//    check-in from the network (so it is in the mempool or a block: the
//    network ran every script, including the holder's signature), fetches
//    what it spends from the network too (never from the caller), checks it
//    is a check-in of THIS show (worker/lib/rules.js checkCheckIn), runs the
//    2026 VM over it when the runtime has one, and gives the show's event
//    link from the DOOR_LINKS secret to ONE claimant per check-in: the one
//    that reserved it, or with no reservation the first caller, and later
//    calls from that claimant (the same `claim` secret, or without one the
//    same client IP). Someone who only saw the txid in the mempool gets 409.
import { bytesToHex, isHex, WorkerError } from './bytes.js';
import { sha256 } from './crypto.js';
import { checkCheckIn } from './rules.js';
import { seatLabelOf } from './shows.js';

const refuse = (code, message, extra) => {
  throw new WorkerError(code, message, extra);
};

export const parseDoorRequest = (body) => {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) refuse('bad-request', 'send JSON { category, txid }');
  if (!isHex(body.category, 32)) refuse('bad-request', 'category must be 64 hex characters');
  if (!isHex(body.txid, 32)) refuse('bad-request', 'txid must be the check-in\'s 64 hex character id');
  if (body.claim !== undefined && !(isHex(body.claim) && body.claim.length >= 32 && body.claim.length <= 128)) {
    refuse('bad-request', 'claim, when given, must be 32 to 128 hex characters (a random secret the page keeps)');
  }
  if (body.reserve !== undefined && typeof body.reserve !== 'boolean') refuse('bad-request', 'reserve, when given, is true or false');
  if (body.reserve === true && body.claim === undefined) refuse('bad-request', 'a reservation needs the page\'s claim secret');
  return { categoryHex: body.category.toLowerCase(), txid: body.txid.toLowerCase(), claim: body.claim?.toLowerCase(), reserve: body.reserve === true };
};

const encoder = new TextEncoder();

/**
 * The token stored for the claimant: a hash of the page's claim secret, or
 * without one of the client IP. Hashed so the record never holds either.
 */
export const claimToken = ({ claim, clientIp }) => {
  const source = claim !== undefined ? `claim:${claim}` : typeof clientIp === 'string' && clientIp !== '' && clientIp !== 'unknown' ? `ip:${clientIp}` : null;
  return source === null ? null : bytesToHex(sha256(encoder.encode(source)));
};

/** Fill an event link template: {seat} is the seat label, {txid} the check-in. */
export const fillLink = (template, { seatLabel, txid }) => template.replaceAll('{seat}', encodeURIComponent(seatLabel)).replaceAll('{txid}', txid);

/**
 * @param {object} a
 * @param {Array} a.shows worker shows
 * @param {object} a.chain worker chain client
 * @param {object|null} a.doorLinks { [show id]: "https://..." }
 * @param {{ reserve(key, token), claim(key, token): Promise<'first'|'same'|'taken'> }} a.claims one claimant per check-in (worker/lib/limits.js)
 * @param {Function} [a.vmCheck] the 2026 VM (Node); absent in workerd
 * @param {string} [a.clientIp] identifies the claimant when the page sends no claim
 */
const alreadyAnswered = () =>
  refuse('already-answered', 'this check-in already got its door answer; the page that checked in shows it', { status: 409 });

/** The record key of one check-in at one show. */
export const doorKey = (show, txid) => `door:${show.id}:${txid}`;

/**
 * Reserve a check-in before it is sent: { reserved: true, again } for the
 * claimant that holds the record, 409 already-answered for anyone else.
 */
export const reserveDoor = async ({ show, claims, request }) => {
  const reserved = await claims.reserve(doorKey(show, request.txid), claimToken({ claim: request.claim }));
  if (reserved !== 'first' && reserved !== 'same') alreadyAnswered();
  return { reserved: true, again: reserved === 'same' };
};

export const answerDoor = async ({ shows, chain, doorLinks, claims, vmCheck, body, clientIp }) => {
  const request = parseDoorRequest(body);
  const show = shows.find((s) => s.categoryHex === request.categoryHex);
  if (show === undefined) refuse('unknown-show', 'no show in shows.json has this category', { status: 404 });
  if (show.kind !== 'real') refuse('not-a-real-show', 'only real shows have a door; sample shows have nothing to walk into', { status: 403 });
  if (show.door === null) refuse('no-door', 'this show has no door', { status: 404 });
  if (request.reserve) return reserveDoor({ show, claims, request });
  const template = doorLinks?.[show.id];
  if (typeof template !== 'string') refuse('door-not-configured', 'the door for this show is not set up yet', { status: 503 });

  const found = await chain.getTransaction(request.txid);
  if (found === null) refuse('not-on-chain', 'the network does not know this check-in; send it first, then ask again', { status: 404, retryable: true });
  const { transaction } = found;
  if (transaction.inputs.length !== 2) refuse('not-a-check-in', 'a check-in has exactly two inputs', { status: 422 });
  // The coins it spends, from the network (never from the caller), both at once.
  const parents = await Promise.all(transaction.inputs.map((input) => chain.getTransaction(bytesToHex(input.outpointTransactionHash))));
  const sourceOutputs = transaction.inputs.map((input, i) => {
    const output = parents[i]?.transaction.outputs[input.outpointIndex];
    if (output === undefined) refuse('missing-source', `the coin input ${i} spends is not known to the network`, { status: 422 });
    return output;
  });
  const { seat } = checkCheckIn({ show, transaction, sourceOutputs });
  if (typeof vmCheck === 'function') {
    const r = vmCheck({ kind: 'checkIn', transaction, sourceOutputs });
    if (r?.ok !== true) refuse('vm-invalid', `the 2026 VM refuses this check-in: ${r?.reason ?? 'no reason given'}`, { status: 422 });
  }
  const height = await chain.transactionHeight(request.txid);
  const claimed = await claims.claim(doorKey(show, request.txid), claimToken({ claim: request.claim, clientIp }));
  if (claimed !== 'first' && claimed !== 'same') alreadyAnswered();
  const seatLabel = seatLabelOf(show, seat);
  return {
    show: show.id,
    seat: bytesToHex(seat),
    seatLabel,
    txid: request.txid,
    confirmed: typeof height === 'number' && height > 0,
    again: claimed === 'same',
    link: fillLink(template, { seatLabel, txid: request.txid }),
  };
};
