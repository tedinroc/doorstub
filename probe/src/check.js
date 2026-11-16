// Check a wallet's signed reply against the shape the probe sent.
//
// A reply passes when: it decodes; version, locktime, every outpoint and
// sequence are unchanged; every covenant (signature-free) input keeps the
// exact unlocking bytecode we sent; every output is byte-equal to what we
// sent; every wallet input carries a push of one signature (SIGHASH 0x61, or
// 0x41 which also covers every output; anything else, e.g. NONE or
// ANYONECANPAY, fails because such a signature could be lifted into another
// path) and one public key that hashes to the coin's address; and every input passes
// the libauth 2026 VM (standard and consensus) with the stated source outputs.
import {
  binToHex,
  decodeAuthenticationInstructions,
  decodeTransaction,
  encodeTransactionOutput,
  hash160,
  hexToBin,
} from '@bitauth/libauth';
import { SIGHASH_ALL_UTXOS, describeResult, evaluateTransaction, sameBytes } from '../../src/tx/index.js';

const P2PKH_PREFIX = [0x76, 0xa9, 0x14];

/** Sighash types that cover every input and every output: ALL|UTXOS|FORKID and ALL|FORKID. */
export const ACCEPTED_SIGHASH = [SIGHASH_ALL_UTXOS, 0x41];

/** The 20-byte hash inside a P2PKH locking bytecode, or undefined. */
export const p2pkhHash = (lockingBytecode) => {
  const b = lockingBytecode;
  const isP2pkh = b.length === 25 && P2PKH_PREFIX.every((x, i) => b[i] === x) && b[23] === 0x88 && b[24] === 0xac;
  return isP2pkh ? b.slice(3, 23) : undefined;
};

/** Read a P2PKH unlocking bytecode: { signature, publicKey, sighashType, algorithm } or { error }. */
export const readP2pkhUnlock = (unlockingBytecode) => {
  if (unlockingBytecode.length === 0) return { error: 'not signed (empty unlocking bytecode)' };
  const instructions = decodeAuthenticationInstructions(unlockingBytecode);
  if (instructions.length !== 2 || instructions.some((ins) => !('data' in ins) || 'malformed' in ins)) {
    return { error: 'unlocking bytecode is not <signature> <public key>' };
  }
  const [signature, publicKey] = instructions.map((ins) => ins.data);
  if (publicKey.length !== 33 && publicKey.length !== 65) return { error: `public key is ${publicKey.length} bytes` };
  if (signature.length === 0) return { error: 'empty signature' };
  const sighashType = signature[signature.length - 1];
  const algorithm = signature.length === 65 ? 'schnorr' : 'ecdsa';
  return { signature, publicKey, sighashType, algorithm };
};

const hexOf = (bytes) => binToHex(bytes);
const sameOutpoint = (a, b) =>
  sameBytes(a.outpointTransactionHash, b.outpointTransactionHash) && a.outpointIndex === b.outpointIndex;

/**
 * Compare a signed reply with the shape.
 * @returns {{ verdict: 'PASS'|'FAIL'|'SIGNED', summary: string, checks: Array<{name, ok, detail}>, signatures: Array, vm: object|null, signedHex: string }}
 *   'SIGNED' is used only for the 41-byte control (D): the wallet signed instead of refusing.
 */
