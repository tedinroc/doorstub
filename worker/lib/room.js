// The screening room's worker side: room passes, the media folder, and
// POST /api/room/enter. No chain call, no KV, no question log.
//
// A real show's room link is a DOOR_LINKS template that the door fills
// (worker/lib/door.js fillLink):
//   https://doorstub.pages.dev/room/#show={show}&seat={seat}&txid={txid}&pass={pass}&m={media}
// - pass: the first 32 hex of HMAC-SHA256(ROOM_KEY, "doorstub-room-v1\n" +
//   show id + "\n" + seat label + "\n" + txid). Seat and txid are public on
//   chain; the pass is what only the holder of ROOM_KEY (the door) can make.
// - media: the first 32 hex of HMAC-SHA256(ROOM_KEY, "doorstub-room-media-v1"),
//   the unlisted folder of the film's files (/room/media/<folder>/). The folder
//   is unlisted, not secret: anyone who has one room link can share it.
// ROOM_KEY is 64 hex; the HMAC key is the 32 bytes it encodes.
//
// POST /api/room/enter { show, seat, txid, pass }
//   -> { show, title, seatLabel, eventAt, durationMin, now, opensUntil }
// eventAt and opensUntil are ISO 8601 UTC times; now is the server's clock in
// ms. Questions stay open until opensUntil = eventAt + durationMin + 10 min.
// The page plays the film from static files without this call; a verified
// enter only lets it show the seat and receipt and sharpen its clock.
//
// The 'rehearsal' show is not in shows.json: it starts at the next 5-minute
// mark at least 2 minutes away (or, on simnet only, ROOM_REHEARSAL_LEAD_S
// seconds after the call), lasts 25 minutes, and its passes need ROOM_KEY
// like any other.
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import { eventAtMs, MAX_DURATION_MIN } from '../../src/shows/event.js';
import { bytesToHex, hexToBytes, isHex, WorkerError } from './bytes.js';

/** Questions stay open this long after the event ends. */
export const QUESTIONS_AFTER_MIN = 10;
export const REHEARSAL = Object.freeze({ id: 'rehearsal', title: 'Doorstub rehearsal', durationMin: 25 });
/** The rehearsal starts on a 5-minute mark at least 2 minutes away. */
const REHEARSAL_STEP_MS = 5 * 60_000;
const REHEARSAL_MIN_LEAD_MS = 2 * 60_000;

const SHOW_ID = /^[a-z0-9-]{1,40}$/;
const SEAT_LABEL = /^[A-Z]-(0|[1-9]\d{0,2})-(0|[1-9]\d{0,4})$/;
const PASS = /^[0-9a-f]{32}$/i;
const PASS_DOMAIN = 'doorstub-room-v1';
const MEDIA_DOMAIN = 'doorstub-room-media-v1';

const encoder = new TextEncoder();
const keyBytes = (key) => (typeof key === 'string' ? hexToBytes(key) : key);
const mac = (key, message) => hmac(sha256, keyBytes(key), encoder.encode(message));

/** The pass for one seat's check-in at one show: 32 hex. */
export const roomPass = (key, showId, seatLabel, txid) => bytesToHex(mac(key, `${PASS_DOMAIN}\n${showId}\n${seatLabel}\n${txid}`).subarray(0, 16));

/** The media folder name: 32 hex, derived from ROOM_KEY so it can never mismatch it. */
export const roomMediaFolder = (key) => bytesToHex(mac(key, MEDIA_DOMAIN).subarray(0, 16));

/** Byte arrays compared without stopping at the first difference. */
export const sameInConstantTime = (a, b) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
};

/** Whether `pass` is the pass for this show, seat and check-in. */
export const checkPass = (key, showId, seatLabel, txid, pass) => {
  if (typeof pass !== 'string' || !PASS.test(pass)) return false;
  const expected = mac(key, `${PASS_DOMAIN}\n${showId}\n${seatLabel}\n${txid}`).subarray(0, 16);
  return sameInConstantTime(expected, hexToBytes(pass.toLowerCase()));
};

