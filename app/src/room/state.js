// The screening room's rules as plain functions: no DOM, no network, so
// test-room/room-page.test.js runs them in Node. The page (controller.js)
// feeds them the clock, the fragment and what the static files and
// /api/room/enter said.
import { etaMinutes } from '../lib/format.js';

/** Questions stay open this long after the event ends (worker/lib/room.js opensUntil = eventAt + durationMin + 10 min). */
export const QUESTIONS_AFTER_MIN = 10;
/** "Watch from the start" stays this long after questions close; after that the room offers no media. */
export const REPLAY_DAYS = 4;
export const REPLAY_MS = REPLAY_DAYS * 24 * 3_600_000;
/** While the film runs, re-sync when the player is this far from the screening (seconds)... */
export const RESYNC_DRIFT_S = 5;
/** ...or, on coming back to the page (visible, pageshow), this far. */
export const RETURN_DRIFT_S = 1;
/** At most one re-sync in this long, and none this soon after a stall ended. */
export const RESYNC_GAP_MS = 30_000;
export const STALL_QUIET_MS = 10_000;
/** A seek lands this much ahead, at most, to cover the time the player takes to buffer there (seconds). */
export const MAX_SEEK_LEAD_S = 3;
/** Enter: retry after these delays (ms), then every RETRY_EVERY_MS. */
export const RETRY_MS = Object.freeze([1_500, 3_000, 6_000, 12_000]);
export const RETRY_EVERY_MS = 30_000;
/** Re-measure the clock this often before the start, and once this long before it. */
export const REMEASURE_EVERY_MS = 10 * 60_000;
export const REMEASURE_BEFORE_MS = 60_000;
/** A request to the site (shows.json, room.json, enter) that has not answered in this long is given up and retried. */
export const FETCH_TIMEOUT_MS = 10_000;
/**
 * The operator's rehearsal (worker/lib/room.js REHEARSAL.id): no ticket, no check-in, so the room shows no
 * receipt and no thanks for walking in, even after a verified enter.
 */
export const REHEARSAL_SHOW = 'rehearsal';

const SHOW = /^[a-z0-9-]{1,40}$/;
const SEAT = /^[A-Z]-\d{1,3}-\d{1,5}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;

/**
 * The room link's fragment: `#show=…&seat=…&txid=…&pass=…&m=…` (the door fills
 * it in; worker/lib/door.js). Returns { show, seat, txid, pass, m } or null
 * when anything is missing or out of shape. The fragment never reaches a
 * server: the page sends show, seat, txid and pass to /api/room/enter, and
 * uses m only as the media folder on this origin.
 */
