// Probe transaction shapes. Every shape spends at least one made-up outpoint,
// so no shape can ever be valid on chain, even if a wallet broadcast it.
//
// The shapes reuse the real builders in src/tx and the real compiled
// contracts (bundled at build time), so a contract change only needs a
// rebuild of the probe.
import { generatePrivateKey, hash160, secp256k1 } from '@bitauth/libauth';
import {
  buildBuy,
  buildCheckIn,
  buildHandBack,
  encodeBoxOfficeCommitment,
  encodeMarkerCommitment,
  encodeSeat,
  encodeTicketCommitment,
  p2pkhLockingBytecode,
  showContracts,
  validateShow,
  TOKEN_OUTPUT_SATS,
} from '../../src/tx/index.js';

/** Shown by the wallet on its confirm screen. */
export const USER_PROMPT = 'Doorstub probe: sign only, nothing is sent';

/** Every shape the page offers, in the order the user should run them. */
export const SHAPES = [
  {
    id: 'A-free',
    title: 'Buy, made-up coin',
    summary: 'Made-up BoxOffice coin + a made-up 50,000-sat coin at your receive address 0. Outputs: BoxOffice, ticket NFT to you, escrow coin, change to you.',
    expect: 'sign',
  },
  {
    id: 'A-real',
    title: 'Buy, your real coins',
    summary: 'Same buy, but paid from your real coins found by the scan. Input 0 stays made-up, so it can never be valid on chain.',
    expect: 'sign',
    needsCoins: true,
  },
  {
    id: 'B',
    title: 'Hand back',
    summary: 'Made-up escrow coin + a made-up ticket NFT at your receive address 0. Output: the refund to you.',
    expect: 'sign',
  },
  {
    id: 'C',
    title: 'Check in',
    summary: 'Made-up escrow coin + a made-up ticket NFT at your receive address 0. Outputs: organiser payout, keepsake ticket back to you.',
    expect: 'sign',
  },
  {
    id: 'D',
    title: '41-byte control',
    summary: 'Shape B, but the ticket input carries a 41-byte commitment. Selene is expected to refuse; record its exact words.',
    expect: 'refuse-41',
  },
];

export const shapeInfo = (id) => {
  const info = SHAPES.find((s) => s.id === id);
  if (info === undefined) throw new Error(`unknown shape ${id}`);
  return info;
};

export const randomBytes = (length) => crypto.getRandomValues(new Uint8Array(length));

/** A made-up txid: 32 random bytes that no real transaction has. */
export const madeUpTxid = () => randomBytes(32);

const freshPublicKey = () => {
  // The private key is dropped at once: nobody can ever sign for the probe show.
  const publicKey = secp256k1.derivePublicKeyCompressed(generatePrivateKey());
  if (typeof publicKey === 'string') throw new Error(publicKey);
  return publicKey;
};

/** Sample numbers shared by every probe shape. */
export const PROBE_PRICE = 10_000n;
export const PROBE_FREE_COIN_SATS = 50_000n;
export const PROBE_SHARD = 0;
export const PROBE_SOLD_BEFORE = 41;
export const PROBE_START_HEIGHT = 980_000;
/** The made-up chain tip the probe's buys are built at (sales still open). */
export const PROBE_SALE_HEIGHT = PROBE_START_HEIGHT - 1_000;

/**
 * A fresh made-up show: random category, organiser keys whose private halves
 * are thrown away, the real compiled BoxOffice and Escrow.
 */
export const makeProbeShow = () => {
  const organiserPk = freshPublicKey();
  const show = validateShow({
    category: madeUpTxid(),
    price: PROBE_PRICE,
    organiserPk,
    organiserPkh: hash160(organiserPk),
    organiserDataPk: freshPublicKey(),
    startHeight: PROBE_START_HEIGHT,
    graceBlocks: 144,
    handBackFeeBps: 0,
    noShowFeeBps: 0,
    minerFeeCap: 1_500n,
  });
  return { show, contracts: showContracts(show) };
};

const nft = (category, capability, commitment) => ({ amount: 0n, category, nft: { capability, commitment } });

const seatForProbe = () => encodeSeat({ shard: PROBE_SHARD, sold: PROBE_SOLD_BEFORE + 1 });

/** Made-up coins for the hand-back / check-in shapes: the escrow coin and the ticket at the wallet. */
const madeUpTicketPair = ({ show, contracts }, walletPkh) => {
  const seat = seatForProbe();
  const escrowUtxo = {
    txid: madeUpTxid(),
    vout: 2,
    output: {
      lockingBytecode: contracts.escrow.lockingBytecode,
      valueSatoshis: BigInt(show.price) + TOKEN_OUTPUT_SATS,
      token: nft(show.category, 'none', encodeMarkerCommitment(seat, walletPkh)),
    },
  };
  const ticketUtxo = {
    txid: madeUpTxid(),
    vout: 1,
    output: {
      lockingBytecode: p2pkhLockingBytecode(walletPkh),
      valueSatoshis: TOKEN_OUTPUT_SATS,
      token: nft(show.category, 'none', encodeTicketCommitment(seat, walletPkh)),
    },
  };
  return { escrowUtxo, ticketUtxo };
};

const madeUpBoxOffice = ({ show, contracts }) => ({
  txid: madeUpTxid(),
  vout: 0,
  output: {
    lockingBytecode: contracts.boxOffice.lockingBytecode,
    valueSatoshis: TOKEN_OUTPUT_SATS,
    token: nft(
      show.category,
      'minting',
      encodeBoxOfficeCommitment({ open: true, shard: PROBE_SHARD, sold: PROBE_SOLD_BEFORE }),
    ),
  },
});

