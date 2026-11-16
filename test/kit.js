// Attack kit: hand-built transactions over made-up coins, and assertions that
// the libauth 2026 VM rejects them in BOTH standard and consensus mode.
//
// The VM does not ask where a source output came from, so a made-up coin
// models "suppose someone held this coin". Every P2PKH input is signed after
// the last change to the transaction, so a rejection comes from the rule a
// test names (a contract check, or a token rule where the test says so), never
// from a stale signature. Keys are fresh and never funded; outpoints are random.
import { bigIntToVmNumber, encodeDataPush, flattenBinArray } from '@bitauth/libauth';
import {
  SEQUENCE_FINAL,
  SEQUENCE_LOCKTIME,
  buildBuy,
  describeResult,
  encodeBoxOfficeCommitment,
  encodeMarkerCommitment,
  encodeRefundNoticeMessage,
  encodeSeat,
  encodeTicketCommitment,
  evaluateTransaction,
  p2pkhLockingBytecode,
  scopeByte,
  signingDigest,
} from '../src/tx/index.js';
import { signDataMessage, signDigest, signP2pkhInput } from '../src/tx/sign.js';
import { fakeCoin, freshKey, randomTxid, saleHeight } from './helpers.js';

export const MODES = ['standard', 'consensus'];
export const p2pkh = p2pkhLockingBytecode;

/** A plain BCH output. */
export const out = (lockingBytecode, valueSatoshis) => ({ lockingBytecode, valueSatoshis: BigInt(valueSatoshis) });

/** An output carrying one NFT (and, if asked, a fungible amount) of `category`. */
export const nftOut = (lockingBytecode, valueSatoshis, { category, commitment, capability = 'none', amount = 0n }) => ({
  lockingBytecode,
  valueSatoshis: BigInt(valueSatoshis),
  token: { amount: BigInt(amount), category, nft: { capability, commitment } },
});

/** A made-up coin (random outpoint) holding `output`. */
export const coin = (output, vout = 0) => ({ txid: randomTxid(), vout, output });

export const seatOf = (shard, sold) => encodeSeat({ shard, sold });

/** Value of a sample escrow coin: price + 1,000. */
export const coinValue = (ctx) => BigInt(ctx.show.price) + 1000n;

/** Settle opens at this locktime. */
export const settleHeight = (ctx) => Number(BigInt(ctx.show.startHeight) + BigInt(ctx.show.graceBlocks));

/** A made-up Escrow coin. Defaults to an honest one; override any field to forge one. */
export const escrowCoin = (
  ctx,
  {
    seat = seatOf(0, 1),
    buyerPkh,
    value = coinValue(ctx),
    commitment = encodeMarkerCommitment(seat, buyerPkh),
    category = ctx.show.category,
    capability = 'none',
    amount = 0n,
    lockingBytecode = ctx.contracts.escrow.lockingBytecode,
  } = {},
) => coin(nftOut(lockingBytecode, value, { category, commitment, capability, amount }));

/** A made-up ticket. Defaults to an honest one at P2PKH(buyerPkh). */
export const ticketCoin = (
  ctx,
  {
    seat = seatOf(0, 1),
    buyerPkh,
    holderLock = p2pkh(buyerPkh),
    value = 1000n,
    commitment = encodeTicketCommitment(seat, buyerPkh),
    category = ctx.show.category,
    capability = 'none',
    amount = 0n,
  } = {},
) => coin(nftOut(holderLock, value, { category, commitment, capability, amount }));

/** A made-up BoxOffice shard. */
export const shardCoin = (
  ctx,
  {
    open = true,
    shard = 0,
    sold = 0,
    value = 1000n,
    commitment = encodeBoxOfficeCommitment({ open, shard, sold }),
    category = ctx.show.category,
    capability = 'minting',
    lockingBytecode = ctx.contracts.boxOffice.lockingBytecode,
  } = {},
) => coin(nftOut(lockingBytecode, value, { category, commitment, capability }));

/** Escrow unlocking bytecode for each path. */
export const escrowUnlock = (ctx) => ({
  handBack: (ticketInputIndex = 1) => ctx.contracts.escrow.unlock('handBack', [BigInt(ticketInputIndex)]),
  checkIn: (ticketInputIndex = 1) => ctx.contracts.escrow.unlock('checkIn', [BigInt(ticketInputIndex)]),
  settle: () => ctx.contracts.escrow.unlock('settle'),
  refund: (signature, scope) => ctx.contracts.escrow.unlock('refund', [signature, scopeByte(scope)]),
});

/**
 * Unlocking bytecode with raw, already-encoded argument bytes (declaration
 * order), for arguments the normal encoder refuses (wrong lengths, bad selectors).
 */
export const rawUnlock = (instance, selector, args) =>
  flattenBinArray([
    ...[...args].reverse().map((arg) => encodeDataPush(arg)),
    ...(selector === undefined ? [] : [encodeDataPush(bigIntToVmNumber(BigInt(selector)))]),
    encodeDataPush(instance.redeemScript),
  ]);

