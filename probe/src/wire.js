// Turn a probe shape into a WizardConnect sign request, in the relay format
// the protocol documents: the transaction as hex, source outputs with bytes as
// hex and bigints as "<bigint: Nn>" (sourceOutputToRelay from @wizardconnect/core).
//
// The probe never asks a wallet to broadcast: `broadcast` is always false and
// this module refuses to build anything else.
import { binToHex, encodeTransaction } from '@bitauth/libauth';
import { sourceOutputToRelay } from '@wizardconnect/core/hdwalletv1-serialize';
import { USER_PROMPT } from './shapes.js';

/** Source output as a wallet expects it: the input fields plus the spent output. */
export const wcSourceOutputs = (shape) =>
  shape.sourceOutputs.map((output, i) => ({ ...shape.transaction.inputs[i], ...output }));

/** The `transaction` and `inputPaths` fields of a sign_transaction_request. */
export const toSignRequest = (shape, userPrompt = USER_PROMPT) => {
  const request = {
    transaction: {
      transaction: binToHex(encodeTransaction(shape.transaction)),
      sourceOutputs: wcSourceOutputs(shape).map((so) => sourceOutputToRelay(so)),
      broadcast: false,
      userPrompt,
    },
    inputPaths: shape.inputPaths.map(([inputIndex, pathName, addressIndex]) => [inputIndex, pathName, addressIndex]),
  };
  assertSignOnly(request);
  return request;
};

/** Throw unless the request is sign-only. */
export const assertSignOnly = (request) => {
  if (request?.transaction?.broadcast !== false) throw new Error('probe requests must carry broadcast: false');
  return request;
};
