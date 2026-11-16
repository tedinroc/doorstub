// What the probe keeps and exports. A-real asks the wallet to sign the
// wallet's REAL coins. With SIGHASH_ALL that signature is useless anywhere
// else, but a wallet that signed with ANYONECANPAY and NONE (or SINGLE) would
// hand out a signature that spends those coins in another transaction. So the
// signed transaction of an A-real run is never stored, shown or exported: the
// verdict and the per-check details are all the analysis needs.

/** Shapes whose wallet inputs are real coins. */
export const REAL_COIN_SHAPES = Object.freeze(['A-real']);

/** A run (or a check result) without any signed transaction of real coins. */
export const redactRun = (run) => {
  if (run === null || typeof run !== 'object') return run;
  if (!REAL_COIN_SHAPES.includes(run.shape ?? run.id)) return run;
  if (run.signedHex === null || run.signedHex === undefined) return { ...run, signedHex: null };
  return { ...run, signedHex: null, signedHexRedacted: true };
};

/** Redact a list of saved runs (results kept from before this rule existed included). */
export const redactRuns = (runs) => (Array.isArray(runs) ? runs.map(redactRun) : []);
