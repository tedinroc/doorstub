// A show's BCMR NFT parse, run as a wallet runs it: the registry's parse
// bytecode over a ticket or marker commitment in the 2026 VM. Used by the
// studio test (test/studio/studio.test.js) and the E2E (test/e2e/judge-path.js).
import assert from 'node:assert/strict';
import { binToHex, binToUtf8, createVirtualMachineBch2026, hexToBin, vmNumberToBigInt } from '@bitauth/libauth';
import { p2pkhLockingBytecode } from '../../src/tx/index.js';

/**
 * Run a show's BCMR NFT parse bytecode over a commitment in the 2026 VM, as a
 * wallet does. Returns the raw altstack (hex), the parse type and the decoded
 * field values.
 */
export const parseNft = (registry, category, commitment, holderPkh = new Uint8Array(20)) => {
  const snapshot = Object.values(registry.identities[category])[0];
  const { parse } = snapshot.token.nfts;
  const nftUtxo = { lockingBytecode: p2pkhLockingBytecode(holderPkh), valueSatoshis: 1_000n, token: { amount: 0n, category: hexToBin(category), nft: { capability: 'none', commitment } } };
  const parser = { lockingBytecode: hexToBin(parse.bytecode), valueSatoshis: 0n };
  const transaction = {
    version: 2,
    inputs: [
      { outpointTransactionHash: crypto.getRandomValues(new Uint8Array(32)), outpointIndex: 0, sequenceNumber: 0, unlockingBytecode: new Uint8Array() },
      { outpointTransactionHash: new Uint8Array(32), outpointIndex: 0, sequenceNumber: 0, unlockingBytecode: Uint8Array.of(0x51) },
    ],
    outputs: [{ lockingBytecode: Uint8Array.of(0x6a), valueSatoshis: 0n }],
    locktime: 0,
  };
  const state = createVirtualMachineBch2026(true).evaluate({ inputIndex: 1, sourceOutputs: [nftUtxo, parser], transaction });
  assert.equal(state.error, undefined);
  assert.deepEqual(state.stack.map(binToHex), ['01'], 'a single truthy item');
  const [tag, ...values] = state.alternateStack;
  const type = parse.types[binToHex(tag)];
  assert.ok(type, `type ${binToHex(tag)} is listed`);
  const decoded = Object.fromEntries(
    type.fields.map((name, i) => {
      const { encoding } = snapshot.token.nfts.fields[name];
      const value = values[i];
      return [name, encoding.type === 'utf8' ? binToUtf8(value) : encoding.type === 'number' ? Number(vmNumberToBigInt(value, { requireMinimalEncoding: true })) : binToHex(value)];
    }),
  );
  return { raw: state.alternateStack.map(binToHex), type, decoded };
};

/** The seat label a wallet shows from the parsed fields, in the site's form. */
export const walletLabel = ({ show, boxOffice, seat }) => `${show}-${boxOffice}-${seat}`;
