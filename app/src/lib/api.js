// Client for the two worker endpoints the page calls (same origin in
// production):
//
//   POST /api/notice { category, seat, txid? }          -> { signature }        sample-refund-seat shows only
//   POST /api/door   { category, txid, claim, reserve } -> { reserved, again }  real shows, before the check-in is sent
//   POST /api/door   { category, txid, claim? }         -> { link }             real shows, after the check-in
//
// `txid` on a notice is the buy, so the signer finds the seat's marker at
// once. `claim` on the door is a random secret the page keeps for that
// check-in: the door gives the link to one claimant per check-in, so the same
// page can ask again (after a lost answer or a reload) and nobody else can.
// The page reserves its claim with the check-in's txid BEFORE it sends the
// check-in (only the page knows that txid then), so someone who sees the
// check-in on the network cannot claim the link first. A 409 means the door
// already answered another claimant; it is never retried.
//
// Every call has a timeout and a few retries for the answers that mean "not
// yet" (the worker may read a Fulcrum server that has not seen our buy or
// check-in for a second or two). What comes back is data, never trusted on
// its own: the page verifies a notice signature against the show's data key
// before it builds anything with it, and only opens an https: door link.

export const API_TIMEOUT_MS = 6_000;
/** The reservation is one quick try: the check-in waits for it, and the door answers the page by its claim either way. */
export const RESERVE_TIMEOUT_MS = 4_000;
/** Pauses between attempts; the length is the number of retries. */
export const RETRY_DELAYS_MS = Object.freeze([1_500, 3_000, 6_000]);
/** HTTP statuses worth another try: not found yet, too early, rate limited, server trouble. Never 409 (already answered). */
export const RETRYABLE_STATUS = Object.freeze(new Set([404, 408, 425, 429, 500, 502, 503, 504]));

export class ApiError extends Error {
  /**
   * @param {string} code timeout | network | http | bad-answer
   * @param {string} message
   * @param {{ status?: number, serverMessage?: string, serverCode?: string }} [details]
   */
  constructor(code, message, { status, serverMessage, serverCode } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    if (status !== undefined) this.status = status;
    if (serverMessage !== undefined) this.serverMessage = serverMessage;
    if (serverCode !== undefined) this.serverCode = serverCode;
  }

  /** The door already gave this check-in's link to another claimant. */
  get alreadyAnswered() {
    return this.code === 'http' && this.status === 409;
  }

  get retryable() {
    return this.code === 'timeout' || this.code === 'network' || (this.code === 'http' && RETRYABLE_STATUS.has(this.status));
  }
}

const HEX = /^(?:[0-9a-f]{2})+$/i;
const CLAIM = /^[0-9a-f]{64}$/;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} [options]
 * @param {string} [options.origin] '' for our own origin
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @param {number[]} [options.retryDelaysMs]
 * @param {number} [options.reserveTimeoutMs]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 */
export const createApi = ({
  origin = '',
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = API_TIMEOUT_MS,
  retryDelaysMs = RETRY_DELAYS_MS,
  reserveTimeoutMs = RESERVE_TIMEOUT_MS,
  sleep = defaultSleep,
} = {}) => {
  const once = async (path, body, { timeout = timeoutMs } = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let response;
    try {
      response = await fetchImpl(`${origin}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      if (controller.signal.aborted) throw new ApiError('timeout', `${path} did not answer within ${Math.round(timeout / 1000)} s`);
      throw new ApiError('network', `${path} could not be reached: ${e?.message ?? e}`);
    } finally {
      clearTimeout(timer);
    }
    let json = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    if (!response.ok) {
      // The worker answers { error: { code, message, retryable }, message }; older shapes put a string in `error`.
      const error = json?.error;
      const serverMessage =
        typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : typeof json?.message === 'string' ? json.message : undefined;
      const serverCode = typeof error?.code === 'string' ? error.code : undefined;
      throw new ApiError('http', `${path} answered ${response.status}${serverMessage ? `: ${serverMessage}` : ''}`, { status: response.status, serverMessage, serverCode });
    }
    if (json === null || typeof json !== 'object') throw new ApiError('bad-answer', `${path} did not answer with JSON`);
    return json;
  };

  const withRetries = async (path, body, { signal } = {}) => {
    let lastError;
    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
      if (signal?.aborted) throw new ApiError('network', 'cancelled');
      try {
        return await once(path, body);
      } catch (e) {
        lastError = e;
        if (!(e instanceof ApiError) || !e.retryable || attempt === retryDelaysMs.length) throw e;
        await sleep(retryDelaysMs[attempt]);
      }
    }
    throw lastError;
  };

  return {
    /** Ask for an 'R' notice for one seat (`txid`: its buy, optional). Resolves { signature } (hex). */
    notice: async ({ category, seat, txid }, options) => {
      const json = await withRetries('/api/notice', { category, seat, ...(txid !== undefined && { txid }) }, options);
      if (typeof json.signature !== 'string' || !HEX.test(json.signature)) throw new ApiError('bad-answer', '/api/notice answered without a hex signature');
      return { signature: json.signature.toLowerCase() };
    },
    /**
     * Reserve the door's answer for this page before the check-in is sent:
     * one try, at most RESERVE_TIMEOUT_MS, never retried (a 409 means the
     * door already holds another claim). Resolves { reserved, again }.
     */
    doorReserve: async ({ category, txid, claim }, { endpoint = '/api/door' } = {}) => {
      if (typeof claim !== 'string' || !CLAIM.test(claim)) throw new ApiError('bad-request', 'a reservation needs a 64 hex character claim');
      const json = await once(endpoint, { category, txid, claim, reserve: true }, { timeout: reserveTimeoutMs });
      if (json.reserved !== true) throw new ApiError('bad-answer', 'the door did not confirm the reservation');
      return { reserved: true, again: json.again === true };
    },
    /** Ask the door for the event link after a check-in (`claim`: the page's secret for it, optional). Resolves { link } (an https URL). */
    door: async ({ category, txid, claim }, { endpoint = '/api/door', ...options } = {}) => {
      const json = await withRetries(endpoint, { category, txid, ...(claim !== undefined && { claim }) }, options);
      let url;
      try {
        url = new URL(json.link);
      } catch {
        throw new ApiError('bad-answer', 'the door answered without a link');
      }
      if (url.protocol !== 'https:') throw new ApiError('bad-answer', 'the door link is not an https link');
      return { link: url.href };
    },
  };
};