/** A DOOR_LINKS template that only ROOM_KEY can fill. */
export const needsRoomKey = (template) => typeof template === 'string' && /\{(?:pass|media)\}/.test(template);

/** The fragment a room link's template must carry, key by key: what the page reads (app/src/room/state.js parseFragment). */
export const ROOM_FRAGMENT = Object.freeze({ show: '{show}', seat: '{seat}', txid: '{txid}', pass: '{pass}', m: '{media}' });

/**
 * Whether a template's fragment (after its first '#') is exactly show={show}, seat={seat}, txid={txid},
 * pass={pass} and m={media}, in any order: each key once, no other key. A '%' or '+' in it fails, since
 * fillLink fills only the literal placeholders and these five never need encoding.
 */
export const roomFragmentOk = (template) => {
  if (typeof template !== 'string') return false;
  const at = template.indexOf('#');
  if (at < 0) return false;
  const fragment = template.slice(at + 1);
  if (/[%+]/.test(fragment)) return false;
  const params = new URLSearchParams(fragment);
  const keys = [...params.keys()];
  const want = Object.keys(ROOM_FRAGMENT);
  return keys.length === want.length && want.every((k) => params.getAll(k).length === 1 && params.get(k) === ROOM_FRAGMENT[k]);
};

/** A room link's template: on the site's /room/, with the fragment the room reads (roomFragmentOk). */
export const isRoomTemplate = (template, site) => typeof template === 'string' && typeof site === 'string' && site !== '' && template.startsWith(`${site}/room/`) && roomFragmentOk(template);

/** A seat label as worker/lib/shows.js seatLabelOf prints it: letter, shard (0-255), seat (0-65535). */
export const isSeatLabel = (value) => {
  const m = typeof value === 'string' ? SEAT_LABEL.exec(value) : null;
  return m !== null && Number(m[1]) <= 255 && Number(m[2]) <= 65_535;
};

const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');

/** eventAt + durationMin + QUESTIONS_AFTER_MIN, in ms. */
export const opensUntilMs = (eventAt, durationMin) => eventAt + (durationMin + QUESTIONS_AFTER_MIN) * 60_000;

/** When a rehearsal entered at `now` starts, in ms. `leadS` (simnet tests only) replaces the 5-minute mark. */
export const rehearsalEventAt = (now, leadS = null) =>
  leadS !== null ? Math.ceil((now + leadS * 1_000) / 1_000) * 1_000 : Math.ceil((now + REHEARSAL_MIN_LEAD_MS) / REHEARSAL_STEP_MS) * REHEARSAL_STEP_MS;

/**
 * The real shows of a shows.json, light: { origin, shows: [{ id, kind, title,
 * eventAt, durationMin }] }. No contract is recomputed (that is
 * parseWorkerShows' work, for the door); a show without a valid id or event
 * time is left out.
 */
export const readRoomShows = (text, { network }) => {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new WorkerError('bad-shows', 'shows.json is not JSON', { status: 500 });
  }
  if (json === null || typeof json !== 'object' || json.version !== 1 || !Array.isArray(json.shows)) {
    throw new WorkerError('bad-shows', 'shows.json is not a version 1 catalogue', { status: 500 });
  }
  if (json.network !== network) throw new WorkerError('wrong-network', `shows.json is not for ${network}`, { status: 500 });
  const shows = new Map();
  for (const raw of json.shows) {
    if (raw?.kind !== 'real' || typeof raw.id !== 'string' || !SHOW_ID.test(raw.id) || shows.has(raw.id)) continue;
    const d = raw.durationMin;
    if (eventAtMs(raw.eventAt) === null || !Number.isSafeInteger(d) || d < 1 || d > MAX_DURATION_MIN) continue;
    shows.set(raw.id, { id: raw.id, kind: 'real', title: typeof raw.title === 'string' ? raw.title : '', eventAt: raw.eventAt, durationMin: d });
  }
  return { origin: typeof json.origin === 'string' ? json.origin : null, shows: [...shows.values()] };
};

