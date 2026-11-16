// The only way to get a transaction that the pool will broadcast.
//
// `checkTransaction` evaluates a fully built transaction in the 2026 VM, in
// standard and consensus mode, with source outputs the CALLER supplies (ours,
// from our own UTXO lookups; never the wallet's). It returns a frozen object
// and remembers it in a module-private WeakSet. `broadcastChecked` in the pool
// refuses anything that is not such an object, so nothing reaches the network
// unless it passed the VM here.
//
// Callers add their own checks first: `checkSignedReply` (src/wallet/check.js)
// compares a wallet's reply with what we built; `checkSignatureFree` below
// covers the keeper paths (settle, refund) that need no key.
import { binToHex, encodeTransaction, hashTransactionUiOrder } from '@bitauth/libauth';
import { MAX_STANDARD_TX_BYTES, describeResult, evaluateTransaction } from '../tx/index.js';

const CHECKED = new WeakSet();

export class CheckError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'CheckError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/**
 * VM-check a transaction and brand it as broadcastable.
 * @param {object} args
 * @param {object} args.transaction decoded libauth transaction, fully signed
 * @param {Array} args.sourceOutputs the outputs it spends, from OUR lookups
 * @param {string} [args.kind] buy | handBack | checkIn | settle | refund | genesis | closeSales | ...
 * @returns {Readonly<{ kind, txid, hex, size, transaction, sourceOutputs }>}
 */
export const checkTransaction = ({ transaction, sourceOutputs, kind = 'transaction' }) => {
  if (transaction === null || typeof transaction !== 'object' || !Array.isArray(transaction.inputs)) {
    throw new CheckError('bad-transaction', 'expected a decoded transaction');
  }
  if (!Array.isArray(sourceOutputs) || sourceOutputs.length !== transaction.inputs.length) {
    throw new CheckError('bad-source-outputs', 'need exactly one source output per input');
  }
  const bytes = encodeTransaction(transaction);
  if (bytes.length > MAX_STANDARD_TX_BYTES) {
    throw new CheckError('tx-too-large', `${bytes.length} bytes is over the ${MAX_STANDARD_TX_BYTES}-byte standard limit`);
  }
  const result = evaluateTransaction({ transaction, sourceOutputs });
  if (!result.ok) throw new CheckError('vm-invalid', `the 2026 VM refuses this ${kind}: ${describeResult(result)}`, describeResult(result));
  const checked = Object.freeze({
    kind,
    txid: binToHex(hashTransactionUiOrder(bytes)),
    hex: binToHex(bytes),
    size: bytes.length,
    transaction,
    sourceOutputs,
  });
  CHECKED.add(checked);
  return checked;
};

/** Did this exact object come out of checkTransaction? */
export const isChecked = (value) => value !== null && typeof value === 'object' && CHECKED.has(value);

/**
 * Keeper paths: a builder result that needs no signature at all (settle,
 * refund). Refuses anything with wallet inputs left to sign.
 */
export const checkSignatureFree = (built) => {
  if (!['settle', 'refund'].includes(built?.kind)) throw new CheckError('not-signature-free', `${built?.kind} needs a signature; use checkSignedReply`);
  if (built.walletInputIndexes.length !== 0) throw new CheckError('not-signature-free', 'this transaction has inputs a wallet must sign');
  return checkTransaction({ transaction: built.transaction, sourceOutputs: built.sourceOutputs, kind: built.kind });
};
