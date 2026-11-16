// POST /api/notice: the refund-notice signer for sample show B.
//
// It signs exactly one kind of message, 'R' | category | seat, and only when
//   - the category is a show of kind 'sample-refund-seat' in shows.json,
//   - the configured data key is that show's organiserDataPk,
//   - a coin at that show's Escrow carries a marker of that category for that
//     seat (the buy that made it is on chain or in the mempool).
// It never signs 'C' (a whole-show cancel) or anything for another show.
// Signatures are deterministic, so asking twice gives the same answer.
import { TAG_MARKER, TOKEN_OUTPUT_SATS } from '../../src/tx/constants.js';
import { bytesToHex, equal, hexToBytes, isHex, WorkerError } from './bytes.js';
import { publicKeyOf, signDataEcdsa, verifyDataSignature } from './crypto.js';
import { coinFromElectrum } from './escrow.js';
import { refundNoticeMessage, seatLabelOf } from './shows.js';

const refuse = (code, message, extra) => {
  throw new WorkerError(code, message, extra);
};

/** Parse { category, seat, txid? } from a request body. */
export const parseNoticeRequest = (body) => {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) refuse('bad-request', 'send JSON { category, seat }');
  if (body.scope !== undefined && body.scope !== 'R') refuse('seat-notices-only', 'this signer only signs per-seat refund notices (scope R), never a whole-show cancel');
  if (!isHex(body.category, 32)) refuse('bad-request', 'category must be 64 hex characters');
  if (!isHex(body.seat, 3)) refuse('bad-request', 'seat must be 6 hex characters');
  if (body.txid !== undefined && !isHex(body.txid, 32)) refuse('bad-request', 'txid, when given, must be 64 hex characters');
  return { categoryHex: body.category.toLowerCase(), seat: hexToBytes(body.seat), txid: body.txid?.toLowerCase() };
};

/** The show a notice is for; refuses every show that is not the refund-seat sample. */
export const noticeShow = (shows, categoryHex) => {
  const show = shows.find((s) => s.categoryHex === categoryHex);
  if (show === undefined) refuse('unknown-show', 'no show in shows.json has this category', { status: 404 });
  if (show.kind !== 'sample-refund-seat') {
    refuse('not-a-refund-seat-show', 'this show\'s organiser does not refund seats automatically, so the signer does not sign for it', { status: 403 });
  }
  return show;
};

const isMarkerFor = (show, output, seat) => {
  const t = output.token;
  return (
    equal(output.lockingBytecode, show.escrow.lockingBytecode) &&
    t !== undefined &&
    equal(t.category, show.category) &&
    t.amount === 0n &&
    t.nft?.capability === 'none' &&
    t.nft.commitment.length === 24 &&
    t.nft.commitment[0] === TAG_MARKER &&
    equal(t.nft.commitment.slice(1, 4), seat) &&
    output.valueSatoshis >= show.price + TOKEN_OUTPUT_SATS
  );
};

/**
 * Find the seat's marker: in the transaction the caller names (the buy, read
 * from the network by txid, so it is in the mempool or a block), else among
 * the unspent coins at the show's Escrow (mempool counted). Waits up to
 * `waitMs` for a just-sent buy to show up. Returns { txid, vout, height } or null.
 */
export const findMarker = async ({ chain, show, seat, txid, waitMs = 0, pollMs = 1_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) => {
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (txid !== undefined) {
      const tx = await chain.getTransaction(txid);
      const vout = tx === null ? -1 : tx.transaction.outputs.findIndex((o) => isMarkerFor(show, o, seat));
      if (vout !== -1) return { txid, vout, height: null };
    }
    const items = await chain.listUnspent(show.escrow.scripthash);
    for (const item of items) {
      const coin = coinFromElectrum(show, item);
      if (coin.ignored === undefined && equal(coin.seat, seat)) return { txid: coin.txidHex, vout: coin.vout, height: coin.height };
    }
    if (Date.now() + pollMs > deadline) return null;
    await sleep(pollMs);
  }
};

/** Sign the 'R' notice for one live seat of the refund-seat sample. */
export const signSeatNotice = async ({ shows, chain, dataKey, body, markerWaitMs = 0, pollMs }) => {
  const request = parseNoticeRequest(body);
  const show = noticeShow(shows, request.categoryHex);
  if (dataKey === null || dataKey === undefined) refuse('signer-not-configured', 'the refund signer has no key; the keeper will refund this seat within minutes', { status: 503, retryable: true });
  if (!equal(publicKeyOf(dataKey), show.organiserDataPk)) refuse('signer-key-mismatch', 'the signer\'s key is not this show\'s data key', { status: 503 });
  const marker = await findMarker({ chain, show, seat: request.seat, txid: request.txid, waitMs: markerWaitMs, pollMs });
  if (marker === null) {
    refuse('no-live-marker', 'no ticket money for this seat is in the show\'s contract (yet); if you just bought it, ask again in a few seconds', { status: 404, retryable: true });
  }
  const message = refundNoticeMessage({ scope: 'R', category: show.category, seat: request.seat });
  const signature = signDataEcdsa(dataKey, message);
  if (!verifyDataSignature(signature, show.organiserDataPk, message)) refuse('sign-failed', 'the notice did not verify after signing', { status: 500 });
  return {
    scope: 'R',
    show: show.id,
    category: show.categoryHex,
    seat: bytesToHex(request.seat),
    seatLabel: seatLabelOf(show, request.seat),
    signature: bytesToHex(signature),
    marker,
  };
};
