// Worker configuration from the environment (Cloudflare `env`, or the Node
// adapter's options). Requests can never change any of it.
//
//   STUDIO_DATA_KEY   64 hex: the studio's data key (signs 'R' notices). Secret.
//   DOOR_LINKS        JSON { "<show id>": "https://..." } ({seat}, {txid} are filled in). Secret.
//   DOORSTUB_NETWORK  unset or "mainnet" (production); "simnet" only for local tests.
//   DOORSTUB_FULCRUM  simnet only: the simnet's ws:// URL. Ignored on mainnet,
//                     which always uses the fixed server list in src/chain/servers.js.
//   SHOWS_URL         cron Worker only: where to read shows.json (https on mainnet).
import { hexToBytes, isHex } from './bytes.js';
import { isPrivateKey } from './crypto.js';

export const workerConfig = (env = {}) => {
  const errors = [];
  const network = env.DOORSTUB_NETWORK === 'simnet' ? 'simnet' : 'mainnet';
  if (env.DOORSTUB_NETWORK !== undefined && env.DOORSTUB_NETWORK !== '' && !['mainnet', 'simnet'].includes(env.DOORSTUB_NETWORK)) {
    errors.push(`DOORSTUB_NETWORK "${env.DOORSTUB_NETWORK}" is not mainnet or simnet; using mainnet`);
  }
  const servers =
    network === 'simnet'
      ? String(env.DOORSTUB_FULCRUM ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter((s) => /^wss?:\/\//.test(s))
      : undefined;
  if (network === 'simnet' && servers.length === 0) errors.push('DOORSTUB_FULCRUM must name the simnet ws:// URL');

  let dataKey = null;
  if (env.STUDIO_DATA_KEY !== undefined && env.STUDIO_DATA_KEY !== '') {
    const raw = String(env.STUDIO_DATA_KEY).trim();
    if (isHex(raw, 32) && isPrivateKey(hexToBytes(raw))) dataKey = hexToBytes(raw);
    else errors.push('STUDIO_DATA_KEY must be 64 hex characters (the data.privateKey of .secrets/studio.json)');
  }

  let doorLinks = null;
  if (env.DOOR_LINKS !== undefined && env.DOOR_LINKS !== '') {
    try {
      const parsed = typeof env.DOOR_LINKS === 'string' ? JSON.parse(env.DOOR_LINKS) : env.DOOR_LINKS;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      doorLinks = {};
      for (const [id, link] of Object.entries(parsed)) {
        if (typeof link !== 'string' || !/^https:\/\/[^\s]+$/.test(link)) throw new Error(`${id}: links must be https URLs`);
        doorLinks[id] = link;
      }
    } catch (e) {
      doorLinks = null;
      errors.push(`DOOR_LINKS must be JSON { "<show id>": "https://..." } (${e.message})`);
    }
  }
  return { network, servers, dataKey, doorLinks, errors };
};
