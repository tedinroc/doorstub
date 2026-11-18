#!/usr/bin/env node
// npm run worker:dev -- [options]
//
// Serve the worker's /api/* locally with the Node adapter (same handlers as
// Pages Functions, plus the libauth VM check). For the app's dev server and
// the simnet E2E, point Vite's /api proxy at it.
//
//   --fulcrum ws://127.0.0.1:50021   simnet Fulcrum URL (simnet only; mainnet uses the fixed server list)
//   --network simnet|mainnet         default simnet
//   --shows app/public/shows.json    shows.json on disk (default), or --shows-url <url>
//   --port 8788                      0 picks a free port
//   --studio <path>/studio.json      take STUDIO_DATA_KEY from a studio secrets file (simnet runs)
//   --dev-vars .dev.vars             KEY=VALUE file with STUDIO_DATA_KEY, DOOR_LINKS, ROOM_KEY (default .dev.vars if present)
//   --door-links '{"id":"https://..."}'
//   --static app/dist                also serve the built site on the same origin (as Pages does)
//   --cors                           let a dev server on another port call /api/*
//
// Nothing here broadcasts: the notice signer signs, the door reads.
import { parseArgs } from 'node:util';
import { dataKeyFromStudio, readDevVars } from './env.js';
import { startWorkerServer } from './server.js';

const { values } = parseArgs({
  options: {
    fulcrum: { type: 'string' },
    network: { type: 'string', default: 'simnet' },
    shows: { type: 'string' },
    'shows-url': { type: 'string' },
    port: { type: 'string', default: '8788' },
    host: { type: 'string', default: '127.0.0.1' },
    studio: { type: 'string' },
    'dev-vars': { type: 'string', default: '.dev.vars' },
    'door-links': { type: 'string' },
    static: { type: 'string' },
    cors: { type: 'boolean', default: false },
  },
});

const env = { ...readDevVars(values['dev-vars']) };
for (const key of ['STUDIO_DATA_KEY', 'DOOR_LINKS', 'ROOM_KEY', 'ROOM_REHEARSAL_LEAD_S']) if (process.env[key] !== undefined) env[key] = process.env[key];
env.DOORSTUB_NETWORK = values.network;
if (values.fulcrum !== undefined) env.DOORSTUB_FULCRUM = values.fulcrum;
if (values.studio !== undefined) env.STUDIO_DATA_KEY = dataKeyFromStudio(values.studio);
if (values['door-links'] !== undefined) env.DOOR_LINKS = values['door-links'];

const showsUrl = values['shows-url'];
const showsPath = showsUrl === undefined ? (values.shows ?? 'app/public/shows.json') : undefined;
const server = await startWorkerServer({
  env,
  showsPath,
  showsUrl,
  port: Number(values.port),
  host: values.host,
  staticRoot: values.static,
  cors: values.cors,
  log: (line) => console.error(line),
});
console.log(`doorstub worker (${server.config.network}) on ${server.url}/api  (health: ${server.url}/api/health)`);
for (const e of server.config.errors) console.log(`config: ${e}`);
const stop = async () => {
  await server.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
