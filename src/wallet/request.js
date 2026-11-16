// Turn a builder result into a WizardConnect sign_transaction_request body.
//
// Format (protocol docs, probe/src/wire.js): the transaction as hex, the
// source outputs merged with their inputs, bytes as hex and bigints as
// "<bigint: Nn>" (sourceOutputToRelay), `broadcast: false` ALWAYS, a
// `userPrompt`, and `inputPaths` naming the wallet path of every input the
// wallet must sign. The app broadcasts the checked reply itself.
import { binToHex, encodeTransaction } from '@bitauth/libauth';
import { sourceOutputToRelay } from '@wizardconnect/core/hdwalletv1-serialize';
import { WalletError } from './hd.js';

/** Throw unless the request is sign-only. */
export const assertSignOnly = (request) => {
  if (request?.transaction?.broadcast !== false) throw new WalletError('not-sign-only', 'Doorstub sign requests must carry broadcast: false');
  return request;
};

/** Source outputs as a wallet expects them: the input's fields plus the spent output. */
export const wcSourceOutputs = (built) => built.sourceOutputs.map((output, i) => ({ ...built.transaction.inputs[i], ...output }));

/**
 * @param {object} built a builder result ({ transaction, sourceOutputs, walletInputIndexes })
 * @param {object} options
 * @param {(lockingBytecode: Uint8Array) => ({ path, index } | undefined)} options.pathOf wallet path of a coin (pathLookup from hd.js)
 * @param {string} options.userPrompt what the wallet shows on its confirm screen
 * @returns {{ transaction: { transaction, sourceOutputs, broadcast: false, userPrompt }, inputPaths: Array<[number, string, number]> }}
 */
export const buildSignRequest = (built, { pathOf, userPrompt }) => {
  if (!Array.isArray(built?.walletInputIndexes) || built.walletInputIndexes.length === 0) {
    throw new WalletError('nothing-to-sign', `${built?.kind ?? 'this transaction'} has no input for the wallet to sign`);
  }
  if (typeof userPrompt !== 'string' || userPrompt.length === 0) throw new WalletError('no-prompt', 'a sign request needs a userPrompt');
  const inputPaths = built.walletInputIndexes.map((inputIndex) => {
    const where = pathOf(built.sourceOutputs[inputIndex].lockingBytecode);
    if (where === undefined) throw new WalletError('unknown-coin', `input ${inputIndex} is not at an address of this wallet`);
    return [inputIndex, where.path, where.index];
  });
  const request = {
    transaction: {
      transaction: binToHex(encodeTransaction(built.transaction)),
      sourceOutputs: wcSourceOutputs(built).map((so) => sourceOutputToRelay(so)),
      broadcast: false,
      userPrompt,
    },
    inputPaths,
  };
  return assertSignOnly(request);
};
