// The 2026 VM check for the worker's Node adapter (tests, simnet E2E, the
// keeper CLI). workerd cannot load libauth; Node can, so here every
// transaction the worker builds or trusts is also run through
// createVirtualMachineBch2026 in standard and consensus mode, with the source
// outputs the worker looked up itself. The worker's transaction shapes are
// libauth's, so nothing is converted.
import { describeResult, evaluateTransaction } from '../../src/tx/index.js';

export const libauthVmCheck = ({ transaction, sourceOutputs }) => {
  const result = evaluateTransaction({ transaction, sourceOutputs });
  return result.ok ? { ok: true } : { ok: false, reason: describeResult(result) };
};
