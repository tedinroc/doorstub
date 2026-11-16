// Studio keys: the sales key (signs closeSales, owns the studio's coins), the
// data key (signs refund notices for the sample shows; the worker holds a
// copy), the real-show data key (organiserDataPk of every real show; it never
// leaves this file, so a leaked worker secret cannot refund a real show's
// unused tickets) and the identity key (holds each show's BCMR identity
// output). Stored in .secrets/studio.json, which is gitignored; never printed.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  binToHex,
  encodePrivateKeyWif,
  generatePrivateKey,
  hash160,
  hexToBin,
  lockingBytecodeToCashAddress,
} from '@bitauth/libauth';
import { p2pkhLockingBytecode } from '../../src/tx/index.js';
import { publicKeyOf } from '../../src/tx/sign.js';

export const DEFAULT_SECRETS_PATH = '.secrets/studio.json';

export const p2pkhAddress = (pkh, tokenSupport = false) =>
  lockingBytecodeToCashAddress({ bytecode: p2pkhLockingBytecode(pkh), prefix: 'bitcoincash', tokenSupport }).address;

const describeKey = (privateKey) => {
  const publicKey = publicKeyOf(privateKey);
  const pkh = hash160(publicKey);
  return { privateKey, publicKey, pkh, lockingBytecode: p2pkhLockingBytecode(pkh), address: p2pkhAddress(pkh) };
};

const serialiseKey = (key) => ({
  privateKey: binToHex(key.privateKey),
  wif: encodePrivateKeyWif(key.privateKey, 'mainnet'),
  publicKey: binToHex(key.publicKey),
  pkh: binToHex(key.pkh),
  address: key.address,
});

const NOTE =
  'Doorstub studio keys. Back this file up and never commit or share it. The worker needs only data.privateKey (STUDIO_DATA_KEY); realData signs for real shows and never leaves this file.';

/** Create the studio keys; refuses to overwrite an existing file. Returns the public view. */
export const keygen = ({ secretsPath = DEFAULT_SECRETS_PATH, now = new Date() } = {}) => {
  if (existsSync(secretsPath)) {
    throw new Error(`${secretsPath} already exists; refusing to overwrite the studio keys (move it away first if you really mean to)`);
  }
  const body = {
    version: 1,
    createdAt: now.toISOString(),
    note: NOTE,
    sales: serialiseKey(describeKey(generatePrivateKey())),
    data: serialiseKey(describeKey(generatePrivateKey())),
    realData: serialiseKey(describeKey(generatePrivateKey())),
    identity: serialiseKey(describeKey(generatePrivateKey())),
  };
  mkdirSync(dirname(secretsPath), { recursive: true, mode: 0o700 });
  writeFileSync(secretsPath, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  chmodSync(secretsPath, 0o600);
  return publicView(loadSecrets(secretsPath));
};

/**
 * Add the real-show data key to a studio file made before it existed (every
 * other key stays as it is). Refuses when the file already has one.
 */
export const addRealDataKey = ({ secretsPath = DEFAULT_SECRETS_PATH } = {}) => {
  loadSecrets(secretsPath);
  const body = JSON.parse(readFileSync(secretsPath, 'utf8'));
  if (body.realData !== undefined) throw new Error(`${secretsPath} already has a real-show data key`);
  const next = { ...body, note: NOTE, realData: serialiseKey(describeKey(generatePrivateKey())) };
  writeFileSync(secretsPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  chmodSync(secretsPath, 0o600);
  return publicView(loadSecrets(secretsPath));
};

/** Read the studio keys (private keys as bytes). `realData` is undefined in a file made before it existed. */
export const loadSecrets = (secretsPath = DEFAULT_SECRETS_PATH) => {
  if (!existsSync(secretsPath)) throw new Error(`${secretsPath} not found; run \`npm run studio -- keygen\` first`);
  const body = JSON.parse(readFileSync(secretsPath, 'utf8'));
  if (body.version !== 1) throw new Error(`${secretsPath}: unknown version ${body.version}`);
  const load = (name) => {
    const key = describeKey(hexToBin(body[name].privateKey));
    if (binToHex(key.publicKey) !== body[name].publicKey) throw new Error(`${secretsPath}: ${name} key does not match its public key`);
    return key;
  };
  const secrets = { sales: load('sales'), data: load('data'), identity: load('identity') };
  if (body.realData !== undefined) secrets.realData = load('realData');
  if (secrets.realData !== undefined && binToHex(secrets.realData.publicKey) === binToHex(secrets.data.publicKey)) {
    throw new Error(`${secretsPath}: the real-show data key must differ from the data key the worker holds`);
  }
  return secrets;
};

/** Everything that may be printed or written to public files. `realDataPk` is null when the file has no real-show data key. */
export const publicView = (secrets) => ({
  fundingAddress: secrets.sales.address,
  salesPk: binToHex(secrets.sales.publicKey),
  dataPk: binToHex(secrets.data.publicKey),
  realDataPk: secrets.realData === undefined ? null : binToHex(secrets.realData.publicKey),
  identityAddress: secrets.identity.address,
});
