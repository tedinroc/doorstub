// shows.json: the shared contract between the studio (which writes it) and
// src/shows (which reads it). Hex strings; `category` in display order.
//
// {
//   "version": 1, "network": "mainnet" | "simnet", "origin": "https://...", "generatedAt": "<ISO>",
//   "shows": [ { "id", "kind", "title", "subtitle", "card", "startsAtEstimate",
//                "params": { category, price, organiserPk, organiserPkh, organiserDataPk, startHeight,
//                            graceBlocks, handBackFeeBps, noShowFeeBps, minerFeeCap },
//                "shards", "genesisTxid", "derived": { ... }, "notices": [ { scope: "C", signature } ],
//                "door": null | { endpoint } } ]
// }
// "derived" is a convenience for runtimes without libauth (the worker); every
// client that can must recompute and compare it.
import { existsSync, readFileSync } from 'node:fs';
import { binToHex, hexToBin, isHex, lockingBytecodeToCashAddress } from '@bitauth/libauth';
import { showContracts, validateShow, verifyRefundNotice } from '../../src/tx/index.js';
import { scripthashOf } from '../../simnet/chain.js';

export const SHOW_KINDS = ['sample-settle', 'sample-refund-seat', 'real', 'proof'];
export const NETWORKS = ['mainnet', 'simnet'];
export const DEFAULT_ORIGIN = 'https://doorstub.pages.dev';

const HEX_FIELDS = { category: 64, organiserPk: 66, organiserPkh: 40, organiserDataPk: 66 };
const INT_FIELDS = ['price', 'startHeight', 'graceBlocks', 'handBackFeeBps', 'noShowFeeBps', 'minerFeeCap'];

const fail = (message) => {
  throw new Error(`shows.json: ${message}`);
};

/** JSON params (hex, numbers) -> the libauth show object the builders take. */
export const showFromParams = (params) => {
  for (const [key, length] of Object.entries(HEX_FIELDS)) {
    if (key === 'category' && params.category === undefined) continue;
    const value = params[key];
    if (typeof value !== 'string' || value.length !== length || !isHex(value)) fail(`params.${key} must be ${length} hex characters`);
  }
  for (const key of INT_FIELDS) {
    if (!Number.isSafeInteger(params[key]) || params[key] < 0) fail(`params.${key} must be a non-negative integer`);
  }
  return {
    ...(params.category === undefined ? {} : { category: hexToBin(params.category) }),
    price: BigInt(params.price),
    organiserPk: hexToBin(params.organiserPk),
    organiserPkh: hexToBin(params.organiserPkh),
    organiserDataPk: hexToBin(params.organiserDataPk),
    startHeight: params.startHeight,
    graceBlocks: params.graceBlocks,
    handBackFeeBps: params.handBackFeeBps,
    noShowFeeBps: params.noShowFeeBps,
    minerFeeCap: BigInt(params.minerFeeCap),
  };
};

/** The libauth show object -> JSON params. */
export const paramsFromShow = (show) => ({
  ...(show.category === undefined ? {} : { category: binToHex(show.category) }),
  price: Number(show.price),
  organiserPk: binToHex(show.organiserPk),
  organiserPkh: binToHex(show.organiserPkh),
  organiserDataPk: binToHex(show.organiserDataPk),
  startHeight: Number(show.startHeight),
  graceBlocks: Number(show.graceBlocks),
  handBackFeeBps: Number(show.handBackFeeBps),
  noShowFeeBps: Number(show.noShowFeeBps),
  minerFeeCap: Number(show.minerFeeCap),
});

const addresses = (lockingBytecode) => ({
  plain: lockingBytecodeToCashAddress({ bytecode: lockingBytecode, prefix: 'bitcoincash', tokenSupport: false }).address,
  token: lockingBytecodeToCashAddress({ bytecode: lockingBytecode, prefix: 'bitcoincash', tokenSupport: true }).address,
});

