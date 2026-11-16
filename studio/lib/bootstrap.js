// One call that builds a working simnet catalogue for tests and the E2E run:
// studio keys in `dir`, a funded studio address, a plan, genesis broadcast to
// the simnet, one block mined so every genesis is confirmed. Simnet only.
//
// A real show in `schedule` that does not name its call gets one for the
// simnet: an hour from `now`, 25 minutes, and as its seat letter the title's
// first letter (as before seat letters were named), or the next free one from S.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { connectRpc } from '../../simnet/rpc.js';
import { genesis } from './genesis.js';
import { addRealDataKey, keygen, loadSecrets, publicView } from './keys.js';
import { makePlan } from './plan.js';
import { writePlan } from './plan-file.js';

/** Simnet stand-ins for the call fields a real schedule entry leaves out. */
export const withSimnetCalls = (schedule, now = new Date()) => {
  const used = new Set(schedule.map((item) => item.seatPrefix).filter((p) => typeof p === 'string'));
  const nextLetter = (title) => {
    const first = /[A-Za-z]/.exec(title ?? '')?.[0]?.toUpperCase();
    const letter = [first, ...'STUVWXYZCDEFGHIJKLMNOPQR'].find((l) => l !== undefined && l !== 'A' && l !== 'B' && !used.has(l));
    if (letter === undefined) throw new Error('no free seat letter left');
    used.add(letter);
    return letter;
  };
  return schedule.map((item) => {
    if ((item.kind ?? 'real') !== 'real') return item;
    return {
      ...item,
      eventAt: item.eventAt ?? new Date(Math.floor(now.getTime() / 60_000) * 60_000 + 3_600_000).toISOString().replace('.000Z', 'Z'),
      durationMin: item.durationMin ?? 25,
      seatPrefix: item.seatPrefix ?? nextLetter(item.title),
    };
  });
};

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
  else if (loadSecrets(secretsPath).realData === undefined) addRealDataKey({ secretsPath });
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
      schedule: withSimnetCalls(schedule, now),
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
