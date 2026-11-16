// Check a wallet's signed reply against the transaction we built (buy,
// handBack, checkIn, or any builder result with wallet inputs), and only then
// hand out a broadcastable (checked) transaction.
//
// A reply passes when:
// - it decodes; version and locktime are unchanged;
// - every input keeps its outpoint and sequence number;
// - every contract input (not a wallet input) keeps the exact unlocking bytecode we built;
// - every output is byte-equal to ours, and there are no extra inputs or outputs;
// - every wallet input is `<signature> <public key>`, with sighash 0x41 (ALL)
//   or 0x61 (ALL | UTXOS) only (anything else, e.g. NONE or ANYONECANPAY,
//   could be lifted into another transaction; SPEC 7), and the key hashes to
//   the coin's P2PKH hash;
// - the whole transaction passes the 2026 VM in standard and consensus mode
//   with OUR source outputs (checkTransaction, which brands it).
import { binToHex, decodeAuthenticationInstructions, decodeTransaction, encodeTransactionOutput, hash160, hexToBin } from '@bitauth/libauth';
import { SIGHASH_ALL_UTXOS, sameBytes } from '../tx/index.js';
import { CheckError, checkTransaction } from '../chain/checked.js';

/** Sighash types that cover every input and every output. */
export const ACCEPTED_SIGHASH = Object.freeze([SIGHASH_ALL_UTXOS, 0x41]);

/** The 20-byte hash inside a P2PKH locking bytecode, or undefined. */
export const p2pkhHash = (b) =>
  b.length === 25 && b[0] === 0x76 && b[1] === 0xa9 && b[2] === 0x14 && b[23] === 0x88 && b[24] === 0xac ? b.slice(3, 23) : undefined;

/** Read a P2PKH unlocking bytecode: { signature, publicKey, sighashType, algorithm } or { error }. */
export const readP2pkhUnlock = (unlockingBytecode) => {
  if (unlockingBytecode.length === 0) return { error: 'not signed (empty unlocking bytecode)' };
  const instructions = decodeAuthenticationInstructions(unlockingBytecode);
  if (instructions.length !== 2 || instructions.some((ins) => !('data' in ins) || 'malformed' in ins)) {
    return { error: 'unlocking bytecode is not <signature> <public key>' };
  }
  const [signature, publicKey] = instructions.map((ins) => ins.data);
  if (publicKey.length !== 33 && publicKey.length !== 65) return { error: `public key is ${publicKey.length} bytes` };
  if (signature.length !== 65 && (signature.length < 9 || signature.length > 73)) return { error: `signature is ${signature.length} bytes` };
  const sighashType = signature[signature.length - 1];
  return { signature, publicKey, sighashType, algorithm: signature.length === 65 ? 'schnorr' : 'ecdsa' };
};

const sameOutpoint = (a, b) => sameBytes(a.outpointTransactionHash, b.outpointTransactionHash) && a.outpointIndex === b.outpointIndex;

/**
 * @param {object} built builder result: { kind, transaction, sourceOutputs, walletInputIndexes }
 * @param {string} signedHex the wallet's signed transaction
 * @returns {{ ok: boolean, summary: string, checks: Array<{ name, ok, detail }>, signatures: Array, checked: object|null }}
 *   `checked` (only when ok) is what pool.broadcastChecked takes.
 */
