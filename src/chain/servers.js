// Public mainnet Fulcrum WSS servers. Every one answered server.version and
// headers.subscribe (Fulcrum 2.1.x, protocol 1.5, cashtokens on) on 11/16.
// `operator` groups servers run by the same people, so a broadcast goes to two
// different operators when it can.
export const MAINNET_SERVERS = Object.freeze([
  { url: 'wss://bch.imaginary.cash:50004', operator: 'imaginary.cash' },
  { url: 'wss://electrum.imaginary.cash:50004', operator: 'imaginary.cash' },
  { url: 'wss://fulcrum.greyh.at:50004', operator: 'greyh.at' },
  { url: 'wss://blackie.c3-soft.com:50004', operator: 'c3-soft.com' },
  { url: 'wss://bch.soul-dev.com:50004', operator: 'soul-dev.com' },
  { url: 'wss://fulcrum.pat.mn:50004', operator: 'pat.mn' },
  { url: 'wss://electroncash.dk:50004', operator: 'electroncash.dk' },
  { url: 'wss://bch.loping.net:50004', operator: 'loping.net' },
]);

/** The BCH mainnet genesis block hash, as `server.features` reports it. */
export const MAINNET_GENESIS_HASH = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';

/** Accept plain URLs or { url, operator }; the operator defaults to the host. */
export const normaliseServers = (servers) => {
  if (!Array.isArray(servers) || servers.length === 0) throw new Error('need at least one Fulcrum server');
  return servers.map((s) => {
    const url = typeof s === 'string' ? s : s?.url;
    if (typeof url !== 'string' || !/^wss?:\/\//.test(url)) throw new Error(`bad Fulcrum server ${JSON.stringify(s)}`);
    const host = url.replace(/^wss?:\/\//, '').split(/[:/]/)[0];
    return { url, operator: (typeof s === 'object' && s.operator) || host };
  });
};
