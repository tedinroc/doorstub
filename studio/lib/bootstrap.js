// One call that builds a working simnet catalogue for tests and the E2E run:
// studio keys in `dir`, a funded studio address, a plan, genesis broadcast to
// the simnet, one block mined so every genesis is confirmed. Simnet only.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { connectRpc } from '../../simnet/rpc.js';
import { genesis } from './genesis.js';
import { keygen, loadSecrets, publicView } from './keys.js';
import { makePlan } from './plan.js';
import { writePlan } from './plan-file.js';

export const bootstrapSimnet = async ({
  server,
  dir,
  showsPath = join(dir, 'public', 'shows.json'),
  publicDir,
  payee,
  count = 2,
  firstStart = '+36',
  step = 36,
  refundSeatStart = '+6500',
  schedule = [],
  fundSats = 2_000_000,
  origin = 'https://doorstub.pages.dev',
  now = new Date(),
  print = () => {},
}) => {
  const secretsPath = join(dir, 'studio.json');
  if (!existsSync(secretsPath)) keygen({ secretsPath, now });
  const studio = publicView(loadSecrets(secretsPath));
  const rpc = await connectRpc(server, { clientName: 'Doorstub studio bootstrap' });
  try {
    await rpc.request('simnet.fund', { address: studio.fundingAddress, sats: fundSats, mine: true });
    const tip = (await rpc.request('blockchain.headers.subscribe', [])).height;
    const plan = makePlan({
      network: 'simnet',
      origin,
      tip,
      now,
      studio,
      payee: payee ?? studio.fundingAddress,
      firstStart,
      step,
      count,
      refundSeatStart,
      schedule,
    });
    const planPath = join(dir, 'plan.json');
    writePlan(planPath, plan);
    const result = await genesis({
      planPath,
      secretsPath,
      network: 'simnet',
      server,
      showsPath,
      publicDir,
      broadcast: true,
      mine: true,
      previewPath: join(dir, 'genesis-preview.json'),
      now,
      print,
    });
    return { secretsPath, planPath, showsPath, studio, plan, genesis: result };
  } finally {
    rpc.close();
  }
};
