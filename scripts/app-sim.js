#!/usr/bin/env node
// npm run app:sim: try the whole site locally, with no real money anywhere.
//
// Starts a simnet (ws://127.0.0.1:50021), makes a studio catalogue on it
// (sample A, sample B and a real test show), serves /shows.json and the
// worker's /api/* (its Node adapter, pinned to the simnet) on
// http://127.0.0.1:50022, and runs the Vite dev server on
// http://localhost:5190 in test mode. Open the printed link, connect any
// WizardConnect wallet (its signatures only ever reach the simnet), press
// "Fund wallet" in the SIMNET panel, and buy.
import { join } from 'node:path';
import { createServer } from 'vite';
import { repoRoot, startStage } from '../test/e2e/stage.js';

const stage = await startStage({ dir: join(repoRoot, '.cache', 'app-sim', String(Date.now())), simnetPort: 50021, apiPort: 50022, cors: true });
const vite = await createServer({ configFile: join(repoRoot, 'app', 'vite.config.js'), root: join(repoRoot, 'app'), mode: 'development' });
await vite.listen();
const url = `http://localhost:5190/?fulcrum=${encodeURIComponent(stage.simnet.url)}&api=${encodeURIComponent(stage.server.origin)}`;
console.log(`\nDoorstub on simnet is ready:\n\n  ${url}\n`);
console.log(`simnet ${stage.simnet.url}, worker ${stage.server.origin}, shows: ${stage.shows.map((s) => s.id).join(', ')}`);
console.log('Ctrl+C stops everything.');

const stop = async () => {
  await vite.close();
  await stage.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
