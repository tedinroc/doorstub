#!/usr/bin/env node
// npm run worker:workerd-check
//
// Runs the real Cloudflare adapters inside workerd on this machine (wrangler
// dev in local mode: no login, no account, nothing deployed) against an
// in-process simnet, and checks they work end to end:
//   1. Pages Functions (`wrangler pages dev` with ./functions): /api/health,
//      and /api/notice signs an 'R' notice for a live sample B seat; the
//      notice verifies with src/tx and the refund built from it is accepted;
//      /api/door gives a real show's link for a check-in on the simnet (once
//      per claimant) and refuses a hand-back; a check-in the page reserved
//      before sending it (the record in a local DOOR_CLAIMS KV namespace) is
//      refused to an observer and answered to the reserving claim;
//      /api/room/enter opens the screening room for that check-in's pass
//      (HMAC with a local test ROOM_KEY) and refuses a wrong one.
//   2. The cron Worker (`wrangler dev --test-scheduled` with worker/wrangler.toml
//      overridden by --var): one scheduled run refunds a new sample B seat and
//      settles a sample A ticket past its start plus grace.
// Simnet only: the simnet's server.features genesis is never mainnet's, and
// the worker's chain client refuses to broadcast to mainnet on a simnet run.
// Every wrangler/workerd process is killed at the end. Prints a JSON summary.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeTransaction, hexToBin } from '@bitauth/libauth';
import { startSimnet } from '../../simnet/index.js';
import { connectRpc } from '../../simnet/rpc.js';
import { bootstrapSimnet } from '../../studio/index.js';
import { parseShowsFile } from '../../src/shows/index.js';
import { buildRefund, verifyRefundNotice } from '../../src/tx/index.js';
import { checkSignatureFree, createFulcrumPool } from '../../src/chain/index.js';
import { buyTicket, send, signedCheckIn, signedHandBack, unspentAt } from '../../test/worker/support.js';
import { txidOf } from '../lib/crypto.js';
import { roomPass } from '../lib/room.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const wrangler = join(root, 'node_modules', '.bin', 'wrangler');
const work = join(root, '.cache', `workerd-check-${process.pid}`);

