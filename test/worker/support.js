// Shared setup for the worker's simnet tests: an in-process simnet, a studio
// catalogue made by the real studio (bootstrapSimnet), the shows parsed by
// src/shows (for the app-side builders), and helpers that buy, check in and
// hand back with fresh test keys, sending straight to the simnet.
import { readFileSync } from 'node:fs';
import { binToHex, encodeTransaction, hexToBin } from '@bitauth/libauth';
import { startSimnet } from '../../simnet/index.js';
import { connectRpc } from '../../simnet/rpc.js';
import { bootstrapSimnet } from '../../studio/index.js';
import { parseShowsFile } from '../../src/shows/index.js';
import { buildBuy, buildCheckIn, buildHandBack, decodeBoxOfficeCommitment, sameBytes } from '../../src/tx/index.js';
import { coinsAt, fundKey, scratchDir } from '../simnet/support.js';
import { freshKey, signWallet, utxoAt } from '../helpers.js';
import { startWorkerServer } from '../../worker/node/server.js';

/**
 * Start a simnet with a studio catalogue. `schedule` adds real shows
 * (studio plan entries). Returns everything a test needs; `t.after` cleans up.
 */
export const workerSimnet = async (t, { name, count = 1, firstStart = '+20', refundSeatStart = '+6500', schedule = [] } = {}) => {
  const simnet = await startSimnet({ port: 0, seed: `worker-${name}`, height: 977_600 });
  const scratch = scratchDir(`worker-${name}`);
  const rpc = await connectRpc(simnet.url, { timeoutMs: 5_000 });
  t.after(async () => {
    rpc.close();
    await simnet.close();
    scratch.cleanup();
  });
  const boot = await bootstrapSimnet({ server: simnet.url, dir: scratch.dir, count, firstStart, refundSeatStart, schedule });
  const showsText = readFileSync(boot.showsPath, 'utf8');
  const file = parseShowsFile(showsText, { network: 'simnet' });
  if (file.rejected.length > 0) throw new Error(`studio shows rejected: ${JSON.stringify(file.rejected)}`);
  const studio = JSON.parse(readFileSync(boot.secretsPath, 'utf8'));
  const byKind = (kind) => file.shows.filter((s) => s.kind === kind);
  return { simnet, rpc, boot, showsText, showsPath: boot.showsPath, shows: file.shows, byKind, dataKeyHex: studio.data.privateKey, dir: scratch.dir };
};

/** Start the Node adapter on a free port against this simnet. */
export const startWorker = async (t, ctx, { env = {}, ...options } = {}) => {
  const server = await startWorkerServer({
    env: { DOORSTUB_NETWORK: 'simnet', DOORSTUB_FULCRUM: ctx.simnet.url, STUDIO_DATA_KEY: ctx.dataKeyHex, ...env },
    showsPath: ctx.showsPath,
    port: 0,
    markerWaitMs: 0,
    ...options,
  });
  t.after(() => server.close());
  return server;
};

export const post = async (server, path, body) => {
  const response = await fetch(`${server.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};

export const get = async (server, path) => {
  const response = await fetch(`${server.url}${path}`);
  return { status: response.status, body: await response.json() };
};

export const tipOf = async (rpc) => (await rpc.request('blockchain.headers.subscribe', [])).height;

export const send = async (rpc, resolved) => rpc.request('blockchain.transaction.broadcast', [binToHex(encodeTransaction(resolved.transaction))]);

/** An open shard of a show, read from the chain (mempool counted). */
export const openShard = async (rpc, show, shard = 0) => {
  const coins = await coinsAt(rpc, show.contracts.boxOffice.lockingBytecode);
  const found = coins.find((u) => {
    const t = u.output.token;
    if (t?.nft?.capability !== 'minting' || !sameBytes(t.category, show.category)) return false;
    const state = decodeBoxOfficeCommitment(t.nft.commitment);
    return state.open && state.shard === shard;
  });
  if (found === undefined) throw new Error(`no open shard ${shard} for ${show.id}`);
  return found;
};

/** Buy one seat with a fresh (or given) test key; sent to the simnet, left in the mempool. */
export const buyTicket = async (rpc, show, { key = freshKey(), shard = 0 } = {}) => {
  const funding = await fundKey(rpc, key, 200_000, { mine: false });
  const built = buildBuy({
    show,
    boxOfficeUtxo: await openShard(rpc, show, shard),
    fundingUtxos: [funding],
    buyerPkh: key.pkh,
    currentHeight: await tipOf(rpc),
    contracts: show.contracts,
  });
  const signed = signWallet(built, key.privateKey);
  const txid = await send(rpc, signed);
  return {
    key,
    txid,
    seat: built.seat,
    seatHex: binToHex(built.seat),
    ticketUtxo: utxoAt(signed.transaction, 1),
    escrowUtxo: utxoAt(signed.transaction, 2),
    transaction: signed.transaction,
  };
};

/** The holder's signed check-in for a ticket (not sent). */
export const signedCheckIn = (show, ticket) =>
  signWallet(buildCheckIn({ show, escrowUtxo: ticket.escrowUtxo, ticketUtxo: ticket.ticketUtxo, contracts: show.contracts }), ticket.key.privateKey);

/** The holder's signed hand-back for a ticket (not sent). */
export const signedHandBack = (show, ticket) =>
  signWallet(buildHandBack({ show, escrowUtxo: ticket.escrowUtxo, ticketUtxo: ticket.ticketUtxo, contracts: show.contracts }), ticket.key.privateKey);

/** Unspent coins at a locking bytecode (builder UTXOs). */
export const unspentAt = (rpc, lockingBytecode) => coinsAt(rpc, lockingBytecode);

export const hexToBytes = hexToBin;