/** Addresses, bytecode and Electrum script hashes of both contracts, recomputed from the params. */
export const deriveShow = (show) => {
  const { boxOffice, escrow } = showContracts(show);
  const bo = addresses(boxOffice.lockingBytecode);
  const es = addresses(escrow.lockingBytecode);
  return {
    boxOfficeAddress: bo.plain,
    boxOfficeTokenAddress: bo.token,
    boxOfficeLockingBytecode: binToHex(boxOffice.lockingBytecode),
    boxOfficeRedeemScript: binToHex(boxOffice.redeemScript),
    boxOfficeScripthash: scripthashOf(boxOffice.lockingBytecode),
    escrowAddress: es.plain,
    escrowTokenAddress: es.token,
    escrowLockingBytecode: binToHex(escrow.lockingBytecode),
    escrowRedeemScript: binToHex(escrow.redeemScript),
    escrowScripthash: scripthashOf(escrow.lockingBytecode),
  };
};

/**
 * Check a shows.json document: schema, kinds, unique ids, every show inside
 * the policy (validateShow), and "derived" equal to what the params give.
 * Returns the document; throws on the first problem.
 */
export const validateShowsJson = (doc) => {
  if (doc === null || typeof doc !== 'object') fail('not an object');
  if (doc.version !== 1) fail('version must be 1');
  if (!NETWORKS.includes(doc.network)) fail(`network must be one of ${NETWORKS.join(', ')}`);
  if (typeof doc.origin !== 'string' || !/^https?:\/\//.test(doc.origin)) fail('origin must be an http(s) URL');
  if (typeof doc.generatedAt !== 'string' || Number.isNaN(Date.parse(doc.generatedAt))) fail('generatedAt must be an ISO time');
  if (!Array.isArray(doc.shows)) fail('shows must be an array');
  const ids = new Set();
  const categories = new Set();
  for (const entry of doc.shows) {
    const where = `show ${entry?.id}`;
    if (typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(entry.id)) fail(`${where}: id must be a lowercase slug`);
    if (ids.has(entry.id)) fail(`${where}: duplicate id`);
    ids.add(entry.id);
    if (!SHOW_KINDS.includes(entry.kind)) fail(`${where}: kind must be one of ${SHOW_KINDS.join(', ')}`);
    for (const key of ['title', 'subtitle', 'card']) if (typeof entry[key] !== 'string') fail(`${where}: ${key} must be a string`);
    if (typeof entry.startsAtEstimate !== 'string' || Number.isNaN(Date.parse(entry.startsAtEstimate))) fail(`${where}: startsAtEstimate must be an ISO time`);
    if (!Number.isInteger(entry.shards) || entry.shards < 1 || entry.shards > 256) fail(`${where}: shards must be 1-256`);
    if (typeof entry.genesisTxid !== 'string' || entry.genesisTxid.length !== 64 || !isHex(entry.genesisTxid)) fail(`${where}: genesisTxid must be 64 hex characters`);
    if (entry.params?.category === undefined) fail(`${where}: params.category is missing`);
    if (categories.has(entry.params.category)) fail(`${where}: category used twice`);
    categories.add(entry.params.category);
    const show = validateShow(showFromParams(entry.params));
    const derived = deriveShow(show);
    for (const [key, value] of Object.entries(derived)) {
      if (entry.derived?.[key] !== value) fail(`${where}: derived.${key} does not match the params`);
    }
    if (!Array.isArray(entry.notices)) fail(`${where}: notices must be an array`);
    for (const notice of entry.notices) {
      if (notice.scope !== 'C' || typeof notice.signature !== 'string' || !isHex(notice.signature)) fail(`${where}: notices hold { scope: "C", signature: hex }`);
      if (!verifyRefundNotice({ show, notice: { scope: 'C', signature: hexToBin(notice.signature) } })) {
        fail(`${where}: a cancel notice does not verify against organiserDataPk`);
      }
    }
    if (entry.door !== null && (typeof entry.door !== 'object' || typeof entry.door.endpoint !== 'string')) fail(`${where}: door must be null or { endpoint }`);
    if (entry.door !== null && entry.kind !== 'real') fail(`${where}: only real shows have a door`);
  }
  return doc;
};

export const readShowsJson = (path) => {
  if (!existsSync(path)) return undefined;
  return validateShowsJson(JSON.parse(readFileSync(path, 'utf8')));
};

export const findShow = (doc, id) => {
  const entry = doc.shows.find((s) => s.id === id);
  if (entry === undefined) throw new Error(`no show "${id}" in shows.json (have: ${doc.shows.map((s) => s.id).join(', ') || 'none'})`);
  return { entry, show: validateShow(showFromParams(entry.params)) };
};
