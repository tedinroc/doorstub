// A local stage for the site: a simnet, a studio catalogue on it (two sample
// A instances, sample B and one real show), and the stub worker serving
// /shows.json, /api/notice and /api/door (plus a built app, when given).
// Used by the E2E (test/e2e/judge-path.js) and by `npm run app:sim`.
// Nothing here talks to mainnet.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hexToBin } from '@bitauth/libauth';
import { startSimnet } from '../../simnet/index.js';
import { bootstrapSimnet } from '../../studio/index.js';
import { startStubServer } from '../support/stub-worker.js';

export const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/** The page's CSP from app/public/_headers, with the mainnet servers swapped for the local simnet. */
export const simnetCsp = (simnetUrl) => {
  const headers = readFileSync(join(repoRoot, 'app/public/_headers'), 'utf8');
  const csp = /Content-Security-Policy: (.+)/.exec(headers)[1];
  return csp.replace(/wss:\/\/[^ ;]+:50004 ?/g, '').replace("connect-src 'self'", `connect-src 'self' ${simnetUrl}`);
};

export const REAL_SHOW = Object.freeze({
  id: 'simnet-real',
  kind: 'real',
  title: 'Simnet launch call',
  subtitle: 'A test show on the local simnet',
  card: 'A real show on the test chain: walk in and the door answers with the event link.',
  startHeight: '+300',
});

/**
 * @param {object} options
 * @param {string} options.dir scratch directory (under .cache/)
 * @param {number} [options.simnetPort] 0 picks a free port
 * @param {number} [options.apiPort]
 * @param {string} [options.root] a built app to serve (same origin as the API)
 * @param {boolean} [options.csp] send the production CSP (simnet servers swapped in) with the page
 */
export const startStage = async ({ dir, simnetPort = 0, apiPort = 0, root, csp = false, log = () => {} }) => {
  mkdirSync(dir, { recursive: true });
  const simnet = await startSimnet({ port: simnetPort, seed: 'doorstub-stage', height: 977_600 });
  try {
    const boot = await bootstrapSimnet({
      server: simnet.url,
      dir,
      count: 2,
      firstStart: '+36',
      refundSeatStart: '+6500',
      schedule: [REAL_SHOW],
      print: log,
    });
    const secrets = JSON.parse(readFileSync(boot.secretsPath, 'utf8'));
    const shows = JSON.parse(readFileSync(boot.showsPath, 'utf8')).shows;
    const real = shows.find((s) => s.kind === 'real');
    const doorLinks = real ? { [real.params.category]: 'https://example.org/doorstub-simnet-door' } : {};
    const server = await startStubServer({
      root,
      showsPath: boot.showsPath,
      dataPrivateKey: hexToBin(secrets.data.privateKey),
      doorLinks,
      port: apiPort,
      headers: csp ? { 'content-security-policy': simnetCsp(simnet.url) } : {},
    });
    return {
      simnet,
      boot,
      server,
      shows,
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
