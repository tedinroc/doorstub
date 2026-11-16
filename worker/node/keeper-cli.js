#!/usr/bin/env node
// npm run keeper -- [options]
//
// One keeper pass (or one every --interval seconds) with the Node adapter:
// the same worker/lib/keeper.js as the cron Worker, plus the libauth VM check.
//
//   --fulcrum ws://127.0.0.1:50021   simnet Fulcrum URL (simnet only)
//   --network simnet|mainnet         default simnet
//   --shows app/public/shows.json    or --shows-url <url>
//   --studio <path>/studio.json      STUDIO_DATA_KEY from a studio secrets file (for sample show B refunds)
//   --dev-vars .dev.vars             default .dev.vars if present
//   --once                           one pass, then exit (default when --interval is not given)
//   --interval 300                   seconds between passes
//   --dry-run                        build and check, never broadcast
//   --json                           print the full report as JSON
//
// On mainnet this CLI only builds and checks (dry run) unless --mainnet-broadcast
// is given. Only the organiser runs it that way; agents never do.
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createWorkerChain } from '../lib/chain.js';
import { workerConfig } from '../lib/config.js';
import { runKeeper, summariseKeeperReport } from '../lib/keeper.js';
import { parseWorkerShows } from '../lib/shows.js';
import { dataKeyFromStudio, readDevVars } from './env.js';
import { libauthVmCheck } from './vm.js';

const { values } = parseArgs({
  options: {
    fulcrum: { type: 'string' },
    network: { type: 'string', default: 'simnet' },
    shows: { type: 'string' },
    'shows-url': { type: 'string' },
    studio: { type: 'string' },
    'dev-vars': { type: 'string', default: '.dev.vars' },
    once: { type: 'boolean', default: false },
    interval: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    'mainnet-broadcast': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
});

const env = { ...readDevVars(values['dev-vars']) };
if (process.env.STUDIO_DATA_KEY !== undefined) env.STUDIO_DATA_KEY = process.env.STUDIO_DATA_KEY;
env.DOORSTUB_NETWORK = values.network;
if (values.fulcrum !== undefined) env.DOORSTUB_FULCRUM = values.fulcrum;
if (values.studio !== undefined) env.STUDIO_DATA_KEY = dataKeyFromStudio(values.studio);
const config = workerConfig(env);
for (const e of config.errors) console.error(`config: ${e}`);
const dryRun = values['dry-run'] || (config.network === 'mainnet' && !values['mainnet-broadcast']);
if (config.network === 'mainnet' && dryRun) console.error('mainnet: dry run (nothing is broadcast without --mainnet-broadcast)');

const loadShows = async () => {
  const text = values['shows-url'] !== undefined ? await (await fetch(values['shows-url'])).text() : await readFile(values.shows ?? 'app/public/shows.json', 'utf8');
  return parseWorkerShows(text, { network: config.network });
};

const pass = async () => {
  const { shows, rejected } = await loadShows();
  for (const r of rejected) console.error(`shows.json: ${r.message}`);
  const chain = createWorkerChain({ network: config.network, servers: config.servers });
  try {
    const report = await runKeeper({ shows, chain, dataKey: config.dataKey, vmCheck: libauthVmCheck, dryRun });
    console.log(values.json ? JSON.stringify(report, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) : summariseKeeperReport(report));
    return report;
  } finally {
    chain.close();
  }
};

if (values.interval === undefined || values.once) {
  const report = await pass();
  process.exit(report.errors.length === 0 ? 0 : 1);
} else {
  const seconds = Number(values.interval);
  if (!Number.isFinite(seconds) || seconds < 10) throw new Error('--interval must be at least 10 seconds');
  for (;;) {
    try {
      await pass();
    } catch (e) {
      console.error(`keeper pass failed: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, seconds * 1000));
  }
}
