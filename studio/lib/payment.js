// Plain P2PKH payments from the studio key (the prep transactions before each
// genesis, and fee coins). Builders in src/tx never sign; the studio signs
// with its own key through src/tx/sign.js.
import { encodeTransaction, getDustThreshold, hashTransactionUiOrder } from '@bitauth/libauth';
import { DEFAULT_FEE_RATE, P2PKH_UNLOCK_MAX_BYTES, SEQUENCE_FINAL, estimateSize } from '../../src/tx/index.js';
import { signP2pkhInputs } from '../../src/tx/sign.js';

const sum = (values) => values.reduce((a, b) => a + b, 0n);

/**
 * Pay `outputs` from `coins` (plain coins at the key's P2PKH address) with
 * change to `changeLockingBytecode` (always the last output when kept).
 * Returns { transaction, sourceOutputs, fee, change, txid } signed with `privateKey`.
 */
export const buildSignedPayment = ({ coins, outputs, changeLockingBytecode, privateKey, feeRate = DEFAULT_FEE_RATE, keepChange = true }) => {
  if (coins.length === 0) throw new Error('no coins to spend');
  for (const coin of coins) if (coin.output.token !== undefined) throw new Error('studio payments spend plain coins only');
  const inputs = coins.map((coin) => ({
    outpointTransactionHash: coin.txid,
    outpointIndex: coin.vout,
    sequenceNumber: SEQUENCE_FINAL,
    unlockingBytecode: new Uint8Array(),
  }));
  const placeholders = new Map(inputs.map((_, i) => [i, P2PKH_UNLOCK_MAX_BYTES]));
  const totalIn = sum(coins.map((c) => c.output.valueSatoshis));
  const fixedOut = sum(outputs.map((o) => o.valueSatoshis));
  const draft = { version: 2, inputs, outputs: [...outputs, { lockingBytecode: changeLockingBytecode, valueSatoshis: 0n }], locktime: 0 };
  const feeWithChange = BigInt(estimateSize(draft, placeholders)) * BigInt(feeRate);
  const change = totalIn - fixedOut - feeWithChange;
  let transaction;
  let fee;
  if (change >= getDustThreshold({ lockingBytecode: changeLockingBytecode, valueSatoshis: change })) {
    transaction = { ...draft, outputs: [...outputs, { lockingBytecode: changeLockingBytecode, valueSatoshis: change }] };
    fee = feeWithChange;
  } else {
    if (keepChange) throw new Error(`insufficient funds: short by ${546n - change} sats for the change that funds the next step`);
    transaction = { ...draft, outputs };
    fee = totalIn - fixedOut;
    const minimum = BigInt(estimateSize(transaction, placeholders)) * BigInt(feeRate);
    if (fee < minimum) throw new Error(`insufficient funds: short by ${minimum - fee} sats`);
  }
  const sourceOutputs = coins.map((c) => c.output);
  const signed = signP2pkhInputs({ transaction, sourceOutputs, inputIndexes: inputs.map((_, i) => i), privateKey });
  return {
    transaction: signed,
    sourceOutputs,
    fee,
    change: transaction.outputs.length > outputs.length ? change : 0n,
    txid: hashTransactionUiOrder(encodeTransaction(signed)),
  };
};
