// Pair a simulated wallet (fresh throwaway mnemonic, never funded) with a
// running probe page, to try the page without a phone:
//
//   node probe/scripts/sim-wallet-cli.js "wiz://?p=...&s=..." [--lenient] [--ecdsa] [--minutes 10]
//
// Paste the link from the page's "Copy link" button. The simulated wallet
// signs every sign-only request it receives (refusing 41-byte commitments
// like Selene unless --lenient) and refuses any request without
// broadcast:false. It never broadcasts anything.
import { WalletConnectionManager } from '@wizardconnect/wallet';
import { makeSimWallet } from '../test/sim-wallet.js';

const args = process.argv.slice(2);
const uri = args.find((a) => a.toLowerCase().startsWith('wiz://'));
if (!uri) {
  console.error('usage: node probe/scripts/sim-wallet-cli.js "wiz://?p=...&s=..." [--lenient] [--ecdsa] [--minutes N]');
  process.exit(2);
}
const minutesArg = args.indexOf('--minutes');
const minutes = minutesArg >= 0 ? Number(args[minutesArg + 1]) : 10;

const sim = makeSimWallet({ strict40: !args.includes('--lenient'), algorithm: args.includes('--ecdsa') ? 'ecdsa' : 'schnorr' });
const manager = new WalletConnectionManager(sim.adapter);
const log = (msg) => console.log(`[sim-wallet ${new Date().toISOString().slice(11, 19)}] ${msg}`);

manager.on('connectionStatusChanged', (_id, status) => log(`relay ${status.status}`));
manager.on('remoteDisconnect', (_id, reason) => log(`dapp disconnected (${reason})`));
manager.on('pendingSignRequest', ({ connectionId, request }) => {
  if (request.transaction?.broadcast !== false) {
    log(`refusing sequence ${request.sequence}: no broadcast:false`);
    manager.sendSignError(connectionId, request.sequence, 'sim wallet: request must say broadcast:false');
    return;
  }
  try {
    const hex = sim.sign(request);
    log(`signed sequence ${request.sequence} (${hex.length / 2} bytes), prompt "${request.transaction.userPrompt}"`);
    manager.sendSignResponse(connectionId, request.sequence, hex);
  } catch (e) {
    log(`refused sequence ${request.sequence}: ${e.message}`);
    manager.sendSignError(connectionId, request.sequence, e.message);
  }
});

manager.connect(uri);
log(`pairing; staying up for ${minutes} min (Ctrl+C to stop)`);
setTimeout(() => {
  manager.disconnectAll();
  setTimeout(() => process.exit(0), 1000);
}, minutes * 60_000);
