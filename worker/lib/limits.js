// Per-IP rate limits and the door's "one answer per check-in" record.
//
// Both live in memory by default. On Cloudflare that memory belongs to one
// isolate, so the limits are best effort (Cloudflare's own rate-limiting
// rules can back them up); the door record can use a KV namespace instead
// (binding DOOR_CLAIMS), see RUNTIME.md.

/** Requests per window, per client IP. */
export const DEFAULT_LIMITS = Object.freeze({
  notice: { max: 30, windowMs: 60_000 },
  door: { max: 20, windowMs: 60_000 },
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

/**
 * The door's record: one claimant per check-in. `claim(key, token)` stores the
 * first caller's token (a hash; null for none) and answers 'first' for that
 * call, 'same' when a later call brings the same token, else 'taken'.
 * In memory: one process (Node) or one isolate (workerd).
 */
export const createMemoryClaims = ({ maxKeys = 100_000 } = {}) => {
  const held = new Map();
  return {
    kind: 'memory',
    claim: async (key, token = null) => {
      if (held.has(key)) return token !== null && held.get(key) === token ? 'same' : 'taken';
      held.set(key, token);
      if (held.size > maxKeys) held.delete(held.keys().next().value);
      return 'first';
    },
  };
};

const NO_TOKEN = '-';

/** The same record in a Cloudflare KV namespace (eventually consistent across locations). */
export const createKvClaims = (kv, { ttlSeconds = 60 * 60 * 24 * 120 } = {}) => ({
  kind: 'kv',
  claim: async (key, token = null) => {
    const stored = await kv.get(key);
    if (stored !== null) return token !== null && stored === token ? 'same' : 'taken';
    await kv.put(key, token ?? NO_TOKEN, { expirationTtl: ttlSeconds });
    return 'first';
  },
});
