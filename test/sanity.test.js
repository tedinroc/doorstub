// Checks on the test harness itself: our contract encoding matches the
// CashScript SDK byte for byte, and the VM helper really rejects bad
// transactions (so the happy paths prove something). The full attack suite
// lives in its own files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { binToHex } from '@bitauth/libauth';
import { Contract, MockNetworkProvider } from 'cashscript';
import {
  buildBuy,
  buildRefund,
  buildSettle,
  categoryToVmOrder,
  encodeRefundNoticeMessage,
  encodeTicketCommitment,
  encodeSeat,
  evaluateTransaction,
} from '../src/tx/index.js';
import { signDataMessage } from '../src/tx/sign.js';
import { fakeCoin, freshKey, makeShow, signWallet, utxoAt } from './helpers.js';

const artifact = (name) => JSON.parse(readFileSync(new URL(`../contracts/${name}.json`, import.meta.url), 'utf8'));

test('redeem scripts, locking and unlocking bytecode match the CashScript SDK', () => {
  const ctx = makeShow(assert);
  const provider = new MockNetworkProvider();
  const { show, contracts } = ctx;
  const sdkEscrow = new Contract(
    artifact('Escrow'),
    [
      categoryToVmOrder(show.category),
      show.organiserPkh,
      show.organiserDataPk,
      BigInt(show.startHeight),
      BigInt(show.graceBlocks),
      BigInt(show.handBackFeeBps),
      BigInt(show.noShowFeeBps),
      BigInt(show.minerFeeCap),
    ],
    { provider, addressType: 'p2sh32' },
  );
  assert.equal(sdkEscrow.bytecode, binToHex(contracts.escrow.redeemScript));
  assert.equal(sdkEscrow.lockingBytecode, binToHex(contracts.escrow.lockingBytecode));

  const sdkBoxOffice = new Contract(
    artifact('BoxOffice'),
    [BigInt(show.price), show.organiserPk, contracts.escrow.lockingBytecode],
    { provider, addressType: 'p2sh32' },
  );
  assert.equal(sdkBoxOffice.bytecode, binToHex(contracts.boxOffice.redeemScript));
  assert.equal(sdkBoxOffice.address, contracts.boxOffice.address('bchtest', false), 'MockNetworkProvider uses chipnet prefixes');

  const buyer = freshKey();
  const context = { transaction: undefined, sourceOutputs: [], inputIndex: 0 };
  assert.equal(
    binToHex(sdkBoxOffice.unlock.buy(buyer.pkh).generateUnlockingBytecode(context)),
    binToHex(contracts.boxOffice.unlock('buy', [buyer.pkh])),
  );
  assert.equal(
    binToHex(sdkEscrow.unlock.checkIn(1n).generateUnlockingBytecode(context)),
    binToHex(contracts.escrow.unlock('checkIn', [1n])),
  );
  assert.equal(
    binToHex(sdkEscrow.unlock.settle().generateUnlockingBytecode(context)),
    binToHex(contracts.escrow.unlock('settle')),
  );
  const sig = new Uint8Array(64).fill(7);
  assert.equal(
    binToHex(sdkEscrow.unlock.refund(sig, Uint8Array.of(0x43)).generateUnlockingBytecode(context)),
    binToHex(contracts.escrow.unlock('refund', [sig, Uint8Array.of(0x43)])),
  );
});

test('the VM helper rejects a buy whose ticket names the wrong seat', () => {
  const ctx = makeShow(assert);
  const buyer = freshKey();
  const built = buildBuy({
    show: ctx.show,
    boxOfficeUtxo: ctx.shardUtxos[0],
    fundingUtxos: [fakeCoin(buyer.pkh, 50_000)],
    buyerPkh: buyer.pkh,
  });
  const outputs = built.transaction.outputs.slice();
  const wrongSeat = encodeSeat({ shard: 0, sold: 2 });
  outputs[1] = {
    ...outputs[1],
    token: { ...outputs[1].token, nft: { capability: 'none', commitment: encodeTicketCommitment(wrongSeat, buyer.pkh) } },
  };
  const tampered = signWallet({ ...built, transaction: { ...built.transaction, outputs } }, buyer.privateKey);
  const result = evaluateTransaction(tampered);
  assert.equal(result.standard.ok, false);
  assert.equal(result.consensus.ok, false);
  assert.notEqual(result.consensus.inputs[0], true, 'the BoxOffice input itself must fail');
});

test('the VM helper rejects settle before start + grace and a refund signed by the wrong key', () => {
  const ctx = makeShow(assert);
  const buyer = freshKey();
  const sale = signWallet(
    buildBuy({ show: ctx.show, boxOfficeUtxo: ctx.shardUtxos[1], fundingUtxos: [fakeCoin(buyer.pkh, 50_000)], buyerPkh: buyer.pkh }),
    buyer.privateKey,
  );
  const escrowCoin = utxoAt(sale.transaction, 2);

  const settle = buildSettle({ show: ctx.show, escrowUtxos: [escrowCoin] });
  const early = { ...settle, transaction: { ...settle.transaction, locktime: settle.transaction.locktime - 1 } };
  const earlyResult = evaluateTransaction(early);
  assert.equal(earlyResult.standard.ok, false);
  assert.equal(earlyResult.consensus.ok, false);

  const message = encodeRefundNoticeMessage({ scope: 'C', category: ctx.show.category });
  const forged = signDataMessage(freshKey().privateKey, message);
  const refund = buildRefund({ show: ctx.show, escrowUtxos: [escrowCoin], notices: [{ scope: 'C', signature: forged }] });
  const forgedResult = evaluateTransaction(refund);
  assert.equal(forgedResult.standard.ok, false);
  assert.equal(forgedResult.consensus.ok, false);
});
