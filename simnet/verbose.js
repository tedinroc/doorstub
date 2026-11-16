// BCHN-style verbose transaction JSON (getrawtransaction with verbose=true),
// as Fulcrum passes it through for blockchain.transaction.get(txid, true).
import {
  OpcodesBch,
  binToHex,
  decodeAuthenticationInstructions,
  isArbitraryDataOutput,
  lockingBytecodeToAddressContents,
  lockingBytecodeToCashAddress,
  vmNumberToBigInt,
} from '@bitauth/libauth';
import { tokenDataJson } from './chain.js';

const SMALL_INTEGERS = new Map([[0x00, '0'], [0x4f, '-1']]);
for (let n = 1; n <= 16; n += 1) SMALL_INTEGERS.set(0x50 + n, String(n));

/** BCHN ScriptToAsmStr: pushes up to 4 bytes as numbers, longer pushes as hex, opcodes by name. */
export const asm = (bytecode) => {
  const parts = [];
  for (const instruction of decodeAuthenticationInstructions(bytecode)) {
    if (SMALL_INTEGERS.has(instruction.opcode)) {
      parts.push(SMALL_INTEGERS.get(instruction.opcode));
    } else if ('data' in instruction && instruction.opcode <= 0x4e) {
      if ('malformed' in instruction && instruction.malformed) {
        parts.push('[error]');
        break;
      }
      const number = instruction.data.length <= 4 ? vmNumberToBigInt(instruction.data, { requireMinimalEncoding: false }) : undefined;
      parts.push(typeof number === 'bigint' ? number.toString() : binToHex(instruction.data));
    } else {
      parts.push(OpcodesBch[instruction.opcode] ?? `OP_UNKNOWN${instruction.opcode}`);
    }
  }
  return parts.join(' ');
};

const scriptPubKey = (lockingBytecode) => {
  const hex = binToHex(lockingBytecode);
  if (isArbitraryDataOutput(lockingBytecode)) return { asm: asm(lockingBytecode), hex, type: 'nulldata' };
  const contents = lockingBytecodeToAddressContents(lockingBytecode);
  const types = { P2PKH: 'pubkeyhash', P2SH20: 'scripthash', P2SH32: 'scripthash', P2PK: 'pubkey' };
  const type = types[contents.type];
  if (type === undefined) return { asm: asm(lockingBytecode), hex, type: 'nonstandard' };
  const encoded = lockingBytecodeToCashAddress({ bytecode: lockingBytecode, prefix: 'bitcoincash', tokenSupport: false });
  const out = { asm: asm(lockingBytecode), hex, reqSigs: 1, type };
  if (typeof encoded !== 'string') out.addresses = [encoded.address];
  return out;
};

/** Sats as a BCH number (8 decimals), as bitcoind prints values. */
const toBch = (sats) => Number(sats) / 1e8;

export const verboseTransaction = (chain, txid, entry) => {
  const { tx, raw } = entry;
  const result = {
    hash: txid,
    hex: binToHex(raw),
    locktime: tx.locktime,
    size: raw.length,
    txid,
    version: tx.version,
    vin: tx.inputs.map((input) => ({
      scriptSig: { asm: asm(input.unlockingBytecode), hex: binToHex(input.unlockingBytecode) },
      sequence: input.sequenceNumber,
      txid: binToHex(input.outpointTransactionHash),
      vout: input.outpointIndex,
    })),
    vout: tx.outputs.map((output, n) => {
      const item = { n, scriptPubKey: scriptPubKey(output.lockingBytecode), value: toBch(output.valueSatoshis) };
      if (output.token !== undefined) item.tokenData = tokenDataJson(output.token);
      return item;
    }),
  };
  if (entry.height !== null) {
    const block = chain.block(entry.height);
    result.blockhash = block.hash;
    result.blocktime = block.time;
    result.confirmations = chain.tipHeight - entry.height + 1;
    result.time = block.time;
  }
  return result;
};
