// Client for the two worker endpoints the page calls (same origin in
// production):
//
//   POST /api/notice { category, seat, txid? }  -> { signature }   sample-refund-seat shows only
//   POST /api/door   { category, txid, claim? } -> { link }        real shows, after a check-in
//
// `txid` on a notice is the buy, so the signer finds the seat's marker at
// once. `claim` on the door is a random secret the page keeps for that
// check-in: the door gives the link to one claimant per check-in, so the same
// page can ask again (after a lost answer or a reload) and nobody else can.
//
// Every call has a timeout and a few retries for the answers that mean "not
// yet" (the worker may read a Fulcrum server that has not seen our buy or
// check-in for a second or two). What comes back is data, never trusted on
// its own: the page verifies a notice signature against the show's data key
// before it builds anything with it, and only opens an https: door link.

export const API_TIMEOUT_MS = 6_000;
/** Pauses between attempts; the length is the number of retries. */
export const RETRY_DELAYS_MS = Object.freeze([1_500, 3_000, 6_000]);
/** HTTP statuses worth another try: not found yet, conflict, too early, rate limited, server trouble. */
export const RETRYABLE_STATUS = Object.freeze(new Set([404, 408, 409, 425, 429, 500, 502, 503, 504]));

export class ApiError extends Error {
  /**
   * @param {string} code timeout | network | http | bad-answer
   * @param {string} message
   * @param {{ status?: number, serverMessage?: string }} [details]
   */
  constructor(code, message, { status, serverMessage } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    if (status !== undefined) this.status = status;
    if (serverMessage !== undefined) this.serverMessage = serverMessage;
  }

  get retryable() {
    return this.code === 'timeout' || this.code === 'network' || (this.code === 'http' && RETRYABLE_STATUS.has(this.status));
  }
}

const HEX = /^(?:[0-9a-f]{2})+$/i;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} [options]
 * @param {string} [options.origin] '' for our own origin
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @param {number[]} [options.retryDelaysMs]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 */
export const createApi = ({
  origin = '',
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = API_TIMEOUT_MS,
  retryDelaysMs = RETRY_DELAYS_MS,
  sleep = defaultSleep,
} = {}) => {
  const once = async (path, body) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${origin}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      if (controller.signal.aborted) throw new ApiError('timeout', `${path} did not answer within ${Math.round(timeoutMs / 1000)} s`);
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
      const serverMessage = typeof json?.error === 'string' ? json.error : typeof json?.message === 'string' ? json.message : undefined;
      throw new ApiError('http', `${path} answered ${response.status}${serverMessage ? `: ${serverMessage}` : ''}`, { status: response.status, serverMessage });
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
