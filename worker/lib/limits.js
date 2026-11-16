// Per-IP rate limits and the door's "one answer per check-in" record.
//
// Both live in memory by default. On Cloudflare that memory belongs to one
// isolate, so the limits are best effort (Cloudflare's own rate-limiting
// rules can back them up); the door record can use a KV namespace instead
// (binding DOOR_CLAIMS), see RUNTIME.md.

/**
 * Requests per window, per client IP. `reserve` counts the door's
 * reservations on top of `door` (they share its 20 a minute): each new one is
 * a KV write that needs no check-in, and a page makes one per walk-in, so 10
 * an hour is plenty and keeps one client from spending a free KV plan's daily
 * writes (RUNTIME.md section 5).
 */
export const DEFAULT_LIMITS = Object.freeze({
  notice: { max: 30, windowMs: 60_000 },
  door: { max: 20, windowMs: 60_000 },
  reserve: { max: 10, windowMs: 3_600_000 },
  health: { max: 60, windowMs: 60_000 },
});

/** Fixed-window counters per (bucket, key); forgets the oldest keys past `maxKeys`. */
export const createRateLimiter = ({ limits = DEFAULT_LIMITS, maxKeys = 10_000, now = () => Date.now() } = {}) => {
  const windows = new Map();
  const take = (bucket, key) => {
    const limit = limits[bucket];
    if (limit === undefined) return { ok: true };
    const id = `${bucket}|${key}`;
    const t = now();
    let w = windows.get(id);
    if (w === undefined || t >= w.resetAt) {
      w = { count: 0, resetAt: t + limit.windowMs };
      windows.delete(id);
      windows.set(id, w);
      while (windows.size > maxKeys) windows.delete(windows.keys().next().value);
    }
    w.count += 1;
    if (w.count > limit.max) return { ok: false, retryAfterMs: w.resetAt - t };
    return { ok: true };
  };
  return { take };
};

/** An answered check-in is remembered this long, so its claimant can come back for the link. */
export const ANSWER_TTL_SECONDS = 60 * 60 * 24 * 120;
/**
 * A reservation is kept as long as an answer. A check-in's txid stays public
 * in the Escrow's history, so a reservation that expired while its door was
 * not answered yet (the door down, or not configured) would let anyone who
 * asks later take the link and lock the holder out (RUNTIME.md section 5).
 */
export const RESERVE_TTL_SECONDS = ANSWER_TTL_SECONDS;

/**
 * The door's record: one claimant per check-in, as { token, state }, where the
 * token is a hash of the claimant's claim secret (or IP; null for none) and
 * the state is 'reserved' (the page reserved the check-in before sending it)
 * or 'answered'; both are kept for 120 days.
 *
 *   reserve(key, token)  no record: store a reservation, 'first'; same token: 'same'; else 'taken'
 *   claim(key, token)    called once the chain checks passed. No record, or a
 *                        reservation with this token: store it answered, 'first';
 *                        answered with this token: 'same'; else 'taken'
 */
const decide = {
  reserve: (record, token) => (record === undefined ? { result: 'first', store: { token, state: 'reserved' } } : { result: token !== null && record.token === token ? 'same' : 'taken' }),
  claim: (record, token) => {
    if (record === undefined) return { result: 'first', store: { token, state: 'answered' } };
    if (token === null || record.token !== token) return { result: 'taken' };
    return record.state === 'reserved' ? { result: 'first', store: { token, state: 'answered' } } : { result: 'same' };
  },
};

const ttlOf = (state) => (state === 'reserved' ? RESERVE_TTL_SECONDS : ANSWER_TTL_SECONDS);

/** The record in memory: one process (Node) or one isolate (workerd). */
export const createMemoryClaims = ({ maxKeys = 100_000, now = () => Date.now() } = {}) => {
  const held = new Map();
  const read = (key) => {
    const record = held.get(key);
    if (record !== undefined && record.expiresAt <= now()) {
      held.delete(key);
      return undefined;
    }
    return record;
  };
  const run = (step) => async (key, token = null) => {
    const { result, store } = step(read(key), token);
    if (store !== undefined) {
      held.delete(key);
      held.set(key, { ...store, expiresAt: now() + ttlOf(store.state) * 1000 });
      if (held.size > maxKeys) held.delete(held.keys().next().value);
    }
    return result;
  };
  return { kind: 'memory', reserve: run(decide.reserve), claim: run(decide.claim) };
};

const NO_TOKEN = '-';
const encodeRecord = ({ token, state }) => `${state === 'reserved' ? 'r' : 'a'}:${token ?? NO_TOKEN}`;
const decodeRecord = (value) => {
  if (value === null || value === undefined) return undefined;
  const m = /^([ra]):(.*)$/.exec(value);
  const raw = m === null ? value : m[2];
  return { token: raw === NO_TOKEN ? null : raw, state: m?.[1] === 'r' ? 'reserved' : 'answered' };
};

/** The same record in a Cloudflare KV namespace (eventually consistent across locations; RUNTIME.md section 5). */
export const createKvClaims = (kv) => {
  const run = (step) => async (key, token = null) => {
    const { result, store } = step(decodeRecord(await kv.get(key)), token);
    if (store !== undefined) await kv.put(key, encodeRecord(store), { expirationTtl: ttlOf(store.state) });
    return result;
  };
  return { kind: 'kv', reserve: run(decide.reserve), claim: run(decide.claim) };
};

/**
 * KV first; when KV fails (down, or over its daily write quota), the
 * isolate's own memory record, so the door still answers (one claimant per
 * isolate only, as without KV). `log` hears about every fallback.
 */
export const withFallback = (primary, fallback, log = () => {}) => {
  const run = (name) => async (key, token) => {
    try {
      return await primary[name](key, token);
    } catch (e) {
      log(`door record: ${primary.kind} ${name} failed (${e?.message ?? e}); using ${fallback.kind}`);
      return fallback[name](key, token);
    }
  };
  return { kind: `${primary.kind}+${fallback.kind}`, reserve: run('reserve'), claim: run('claim') };
};
