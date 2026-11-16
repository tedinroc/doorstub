// The cron-only keeper Worker (worker/wrangler.toml: every 5 minutes, no
// public URL). It reads shows.json from the site, settles every show past its
// start plus grace, refunds sample show B seats with fresh 'R' notices and
// refunds cancelled shows, then logs what it did. See worker/lib/keeper.js.
import { createWorkerChain } from './lib/chain.js';
import { workerConfig } from './lib/config.js';
import { runKeeper, summariseKeeperReport } from './lib/keeper.js';
import { parseWorkerShows } from './lib/shows.js';

/** One keeper pass with this Worker's environment. Returns the report. */
export const runCron = async (env, { fetchImpl = (...args) => fetch(...args), WebSocketImpl, log = (line) => console.log(line) } = {}) => {
  const config = workerConfig(env);
  const showsUrl = String(env.SHOWS_URL ?? '');
  if (!/^https:\/\//.test(showsUrl) && !(config.network === 'simnet' && /^http:\/\/127\.0\.0\.1[:/]/.test(showsUrl))) {
    throw new Error('SHOWS_URL must be the https URL of the site\'s shows.json');
  }
  const response = await fetchImpl(showsUrl, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`shows.json answered ${response.status}`);
  const { shows, rejected } = parseWorkerShows(await response.text(), { network: config.network });
  const chain = createWorkerChain({ network: config.network, servers: config.servers, ...(WebSocketImpl && { WebSocketImpl }) });
  try {
    const report = await runKeeper({ shows, chain, dataKey: config.dataKey });
    report.rejectedShows = rejected;
    report.configErrors = config.errors;
    log(summariseKeeperReport(report));
    for (const r of rejected) log(`shows.json: ${r.message}`);
    for (const e of config.errors) log(`config: ${e}`);
    return report;
  } finally {
    chain.close();
  }
};

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runCron(env).catch((e) => {
        console.log(`keeper failed: ${e?.stack ?? e}`);
      }),
    );
  },
};
