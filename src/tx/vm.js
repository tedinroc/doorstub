// Evaluate transactions in the libauth BCH 2026 VM, in standard and consensus mode.
import { createVirtualMachineBch2026 } from '@bitauth/libauth';

const machines = {
  standard: createVirtualMachineBch2026(true),
  consensus: createVirtualMachineBch2026(false),
};

/**
 * Evaluate one transaction in one mode.
 * Returns { ok, verify, inputs } where `verify` is true or the VM's error for
 * the whole transaction (token rules, values, standardness), and `inputs[i]`
 * is true or the error from evaluating input i alone.
 */
export const evaluateInMode = ({ transaction, sourceOutputs }, mode) => {
  const vm = machines[mode];
  if (vm === undefined) throw new Error(`unknown VM mode ${mode}`);
  const inputs = transaction.inputs.map((_, inputIndex) =>
    vm.stateSuccess(vm.evaluate({ inputIndex, sourceOutputs, transaction })),
  );
  const verify = vm.verify({ sourceOutputs, transaction });
  return { ok: verify === true && inputs.every((r) => r === true), verify, inputs };
};

/** Evaluate in both modes: { ok, standard, consensus }. */
export const evaluateTransaction = (resolved) => {
  const standard = evaluateInMode(resolved, 'standard');
  const consensus = evaluateInMode(resolved, 'consensus');
  return { ok: standard.ok && consensus.ok, standard, consensus };
};

/** One-line summary of the first failure, or 'ok'. */
export const describeResult = (result) => {
  for (const mode of ['standard', 'consensus']) {
    const r = result[mode];
    if (r.verify !== true) return `${mode}: ${r.verify}`;
    const bad = r.inputs.findIndex((x) => x !== true);
    if (bad !== -1) return `${mode}: input ${bad}: ${r.inputs[bad]}`;
  }
  return 'ok';
};
