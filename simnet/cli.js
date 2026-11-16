#!/usr/bin/env node
// npm run simnet -- [--port 50021] [--host 127.0.0.1] [--seed doorstub-simnet]
//                   [--height 977600] [--time <unix seconds>] [--auto-mine-seconds N] [--quiet]
// Starts a local Fulcrum-compatible test chain and prints its URL.
import { parseArgs } from 'node:util';
import { DEFAULT_PORT, startSimnet } from './server.js';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: String(DEFAULT_PORT) },
    host: { type: 'string', default: '127.0.0.1' },
    seed: { type: 'string' },
    height: { type: 'string' },
    time: { type: 'string' },
    'auto-mine-seconds': { type: 'string' },
    quiet: { type: 'boolean', default: false },
  },
});

const simnet = await startSimnet({
  port: Number(values.port),
  host: values.host,
  seed: values.seed,
  height: values.height === undefined ? undefined : Number(values.height),
  time: values.time === undefined ? undefined : Number(values.time),
  autoMineMs: values['auto-mine-seconds'] ? Number(values['auto-mine-seconds']) * 1000 : undefined,
  log: values.quiet ? () => {} : (line) => console.log(`[simnet] ${line}`),
});
const info = simnet.chain.info();
console.log(`simnet listening on ${simnet.url} (height ${info.height}, seed "${info.seed}")`);
console.log('control: simnet.fund {address, sats, token?, mine?}, simnet.mine {blocks}, simnet.reset {}, simnet.info');
const stop = async () => {
  await simnet.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
