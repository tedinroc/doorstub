#!/usr/bin/env node
// Doorstub studio CLI: npm run studio -- <command> [options]. See studio/README.md.
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { bootstrapSimnet } from './lib/bootstrap.js';
import { close } from './lib/close.js';
import { genesis } from './lib/genesis.js';
import { DEFAULT_SECRETS_PATH, keygen, loadSecrets, publicView } from './lib/keys.js';
import { openNetwork } from './lib/net.js';
import { SAMPLE_DEFAULTS, makePlan } from './lib/plan.js';
import { writePlan } from './lib/plan-file.js';
import { DEFAULT_ORIGIN } from './lib/shows-json.js';
import { status } from './lib/status.js';

const HELP = `Doorstub studio (organiser CLI)

  keygen            create .secrets/studio.json (sales, data and identity keys); prints the funding address
  plan              write studio/plan.json from a schedule and the current tip
                      --payee <cashaddr> (P2PKH) --first-start <height|+blocks> [--count ${SAMPLE_DEFAULTS.count}] [--step ${SAMPLE_DEFAULTS.step}]
                      [--price ${SAMPLE_DEFAULTS.price}] [--grace ${SAMPLE_DEFAULTS.graceBlocks}] [--shards ${SAMPLE_DEFAULTS.shards}] [--miner-fee-cap ${SAMPLE_DEFAULTS.minerFeeCap}]
                      [--hand-back-fee-bps 0] [--no-show-fee-bps 0] [--refund-seat-start <height|+blocks>] [--no-refund-seat]
                      [--schedule shows.json-like list of extra shows] [--tip <height>] [--out studio/plan.json]
  genesis           build (and with --broadcast send) every planned show's prep and genesis;
                      writes app/public/shows.json and app/public/bcmr/<category>.json after sending
                      [--plan studio/plan.json] [--shows app/public/shows.json] [--broadcast] [--mine (simnet)]
  close             closeSales on a show's open shards: --show <id> | --started  [--broadcast] [--mine (simnet)]
  status            per show: genesis, shards, seats sold, escrow coins, paths taken  [--shows ...]
  simnet-bootstrap  keys + funding + plan + genesis on a running simnet, for tests and E2E
                      [--dir .cache/simnet-studio] [--shows <dir>/public/shows.json] [--count 2] [--first-start +36]

Common: --network simnet|mainnet (default simnet)  --server ws://127.0.0.1:50021 (simnet)
        --secrets ${DEFAULT_SECRETS_PATH}  --origin ${DEFAULT_ORIGIN}

Nothing is sent without --broadcast. On mainnet, --broadcast prints the plan and its cost
and sends only after you type BROADCAST in an interactive terminal.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: 'boolean', short: 'h' },
    network: { type: 'string', default: 'simnet' },
    server: { type: 'string' },
    secrets: { type: 'string', default: DEFAULT_SECRETS_PATH },
    origin: { type: 'string', default: DEFAULT_ORIGIN },
    payee: { type: 'string' },
    'first-start': { type: 'string' },
    count: { type: 'string' },
    step: { type: 'string' },
    price: { type: 'string' },
    grace: { type: 'string' },
    shards: { type: 'string' },
    'miner-fee-cap': { type: 'string' },
    'hand-back-fee-bps': { type: 'string' },
    'no-show-fee-bps': { type: 'string' },
    'refund-seat-start': { type: 'string' },
    'no-refund-seat': { type: 'boolean' },
    schedule: { type: 'string' },
    tip: { type: 'string' },
    out: { type: 'string', default: 'studio/plan.json' },
    plan: { type: 'string', default: 'studio/plan.json' },
    shows: { type: 'string' },
    'public-dir': { type: 'string' },
    'icon-path': { type: 'string' },
    broadcast: { type: 'boolean', default: false },
    mine: { type: 'boolean', default: false },
    show: { type: 'string' },
    started: { type: 'boolean', default: false },
    dir: { type: 'string', default: '.cache/simnet-studio' },
  },
});

const num = (value, fallback) => (value === undefined ? fallback : Number(value));
const network = values.network;
const showsPath = values.shows ?? 'app/public/shows.json';

const commands = {
  keygen: async () => {
    const view = keygen({ secretsPath: values.secrets });
    console.log(`Wrote ${values.secrets} (keep it secret, back it up, never commit it).`);
    console.log(`Fund the studio at:  ${view.fundingAddress}`);
    console.log(`Sales public key:    ${view.salesPk}  (organiserPk; signs closeSales)`);
    console.log(`Data public key:     ${view.dataPk}  (organiserDataPk; signs refund notices)`);
    console.log(`Identity address:    ${view.identityAddress}  (holds each show's BCMR identity output; never spend it)`);
  },
  plan: async () => {
    if (values.payee === undefined) throw new Error('--payee <cashaddr> is required (the organiser payee; check-ins and posted fees pay it)');
    const studio = publicView(loadSecrets(values.secrets));
    let tip = values.tip === undefined ? undefined : Number(values.tip);
    if (tip === undefined) {
      const net = await openNetwork({ network, server: values.server });
      try {
        tip = await net.tip();
      } finally {
        net.close();
      }
    }
    const schedule = values.schedule ? JSON.parse(readFileSync(values.schedule, 'utf8')) : [];
    const plan = makePlan({
      network,
      origin: values.origin,
      tip,
      studio,
      payee: values.payee,
      firstStart: values['first-start'],
      count: num(values.count, values['first-start'] === undefined && schedule.length > 0 ? 0 : SAMPLE_DEFAULTS.count),
      step: num(values.step, SAMPLE_DEFAULTS.step),
      price: num(values.price, SAMPLE_DEFAULTS.price),
      graceBlocks: num(values.grace, SAMPLE_DEFAULTS.graceBlocks),
      shards: num(values.shards, SAMPLE_DEFAULTS.shards),
      minerFeeCap: num(values['miner-fee-cap'], SAMPLE_DEFAULTS.minerFeeCap),
      handBackFeeBps: num(values['hand-back-fee-bps'], 0),
      noShowFeeBps: num(values['no-show-fee-bps'], 0),
      refundSeatStart: values['no-refund-seat'] ? null : values['refund-seat-start'] ?? `+${SAMPLE_DEFAULTS.refundSeatOffset}`,
      schedule: Array.isArray(schedule) ? schedule : schedule.shows ?? [],
    });
    if (existsSync(values.out)) console.log(`Replacing ${values.out}.`);
    writePlan(values.out, plan);
    console.log(`Wrote ${values.out}: ${plan.shows.length} show(s) on ${network}, tip ${tip}.`);
    for (const s of plan.shows) console.log(`  ${s.id}  ${s.kind}  start ${s.params.startHeight} (about ${s.startsAtEstimate})  ${s.shards} shards  ${s.params.price} sats`);
  },
  genesis: async () => {
    await genesis({
      planPath: values.plan,
      secretsPath: values.secrets,
      network,
      server: values.server,
      showsPath,
      publicDir: values['public-dir'],
      broadcast: values.broadcast,
      mine: values.mine,
      iconPath: values['icon-path'],
    });
  },
  close: async () => {
    await close({
      showsPath,
      secretsPath: values.secrets,
      network,
      server: values.server,
      showId: values.show,
      started: values.started,
      broadcast: values.broadcast,
      mine: values.mine,
    });
  },
  status: async () => {
    await status({ showsPath, network, server: values.server });
  },
  'simnet-bootstrap': async () => {
    if (network !== 'simnet') throw new Error('simnet-bootstrap is simnet-only');
    const result = await bootstrapSimnet({
      server: values.server ?? 'ws://127.0.0.1:50021',
      dir: values.dir,
      showsPath: values.shows,
      publicDir: values['public-dir'],
      payee: values.payee,
      count: num(values.count, 2),
      firstStart: values['first-start'] ?? '+36',
      print: console.log,
    });
    console.log(`Studio keys: ${result.secretsPath}; plan: ${result.planPath}; shows: ${result.showsPath}`);
  },
};

const command = positionals[0];
if (values.help || command === undefined || command === 'help') {
  console.log(HELP);
} else if (commands[command] === undefined) {
  console.error(`unknown command "${command}"\n\n${HELP}`);
  process.exitCode = 2;
} else {
  try {
    await commands[command]();
  } catch (error) {
    console.error(`studio ${command}: ${error.message}`);
    process.exitCode = 1;
  }
}