const freePort = () =>
  new Promise((resolve) => {
    const s = createNetServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const children = [];
const startWrangler = (args, logName) => {
  const child = spawn(wrangler, args, {
    cwd: root,
    detached: true,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', XDG_CONFIG_HOME: join(root, '.cache', 'wrangler-config'), CLOUDFLARE_API_TOKEN: '', CI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  children.push(child);
  return { child, log: () => log, name: logName };
};

const killAll = () => {
  for (const child of children) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
};

const waitFor = async (predicate, what, ms = 60_000) => {
  const start = Date.now();
  for (;;) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch {
      // not yet
    }
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
};

const summary = { runtime: 'workerd via wrangler dev (local)', steps: [] };
const step = (name, details) => {
  summary.steps.push({ name, ...details });
  console.error(`ok: ${name}`);
};

let simnet;
let rpc;
let pool;
let showsServer;
try {
  mkdirSync(work, { recursive: true });
  simnet = await startSimnet({ port: 0, seed: 'workerd-check', height: 977_600 });
  rpc = await connectRpc(simnet.url);
  const boot = await bootstrapSimnet({
    server: simnet.url,
    dir: work,
    count: 1,
    firstStart: '+12',
    refundSeatStart: '+6500',
    schedule: [{ id: 'live-call', kind: 'real', title: 'Live call', card: 'A real show.', startHeight: '+300', eventAt: '2026-11-24T13:00:00Z', durationMin: 25, seatPrefix: 'L' }],
  });
  const showsText = readFileSync(boot.showsPath, 'utf8');
  const { shows } = parseShowsFile(showsText, { network: 'simnet' });
  const showA = shows.find((s) => s.kind === 'sample-settle');
  const showB = shows.find((s) => s.kind === 'sample-refund-seat');
  const real = shows.find((s) => s.kind === 'real');
  const doorLinks = JSON.stringify({ 'live-call': 'https://example.invalid/call?seat={seat}' });
  const dataKeyHex = JSON.parse(readFileSync(boot.secretsPath, 'utf8')).data.privateKey;
  // A local test key, used only by this run.
  const roomKeyHex = '42'.repeat(32);
  pool = createFulcrumPool({ network: 'simnet', servers: [simnet.url], allowBroadcast: true, pingIntervalMs: 0 });

  // ---------------------------------------------------------------- 1. Pages Functions in workerd
  const pagesPort = await freePort();
  const pages = startWrangler(
    [
      'pages', 'dev', dirname(boot.showsPath),
      '--ip', '127.0.0.1', '--port', String(pagesPort), '--inspector-port', String(await freePort()),
      '--compatibility-date', '2024-11-11', '--show-interactive-dev-session=false',
      '--binding', 'DOORSTUB_NETWORK=simnet', `DOORSTUB_FULCRUM=${simnet.url}`, `STUDIO_DATA_KEY=${dataKeyHex}`, `DOOR_LINKS=${doorLinks}`, `ROOM_KEY=${roomKeyHex}`,
      '--kv', 'DOOR_CLAIMS', '--persist-to', join(work, 'state'),
    ],
    'pages',
  );
  const base = `http://127.0.0.1:${pagesPort}`;
  const health = await waitFor(async () => {
    const r = await fetch(`${base}/api/health`);
    return r.ok ? r.json() : null;
  }, 'wrangler pages dev', 90_000).catch((e) => {
    throw new Error(`${e.message}\n${pages.log()}`);
  });
  if (health.runtime !== 'workerd' || health.chain?.tip === undefined || health.signer?.shows?.[0]?.keyMatches !== true || health.signer?.alsoKeyOf?.length !== 0 || health.door?.record !== 'kv+memory' || health.room?.configured !== true) {
    throw new Error(`unexpected health ${JSON.stringify(health)}`);
  }
  step('pages: /api/health in workerd', { tip: health.chain.tip, signer: health.signer, door: health.door, vm: health.vm });

  const ticket = await buyTicket(rpc, showB);
  const t0 = Date.now();
  const res = await fetch(`${base}/api/notice`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ category: showB.categoryHex, seat: ticket.seatHex, txid: ticket.txid }) });
  const notice = await res.json();
  if (res.status !== 200) throw new Error(`notice ${res.status} ${JSON.stringify(notice)}\n${pages.log()}`);
  const signature = hexToBin(notice.signature);
  if (!verifyRefundNotice({ show: showB, notice: { scope: 'R', seat: ticket.seat, signature } })) throw new Error('notice does not verify');
  const refund = buildRefund({ show: showB, escrowUtxos: [ticket.escrowUtxo], notices: [{ scope: 'R', seat: ticket.seat, signature }], contracts: showB.contracts });
  const sent = await pool.broadcastChecked(checkSignatureFree(refund));
  step('pages: /api/notice signed in workerd; the page-side refund was accepted', { ms: Date.now() - t0, signatureBytes: signature.length, refundTxid: sent.txid });

  const bad = await fetch(`${base}/api/notice`, { method: 'POST', body: JSON.stringify({ category: showA.categoryHex, seat: '000100' }) });
  if (bad.status !== 403) throw new Error(`sample A notice should be refused, got ${bad.status}`);
  step('pages: refuses a notice for sample A', { status: bad.status });

  const holder = await buyTicket(rpc, real);
  const checkInTxid = await send(rpc, signedCheckIn(real, holder));
  const askDoor = async (txid, extra = {}) => {
    const r = await fetch(`${base}/api/door`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ category: real.categoryHex, txid, ...extra }) });
    return { status: r.status, body: await r.json() };
  };
  const t1 = Date.now();
  const opened = await askDoor(checkInTxid);
  if (opened.status !== 200 || opened.body.link !== 'https://example.invalid/call?seat=L-0-1') throw new Error(`door ${opened.status} ${JSON.stringify(opened.body)}\n${pages.log()}`);
  const doorMs = Date.now() - t1;
  const again = await askDoor(checkInTxid);
  if (again.status !== 200 || again.body.again !== true) throw new Error(`door repeat ${again.status} ${JSON.stringify(again.body)}`);
  const handBackTxid = await send(rpc, signedHandBack(real, await buyTicket(rpc, real)));
  const refused = await askDoor(handBackTxid);
  if (refused.status !== 422 || refused.body.error?.code !== 'not-a-check-in') throw new Error(`door should refuse a hand-back, got ${refused.status} ${JSON.stringify(refused.body)}`);
  step('pages: /api/door answers a real check-in in workerd (again for the same caller) and refuses a hand-back', { ms: doorMs, seatLabel: opened.body.seatLabel, refused: refused.body.error.code });

  // Reserve before sending (as the page does), then an observer asks first, then the page.
  const claim = 'c3'.repeat(32);
  const reservedTicket = await buyTicket(rpc, real, { shard: 1 });
  const reservedCheckIn = signedCheckIn(real, reservedTicket);
  const reservedTxid = txidOf(encodeTransaction(reservedCheckIn.transaction));
  const t2 = Date.now();
  const reserved = await askDoor(reservedTxid, { claim, reserve: true });
  const reserveMs = Date.now() - t2;
  if (reserved.status !== 200 || reserved.body.reserved !== true || reserved.body.again !== false) throw new Error(`reserve ${reserved.status} ${JSON.stringify(reserved.body)}\n${pages.log()}`);
  await send(rpc, reservedCheckIn);
  const observer = await askDoor(reservedTxid, { claim: 'b2'.repeat(32) });
  if (observer.status !== 409 || observer.body.error?.code !== 'already-answered') throw new Error(`observer should get 409, got ${observer.status} ${JSON.stringify(observer.body)}`);
  const holderAnswer = await askDoor(reservedTxid, { claim });
  if (holderAnswer.status !== 200 || holderAnswer.body.link !== 'https://example.invalid/call?seat=L-1-1') throw new Error(`reserved door ${holderAnswer.status} ${JSON.stringify(holderAnswer.body)}\n${pages.log()}`);
  step('pages: a reserved check-in (record in local KV) is refused to an observer and answered to the page', { reserveMs, observer: observer.status, seatLabel: holderAnswer.body.seatLabel });

  // The screening room: the pass for that seat and check-in opens it; another seat's does not.
  const enterRoom = async (extra) => {
    const r = await fetch(`${base}/api/room/enter`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(extra) });
    return { status: r.status, body: await r.json() };
  };
  const seat = holderAnswer.body.seatLabel;
  const t3 = Date.now();
  const room = await enterRoom({ show: real.id, seat, txid: reservedTxid, pass: roomPass(roomKeyHex, real.id, seat, reservedTxid) });
  const enterMs = Date.now() - t3;
  if (room.status !== 200 || room.body.eventAt !== '2026-11-24T13:00:00Z' || room.body.opensUntil !== '2026-11-24T13:35:00Z' || typeof room.body.now !== 'number') {
    throw new Error(`room enter ${room.status} ${JSON.stringify(room.body)}\n${pages.log()}`);
  }
  const wrong = await enterRoom({ show: real.id, seat: 'L-9-9', txid: reservedTxid, pass: roomPass(roomKeyHex, real.id, seat, reservedTxid) });
  if (wrong.status !== 403 || wrong.body.error?.code !== 'bad-pass') throw new Error(`room enter with another seat should be 403, got ${wrong.status} ${JSON.stringify(wrong.body)}`);
  const rehearsal = await enterRoom({ show: 'rehearsal', seat: 'R-0-1', txid: reservedTxid, pass: roomPass(roomKeyHex, 'rehearsal', 'R-0-1', reservedTxid) });
  if (rehearsal.status !== 200 || rehearsal.body.title !== 'Doorstub rehearsal') throw new Error(`rehearsal enter ${rehearsal.status} ${JSON.stringify(rehearsal.body)}`);
  step('pages: /api/room/enter opens the room for a seat\'s pass in workerd (HMAC) and refuses another seat', { ms: enterMs, wrong: wrong.status, rehearsalAt: rehearsal.body.eventAt });
  killAll();

  // ---------------------------------------------------------------- 2. the cron Worker in workerd
  showsServer = createServer((req, res) => {
    res.writeHead(req.url === '/shows.json' ? 200 : 404, { 'content-type': 'application/json' });
    res.end(req.url === '/shows.json' ? showsText : '{}');
  });
  await new Promise((r) => showsServer.listen(0, '127.0.0.1', r));
  const showsUrl = `http://127.0.0.1:${showsServer.address().port}/shows.json`;
  const b2 = await buyTicket(rpc, showB);
  const a1 = await buyTicket(rpc, showA);
  const tip = (await rpc.request('blockchain.headers.subscribe', [])).height;
  await rpc.request('simnet.mine', { blocks: showA.startHeight + showA.graceBlocks - tip });

  const cronPort = await freePort();
  const cron = startWrangler(
    [
      'dev', '--config', 'worker/wrangler.toml', '--test-scheduled',
      '--ip', '127.0.0.1', '--port', String(cronPort), '--inspector-port', String(await freePort()), '--show-interactive-dev-session=false',
      '--var', 'DOORSTUB_NETWORK:simnet', `DOORSTUB_FULCRUM:${simnet.url}`, `STUDIO_DATA_KEY:${dataKeyHex}`, `SHOWS_URL:${showsUrl}`,
    ],
    'cron',
  );
  await waitFor(async () => (await fetch(`http://127.0.0.1:${cronPort}/__scheduled?cron=*/5+*+*+*+*`)).ok, 'wrangler dev --test-scheduled', 90_000).catch((e) => {
    throw new Error(`${e.message}\n${cron.log()}`);
  });
  await waitFor(async () => (await unspentAt(rpc, showB.contracts.escrow.lockingBytecode)).length === 0 && (await unspentAt(rpc, showA.contracts.escrow.lockingBytecode)).length === 0, 'the cron keeper to refund B and settle A', 30_000).catch((e) => {
    throw new Error(`${e.message}\n${cron.log()}`);
  });
  const keeperLine = cron.log().split('\n').filter((l) => /keeper simnet|sample-/.test(l)).slice(0, 6);
  step('cron: one scheduled run in workerd refunded a sample B seat and settled sample A', { seats: [b2.seatHex, a1.seatHex], log: keeperLine });
  summary.ok = true;
} catch (e) {
  summary.ok = false;
  summary.error = e.message;
} finally {
  killAll();
  pool?.close();
  rpc?.close();
  showsServer?.close();
  await simnet?.close();
  rmSync(work, { recursive: true, force: true });
}
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.ok ? 0 : 1);