/** Organiser data signature on a refund notice. */
export const notice = (ctx, scope, seat, key = ctx.dataKey) =>
  signDataMessage(key.privateKey, encodeRefundNoticeMessage({ scope, category: ctx.show.category, seat }));

/**
 * Build a resolved transaction from inputs [{ coin, unlock, signer, sequence }].
 * `unlock` is a contract input's unlocking bytecode, or a function
 * ({ transaction, sourceOutputs, inputIndex }) => bytecode for contract inputs
 * that sign (closeSales). `signer` (a test key) signs a P2PKH input, with
 * `sighash` (default SIGHASH_ALL | SIGHASH_UTXOS | FORKID, 0x61).
 */
export const assemble = ({ inputs, outputs, locktime = 0, version = 2 }) => {
  const sourceOutputs = inputs.map((input) => input.coin.output);
  let transaction = {
    version,
    locktime,
    outputs,
    inputs: inputs.map(({ coin: c, unlock, sequence = SEQUENCE_FINAL }) => ({
      outpointTransactionHash: c.txid,
      outpointIndex: c.vout,
      sequenceNumber: sequence,
      unlockingBytecode: unlock instanceof Uint8Array ? unlock : new Uint8Array(),
    })),
  };
  inputs.forEach((input, inputIndex) => {
    if (typeof input.unlock === 'function') {
      const unlockingBytecode = input.unlock({ transaction, sourceOutputs, inputIndex });
      transaction = {
        ...transaction,
        inputs: transaction.inputs.map((x, i) => (i === inputIndex ? { ...x, unlockingBytecode } : x)),
      };
    } else if (input.signer !== undefined) {
      transaction = signP2pkhInput({ transaction, sourceOutputs, inputIndex, privateKey: input.signer.privateKey, sighashType: input.sighash });
    }
  });
  return { transaction, sourceOutputs };
};

/** A closeSales unlock signed by `key` over the final transaction. */
export const closeSalesUnlock = (ctx, key = ctx.organiser) => ({ transaction, sourceOutputs, inputIndex }) => {
  const { boxOffice } = ctx.contracts;
  const digest = signingDigest({ transaction, sourceOutputs, inputIndex, coveredBytecode: boxOffice.redeemScript });
  return boxOffice.unlock('closeSales', [signDigest(key.privateKey, digest)]);
};

/** Inputs and outputs of an honest buy, ready to tamper with and re-assemble. */
export const honestBuy = (ctx, { buyer = freshKey(), shard = ctx.shardUtxos[0], funding } = {}) => {
  const fundingCoin = funding ?? fakeCoin(buyer.pkh, 50_000);
  const built = buildBuy({ show: ctx.show, boxOfficeUtxo: shard, fundingUtxos: [fundingCoin], buyerPkh: buyer.pkh, currentHeight: saleHeight(ctx.show) });
  return {
    buyer,
    built,
    seat: built.seat,
    inputs: [
      { coin: shard, unlock: built.transaction.inputs[0].unlockingBytecode },
      { coin: fundingCoin, signer: buyer },
    ],
    outputs: built.transaction.outputs,
  };
};

export { SEQUENCE_LOCKTIME };

/** Short reason for a result: the first failing input or the whole-transaction error. */
export const why = (result) => describeResult(result);

/**
 * Assert the 2026 VM rejects `resolved` in standard AND consensus mode.
 *   failing: input index (or list) that must fail in both modes. Unless
 *            `othersPass` is false, every other input must pass, which pins the
 *            rejection on the named input's own rule.
 *   verify:  RegExp the whole-transaction error must match, for attacks that a
 *            consensus token or value rule stops rather than a contract.
 */
export const expectReject = (assert, resolved, { failing, othersPass = true, verify } = {}, label = 'attack') => {
  const result = evaluateTransaction(resolved);
  for (const mode of MODES) {
    const r = result[mode];
    assert.equal(r.ok, false, `${label}: the ${mode} VM must reject`);
    if (failing !== undefined) {
      const list = [failing].flat();
      for (const i of list) assert.notEqual(r.inputs[i], true, `${label}: ${mode}: input ${i} must fail`);
      if (othersPass) {
        r.inputs.forEach((x, i) => {
          if (!list.includes(i)) assert.equal(x, true, `${label}: ${mode}: input ${i} should pass, got ${x}`);
        });
      }
    }
    if (verify !== undefined) assert.match(String(r.verify), verify, `${label}: ${mode} whole-transaction error`);
  }
  return result;
};

/** Assert the VM accepts `resolved` in both modes (honest controls and pinned limits). */
export const expectAccept = (assert, resolved, label = 'control') => {
  const result = evaluateTransaction(resolved);
  assert.equal(why(result), 'ok', `${label} should be valid`);
  assert.equal(result.standard.ok, true);
  assert.equal(result.consensus.ok, true);
  return result;
};
