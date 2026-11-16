// POST /api/door: the door for real shows.
//
// The holder's page sends the check-in, then asks the door with its txid. The
// door reads the check-in from the network (so it is in the mempool or a
// block: the network ran every script, including the holder's signature),
// fetches what it spends from the network too (never from the caller), checks
// it is a check-in of THIS show (worker/lib/rules.js checkCheckIn), runs the
// 2026 VM over it when the runtime has one, and answers once per check-in
// with the show's event link from the DOOR_LINKS secret.
import { bytesToHex, isHex, WorkerError } from './bytes.js';
import { checkCheckIn } from './rules.js';
import { seatLabelOf } from './shows.js';

const refuse = (code, message, extra) => {
  throw new WorkerError(code, message, extra);
};

export const parseDoorRequest = (body) => {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) refuse('bad-request', 'send JSON { category, txid }');
  if (!isHex(body.category, 32)) refuse('bad-request', 'category must be 64 hex characters');
  if (!isHex(body.txid, 32)) refuse('bad-request', 'txid must be the check-in\'s 64 hex character id');
  return { categoryHex: body.category.toLowerCase(), txid: body.txid.toLowerCase() };
};

/** Fill an event link template: {seat} is the seat label, {txid} the check-in. */
export const fillLink = (template, { seatLabel, txid }) => template.replaceAll('{seat}', encodeURIComponent(seatLabel)).replaceAll('{txid}', txid);

/**
 * @param {object} a
 * @param {Array} a.shows worker shows
 * @param {object} a.chain worker chain client
 * @param {object|null} a.doorLinks { [show id]: "https://..." }
 * @param {{ claim(key): Promise<boolean> }} a.claims one answer per check-in
 * @param {Function} [a.vmCheck] the 2026 VM (Node); absent in workerd
 */
export const answerDoor = async ({ shows, chain, doorLinks, claims, vmCheck, body }) => {
  const request = parseDoorRequest(body);
  const show = shows.find((s) => s.categoryHex === request.categoryHex);
  if (show === undefined) refuse('unknown-show', 'no show in shows.json has this category', { status: 404 });
  if (show.kind !== 'real') refuse('not-a-real-show', 'only real shows have a door; sample shows have nothing to walk into', { status: 403 });
  if (show.door === null) refuse('no-door', 'this show has no door', { status: 404 });
  const template = doorLinks?.[show.id];
  if (typeof template !== 'string') refuse('door-not-configured', 'the door for this show is not set up yet', { status: 503 });

  const found = await chain.getTransaction(request.txid);
  if (found === null) refuse('not-on-chain', 'the network does not know this check-in; send it first, then ask again', { status: 404, retryable: true });
  const { transaction } = found;
  if (transaction.inputs.length !== 2) refuse('not-a-check-in', 'a check-in has exactly two inputs', { status: 422 });
  const sourceOutputs = [];
  for (const [i, input] of transaction.inputs.entries()) {
    const parent = await chain.getTransaction(bytesToHex(input.outpointTransactionHash));
    const output = parent?.transaction.outputs[input.outpointIndex];
    if (output === undefined) refuse('missing-source', `the coin input ${i} spends is not known to the network`, { status: 422 });
    sourceOutputs.push(output);
  }
  const { seat } = checkCheckIn({ show, transaction, sourceOutputs });
  if (typeof vmCheck === 'function') {
    const r = vmCheck({ kind: 'checkIn', transaction, sourceOutputs });
    if (r?.ok !== true) refuse('vm-invalid', `the 2026 VM refuses this check-in: ${r?.reason ?? 'no reason given'}`, { status: 422 });
  }
  const height = await chain.transactionHeight(request.txid);
  if (!(await claims.claim(`door:${show.id}:${request.txid}`))) {
    refuse('already-answered', 'this check-in already got its door answer; the page that checked in shows it', { status: 409 });
  }
  const seatLabel = seatLabelOf(show, seat);
  return {
    show: show.id,
    seat: bytesToHex(seat),
    seatLabel,
    txid: request.txid,
    confirmed: typeof height === 'number' && height > 0,
    link: fillLink(template, { seatLabel, txid: request.txid }),
  };
};
