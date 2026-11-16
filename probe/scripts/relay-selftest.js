// End-to-end self-test over the PUBLIC WizardConnect relays, headless in Node.
//
//   node probe/scripts/relay-selftest.js [--scan]
//
// The dapp side is the probe's own connect.js; the wallet side is
// @wizardconnect/wallet driven by a simulated wallet with a fresh throwaway
// mnemonic (never funded). It pairs, reads receive index 0, sends shapes
// A-free, B, C and D as sign-only requests, and checks every reply with the
// probe's checker. The simulated wallet refuses 41-byte commitments like
// Selene, so D should come back REFUSED.
//
// Nothing is broadcast: requests carry broadcast:false, every shape spends a
// made-up outpoint, and the probe has no broadcast code. With --scan it also
// runs the read-only Fulcrum scan for the throwaway wallet (expects 0 coins).
import { WalletConnectionManager } from '@wizardconnect/wallet';
import { buildShape, makeProbeShow } from '../src/shapes.js';
import { toSignRequest } from '../src/wire.js';
import { checkReply, refusal } from '../src/check.js';
import { requestSignature, scanAddresses, startPairing } from '../src/connect.js';
import { scanCoins } from '../src/fulcrum.js';
import { makeSimWallet } from '../test/sim-wallet.js';

const scan = process.argv.includes('--scan');
const t0 = Date.now();
const log = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

const withTimeout = (promise, ms, what) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms))]);

const main = async () => {
  const sim = makeSimWallet({ strict40: true });
  const walletManager = new WalletConnectionManager(sim.adapter);
  walletManager.on('pendingSignRequest', ({ connectionId, request }) => {
    if (request.transaction?.broadcast !== false) {
      walletManager.sendSignError(connectionId, request.sequence, 'sim wallet: request did not say broadcast:false');
      return;
    }
    let hex;
    try {
      hex = sim.sign(request);
    } catch (e) {
      log(`wallet refuses sequence ${request.sequence}: ${e.message}`);
      walletManager.sendSignError(connectionId, request.sequence, e.message);
      return;
    }
    log(`wallet signs sequence ${request.sequence} (prompt: "${request.transaction.userPrompt}")`);
    walletManager.sendSignResponse(connectionId, request.sequence, hex);
  });

  let resolveReady;
  const ready = new Promise((resolve) => (resolveReady = resolve));
  const pairing = startPairing({
    onStatus: (status, error) => log(`dapp relay: ${status}${error ? ` (${error})` : ''}`),
    onWalletReady: (info) => resolveReady(info),
    onDisconnect: (reason, message) => log(`dapp: disconnect ${reason} ${message ?? ''}`),
  });
  log(`pairing uri ${pairing.uri.slice(0, 24)}... (QR form starts ${pairing.qrUri.slice(0, 8)})`);
  walletManager.connect(pairing.uri);

  const results = [];
  try {
    const info = await withTimeout(ready, 60_000, 'wallet_ready');
    log(`wallet_ready: ${info.name}, ${info.network}, receive 0 ${info.receive0.tokenAddress}`);
    const expectedPkh = sim.pkhAt('receive', 0);
    if (!info.receive0.pkh.every((b, i) => b === expectedPkh[i])) throw new Error('receive 0 derived from the xpub does not match the wallet');
    log('receive 0 matches the simulated wallet');

    if (scan) {
      const addresses = scanAddresses(pairing.manager, info.prefix, 20);
      const found = await scanCoins(addresses, { onProgress: (m) => log(`scan: ${m}`) });
      log(`scan: ${found.server} returned ${found.coins.length} plain coins, ${found.tokenCoins} token coins over ${addresses.length} addresses`);
      results.push({ id: 'scan', verdict: found.coins.length === 0 ? 'PASS' : 'UNEXPECTED', summary: `${found.coins.length} coins` });
    }

    const probe = makeProbeShow();
    const expected = { 'A-free': 'PASS', B: 'PASS', C: 'PASS', D: 'REFUSED' };
    for (const id of Object.keys(expected)) {
      const shape = buildShape(id, { probe, walletPkh: info.receive0.pkh });
      const request = toSignRequest(shape);
      const started = Date.now();
      let result;
      try {
        const hex = await withTimeout(requestSignature(pairing.manager, request), 60_000, `sign ${id}`);
        result = checkReply(shape, hex);
      } catch (e) {
        result = refusal(shape, e.message);
      }
      log(`${id}: ${result.verdict} in ${Date.now() - started} ms; ${result.summary}`);
      results.push({ id, verdict: result.verdict, expected: expected[id], summary: result.summary });
    }
  } finally {
    await pairing.close();
    walletManager.disconnectAll();
  }

  const bad = results.filter((r) => r.expected !== undefined && r.verdict !== r.expected);
  console.log(JSON.stringify({ ok: bad.length === 0, results }, null, 2));
  // Give the relay sockets a moment to close, then exit.
  setTimeout(() => process.exit(bad.length === 0 ? 0 : 1), 500);
};

main().catch((e) => {
  console.error(`self-test failed: ${e.stack ?? e}`);
  process.exit(1);
});
