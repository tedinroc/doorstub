// `studio status`: per show, the genesis confirmation, shards open or closed,
// seats sold, live escrow coins, and how many coins left by each path
// (read from the Escrow address history and classified by function selector).
import { binToHex, decodeAuthenticationInstructions, decodeTransaction, vmNumberToBigInt } from '@bitauth/libauth';
import { decodeBoxOfficeCommitment, sameBytes, showContracts } from '../../src/tx/index.js';
import { openNetwork } from './net.js';
import { readShowsJson, showFromParams } from './shows-json.js';

export const ESCROW_PATHS = ['handBack', 'checkIn', 'settle', 'refund'];
export const BOX_OFFICE_PATHS = ['buy', 'closeSales'];

/**
 * The function an input runs when it spends a contract with this redeem
 * script: its selector is the push just before the redeem script. Returns
 * the selector number, or undefined if the input does not spend that contract.
 */
export const selectorOf = (unlockingBytecode, redeemScript) => {
  const instructions = decodeAuthenticationInstructions(unlockingBytecode);
  const last = instructions[instructions.length - 1];
  if (last === undefined || !('data' in last) || !sameBytes(last.data, redeemScript)) return undefined;
  const selector = instructions[instructions.length - 2];
  if (selector === undefined) return undefined;
  if (selector.opcode === 0x00) return 0;
  if (selector.opcode >= 0x51 && selector.opcode <= 0x60) return selector.opcode - 0x50;
  if ('data' in selector) {
    const n = vmNumberToBigInt(selector.data);
    return typeof n === 'bigint' ? Number(n) : undefined;
  }
  return undefined;
};

/** Count the Doorstub paths in one transaction for one show. */
export const classifyTransaction = (transaction, contracts) => {
  const counts = Object.fromEntries([...BOX_OFFICE_PATHS, ...ESCROW_PATHS].map((p) => [p, 0]));
  for (const input of transaction.inputs) {
    const escrow = selectorOf(input.unlockingBytecode, contracts.escrow.redeemScript);
    if (escrow !== undefined && ESCROW_PATHS[escrow]) counts[ESCROW_PATHS[escrow]] += 1;
    const boxOffice = selectorOf(input.unlockingBytecode, contracts.boxOffice.redeemScript);
    if (boxOffice !== undefined && BOX_OFFICE_PATHS[boxOffice]) counts[BOX_OFFICE_PATHS[boxOffice]] += 1;
  }
  return counts;
};

export const status = async ({ showsPath = 'app/public/shows.json', network, server, servers, print = console.log }) => {
  const doc = readShowsJson(showsPath);
  if (doc === undefined) throw new Error(`${showsPath} not found`);
  if (doc.network !== network) throw new Error(`${showsPath} is for ${doc.network}; you asked for ${network}`);
  const net = await openNetwork({ network, server, servers });
  try {
    const tip = await net.tip();
    const rows = [];
    for (const entry of doc.shows) {
      const show = showFromParams(entry.params);
      const contracts = showContracts(show);
      const ofShow = (coin) => coin.output.token !== undefined && sameBytes(coin.output.token.category, show.category);
      const shardCoins = (await net.unspent(contracts.boxOffice.lockingBytecode)).filter(
        (coin) => ofShow(coin) && coin.output.token.nft?.capability === 'minting',
      );
      const shards = shardCoins.map((coin) => decodeBoxOfficeCommitment(coin.output.token.nft.commitment));
      const escrowCoins = (await net.unspent(contracts.escrow.lockingBytecode)).filter(
        (coin) => ofShow(coin) && coin.output.token.nft?.capability === 'none',
      );
      const counts = Object.fromEntries([...BOX_OFFICE_PATHS, ...ESCROW_PATHS].map((p) => [p, 0]));
      for (const item of await net.history(contracts.escrow.lockingBytecode)) {
        const tx = decodeTransaction(await net.transaction(item.tx_hash));
        if (typeof tx === 'string') continue;
        const found = classifyTransaction(tx, contracts);
        for (const key of Object.keys(counts)) counts[key] += found[key];
      }
      let genesisHeight;
      try {
        genesisHeight = await net.txHeight(entry.genesisTxid);
      } catch {
        genesisHeight = null;
      }
      rows.push({
        id: entry.id,
        kind: entry.kind,
        startHeight: entry.params.startHeight,
        settleFrom: entry.params.startHeight + entry.params.graceBlocks + 1,
        genesis: genesisHeight === null ? 'missing' : genesisHeight === 0 ? 'unconfirmed' : `confirmed at ${genesisHeight}`,
        shardsOpen: shards.filter((s) => s.open).length,
        shardsClosed: shards.filter((s) => !s.open).length,
        sold: shards.reduce((a, s) => a + s.sold, 0),
        escrowCoins: escrowCoins.length,
        escrowSats: Number(escrowCoins.reduce((a, c) => a + c.output.valueSatoshis, 0n)),
        ...counts,
        category: binToHex(show.category),
      });
    }
    print(`${network} tip ${tip}`);
    for (const r of rows) {
      const phase = tip < r.startHeight ? `sales open until ${r.startHeight}` : tip < r.settleFrom ? `started; settles from ${r.settleFrom}` : 'settling';
      print(
        `${r.id} [${r.kind}] ${phase}; genesis ${r.genesis}; shards ${r.shardsOpen} open / ${r.shardsClosed} closed; sold ${r.sold}; ` +
          `escrow coins ${r.escrowCoins} (${r.escrowSats} sats); buys ${r.buy}, hand-backs ${r.handBack}, check-ins ${r.checkIn}, settles ${r.settle}, refunds ${r.refund}`,
      );
    }
    return { network, tip, rows };
  } finally {
    net.close();
  }
};