export const checkReply = (shape, signedHex) => {
  const checks = [];
  let decodedOk = false;
  const add = (name, ok, detail = '') => {
    checks.push({ name, ok, detail });
    return ok;
  };
  const done = (vm = null, signatures = []) => {
    const failed = checks.filter((c) => !c.ok);
    let verdict = failed.length === 0 ? 'PASS' : 'FAIL';
    const signedControl = shape.expect === 'refuse-41' && decodedOk;
    if (signedControl) verdict = 'SIGNED';
    const summary =
      signedControl
        ? `Wallet signed the 41-byte shape instead of refusing. Wallet input check: ${walletSideSummary(checks)}.`
        : failed.length === 0
          ? 'Valid signature, contract input untouched, outputs unchanged, VM ok (standard + consensus).'
          : `${failed.length} check(s) failed: ${failed.map((c) => c.name).join('; ')}`;
    return { verdict, summary, checks, signatures, vm, signedHex };
  };

  if (typeof signedHex !== 'string' || !/^(?:[0-9a-fA-F]{2})+$/.test(signedHex)) {
    add('reply is hex', false, `got ${typeof signedHex === 'string' ? `"${signedHex.slice(0, 40)}"` : typeof signedHex}`);
    return done();
  }
  const decoded = decodeTransaction(hexToBin(signedHex));
  if (typeof decoded === 'string') {
    add('reply decodes', false, decoded);
    return done();
  }
  add('reply decodes', true, `${signedHex.length / 2} bytes`);
  decodedOk = true;

  const sent = shape.transaction;
  add('version and locktime unchanged', decoded.version === sent.version && decoded.locktime === sent.locktime,
    `version ${decoded.version} (sent ${sent.version}), locktime ${decoded.locktime} (sent ${sent.locktime})`);

  const sameInputCount = add('input count unchanged', decoded.inputs.length === sent.inputs.length,
    `${decoded.inputs.length} (sent ${sent.inputs.length})`);
  if (sameInputCount) {
    const moved = sent.inputs
      .map((input, i) => (sameOutpoint(input, decoded.inputs[i]) && input.sequenceNumber === decoded.inputs[i].sequenceNumber ? null : i))
      .filter((i) => i !== null);
    add('outpoints and sequences unchanged', moved.length === 0, moved.length ? `changed at input ${moved.join(', ')}` : '');
    for (const i of shape.covenantInputIndexes) {
      add(`covenant input ${i} untouched`, sameBytes(decoded.inputs[i].unlockingBytecode, sent.inputs[i].unlockingBytecode),
        `${decoded.inputs[i].unlockingBytecode.length} bytes (sent ${sent.inputs[i].unlockingBytecode.length})`);
    }
  }

  const sameOutputCount = add('output count unchanged', decoded.outputs.length === sent.outputs.length,
    `${decoded.outputs.length} (sent ${sent.outputs.length})`);
  if (sameOutputCount) {
    const differ = sent.outputs
      .map((output, i) => (sameBytes(encodeTransactionOutput(output), encodeTransactionOutput(decoded.outputs[i])) ? null : i))
      .filter((i) => i !== null);
    add('outputs byte-equal', differ.length === 0, differ.length ? `output ${differ.join(', ')} differ` : `${sent.outputs.length} outputs`);
  }

  if (!sameInputCount) return done();

  const signatures = shape.walletInputIndexes.map((i) => {
    const read = readP2pkhUnlock(decoded.inputs[i].unlockingBytecode);
    if (read.error) {
      add(`wallet input ${i} signed`, false, read.error);
      return { input: i, error: read.error };
    }
    const expectedHash = p2pkhHash(shape.sourceOutputs[i].lockingBytecode);
    const keyMatches = expectedHash !== undefined && sameBytes(hash160(read.publicKey), expectedHash);
    add(`wallet input ${i} signed`, true, `${read.algorithm}, sighash 0x${read.sighashType.toString(16)}`);
    add(`wallet input ${i} sighash 0x61 or 0x41`, ACCEPTED_SIGHASH.includes(read.sighashType), `0x${read.sighashType.toString(16)}`);
    add(`wallet input ${i} key matches its address`, keyMatches, keyMatches ? '' : `key ${hexOf(read.publicKey)}`);
    return { input: i, algorithm: read.algorithm, sighashType: read.sighashType, publicKey: hexOf(read.publicKey), keyMatches };
  });

  const result = evaluateTransaction({ transaction: decoded, sourceOutputs: shape.sourceOutputs });
  const vm = {
    ok: result.ok,
    describe: describeResult(result),
    standard: { verify: String(result.standard.verify), inputs: result.standard.inputs.map(String) },
    consensus: { verify: String(result.consensus.verify), inputs: result.consensus.inputs.map(String) },
  };
  if (shape.expect === 'refuse-41') {
    // The covenant input fails by design here; judge only the wallet's own inputs.
    for (const i of shape.walletInputIndexes) {
      const ok = result.standard.inputs[i] === true && result.consensus.inputs[i] === true;
      add(`VM: wallet input ${i}`, ok, ok ? 'ok in both modes' : `standard: ${result.standard.inputs[i]}; consensus: ${result.consensus.inputs[i]}`);
    }
  } else {
    add('VM 2026 standard + consensus', result.ok, vm.describe);
  }
  return done(vm, signatures);
};

const walletSideSummary = (checks) => {
  const walletChecks = checks.filter((c) => c.name.startsWith('wallet input') || c.name.startsWith('VM: wallet input'));
  if (walletChecks.length === 0) return 'no wallet input found';
  return walletChecks.every((c) => c.ok) ? 'signature valid' : walletChecks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('; ');
};

/** A wallet's refusal (the sign request was rejected with an error string). */
export const refusal = (shape, errorText) => ({
  verdict: 'REFUSED',
  summary:
    shape.expect === 'refuse-41'
      ? `Refused, as expected for a 41-byte commitment. Wallet said: ${errorText}`
      : `Wallet refused. Wallet said: ${errorText}`,
  walletError: errorText,
  checks: [],
  signatures: [],
  vm: null,
  signedHex: null,
});
