// BCMR (Bitcoin Cash Metadata Registry v2) for each show's token category, so
// wallets show "Doorstub ticket: <show>" with an icon and parse the seat.
//
// One registry file per show at <origin>/bcmr/<category>.json; the genesis
// transaction carries OP_RETURN <'BCMR'> <sha256(file bytes)> <uri>, where the
// uri omits "https://" (BCMR assumes HTTPS when there is no scheme). Output 0
// of genesis is the studio's identity output, so genesis stays the authhead.
import { binToHex, encodeDataPush, flattenBinArray, sha256, utf8ToBin } from '@bitauth/libauth';

/** Headline (CLAIMS.md section 1). */
export const HEADLINE = 'Tickets that refund themselves. The organiser is paid for each guest who walks in. Every other ticket refunds.';
/** Claim C1 (CLAIMS.md section 2). */
export const TICKET_DESCRIPTION = 'Your ticket money waits in a contract, not with the organiser.';
export const MARKER_DESCRIPTION = 'Escrow marker for one ticket. It stays in the show\'s contract with the ticket\'s money.';

/**
 * NFT parse bytecode (BCMR ParsableNftCollection). Evaluated as input 1 of the
 * parsing transaction with OP_1 as its unlocking bytecode; input 0 holds the NFT.
 * Leaves [tag, box-office letter, seat number, buyer pkh] on the altstack
 * (tag at the bottom is the type key) and OP_1 alone on the stack:
 *
 *   OP_0 OP_UTXOTOKENCOMMITMENT          commitment of input 0
 *   OP_1 OP_SPLIT OP_SWAP OP_TOALTSTACK  tag ('T' or 'E')
 *   OP_1 OP_SPLIT OP_SWAP OP_BIN2NUM     shard number
 *   <0x41> OP_ADD OP_TOALTSTACK          'A' + shard, as one UTF-8 letter
 *   OP_2 OP_SPLIT OP_SWAP OP_BIN2NUM     seat number within the shard (sold, 2 bytes LE)
 *   OP_TOALTSTACK OP_TOALTSTACK          seat number, then buyer pkh
 */
export const NFT_PARSE_BYTECODE = '00cf517f7c6b517f7c810141936b527f7c816b6b';

const fields = {
  boxOffice: {
    name: 'Box office',
    description: 'The box-office shard that sold this seat (A, B, C, ...).',
    encoding: { type: 'utf8' },
  },
  seat: {
    name: 'Seat',
    description: 'Seat number within its box office; the seat label is the box office and this number, e.g. A-0012.',
    encoding: { type: 'number' },
  },
  buyer: {
    name: 'Buyer key hash',
    description: 'HASH160 of the buyer\'s public key. Refunds go only to this address.',
    encoding: { type: 'hex' },
  },
};

/** Host and path of a registry, without "https://" (BCMR assumes HTTPS when no scheme is given). */
export const registryUri = (origin, category) => {
  const url = `${origin}/bcmr/${category}.json`;
  return url.startsWith('https://') ? url.slice('https://'.length) : url;
};

export const registryPath = (category) => `bcmr/${category}.json`;

/** The registry document for one show (the text written to disk is what gets hashed). */
export const buildRegistry = ({ origin, category, entry, iconPath = '/bcmr/icon.png', revision }) => {
  const symbolSuffix = entry.kind === 'sample-settle' ? `A${entry.params.startHeight}` : entry.kind === 'sample-refund-seat' ? 'B' : entry.id.toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 20);
  const snapshot = {
    name: `Doorstub ticket: ${entry.title}`,
    description: `${HEADLINE} ${entry.card}`,
    token: {
      category,
      symbol: `DOORSTUB-${symbolSuffix}`,
      decimals: 0,
      nfts: {
        description: TICKET_DESCRIPTION,
        fields,
        parse: {
          bytecode: NFT_PARSE_BYTECODE,
          types: {
            54: {
              name: `Doorstub ticket: ${entry.title}`,
              description: TICKET_DESCRIPTION,
              fields: ['boxOffice', 'seat', 'buyer'],
              uris: { icon: `${origin}${iconPath}` },
            },
            45: {
              name: `Doorstub escrow marker: ${entry.title}`,
              description: MARKER_DESCRIPTION,
              fields: ['boxOffice', 'seat', 'buyer'],
            },
          },
        },
      },
    },
    uris: { icon: `${origin}${iconPath}`, web: `${origin}/` },
  };
  return {
    $schema: 'https://cashtokens.org/bcmr-v2.schema.json',
    version: { major: 1, minor: 0, patch: 0 },
    latestRevision: revision,
    registryIdentity: {
      name: 'Doorstub',
      description: HEADLINE,
      uris: { web: `${origin}/` },
    },
    identities: { [category]: { [revision]: snapshot } },
  };
};

/** Serialise exactly as published; the hash covers these bytes. */
export const registryText = (registry) => `${JSON.stringify(registry, null, 2)}\n`;

/** OP_RETURN <'BCMR'> <sha256(registry bytes)> <uri> */
export const bcmrOpReturn = (text, uri) =>
  flattenBinArray([Uint8Array.of(0x6a), encodeDataPush(utf8ToBin('BCMR')), encodeDataPush(sha256.hash(utf8ToBin(text))), encodeDataPush(utf8ToBin(uri))]);

export const registryHash = (text) => binToHex(sha256.hash(utf8ToBin(text)));
