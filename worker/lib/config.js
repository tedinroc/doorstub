// Worker configuration from the environment (Cloudflare `env`, or the Node
// adapter's options). Requests can never change any of it.
// Error messages name the variable and the shape it needs, never any part of
// its value: /api/health publishes them.
//
//   STUDIO_DATA_KEY   64 hex: the studio's data key (signs 'R' notices). Secret.
//   DOOR_LINKS        JSON { "<show id>": "https://..." } ({show}, {seat}, {txid}, {pass}, {media}
//                     are filled in; worker/lib/door.js fillLink). Secret.
//   ROOM_KEY          64 hex: makes the screening room's passes and its media folder name
//                     (worker/lib/room.js). Needed by any link with {pass} or {media}. Secret.
//   ROOM_REHEARSAL_LEAD_S  simnet only: a rehearsal starts this many seconds (1 to 600) after
//                     its enter, so local smoke tests need not wait for a 5-minute mark.
//   DOORSTUB_NETWORK  unset or "mainnet" (production); "simnet" only for local tests.
//   DOORSTUB_FULCRUM  simnet only: the simnet's ws:// URL. Ignored on mainnet,
//                     which always uses the fixed server list in src/chain/servers.js.
//   SHOWS_URL         cron Worker only: where to read shows.json (https on mainnet).
import { hexToBytes, isHex } from './bytes.js';
import { isPrivateKey } from './crypto.js';
import { needsRoomKey, roomFragmentOk } from './room.js';

const DOOR_LINKS_SHAPE = 'DOOR_LINKS must be JSON { "<show id>": "https://..." }';

export const workerConfig = (env = {}) => {
  const errors = [];
  const network = env.DOORSTUB_NETWORK === 'simnet' ? 'simnet' : 'mainnet';
  if (env.DOORSTUB_NETWORK !== undefined && env.DOORSTUB_NETWORK !== '' && !['mainnet', 'simnet'].includes(env.DOORSTUB_NETWORK)) {
    errors.push('DOORSTUB_NETWORK must be mainnet or simnet; using mainnet');
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

  let roomKey = null;
  if (env.ROOM_KEY !== undefined && env.ROOM_KEY !== '') {
    const raw = String(env.ROOM_KEY).trim();
    if (isHex(raw, 32)) roomKey = hexToBytes(raw);
    else errors.push('ROOM_KEY must be 64 hex characters (.secrets/room.json)');
  }

  let doorLinks = null;
  if (env.DOOR_LINKS !== undefined && env.DOOR_LINKS !== '') {
    let parsed;
    let problem = null;
    if (typeof env.DOOR_LINKS === 'string') {
      try {
        parsed = JSON.parse(env.DOOR_LINKS);
      } catch {
        problem = 'it is not valid JSON';
      }
    } else parsed = env.DOOR_LINKS;
    if (problem === null && (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))) problem = 'it is not a JSON object';
    if (problem === null && Object.values(parsed).some((link) => typeof link !== 'string' || !/^https:\/\/[^\s]+$/.test(link))) {
      problem = 'every link must be an https URL with no spaces';
    }
    if (problem === null) doorLinks = { ...parsed };
    else errors.push(`${DOOR_LINKS_SHAPE} (${problem})`);
  }
  if (doorLinks !== null && roomKey === null && Object.values(doorLinks).some(needsRoomKey)) {
    errors.push('DOOR_LINKS uses {pass} or {media}, which need ROOM_KEY (64 hex characters); those doors answer 503 until it is set');
  }
  // The door signs the pass for its own show id; a fixed show name in the link could differ, and every pass would fail.
  if (doorLinks !== null && Object.values(doorLinks).some((link) => link.includes('{pass}') && !link.includes('{show}'))) {
    errors.push('DOOR_LINKS: a link with {pass} must name its show as {show}');
  }
  // A room link the page could not read (a missing or misspelt key) would show every guest the room's bad-link line
  // (app/src/room/copy.js badLink). The message is fixed: it never repeats any part of the value.
  if (doorLinks !== null && Object.values(doorLinks).some((link) => link.includes('/room/#') && !roomFragmentOk(link))) {
    errors.push('DOOR_LINKS: a room link must carry show={show}&seat={seat}&txid={txid}&pass={pass}&m={media}');
  }

  let rehearsalLeadS = null;
  if (env.ROOM_REHEARSAL_LEAD_S !== undefined && env.ROOM_REHEARSAL_LEAD_S !== '') {
    const lead = Number(env.ROOM_REHEARSAL_LEAD_S);
    if (network !== 'simnet') errors.push('ROOM_REHEARSAL_LEAD_S is for simnet test runs only; ignored');
    else if (Number.isSafeInteger(lead) && lead >= 1 && lead <= 600) rehearsalLeadS = lead;
    else errors.push('ROOM_REHEARSAL_LEAD_S must be a whole number of seconds from 1 to 600');
  }
  return { network, servers, dataKey, doorLinks, roomKey, rehearsalLeadS, errors };
};
