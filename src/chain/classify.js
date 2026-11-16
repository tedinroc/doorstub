// Read a transaction that touches a show's contracts: which path each
// contract input took (from its CashScript unlocking bytecode), and which
// escrow coins (markers) it created.
//
// Unlocking bytecode is `<args reversed> <selector> <redeemScript>` (SPEC 4).
// An input belongs to the show's Escrow (or BoxOffice) only when its redeem
// script is byte-equal to the one recomputed from the posted parameters.
import { binToHex, decodeAuthenticationInstructions, vmNumberToBigInt } from '@bitauth/libauth';
import { TOKEN_OUTPUT_SATS, decodeTaggedCommitment, sameBytes } from '../tx/index.js';

export const ESCROW_PATHS = Object.freeze(['handBack', 'checkIn', 'settle', 'refund']);
export const BOX_OFFICE_PATHS = Object.freeze(['buy', 'closeSales']);
/** Every path, in the order the proof strip lists them. */
export const PATHS = Object.freeze(['buy', 'handBack', 'checkIn', 'settle', 'refund']);

const OP_1NEGATE = 0x4f;
const OP_1 = 0x51;
const OP_16 = 0x60;

const pushValue = (instruction) => {
  if ('malformed' in instruction) return undefined;
  if (instruction.opcode === 0) return new Uint8Array();
  if ('data' in instruction) return instruction.data;
  if (instruction.opcode === OP_1NEGATE) return Uint8Array.of(0x81);
  if (instruction.opcode >= OP_1 && instruction.opcode <= OP_16) return Uint8Array.of(instruction.opcode - OP_1 + 1);
  return undefined;
};

const smallNumber = (bytes) => {
  if (bytes === undefined || bytes.length > 4) return undefined;
  const n = vmNumberToBigInt(bytes, { requireMinimalEncoding: false });
  return typeof n === 'bigint' ? Number(n) : undefined;
};

/**
 * Parse a push-only unlocking bytecode as a CashScript contract call.
 * Returns { redeemScript, selector, args } (args in push order, i.e. the
 * function's arguments reversed) or undefined.
 */
export const readContractUnlock = (unlockingBytecode) => {
  if (!(unlockingBytecode instanceof Uint8Array) || unlockingBytecode.length === 0) return undefined;
  const pushes = decodeAuthenticationInstructions(unlockingBytecode).map(pushValue);
  if (pushes.length < 2 || pushes.some((p) => p === undefined)) return undefined;
  const redeemScript = pushes[pushes.length - 1];
  const selector = smallNumber(pushes[pushes.length - 2]);
  if (selector === undefined) return undefined;
  return { redeemScript, selector, args: pushes.slice(0, -2) };
};

const SCOPES = { 0x43: 'C', 0x52: 'R' };

/**
 * Classify one transaction against a show.
 * @param {object} args
 * @param {object} args.transaction decoded libauth transaction
 * @param {object} args.show show object (Uint8Array category, display order)
 * @param {object} args.contracts showContracts(show)
 * @returns {{
 *   path: string|null,            // the single path, 'mixed', or null when it touches no contract input
 *   paths: string[],              // every path taken, in PATHS order (plus 'closeSales')
 *   spends: Array<{ inputIndex, outpoint: { txid, vout }, path, scope?, ticketInputIndex? }>,
 *   created: Array<{ vout, seat, seatHex, buyerPkh, value, output }>, // escrow coins with a marker of this show
 *   buyerPkh?: Uint8Array,        // from the BoxOffice buy input, if any
 * }}
 */
export const classifyShowTransaction = ({ transaction, show, contracts }) => {
  const spends = [];
  const pathSet = new Set();
  let buyerPkh;
  transaction.inputs.forEach((input, inputIndex) => {
    const unlock = readContractUnlock(input.unlockingBytecode);
    if (unlock === undefined) return;
    const outpoint = { txid: binToHex(input.outpointTransactionHash), vout: input.outpointIndex };
    if (sameBytes(unlock.redeemScript, contracts.escrow.redeemScript)) {
      const path = ESCROW_PATHS[unlock.selector];
      if (path === undefined) return;
      const spend = { inputIndex, outpoint, path };
      if (path === 'refund') spend.scope = SCOPES[unlock.args[0]?.[0]] ?? null;
      if (path === 'handBack' || path === 'checkIn') spend.ticketInputIndex = smallNumber(unlock.args[0]);
      spends.push(spend);
      pathSet.add(path);
    } else if (sameBytes(unlock.redeemScript, contracts.boxOffice.redeemScript)) {
      const path = BOX_OFFICE_PATHS[unlock.selector];
      if (path === undefined) return;
      pathSet.add(path);
      if (path === 'buy' && unlock.args[0]?.length === 20) buyerPkh = unlock.args[0];
    }
  });

  const created = [];
  transaction.outputs.forEach((output, vout) => {
    if (!sameBytes(output.lockingBytecode, contracts.escrow.lockingBytecode)) return;
    const token = output.token;
    if (token === undefined || !sameBytes(token.category, show.category) || token.nft?.capability !== 'none' || token.amount !== 0n) return;
    let tagged;
    try {
      tagged = decodeTaggedCommitment(token.nft.commitment);
    } catch {
      return;
    }
    if (tagged.kind !== 'marker') return;
    // Only BoxOffice.buy can put a show-category token here, with price + 1,000 sats; an extra guard (SPEC 7).
    if (output.valueSatoshis < BigInt(show.price) + TOKEN_OUTPUT_SATS) return;
    created.push({ vout, seat: tagged.seat, seatHex: binToHex(tagged.seat), buyerPkh: tagged.buyerPkh, value: output.valueSatoshis, output });
  });

  const order = [...PATHS, 'closeSales'];
  const paths = order.filter((p) => pathSet.has(p));
  const path = paths.length === 0 ? null : paths.length === 1 ? paths[0] : 'mixed';
  return { path, paths, spends, created, ...(buyerPkh !== undefined && { buyerPkh }) };
};
