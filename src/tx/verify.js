// Client-side checks the contracts cannot make (SPEC.md section 7).
import { DoorstubError, decodeBoxOfficeCommitment, sameBytes } from './encoding.js';
import { showContracts } from './contracts.js';

const fail = (code, message) => {
  throw new DoorstubError(code, message);
};

/**
 * Verify a show's genesis transaction before selling from (or buying at) its
 * box office. The contracts never see genesis, so this is what makes seat ids
 * unique across shards and rules out pre-minted tickets or markers.
 *
 * Checks, in order:
 * - the posted show parameters are valid (fees, heights, key sizes);
 * - one input spends output 0 of transaction `show.category`, so the category
 *   is born in this transaction and every token of it starts here;
 * - every output carrying the category is an open BoxOffice shard: a minting
 *   NFT at the BoxOffice address recomputed from the posted parameters (which
 *   commits to the Escrow and its category), commitment 01 | shard | 0000, and
 *   no fungible amount;
 * - shard bytes are distinct, and there is at least one shard.
 *
 * `transaction` is a decoded libauth transaction (txids and categories in
 * display order). Returns { shards: [{ vout, shard }] }; throws DoorstubError.
 */
export const verifyGenesis = ({ show, transaction }) => {
  const { boxOffice } = showContracts(show);
  const born = transaction.inputs.some(
    (input) => input.outpointIndex === 0 && sameBytes(input.outpointTransactionHash, show.category),
  );
  if (!born) fail('genesis-not-here', 'no input spends output 0 of the category\'s transaction; this is not the genesis');

  const seen = new Set();
  const shards = [];
  transaction.outputs.forEach((output, vout) => {
    const token = output.token;
    if (token === undefined || !sameBytes(token.category, show.category)) return;
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
  return { shards };
};
