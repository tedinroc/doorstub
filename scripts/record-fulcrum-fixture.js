// Record live mainnet Fulcrum response shapes into test/fixtures/fulcrum-mainnet.json.
//
//   node scripts/record-fulcrum-fixture.js [wss://server:port]
//
// READ-ONLY: it sends only the methods listed in METHODS below (no broadcast,
// no subscription kept). The addresses are public token holders picked for
// their coin shapes: a P2PKH address with immutable NFTs and an empty-commitment
// minting NFT, and a P2SH32 address whose coins carry a fungible amount AND a
// mutable NFT. test/chain/shapes.test.js pins our conversions against it.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cashAddressToLockingBytecode } from '@bitauth/libauth';
import { openElectrum } from '../src/chain/electrum.js';
import { scripthashOf } from '../src/chain/address.js';

const server = process.argv[2] ?? 'wss://bch.imaginary.cash:50004';
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'fulcrum-mainnet.json');

const NFT_P2PKH = 'bitcoincash:zq00xmdnsdhtj4dr54s565h75et8svqz5gngkus4g6';
const FT_NFT_P2SH32 = 'bitcoincash:rvgcl3xk6nwqlngkk09e7g67x5vxs57jv6v2q4qm4ct5yv4d3ppfgdzhpuxn8';

const lockingOf = (address) => {
  const r = cashAddressToLockingBytecode(address);
  if (typeof r === 'string') throw new Error(r);
  return r.bytecode;
};

const main = async () => {
  const conn = await openElectrum(server);
  const calls = [];
  const call = async (method, params) => {
    try {
      const result = await conn.request(method, params);
      calls.push({ method, params, result });
      return result;
    } catch (e) {
      calls.push({ method, params, error: { code: e.code, message: e.message } });
      return undefined;
    }
  };
  try {
    await call('server.ping', []);
    const tip = await call('blockchain.headers.subscribe', []);
    await call('blockchain.block.header', [tip.height - 10]);
    const nftSh = scripthashOf(lockingOf(NFT_P2PKH));
    const ftSh = scripthashOf(lockingOf(FT_NFT_P2SH32));
    await call('blockchain.address.get_scripthash', [NFT_P2PKH]);
    const nftUtxos = await call('blockchain.scripthash.listunspent', [nftSh, 'include_tokens']);
    await call('blockchain.scripthash.listunspent', [nftSh]);
    const ftUtxos = await call('blockchain.scripthash.listunspent', [ftSh, 'include_tokens']);
    const history = await call('blockchain.scripthash.get_history', [nftSh]);
    calls[calls.length - 1].result = history.slice(-5);
    // Raw transactions behind a minting NFT with an empty commitment, an
    // immutable NFT, and an FT+NFT coin, so the test can decode them with
    // libauth and compare with token_data.
    const pick = [
      nftUtxos.find((u) => u.token_data?.nft?.capability === 'minting'),
      nftUtxos.find((u) => u.token_data?.nft?.capability === 'none'),
      ftUtxos.find((u) => u.token_data?.nft !== undefined && u.token_data.amount !== '0'),
      nftUtxos.find((u) => u.token_data === undefined),
    ].filter(Boolean);
    for (const u of pick) await call('blockchain.transaction.get', [u.tx_hash]);
    await call('blockchain.transaction.get_height', [pick[0].tx_hash]);
    await call('blockchain.transaction.get', ['00'.repeat(31) + 'aa']);
    await call('blockchain.nosuch', []);
    // Trim the big lists to the coins the test uses.
    for (const c of calls) {
      if (c.method === 'blockchain.scripthash.listunspent' && Array.isArray(c.result)) {
        c.result = c.result.filter((u) => pick.some((p) => p.tx_hash === u.tx_hash && p.tx_pos === u.tx_pos)).slice(0, 6);
      }
    }
    writeFileSync(
      out,
      `${JSON.stringify({ recordedAt: new Date().toISOString(), serverVersion: conn.serverVersion, addresses: { NFT_P2PKH, FT_NFT_P2SH32 }, calls }, null, 2)}\n`,
    );
    console.log(`wrote ${calls.length} calls from ${server} (${conn.serverVersion.join(' ')})`);
  } finally {
    conn.close();
  }
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
