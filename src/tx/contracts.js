// Instantiate the compiled contracts as P2SH32 and build their unlocking bytecode.
// Mirrors CashScript's encoding: constructor arguments are pushed in reverse order
// before the contract bytecode; function arguments are pushed in reverse order,
// then the function selector (only when the contract has several functions),
// then the redeem script.
import {
  bigIntToVmNumber,
  encodeDataPush,
  encodeLockingBytecodeP2sh32,
  flattenBinArray,
  hash256,
  hexToBin,
  lockingBytecodeToCashAddress,
} from '@bitauth/libauth';
import { BoxOfficeArtifact, EscrowArtifact } from './artifacts.js';
import {
  MAX_MINER_FEE_CAP,
  MAX_MINER_FEE_CAP_BPS,
  MAX_POSTED_FEE_BPS,
  MIN_MINER_FEE_CAP,
  MIN_PRICE,
} from './constants.js';
import { DoorstubError, assertBytes, categoryToVmOrder } from './encoding.js';

const encodeArgument = (value, type, name) => {
  if (type === 'int') {
    if (typeof value !== 'bigint' && !Number.isInteger(value)) {
      throw new DoorstubError('bad-argument', `${name} must be an integer`);
    }
    return bigIntToVmNumber(BigInt(value));
  }
  if (!(value instanceof Uint8Array)) throw new DoorstubError('bad-argument', `${name} must be a Uint8Array`);
  const bounded = /^bytes(\d+)$/.exec(type);
  if (bounded) assertBytes(value, Number(bounded[1]), name);
  if (type === 'pubkey') assertBytes(value, 33, name);
  if (type === 'sig' && ![0, 65, 71, 72, 73].includes(value.length)) {
    throw new DoorstubError('bad-argument', `${name} has an invalid signature length ${value.length}`);
  }
  if (type === 'datasig' && ![0, 64, 70, 71, 72].includes(value.length)) {
    throw new DoorstubError('bad-argument', `${name} has an invalid data signature length ${value.length}`);
  }
  return value;
};

const pushAll = (items) => flattenBinArray(items.map((item) => encodeDataPush(item)));

/**
 * Instantiate an artifact with constructor arguments (in declaration order).
 * Returns the redeem script, the P2SH32 locking bytecode and an `unlock` helper.
 */
export const instantiate = (artifact, args) => {
  if (args.length !== artifact.constructorInputs.length) {
    throw new DoorstubError('bad-argument', `${artifact.contractName} takes ${artifact.constructorInputs.length} arguments`);
  }
  const encoded = args.map((arg, i) =>
    encodeArgument(arg, artifact.constructorInputs[i].type, artifact.constructorInputs[i].name),
  );
  const redeemScript = flattenBinArray([pushAll([...encoded].reverse()), hexToBin(artifact.bytecodeHex)]);
  const lockingBytecode = encodeLockingBytecodeP2sh32(hash256(redeemScript));

  /** Unlocking bytecode for `functionName(...functionArgs)`. */
  const unlock = (functionName, functionArgs = []) => {
    const index = artifact.abi.findIndex((f) => f.name === functionName);
    if (index === -1) throw new DoorstubError('bad-function', `${artifact.contractName} has no function ${functionName}`);
    const abi = artifact.abi[index];
    if (functionArgs.length !== abi.inputs.length) {
      throw new DoorstubError('bad-argument', `${functionName} takes ${abi.inputs.length} arguments`);
    }
    const encodedArgs = functionArgs.map((arg, i) => encodeArgument(arg, abi.inputs[i].type, abi.inputs[i].name));
    const pushes = [...encodedArgs].reverse();
    if (artifact.abi.length > 1) pushes.push(bigIntToVmNumber(BigInt(index)));
    pushes.push(redeemScript);
    return pushAll(pushes);
  };

  const address = (prefix = 'bitcoincash', tokenSupport = true) => {
    const result = lockingBytecodeToCashAddress({ bytecode: lockingBytecode, prefix, tokenSupport });
    if (typeof result === 'string') throw new DoorstubError('bad-address', result);
    return result.address;
  };

  return { name: artifact.contractName, artifact, redeemScript, lockingBytecode, unlock, address };
};