export const parseFragment = (hash) => {
  const q = new URLSearchParams(String(hash ?? '').replace(/^#/, ''));
  const out = {
    show: q.get('show') ?? '',
    seat: q.get('seat') ?? '',
    txid: (q.get('txid') ?? '').toLowerCase(),
    pass: (q.get('pass') ?? '').toLowerCase(),
    m: (q.get('m') ?? '').toLowerCase(),
  };
  if (!SHOW.test(out.show) || !SEAT.test(out.seat) || !HEX64.test(out.txid) || !HEX32.test(out.pass) || !HEX32.test(out.m)) return null;
  return out;
};

/** A time from the API or shows.json (ISO text or milliseconds) in milliseconds, or null. */
export const toMs = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

/** When questions close: the event's end plus QUESTIONS_AFTER_MIN. */
export const opensUntilOf = (eventAtMs, durationMin) => eventAtMs + (Number(durationMin) + QUESTIONS_AFTER_MIN) * 60_000;

/** The show's start and length from /shows.json (static), or null when the file does not list it as a real show with an event. */
export const showFromList = (list, id) => {
  const show = Array.isArray(list?.shows) ? list.shows.find((s) => s?.id === id) : undefined;
  if (show === undefined || show.kind !== 'real') return null;
  const eventAtMs = toMs(show.eventAt);
  const durationMin = Number(show.durationMin);
  if (eventAtMs === null || !Number.isInteger(durationMin) || durationMin < 1) return null;
  return { title: typeof show.title === 'string' ? show.title : '', eventAtMs, durationMin };
};

/** room.json: { film: { seconds, version } | null, preview: { seconds, version } | null }. Anything else counts as null. */
export const mediaFromRoomJson = (body) => {
  const one = (m) => (m !== null && typeof m === 'object' && Number.isFinite(m.seconds) && m.seconds > 0 && typeof m.version === 'string' && /^[0-9a-z-]{1,40}$/.test(m.version) ? { seconds: m.seconds, version: m.version } : null);
  return { film: one(body?.film ?? null), preview: one(body?.preview ?? null) };
};

/**
 * Where the screening is at `now`:
 * - 'before'  now < eventAt
 * - 'running' the film plays to everyone (eventAt <= now < eventAt + film length; with no film known, until opensUntil)
 * - 'after'   the film has finished; questions are open until opensUntil
 * - 'ended'   questions are closed
 */
export const phaseAt = ({ now, eventAtMs, filmSeconds, opensUntilMs }) => {
  if (now < eventAtMs) return 'before';
  if (now >= opensUntilMs) return 'ended';
  if (filmSeconds === null || filmSeconds === undefined) return 'running';
  return now < eventAtMs + filmSeconds * 1000 ? 'running' : 'after';
};

/** Is "Watch from the start" still offered? Only after the film, and until REPLAY_MS after questions close. */
export const replayOpen = ({ now, phase, opensUntilMs }) => (phase === 'after' || phase === 'ended') && now < opensUntilMs + REPLAY_MS;

/** Where the film is for everyone at `now`, in seconds. */
export const filmPosition = (now, eventAtMs) => Math.max(0, (now - eventAtMs) / 1000);

/** The countdown: "45 s", "12 min", "5 h 50 min", "3 days". */
export const countdownText = (ms) => {
  if (ms <= 0) return '0 s';
  if (ms < 60_000) return `${Math.ceil(ms / 1000)} s`;
  return etaMinutes(Math.ceil(ms / 60_000)).replace(/^in /, '');
};

/**
 * Whether to seek the synced film, and where to:
 * - trigger 'start': once, when the synced film begins (or the page opens during it);
 * - trigger 'return': the page became visible again, or came back from the back-forward cache;
 * - trigger 'tick': the regular check while it plays.
 * `position` is where the screening is (filmPosition), `currentTime` where the player is.
 * Never while stalled, never within STALL_QUIET_MS after a stall ended, at most once per
 * RESYNC_GAP_MS (except 'start'), and only past the drift for the trigger. `lead` (seconds) is
 * how long the last seek took to play again, capped at MAX_SEEK_LEAD_S.
 * Returns the target position in seconds, or null.
 */
export const syncDecision = ({ trigger, position, currentTime, sinceSyncMs = Infinity, sinceStallMs = Infinity, stalled = false, lead = 0, filmSeconds = Infinity }) => {
  const target = Math.min(position + Math.min(Math.max(0, lead), MAX_SEEK_LEAD_S), Math.max(0, filmSeconds - 0.5));
  if (trigger === 'start') return target;
  if (stalled || sinceStallMs < STALL_QUIET_MS || sinceSyncMs < RESYNC_GAP_MS) return null;
  const drift = Math.abs(position - currentTime);
  return drift > (trigger === 'return' ? RETURN_DRIFT_S : RESYNC_DRIFT_S) ? target : null;
};

/** Under RESYNC_DRIFT_S, drift is closed by playing up to this much faster or slower: no seek, so no stall. */
export const NUDGE_RATE = 0.05;
/**
 * The playback rate for a synced film `drift` seconds behind the screening (negative: ahead):
 * 1 within 0.25 s, 1 ± NUDGE_RATE from 0.5 s, unchanged in between, and 1 at RESYNC_DRIFT_S or more (a seek's job).
 */
export const nudgeRate = (drift, current = 1) => {
  const a = Math.abs(drift);
  if (a >= RESYNC_DRIFT_S || a < 0.25) return 1;
  if (a < 0.5) return current;
  return drift > 0 ? 1 + NUDGE_RATE : 1 - NUDGE_RATE;
};

/** What an /api/room/enter answer means: 'ok', 'bad-pass' (only 400 and 403) or 'retry' (5xx, 429, a network error, a body that is not JSON). */
export const enterOutcome = ({ status, json }) => {
  if (status === 400 || status === 403) return 'bad-pass';
  if (status === 200 && json !== null && typeof json === 'object' && toMs(json.eventAt) !== null) return 'ok';
  return 'retry';
};

/** The wait before retry number `attempt` (0-based): 1.5, 3, 6 and 12 s, then every 30 s. */
export const retryDelay = (attempt) => RETRY_MS[attempt] ?? RETRY_EVERY_MS;

/**
 * Which player: 'native' when the browser is Apple WebKit (Safari, and every iOS browser) and says it plays
 * HLS, otherwise 'hls' (hls.js over Media Source; Chrome's own HLS is not used). `mse` says Media Source exists.
 */
export const choosePlayer = ({ vendor = '', userAgent = '', canPlayHls = '', mse = true }) => {
  const appleWebKit = /^Apple/.test(vendor) && /AppleWebKit\//.test(userAgent);
  if (appleWebKit && canPlayHls !== '') return 'native';
  if (mse) return 'hls';
  return canPlayHls !== '' ? 'native' : 'none';
};

/**
 * The page's clock: serverNow = Date.now() + offset. Never performance.now(), which stops while a
 * laptop or phone sleeps. Each measurement brings an error bound; a better one replaces the
 * offset, and so does any that disagrees with it by more than both bounds (the device's clock
 * was changed). The bound grows by DRIFT_PER_MS with age, so a fresh rough measurement
 * eventually wins over an old sharp one.
 */
export const DRIFT_PER_MS = 1e-4;
export const JUMP_SLACK_MS = 250;
export const createClock = ({ now = () => Date.now() } = {}) => {
  let offset = 0;
  let error = Infinity;
  let measuredAt = 0;
  const errorNow = (t) => error + Math.abs(t - measuredAt) * DRIFT_PER_MS;
  const take = (next, bound, at) => {
    const current = errorNow(at);
    if (current === Infinity || bound <= current || Math.abs(next - offset) > bound + current + JUMP_SLACK_MS) {
      offset = next;
      error = bound;
      measuredAt = at;
      return true;
    }
    return false;
  };
  return {
    /** The server's time now, in ms. */
    now: () => now() + offset,
    known: () => error !== Infinity,
    offset: () => offset,
    error: () => errorNow(now()),
    /** From a response's Date header (whole seconds) and the local times the request left and the answer came. */
    fromDate: (dateHeader, sentAt, receivedAt) => {
      const server = Date.parse(dateHeader ?? '');
      if (!Number.isFinite(server) || receivedAt < sentAt) return false;
      const half = (receivedAt - sentAt) / 2;
      return take(server + 500 - (sentAt + half), 500 + half, receivedAt);
    },
    /** From the server's own time in ms (enter's `now`). */
    fromServer: (serverMs, sentAt, receivedAt) => {
      if (!Number.isFinite(serverMs) || receivedAt < sentAt) return false;
      const half = (receivedAt - sentAt) / 2;
      return take(serverMs - (sentAt + half), half + 1, receivedAt);
    },
  };
};

/** Answer text as plain-text pieces: { text } or { text, href } for a link to this site (its own origin or `siteOrigin`). */
export const answerPieces = (answer, { origin = '', siteOrigin = 'https://doorstub.pages.dev' } = {}) => {
  const pieces = [];
  const re = /https?:\/\/[^\s<>"]+/g;
  let last = 0;
  for (const m of String(answer).matchAll(re)) {
    let url = m[0];
    const trail = /[.,;:!?)]+$/.exec(url)?.[0] ?? '';
    url = url.slice(0, url.length - trail.length);
    if (m.index > last) pieces.push({ text: answer.slice(last, m.index) });
    let own = false;
    try {
      const u = new URL(url);
      own = u.protocol === 'https:' && (u.origin === siteOrigin || (origin !== '' && u.origin === origin)) && u.username === '' && u.password === '';
    } catch {
      own = false;
    }
    pieces.push(own ? { text: url, href: url } : { text: url });
    last = m.index + m[0].length - trail.length;
  }
  if (last < answer.length) pieces.push({ text: answer.slice(last) });
  return pieces;
};
