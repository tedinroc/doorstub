// A local stage for the site: a simnet, a studio catalogue on it (sample A,
// sample B and one real show), and the worker's Node adapter serving the
// built app, /shows.json and the real /api/notice and /api/door (the same
// handlers as Pages Functions, plus the libauth VM). Used by the E2E
// (test/e2e/judge-path.js) and by `npm run app:sim`. Nothing here talks to
// mainnet: the worker is pinned to the simnet (DOORSTUB_NETWORK=simnet).
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSimnet } from '../../simnet/index.js';
import { bootstrapSimnet } from '../../studio/index.js';
import { startWorkerServer } from '../../worker/node/server.js';

export const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/** The page's CSP from app/public/_headers, with the mainnet servers swapped for the local simnet (and a local relay, if any). */
export const simnetCsp = (simnetUrl, extra = []) => {
  const headers = readFileSync(join(repoRoot, 'app/public/_headers'), 'utf8');
  const csp = /Content-Security-Policy: (.+)/.exec(headers)[1];
  return csp.replace(/wss:\/\/[^ ;]+:50004 ?/g, '').replace("connect-src 'self'", `connect-src 'self' ${[simnetUrl, ...extra].join(' ')}`);
};

/** The stage's call: two days from now, on the minute (its start block is about 50 hours ahead). */
const STAGE_CALL_AT = new Date(Math.floor((Date.now() + 48 * 3_600_000) / 60_000) * 60_000).toISOString().replace(/\.000Z$/, 'Z');

/**
 * The real show on the stage: the first screening as planned (card text in CLAIMS.md section 6), far enough ahead that a
 * run never reaches its start. `eventAt`, `durationMin` and `seatPrefix` are the real-show fields of shows.json.
 */
export const REAL_SHOW = Object.freeze({
  id: 'screening-1',
  kind: 'real',
  title: 'Doorstub screening 1',
  subtitle: 'Online, 25 minutes',
  card: 'Online screening: a 12-minute film on how Doorstub works, then Q&A in the chat. Walk in to get the room link.',
  startHeight: '+300',
  eventAt: STAGE_CALL_AT,
  durationMin: 25,
  seatPrefix: 'S',
});

/** The door link the stage's worker hands out (a test secret; {seat} is filled in by the worker). */
export const STAGE_DOOR_LINK = 'https://example.org/doorstub-simnet-door?seat={seat}';

/**
 * @param {object} options
 * @param {string} options.dir scratch directory (under .cache/)
 * @param {number} [options.simnetPort] 0 picks a free port
 * @param {number} [options.apiPort]
 * @param {string} [options.root] a built app to serve (same origin as the API)
 * @param {boolean} [options.csp] send the production CSP (simnet servers swapped in) with the page
 * @param {string[]} [options.cspExtra] more local URLs for connect-src (a local relay)
 * @param {boolean} [options.cors] let a dev server on another port call /api/* (npm run app:sim)
 * @param {string|number} [options.firstStart] sample A's start, "+blocks" from the tip
 * @param {number} [options.count] how many sample A instances
 */
export const startStage = async ({
  dir,
  simnetPort = 0,
  apiPort = 0,
  root,
  csp = false,
  cspExtra = [],
  cors = false,
  firstStart = '+36',
  count = 2,
  log = () => {},
}) => {
  mkdirSync(dir, { recursive: true });
  const simnet = await startSimnet({ port: simnetPort, seed: 'doorstub-stage', height: 977_600 });
  try {
    const boot = await bootstrapSimnet({
      server: simnet.url,
      dir,
      count,
      firstStart,
      refundSeatStart: '+6500',
      schedule: [REAL_SHOW],
      print: log,
    });
    const secrets = JSON.parse(readFileSync(boot.secretsPath, 'utf8'));
    const shows = JSON.parse(readFileSync(boot.showsPath, 'utf8')).shows;
    const doorLinks = Object.fromEntries(shows.filter((s) => s.kind === 'real').map((s) => [s.id, STAGE_DOOR_LINK]));
    const env = {
      DOORSTUB_NETWORK: 'simnet',
      DOORSTUB_FULCRUM: simnet.url,
      STUDIO_DATA_KEY: secrets.data.privateKey,
      DOOR_LINKS: JSON.stringify(doorLinks),
    };
    const server = await startWorkerServer({
      env,
      showsPath: boot.showsPath,
      port: apiPort,
      staticRoot: root,
      cors,
      htmlHeaders: csp ? { 'content-security-policy': simnetCsp(simnet.url, cspExtra) } : {},
      log,
    });
    if (server.config.errors.length > 0) throw new Error(`worker config: ${server.config.errors.join('; ')}`);
    return {
      simnet,
      boot,
      server: { ...server, origin: server.url },
      shows,
      env,
      secrets,
      close: async () => {
        await server.close();
        await simnet.close();
      },
    };
  } catch (e) {
    await simnet.close();
    throw e;
  }
};
