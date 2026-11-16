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

/** First caller wins, per key. In memory: one process (Node) or one isolate (workerd). */
export const createMemoryClaims = ({ maxKeys = 100_000 } = {}) => {
  const seen = new Set();
  return {
    kind: 'memory',
    claim: async (key) => {
      if (seen.has(key)) return false;
      seen.add(key);
      if (seen.size > maxKeys) seen.delete(seen.values().next().value);
      return true;
    },
  };
};

/** The same record in a Cloudflare KV namespace (eventually consistent across locations). */
export const createKvClaims = (kv, { ttlSeconds = 60 * 60 * 24 * 120 } = {}) => ({
  kind: 'kv',
  claim: async (key) => {
    if ((await kv.get(key)) !== null) return false;
    await kv.put(key, new Date().toISOString(), { expirationTtl: ttlSeconds });
    return true;
  },
});
