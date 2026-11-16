// The few values the organiser fills in before publishing. Everything else
// (servers, network, worker origin, show list) is fixed in lib/runtime.js.
//
// BLAZE banner (required at the very top of the home page). Leave a value
// empty and the banner shows it as "coming soon" instead of a dead link.
export const BLAZE = Object.freeze({
  /** Link to the short presentation (deck or video). */
  presentationUrl: '',
  /** Link to the public source repository (planned: https://github.com/tedinroc/doorstub, once it exists). */
  sourceUrl: '',
  /** EMBER2026 CashTokens donation address (token-aware cashaddr, bitcoincash:z...). */
  donationAddress: '',
});

/** Block explorer for transaction links (checked to show CashTokens outputs, commitments included). */
export const EXPLORER = Object.freeze({
  name: 'bchexplorer.info',
  tx: (txid) => `https://bchexplorer.info/tx/${txid}`,
  address: (address) => `https://bchexplorer.info/address/${address}`,
});

/** Contract sources, shown in "Check it yourself" (paths inside the source repository). */
export const CONTRACT_FILES = Object.freeze(['contracts/BoxOffice.cash', 'contracts/Escrow.cash']);

/** WizardConnect's source (LGPL 3.0 or later). */
export const WIZARDCONNECT_SOURCE = 'https://gitlab.com/riftenlabs/lib/wizardconnect';