/**
 * Pick plain coins (largest first) until they cover price + both token
 * outputs + a fee margin. Returns null when the coins are not enough.
 */
export const pickCoins = (coins, need) => {
  const sorted = coins.filter((c) => c.token === undefined).sort((a, b) => (a.value > b.value ? -1 : a.value < b.value ? 1 : 0));
  const picked = [];
  let total = 0n;
  for (const coin of sorted) {
    if (picked.length >= 3) break;
    picked.push(coin);
    total += coin.value;
    if (total >= need) return picked;
  }
  return null;
};

/** What A-real needs from the wallet: price + ticket + escrow marker sats + a fee margin. */
export const A_REAL_NEED = PROBE_PRICE + 2n * TOKEN_OUTPUT_SATS + 2_000n;

const finish = (id, built, { inputPaths, madeUpInputIndexes, notes = [], sourceOutputs = built.sourceOutputs }) => {
  const walletInputIndexes = inputPaths.map(([i]) => i);
  const covenantInputIndexes = built.transaction.inputs.map((_, i) => i).filter((i) => !walletInputIndexes.includes(i));
  if (madeUpInputIndexes.length === 0) throw new Error(`shape ${id} must spend a made-up outpoint`);
  return {
    id,
    expect: shapeInfo(id).expect,
    kind: built.kind,
    transaction: built.transaction,
    sourceOutputs,
    inputPaths,
    walletInputIndexes,
    covenantInputIndexes,
    madeUpInputIndexes,
    notes,
  };
};

/**
 * Build one probe shape.
 * @param {string} id one of SHAPES[].id
 * @param {object} ctx
 * @param {object} ctx.probe from makeProbeShow()
 * @param {Uint8Array} ctx.walletPkh hash160 of the wallet's receive index 0 public key
 * @param {Array} [ctx.coins] real plain coins from the scan, each
 *   { txid: Uint8Array (display order), vout, value: bigint, lockingBytecode, path: 'receive'|'change', index }
 */
export const buildShape = (id, { probe, walletPkh, coins = [] }) => {
  const { show, contracts } = probe;
  const walletLock = p2pkhLockingBytecode(walletPkh);

  if (id === 'A-free') {
    const built = buildBuy({
      show,
      contracts,
      boxOfficeUtxo: madeUpBoxOffice(probe),
      fundingUtxos: [{ txid: madeUpTxid(), vout: 1, output: { lockingBytecode: walletLock, valueSatoshis: PROBE_FREE_COIN_SATS } }],
      buyerPkh: walletPkh,
      currentHeight: PROBE_SALE_HEIGHT,
      changeLockingBytecode: walletLock,
    });
    return finish(id, built, {
      inputPaths: built.walletInputIndexes.map((i) => [i, 'receive', 0]),
      madeUpInputIndexes: [0, 1],
    });
  }

  if (id === 'A-real') {
    const picked = pickCoins(coins, A_REAL_NEED);
    if (picked === null) {
      const err = new Error(`A-real needs plain BCH coins worth at least ${A_REAL_NEED} sats in receive/change 0-20; the scan found ${coins.length} coin(s)`);
      err.code = 'no-coins';
      throw err;
    }
    const built = buildBuy({
      show,
      contracts,
      boxOfficeUtxo: madeUpBoxOffice(probe),
      fundingUtxos: picked.map((c) => ({ txid: c.txid, vout: c.vout, output: { lockingBytecode: c.lockingBytecode, valueSatoshis: c.value } })),
      buyerPkh: walletPkh,
      currentHeight: PROBE_SALE_HEIGHT,
      changeLockingBytecode: walletLock,
    });
    return finish(id, built, {
      inputPaths: built.walletInputIndexes.map((inputIndex, k) => [inputIndex, picked[k].path, picked[k].index]),
      madeUpInputIndexes: [0],
      notes: [`real coins: ${picked.map((c) => `${c.path}/${c.index} ${c.value} sats`).join(', ')}`],
    });
  }

  if (id === 'B' || id === 'D') {
    const { escrowUtxo, ticketUtxo } = madeUpTicketPair(probe, walletPkh);
    const built = buildHandBack({ show, contracts, escrowUtxo, ticketUtxo });
    const inputPaths = built.walletInputIndexes.map((i) => [i, 'receive', 0]);
    if (id === 'B') return finish(id, built, { inputPaths, madeUpInputIndexes: [0, 1] });
    // D: the same transaction, but the ticket input's source output carries a
    // 41-byte commitment (one byte over Selene's limit). encoding.js refuses
    // commitments over 40 bytes on purpose, so this one is built by hand.
    const ticket = ticketUtxo.output.token.nft.commitment;
    const long = new Uint8Array(41);
    long.set(ticket, 0);
    long.fill(0x2d, ticket.length); // '-' padding
    const sourceOutputs = built.sourceOutputs.map((output, i) =>
      i === 1 ? { ...output, token: { ...output.token, nft: { ...output.token.nft, commitment: long } } } : output,
    );
    return finish(id, built, {
      inputPaths,
      madeUpInputIndexes: [0, 1],
      sourceOutputs,
      notes: ['ticket input commitment is 41 bytes; the covenant input cannot pass the VM by design'],
    });
  }

  if (id === 'C') {
    const { escrowUtxo, ticketUtxo } = madeUpTicketPair(probe, walletPkh);
    const built = buildCheckIn({ show, contracts, escrowUtxo, ticketUtxo });
    return finish(id, built, {
      inputPaths: built.walletInputIndexes.map((i) => [i, 'receive', 0]),
      madeUpInputIndexes: [0, 1],
    });
  }

  throw new Error(`unknown shape ${id}`);
};