/**
 * Escrow for one show.
 * @param {object} show
 * @param {Uint8Array} show.category 32-byte token category in display order (the genesis input's txid)
 * @param {Uint8Array} show.organiserPkh 20-byte payee public key hash
 * @param {Uint8Array} show.organiserDataPk 33-byte key that signs refund notices
 */
export const escrowContract = (show) =>
  instantiate(EscrowArtifact, [
    categoryToVmOrder(show.category),
    show.organiserPkh,
    show.organiserDataPk,
    BigInt(show.startHeight),
    BigInt(show.graceBlocks),
    BigInt(show.handBackFeeBps),
    BigInt(show.noShowFeeBps),
    BigInt(show.minerFeeCap),
  ]);

/**
 * BoxOffice for one show (every shard shares it; the shard number lives in the
 * commitment). It commits to the show's category, so a shard of any other
 * category can never sell here.
 */
export const boxOfficeContract = (show, escrowLockingBytecode) =>
  instantiate(BoxOfficeArtifact, [categoryToVmOrder(show.category), BigInt(show.price), show.organiserPk, escrowLockingBytecode]);

/** Both contracts of a show. */
export const showContracts = (show) => {
  validateShow(show);
  const escrow = escrowContract(show);
  const boxOffice = boxOfficeContract(show, escrow.lockingBytecode);
  return { escrow, boxOffice };
};

/**
 * Check a show's posted parameters: types, and the app's policy bounds
 * (SPEC.md section 6). Every builder and verifyGenesis call this, so a show
 * outside the bounds can be neither built nor sold.
 *
 * - minerFeeCap: at least MIN_MINER_FEE_CAP (the largest single-coin Escrow
 *   transaction at 1 sat/byte, so every path can pay its own fee), at most
 *   MAX_MINER_FEE_CAP and at most MAX_MINER_FEE_CAP_BPS of the price.
 * - handBackFeeBps and noShowFeeBps: at most MAX_POSTED_FEE_BPS (10%).
 * - price: at least MIN_PRICE, which follows from the two cap bounds. Then
 *   every honest output stays far above dust (SPEC.md section 6).
 */
export const validateShow = (show) => {
  assertBytes(show.category, 32, 'category');
  assertBytes(show.organiserPk, 33, 'organiserPk');
  assertBytes(show.organiserPkh, 20, 'organiserPkh');
  assertBytes(show.organiserDataPk, 33, 'organiserDataPk');
  const ints = ['price', 'startHeight', 'graceBlocks', 'handBackFeeBps', 'noShowFeeBps', 'minerFeeCap'];
  for (const key of ints) {
    const value = BigInt(show[key]);
    if (value < 0n) throw new DoorstubError('bad-show', `${key} must not be negative`);
  }
  const price = BigInt(show.price);
  const cap = BigInt(show.minerFeeCap);
  if (BigInt(show.handBackFeeBps) > MAX_POSTED_FEE_BPS || BigInt(show.noShowFeeBps) > MAX_POSTED_FEE_BPS) {
    throw new DoorstubError('bad-show', `posted fees are at most ${MAX_POSTED_FEE_BPS} bps (${Number(MAX_POSTED_FEE_BPS) / 100}%)`);
  }
  if (price < MIN_PRICE) {
    throw new DoorstubError('bad-show', `price must be at least ${MIN_PRICE} sats (the miner-fee cap must fit within ${Number(MAX_MINER_FEE_CAP_BPS) / 100}% of it)`);
  }
  if (cap < MIN_MINER_FEE_CAP) {
    throw new DoorstubError('bad-show', `minerFeeCap must be at least ${MIN_MINER_FEE_CAP} sats, or some Escrow paths cannot pay their own miner fee`);
  }
  if (cap > MAX_MINER_FEE_CAP || cap * 10000n > price * MAX_MINER_FEE_CAP_BPS) {
    throw new DoorstubError('bad-show', `minerFeeCap must be at most ${MAX_MINER_FEE_CAP} sats and at most ${Number(MAX_MINER_FEE_CAP_BPS) / 100}% of the price`);
  }
  if (BigInt(show.startHeight) + BigInt(show.graceBlocks) >= 500_000_000n) {
    throw new DoorstubError('bad-show', 'startHeight + graceBlocks must be a block height (below 500,000,000)');
  }
  return show;
};