/** Per isolate: the light reading of shows.json, redone only when the text changed. */
export const createRoomShowsCache = ({ network }) => {
  let last = null;
  return async (fetchText) => {
    const text = await fetchText();
    if (last !== null && last.text === text) return last.parsed;
    const parsed = readRoomShows(text, { network });
    last = { text, parsed };
    return parsed;
  };
};

const refuse = (code, message, extra) => {
  throw new WorkerError(code, message, extra);
};

export const parseEnterRequest = (body) => {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) refuse('bad-request', 'send JSON { show, seat, txid, pass }');
  if (typeof body.show !== 'string' || !SHOW_ID.test(body.show)) refuse('bad-request', 'show must be a show id');
  if (!isSeatLabel(body.seat)) refuse('bad-request', 'seat must be a seat label such as S-0-1');
  if (!isHex(body.txid, 32)) refuse('bad-request', 'txid must be 64 hex characters');
  if (typeof body.pass !== 'string' || !PASS.test(body.pass)) refuse('bad-request', 'pass must be 32 hex characters');
  return { show: body.show, seat: body.seat, txid: body.txid.toLowerCase(), pass: body.pass };
};

/**
 * POST /api/room/enter. Shapes, then the key, then the pass, then the show.
 * @param {object} a
 * @param {object} a.body
 * @param {Uint8Array|null} a.roomKey
 * @param {() => Promise<{ shows }>} a.roomShows the light shows reader (only read for a real show)
 * @param {number} a.now server time in ms
 * @param {number|null} [a.rehearsalLeadS] simnet only
 */
export const enterRoom = async ({ body, roomKey, roomShows, now, rehearsalLeadS = null }) => {
  const request = parseEnterRequest(body);
  if (!(roomKey instanceof Uint8Array)) refuse('room-not-configured', 'the screening room is not set up yet', { status: 503, retryable: true });
  if (!checkPass(roomKey, request.show, request.seat, request.txid, request.pass)) {
    refuse('bad-pass', 'this room link is not valid; open the room from your walked-in ticket', { status: 403 });
  }
  let show;
  let start;
  if (request.show === REHEARSAL.id) {
    start = rehearsalEventAt(now, rehearsalLeadS);
    show = { ...REHEARSAL, eventAt: iso(start) };
  } else {
    show = (await roomShows()).shows.find((s) => s.id === request.show);
    if (show === undefined) refuse('unknown-show', 'no real show in shows.json has this id', { status: 404 });
    start = eventAtMs(show.eventAt);
  }
  return {
    show: show.id,
    title: show.title,
    seatLabel: request.seat,
    eventAt: show.eventAt,
    durationMin: show.durationMin,
    now,
    opensUntil: iso(opensUntilMs(start, show.durationMin)),
  };
};

/**
 * /api/health's room status: { configured, media, links }.
 * - configured: ROOM_KEY is set and valid.
 * - media: `mediaReady()` says the film's master playlist is deployed (never named here).
 * - links: 'room' when every real show has a template on `origin`/room/ whose fragment is exactly
 *   show={show}&seat={seat}&txid={txid}&pass={pass}&m={media}, in any order (isRoomTemplate);
 *   'none' when no real show has one; 'other' otherwise.
 */
export const roomHealth = async ({ roomKey, doorLinks, roomShows, mediaReady, origin }) => {
  const configured = roomKey instanceof Uint8Array;
  let media = false;
  if (configured && typeof mediaReady === 'function') {
    try {
      media = (await mediaReady()) === true;
    } catch {
      media = false;
    }
  }
  let links = 'none';
  try {
    const read = await roomShows();
    const site = read.origin ?? origin;
    const templates = read.shows.map((s) => doorLinks?.[s.id]);
    if (templates.some((t) => typeof t === 'string')) {
      links = templates.every((t) => isRoomTemplate(t, site)) ? 'room' : 'other';
    }
  } catch {
    links = 'none';
  }
  return { configured, media, links };
};
