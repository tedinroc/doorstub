// Verify a show's genesis from the chain (SPEC 7, "Genesis" and "Which genesis").
//
// The genesis bytes come from Fulcrum by the txid in shows.json, and
// getTransaction checks they hash to that txid. verifyGenesis then checks the
// transaction (born category, only open shards at the recomputed BoxOffice,
// distinct shard bytes, policy). Finally the transaction must be CONFIRMED:
// it must appear with a height > 0 in the BoxOffice address's history (every
// genesis output sits there). Two different transactions can spend the
// category's parent outpoint, but only one can be mined, so a confirmed txid
// is the real genesis. On the simnet, "confirmed" means mined.
import { DoorstubError, verifyGenesis } from '../tx/index.js';
import { createTxCache, getTransaction, heightInHistory } from '../chain/queries.js';

export class GenesisError extends Error {
  constructor(code, message, showId) {
    super(`${showId}: ${message}`);
    this.name = 'GenesisError';
    this.code = code;
    this.showId = showId;
  }
}

/**
 * @returns {Promise<{ showId, txid, height, shards: Array<{ vout, shard }> }>}
 * @throws {GenesisError} genesis-missing | genesis-unconfirmed | genesis-unknown |
 *   genesis-shard-count, or the verifyGenesis code (genesis-foreign-token, ...)
 */
export const verifyShowGenesis = async (pool, show, { cache = createTxCache() } = {}) => {
  let entry;
  try {
    entry = await getTransaction(pool, show.genesisTxid, { cache });
  } catch (e) {
    throw new GenesisError('genesis-missing', `cannot fetch genesis ${show.genesisTxid}: ${e.message}`, show.id);
  }
  let result;
  try {
    result = verifyGenesis({ show, transaction: entry.bytes, txid: show.genesisTxid });
  } catch (e) {
    throw new GenesisError(e instanceof DoorstubError ? e.code : 'genesis-invalid', e.message, show.id);
  }
  if (result.shards.length !== show.shards) {
    throw new GenesisError('genesis-shard-count', `genesis makes ${result.shards.length} shards, shows.json says ${show.shards}`, show.id);
  }
  const height = await heightInHistory(pool, show.genesisTxid, show.contracts.boxOffice.lockingBytecode);
  if (height === null) throw new GenesisError('genesis-unknown', 'the server does not list the genesis at the box office address', show.id);
  if (height <= 0) throw new GenesisError('genesis-unconfirmed', 'the genesis is not confirmed yet', show.id);
  return { showId: show.id, txid: show.genesisTxid, height, shards: result.shards };
};

/**
 * Verify every show; returns { verified: show[], failed: Array<{ show, code, message }> }.
 * The app sells only verified shows.
 */
export const verifyShows = async (pool, shows, { cache = createTxCache() } = {}) => {
  const verified = [];
  const failed = [];
  await Promise.all(
    shows.map(async (show) => {
      try {
        const genesis = await verifyShowGenesis(pool, show, { cache });
        verified.push(Object.assign(show, { genesis }));
      } catch (e) {
        failed.push({ show, code: e.code ?? 'genesis-error', message: e.message });
      }
    }),
  );
  const order = new Map(shows.map((s, i) => [s.id, i]));
  verified.sort((a, b) => order.get(a.id) - order.get(b.id));
  return { verified, failed };
};
