// The few values the organiser fills in before publishing. Everything else
// (servers, network, worker origin, show list) is fixed in lib/runtime.js.
//
// BLAZE banner (required at the very top of the home page). A value left
// empty shows as "coming soon" instead of a dead link, and the production
// build refuses it (scripts/check-app-dist.js) unless
// DOORSTUB_ALLOW_PLACEHOLDERS=1 is set.
export const BLAZE = Object.freeze({
  /** Link to the short presentation (deck or video). To fill in before deploying. */
  presentationUrl: '',
  /** Link to the public source repository. */
  sourceUrl: 'https://github.com/tedinroc/doorstub',
  /** EMBER2026 CashTokens donation address (token-aware cashaddr, bitcoincash:z...). To fill in before deploying. */
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

/** The one-page architecture and the claims file, linked from "Check it yourself". */
export const DOC_FILES = Object.freeze(['ARCHITECTURE.md', 'CLAIMS.md']);

/** A file of the source repository on its default branch (null while there is no repository link). */
export const sourceFileUrl = (file) => (BLAZE.sourceUrl ? `${BLAZE.sourceUrl.replace(/\/$/, '')}/blob/main/${file}` : null);

/** WizardConnect's source (LGPL 3.0 or later). */
export const WIZARDCONNECT_SOURCE = 'https://gitlab.com/riftenlabs/lib/wizardconnect';
