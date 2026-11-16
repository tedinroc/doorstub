// Today's BCH price in dollars, fetched once, only to print "about $0.21"
// next to a BCH price. Prices are in BCH; when no source answers the page
// simply hides the dollar figure (CLAIMS.md section 3).

export const PRICE_SOURCES = Object.freeze([
  {
    url: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash&vs_currencies=usd',
    read: (json) => json?.['bitcoin-cash']?.usd,
  },
  {
    url: 'https://api.coinbase.com/v2/prices/BCH-USD/spot',
    read: (json) => Number(json?.data?.amount),
  },
]);

/** A plausible BCH/USD rate, or null. */
export const saneRate = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 1 && value < 100_000 ? value : null);

/**
 * Try each source in turn (no credentials, no referrer); resolves a number or null.
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number, sources?: typeof PRICE_SOURCES }} [options]
 */
export const fetchUsdPerBch = async ({ fetchImpl = (...a) => globalThis.fetch(...a), timeoutMs = 5_000, sources = PRICE_SOURCES } = {}) => {
  for (const source of sources) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(source.url, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
      if (!response.ok) continue;
      const rate = saneRate(source.read(await response.json()));
      if (rate !== null) return rate;
    } catch {
      // try the next source
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
};