export const checkSignedReply = (built, signedHex) => {
  const checks = [];
  const add = (name, ok, detail = '') => {
    checks.push({ name, ok, detail });
    return ok;
  };
  const finish = (signatures = [], checked = null) => {
    const failed = checks.filter((c) => !c.ok);
    const ok = failed.length === 0 && checked !== null;
    return {
      ok,
      summary: ok ? 'Signed as asked: outputs unchanged, contract inputs untouched, valid in the 2026 VM.' : `${failed.length} check(s) failed: ${failed.map((c) => `${c.name} (${c.detail})`).join('; ')}`,
      checks,
      signatures,
      checked: ok ? checked : null,
    };
  };

  if (typeof signedHex !== 'string' || !/^(?:[0-9a-fA-F]{2})+$/.test(signedHex)) {
    add('reply is hex', false, typeof signedHex === 'string' ? `"${signedHex.slice(0, 40)}"` : typeof signedHex);
    return finish();
  }
  const decoded = decodeTransaction(hexToBin(signedHex));
  if (typeof decoded === 'string') {
    add('reply decodes', false, decoded);
    return finish();
  }
  const sent = built.transaction;
  add('version and locktime unchanged', decoded.version === sent.version && decoded.locktime === sent.locktime,
    `version ${decoded.version} (sent ${sent.version}), locktime ${decoded.locktime} (sent ${sent.locktime})`);
  if (!add('input count unchanged', decoded.inputs.length === sent.inputs.length, `${decoded.inputs.length} (sent ${sent.inputs.length})`)) return finish();
  const moved = sent.inputs.flatMap((input, i) =>
    sameOutpoint(input, decoded.inputs[i]) && input.sequenceNumber === decoded.inputs[i].sequenceNumber ? [] : [i]);
  add('outpoints and sequences unchanged', moved.length === 0, moved.length ? `changed at input ${moved.join(', ')}` : '');
  const wallet = new Set(built.walletInputIndexes);
  sent.inputs.forEach((input, i) => {
    if (wallet.has(i)) return;
    add(`contract input ${i} untouched`, sameBytes(decoded.inputs[i].unlockingBytecode, input.unlockingBytecode),
      `${decoded.inputs[i].unlockingBytecode.length} bytes (sent ${input.unlockingBytecode.length})`);
  });
  if (add('output count unchanged', decoded.outputs.length === sent.outputs.length, `${decoded.outputs.length} (sent ${sent.outputs.length})`)) {
    const differ = sent.outputs.flatMap((o, i) => (sameBytes(encodeTransactionOutput(o), encodeTransactionOutput(decoded.outputs[i])) ? [] : [i]));
    add('outputs byte-equal', differ.length === 0, differ.length ? `output ${differ.join(', ')} differ` : `${sent.outputs.length} outputs`);
  }

  const signatures = built.walletInputIndexes.map((i) => {
    const read = readP2pkhUnlock(decoded.inputs[i].unlockingBytecode);
    if (read.error) {
      add(`wallet input ${i} signed`, false, read.error);
      return { input: i, error: read.error };
    }
    const expected = p2pkhHash(built.sourceOutputs[i].lockingBytecode);
    const keyMatches = expected !== undefined && sameBytes(hash160(read.publicKey), expected);
    add(`wallet input ${i} sighash 0x61 or 0x41`, ACCEPTED_SIGHASH.includes(read.sighashType), `0x${read.sighashType.toString(16)}`);
    add(`wallet input ${i} key matches its address`, keyMatches, keyMatches ? read.algorithm : `key ${binToHex(read.publicKey)}`);
    return { input: i, algorithm: read.algorithm, sighashType: read.sighashType, publicKey: binToHex(read.publicKey), keyMatches };
  });

  if (checks.some((c) => !c.ok)) return finish(signatures);
  try {
    const checked = checkTransaction({ transaction: decoded, sourceOutputs: built.sourceOutputs, kind: built.kind });
    add('VM 2026 standard + consensus', true, 'ok');
    return finish(signatures, checked);
  } catch (e) {
    add('VM 2026 standard + consensus', false, e instanceof CheckError ? e.message : String(e));
    return finish(signatures);
  }
};

/** Same, but throws a CheckError (with `result`) unless the reply passes; returns the checked transaction. */
export const assertSignedReply = (built, signedHex) => {
  const result = checkSignedReply(built, signedHex);
  if (!result.ok) {
    const error = new CheckError('bad-reply', `The wallet's reply did not pass: ${result.summary}`);
    error.result = result;
    throw error;
  }
  return result.checked;
};
