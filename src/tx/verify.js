// Client-side checks the contracts cannot make (SPEC.md section 7).
import { decodeTransaction, encodeTransaction, hashTransactionUiOrder, hexToBin } from '@bitauth/libauth';
import { DoorstubError, decodeBoxOfficeCommitment, sameBytes } from './encoding.js';
import { showContracts } from './contracts.js';

const fail = (code, message) => {
  throw new DoorstubError(code, message);
};

const toTxid = (txid) => {
  const bytes = typeof txid === 'string' ? hexToBin(txid) : txid;
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) fail('bad-txid', 'txid must be 32 bytes (display order) or 64 hex characters');
  return bytes;
};

/**
 * Verify a show's genesis transaction before selling from (or buying at) its
 * box office. The contracts never see genesis, so this is what makes seat ids
 * unique across shards and rules out pre-minted tickets or markers.
 *
 * Checks, in order:
 * - the posted show parameters are valid and inside the app's policy bounds
 *   (validateShow: fees, miner-fee cap, price, heights, key sizes);
 * - the transaction's txid equals `txid`, when the caller names one;
 * - one input spends output 0 of transaction `show.category`, so the category
 *   is born in this transaction and every token of it starts here;
 * - no output carries a token of any other category (so nothing else sits at
 *   the BoxOffice or the Escrow looking like a shard or a marker);
 * - every output carrying the category is an open BoxOffice shard: a minting
 *   NFT at the BoxOffice address recomputed from the posted parameters (which
 *   commits to the category and to the Escrow), commitment 01 | shard | 0000,
 *   and no fungible amount;
 * - shard bytes are distinct, and there is at least one shard.
 *
 * What it cannot check: that this transaction is the one mined. Only one
 * transaction can ever spend (category, 0), but a different, clean-looking
 * one can be shown to a client. The caller must take the genesis txid and
 * bytes from a source independent of the show page and the organiser (its own
 * node or indexer), require it to be confirmed on chain, and pass that txid
 * here (SPEC.md section 7).
 *
 * `transaction` is a decoded libauth transaction (txids and categories in
 * display order) or the raw transaction bytes. `txid` is optional: 32 bytes in
 * display order or 64 hex characters. Returns { txid, shards: [{ vout, shard }] },
 * with `txid` in display order; throws DoorstubError.
 */
export const verifyGenesis = ({ show, transaction, txid: expectedTxid }) => {
  const { boxOffice } = showContracts(show);
  let raw;
  let decoded;
  if (transaction instanceof Uint8Array) {
    raw = transaction;
    decoded = decodeTransaction(raw);
    if (typeof decoded === 'string') fail('genesis-undecodable', `genesis bytes do not decode: ${decoded}`);
  } else {
    decoded = transaction;
    raw = encodeTransaction(transaction);
  }
  const txid = hashTransactionUiOrder(raw);
  if (expectedTxid !== undefined && !sameBytes(txid, toTxid(expectedTxid))) {
    fail('genesis-txid-mismatch', 'this is not the transaction with the given (mined) genesis txid');
  }

  const born = decoded.inputs.some(
    (input) => input.outpointIndex === 0 && sameBytes(input.outpointTransactionHash, show.category),
  );
  if (!born) fail('genesis-not-here', 'no input spends output 0 of the category\'s transaction; this is not the genesis');

  const seen = new Set();
  const shards = [];
  decoded.outputs.forEach((output, vout) => {
    const token = output.token;
    if (token === undefined) return;
    if (!sameBytes(token.category, show.category)) {
      fail('genesis-foreign-token', `output ${vout} carries a token of another category; a genesis may create only the show's shards`);
    }
    if (token.amount !== 0n || token.nft === undefined) {
      fail('genesis-fungible', `output ${vout} mints fungible tokens of the show's category`);
    }
    if (token.nft.capability !== 'minting') {
      fail('genesis-pre-minted', `output ${vout} pre-mints a ${token.nft.capability} NFT (ticket or marker)`);
    }
    if (!sameBytes(output.lockingBytecode, boxOffice.lockingBytecode)) {
      fail('genesis-minting-elsewhere', `output ${vout} holds minting capability outside the show's BoxOffice`);
    }
    let state;
    try {
      state = decodeBoxOfficeCommitment(token.nft.commitment);
    } catch {
      fail('genesis-bad-shard', `output ${vout} is not a BoxOffice commitment (state | shard | sold)`);
    }
    if (!state.open || state.sold !== 0) fail('genesis-bad-shard', `output ${vout} must start open with sold = 0`);
    if (seen.has(state.shard)) fail('genesis-duplicate-shard', `shard ${state.shard} appears twice; seat ids would repeat`);
    seen.add(state.shard);
    shards.push({ vout, shard: state.shard });
  });
  if (shards.length === 0) fail('genesis-no-shards', 'genesis creates no BoxOffice shard of this category');
  return { txid, shards };
};
