// A show's life on the mini chain, built with the real builders and signed
// with fresh test keys (never funded; made-up funding outpoints).
import { binToHex } from '@bitauth/libauth';
import {
  buildBuy,
  buildCheckIn,
  buildHandBack,
  buildRefund,
  buildSettle,
  encodeRefundNoticeMessage,
  showContracts,
} from '../../src/tx/index.js';
import { signDataMessage } from '../../src/tx/sign.js';
import { assertValid, fakeCoin, freshKey, makeShow, saleHeight, signWallet, txidOf, utxoAt } from '../helpers.js';

/**
 * Make a show, put its genesis on `chain` (mined), and return helpers that
 * sell, hand back, check in, settle and refund on that chain.
 */
export const makeScenario = (assert, chain, { shards = 2, overrides = {}, id = 'sample-a', kind = 'sample-settle', title = 'Sample show A' } = {}) => {
  const made = makeShow(assert, { shards, overrides });
  const show = Object.assign(made.show, { id, kind, title, card: 'Sample show.', shards, seatPrefix: kind === 'sample-refund-seat' ? 'B' : 'A' });
  show.contracts = made.contracts;
  const genesisTxid = chain.add(made.signedGenesis.transaction, 0);
  chain.mine(1);
  show.genesisTxid = genesisTxid;
  show.notices = [];
  show.cancelled = false;
  const shardUtxos = [...made.shardUtxos];

  /** Sell one seat on `shard` to `buyer` (a freshKey), or to `pkh` with a custom `sign(built)`. */
  const buy = ({ buyer = freshKey(), shard = 0, funding, sign, buyerPkh = buyer.pkh, height = 0 } = {}) => {
    const fundingUtxos = funding ?? [fakeCoin(buyerPkh, 200_000)];
    const built = buildBuy({ show, boxOfficeUtxo: shardUtxos[shard], fundingUtxos, buyerPkh, currentHeight: saleHeight(show), contracts: made.contracts });
    const signed = sign ? sign(built) : signWallet(built, buyer.privateKey);
    assertValid(assert, signed, 'buy');
    const txid = chain.add(signed.transaction, height);
    shardUtxos[shard] = utxoAt(signed.transaction, 0);
    return {
      show,
      buyer,
      buyerPkh,
      built,
      txid,
      seat: built.seat,
      seatHex: binToHex(built.seat),
      ticketUtxo: utxoAt(signed.transaction, 1),
      escrowUtxo: utxoAt(signed.transaction, 2),
    };
  };

  const handBack = (sale, { height = 0 } = {}) => {
    const built = buildHandBack({ show, escrowUtxo: sale.escrowUtxo, ticketUtxo: sale.ticketUtxo, contracts: made.contracts });
    const signed = signWallet(built, sale.buyer.privateKey);
    assertValid(assert, signed, 'hand-back');
    return { built, txid: chain.add(signed.transaction, height) };
  };

  const checkIn = (sale, { height = 0 } = {}) => {
    const built = buildCheckIn({ show, escrowUtxo: sale.escrowUtxo, ticketUtxo: sale.ticketUtxo, contracts: made.contracts });
    const signed = signWallet(built, sale.buyer.privateKey);
    assertValid(assert, signed, 'check-in');
    return { built, txid: chain.add(signed.transaction, height), keepsakeUtxo: utxoAt(signed.transaction, 1) };
  };

  const settle = (sales, { height = 0 } = {}) => {
    const built = buildSettle({ show, escrowUtxos: sales.map((s) => s.escrowUtxo), contracts: made.contracts });
    assertValid(assert, built, 'settle');
    return { built, txid: chain.add(built.transaction, height) };
  };

  /** An 'R' notice for a seat (or 'C' for the show), signed with the data key. */
  const notice = (scope, seat) => ({
    scope,
    ...(scope === 'R' && { seat }),
    signature: signDataMessage(made.dataKey.privateKey, encodeRefundNoticeMessage({ scope, category: show.category, seat })),
  });

  const refund = (sales, notices = sales.map((s) => notice('R', s.seat)), { height = 0 } = {}) => {
    const built = buildRefund({ show, escrowUtxos: sales.map((s) => s.escrowUtxo), notices, contracts: made.contracts });
    assertValid(assert, built, 'refund');
    return { built, txid: chain.add(built.transaction, height) };
  };

  return { ...made, show, contracts: made.contracts, genesisTxid, shardUtxos, buy, handBack, checkIn, settle, refund, notice, txidOf, showContracts };
};

/** One show, one sale, on `chain`. */
export const buyOne = (assert, chain) => {
  const s = makeScenario(assert, chain, { shards: 1 });
  return { ...s.buy(), scenario: s };
};
