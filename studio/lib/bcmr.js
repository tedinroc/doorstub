// BCMR (Bitcoin Cash Metadata Registry v2) for each show's token category, so
// wallets show "Doorstub ticket: <show>" with an icon and parse the seat into
// the parts of the site's seat label (show letter, box office, seat).
//
// One registry file per show at <origin>/bcmr/<category>.json; the genesis
// transaction carries OP_RETURN <'BCMR'> <sha256(file bytes)> <uri>, where the
// uri omits "https://" (BCMR assumes HTTPS when there is no scheme). Output 0
// of genesis is the studio's identity output, so genesis stays the authhead.
import { binToHex, encodeDataPush, flattenBinArray, sha256, utf8ToBin } from '@bitauth/libauth';
import { readEventFields } from '../../src/shows/event.js';

/** Headline (CLAIMS.md section 1). */
export const HEADLINE = 'Tickets that refund themselves. The organiser is paid for each guest who walks in. Every other ticket refunds.';
/** Claim C1 (CLAIMS.md section 2). */
export const TICKET_DESCRIPTION = 'Your ticket money waits in a contract, not with the organiser.';
export const MARKER_DESCRIPTION = 'Escrow marker for one ticket. It stays in the show\'s contract with the ticket\'s money.';

/**
 * NFT parse bytecode (BCMR ParsableNftCollection) for a show whose seats are
 * labelled with `seatPrefix`. Evaluated as input 1 of the parsing transaction
 * with OP_1 as its unlocking bytecode; input 0 holds the NFT. Leaves
 * [tag, show letter, box office, seat number, buyer pkh] on the altstack (tag
 * at the bottom is the type key) and OP_1 alone on the stack, so a wallet
 * shows the parts of the site's seat label "<letter>-<box office>-<seat>"
 * (src/shows/format.js showSeatLabel):
 *
 *   OP_0 OP_UTXOTOKENCOMMITMENT                  commitment of input 0
 *   OP_1 OP_SPLIT OP_SWAP OP_TOALTSTACK          tag ('T' or 'E')
 *   <letter> OP_TOALTSTACK                       the show's seat letter (one UTF-8 byte, fixed per show)
 *   OP_1 OP_SPLIT OP_SWAP <0x00> OP_CAT OP_BIN2NUM OP_TOALTSTACK
 *                                                box office (shard byte, unsigned, so 128-255 stay positive)
 *   OP_2 OP_SPLIT OP_SWAP OP_BIN2NUM OP_TOALTSTACK
 *                                                seat number within the box office (2 bytes LE, below 32,768)
 *   OP_TOALTSTACK                                buyer pkh
 */
export const nftParseBytecode = (seatPrefix) => {
  if (typeof seatPrefix !== 'string' || !/^[A-Z]$/.test(seatPrefix)) throw new Error('a seat letter is one capital letter');
  return `00cf517f7c6b01${seatPrefix.charCodeAt(0).toString(16)}6b517f7c01007e816b527f7c816b6b`;
};

/** The seat letter of a plan or shows.json entry: A and B for the samples, the show's own for a real show. */
export const seatLetterOf = (entry) => readEventFields(entry, entry.kind).seatPrefix;

const fields = {
  show: {
    name: 'Show',
    description: 'The show\'s letter, the first part of the seat label (A-0-12).',
    encoding: { type: 'utf8' },
  },
  boxOffice: {
    name: 'Box office',
    description: 'The box-office shard that sold this seat (0, 1, 2, ...), the middle part of the seat label (A-0-12).',
    encoding: { type: 'number' },
  },
  seat: {
    name: 'Seat',
    description: 'Seat number within its box office, the last part of the seat label (A-0-12). The site shows the label as show letter, box office and seat.',
    encoding: { type: 'number' },
  },
  buyer: {
    name: 'Buyer key hash',
    description: 'HASH160 of the buyer\'s public key. Refunds go only to this address.',
    encoding: { type: 'hex' },
  },
};

/** The order a parsed NFT's values come in, after its type tag. */
export const NFT_FIELD_ORDER = Object.freeze(['show', 'boxOffice', 'seat', 'buyer']);

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
          bytecode: nftParseBytecode(seatLetterOf(entry)),
          types: {
            54: {
              name: `Doorstub ticket: ${entry.title}`,
              description: TICKET_DESCRIPTION,
              fields: [...NFT_FIELD_ORDER],
              uris: { icon: `${origin}${iconPath}` },
            },
            45: {
              name: `Doorstub escrow marker: ${entry.title}`,
              description: MARKER_DESCRIPTION,
              fields: [...NFT_FIELD_ORDER],
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
