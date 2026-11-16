// The studio's view of a chain: simnet (one local server) or mainnet (public
// Fulcrum servers). Reads go to one healthy server; broadcast is reachable only
// through the studio's gated commands (lib/gate.js), and on mainnet it sends to
// two servers. Simnet refuses a server that reports the mainnet genesis hash.
import { binToHex, hexToBin } from '@bitauth/libauth';
import { FULCRUM_SERVERS } from '../../probe/src/fulcrum.js';
import { connectRpc } from '../../simnet/rpc.js';
import { lockingBytecodeOfAddress, scripthashOf } from '../../simnet/chain.js';

export const MAINNET_GENESIS_HASH = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';
export const DEFAULT_SIMNET_URL = 'ws://127.0.0.1:50021';

/** Fulcrum token_data -> libauth token. */
export const tokenFromData = (data) => {
  if (data === undefined) return undefined;
  const token = { amount: BigInt(data.amount), category: hexToBin(data.category) };
  if (data.nft !== undefined) token.nft = { capability: data.nft.capability, commitment: hexToBin(data.nft.commitment) };
  return token;
};

const isAlreadyKnown = (message) => /already (known|in block ?chain|have)|txn-already/i.test(message);

const wrap = ({ network, query, broadcasters, simnet }) => {
  const toScripthash = (target) =>
    typeof target === 'string' ? scripthashOf(lockingBytecodeOfAddress(target)) : scripthashOf(target);
  const toLocking = (target) => (typeof target === 'string' ? lockingBytecodeOfAddress(target) : target);
  return {
    network,
    url: query.url,
    async tip() {
      const header = await query.request('blockchain.headers.subscribe', []);
      return header.height;
    },
    /** Coins at an address or locking bytecode, as builder UTXOs ({ txid, vout, output, height }). */
    async unspent(target) {
      const lockingBytecode = toLocking(target);
      const items = await query.request('blockchain.scripthash.listunspent', [toScripthash(target), 'include_tokens']);
      return items.map((item) => ({
        txid: hexToBin(item.tx_hash),
        vout: item.tx_pos,
        height: item.height,
        output: { lockingBytecode, valueSatoshis: BigInt(item.value), token: tokenFromData(item.token_data) },
      }));
    },
    history: (target) => query.request('blockchain.scripthash.get_history', [toScripthash(target)]),
    async transaction(txid) {
      return hexToBin(await query.request('blockchain.transaction.get', [typeof txid === 'string' ? txid : binToHex(txid)]));
    },
    txHeight: (txid) => query.request('blockchain.transaction.get_height', [txid]),
    /**
     * Send a raw transaction (hex). Simnet: the one server. Mainnet: two
     * servers; success if either accepts or already knows it. Callers reach
     * this only after the broadcast gate.
     */
    async broadcastRaw(hex) {
      const errors = [];
      let txid;
      for (const client of broadcasters) {
        try {
          txid = await client.request('blockchain.transaction.broadcast', [hex]);
        } catch (error) {
          if (isAlreadyKnown(error.message)) txid ??= 'known';
          else errors.push(`${client.url}: ${error.message}`);
        }
      }
      if (txid === undefined) throw new Error(`broadcast refused: ${errors.join(' | ')}`);
      return txid;
    },
    async mine(blocks = 1) {
      if (!simnet) throw new Error('mine is simnet-only');
      return query.request('simnet.mine', { blocks });
    },
    close() {
      for (const client of new Set([query, ...broadcasters])) client.close();
    },
  };
};

/**
 * Open the network. Simnet: `server` (default ws://127.0.0.1:50021).
 * Mainnet: the public servers (or `servers`), reads read-only; `forBroadcast`
 * also opens two broadcast connections.
 */
export const openNetwork = async ({ network, server, servers = FULCRUM_SERVERS, forBroadcast = false }) => {
  if (network === 'simnet') {
    const client = await connectRpc(server ?? DEFAULT_SIMNET_URL, { clientName: 'Doorstub studio' });
    const features = await client.request('server.features', []);
    if (features.genesis_hash === MAINNET_GENESIS_HASH) {
      client.close();
      throw new Error(`${client.url} is a mainnet server; --network simnet refuses it`);
    }
    return wrap({ network, query: client, broadcasters: [client], simnet: true });
  }
  if (network !== 'mainnet') throw new Error('network must be mainnet or simnet');
  const healthy = [];
  const errors = [];
  for (const url of servers) {
    if (healthy.length >= (forBroadcast ? 2 : 1)) break;
    try {
      const client = await connectRpc(url, { clientName: 'Doorstub studio', readOnly: !forBroadcast });
      const features = await client.request('server.features', []);
      if (features.genesis_hash !== MAINNET_GENESIS_HASH) {
        client.close();
        errors.push(`${url}: not a mainnet server`);
        continue;
      }
      healthy.push(client);
    } catch (error) {
      errors.push(`${url}: ${error.message}`);
    }
  }
  if (healthy.length === 0) throw new Error(`no mainnet Fulcrum server answered (${errors.join('; ')})`);
  if (forBroadcast && healthy.length < 2) {
    for (const client of healthy) client.close();
    throw new Error(`mainnet broadcast wants two healthy servers; found ${healthy.length} (${errors.join('; ')})`);
  }
  return wrap({ network, query: healthy[0], broadcasters: forBroadcast ? healthy : [], simnet: false });
};
