# Worker: runtime, design and abuse review

The worker is Doorstub's small server side: the refund-notice signer for sample show B (`POST /api/notice`), the door for real shows (`POST /api/door`), `GET /api/health`, and the keeper that settles and refunds escrow coins every five minutes. One library (`worker/lib/`) runs in three places:

| Adapter | File | Where it runs | VM check |
|---|---|---|---|
| Pages Functions | `functions/api/[[route]].js` -> `worker/pages.js` | Cloudflare workerd, on the site's own origin (`/api/*`) | worker rule check; the network runs the VM |
| Cron Worker | `worker/cron.js`, `worker/wrangler.toml` | Cloudflare workerd, every 5 minutes, no public URL | worker rule check; the network runs the VM |
| Node | `worker/node/server.js`, `cli.js`, `keeper-cli.js` | tests, simnet E2E, local runs | worker rule check **and** the libauth 2026 VM |

## 1. Runtime check (11/16): libauth does not run in workerd

Tested with `wrangler dev` 3.114.17 in local mode (workerd on this Mac; no login, no account, nothing deployed), with a throwaway Worker that imported `@bitauth/libauth` and `src/tx`:

- `WebAssembly.compile(bytes)` inside a request: `CompileError: WebAssembly.compile(): Wasm code generation disallowed by embedder`. workerd only runs WebAssembly that was uploaded as a module, never bytes compiled at run time.
- libauth builds its sha1, sha256, sha512, ripemd160 and secp256k1 from embedded wasm bytes with a top-level `await`. Imported statically, the Worker does not start: `Uncaught CompileError: WebAssembly.instantiate(): Wasm code generation disallowed by embedder ... at instantiateSha1 ... The Workers runtime failed to start.` Imported dynamically, the module loads but `secp256k1` and `sha256` are `undefined`, so every hash, signature, address and VM call fails (`buildSettle` failed on the first `derivePublicKeyCompressed`).
- `@noble/curves` and `@noble/hashes` work (ECDSA and Schnorr sign and verify).
- Outbound WebSockets work both ways: `new WebSocket('ws://...')` and `fetch(url, { headers: { Upgrade: 'websocket' } })` both reached a local Fulcrum (the simnet) and got `server.version` back. The worker uses the global `WebSocket` (as `src/chain/electrum.js` does in the browser and Node).

So, as planned for this case, nothing the Cloudflare adapters import touches libauth (`test/worker/runtime.test.js` walks their import graphs: only `@noble/*` packages, no `node:` modules, no Node adapter):

- **Crypto**: `@noble/hashes` (sha256) and `@noble/curves` (secp256k1). Notices are signed with **ECDSA, DER, low S, RFC 6979 deterministic nonces** (`OP_CHECKDATASIG` and `src/tx` `verifyRefundNotice` take it; a DER signature shorter than 70 bytes is re-made deterministically, since `src/tx`'s argument encoder takes 64, 70, 71 or 72 bytes). BCH Schnorr (not BIP-340) is only *verified* (for `'C'` notices the studio signs), written from the 2019 spec and pinned against libauth in `test/worker/crypto.test.js`.
- **Contracts**: the Escrow and BoxOffice redeem scripts are recomputed from each show's posted parameters and the compiled artifacts (`src/tx/artifacts.js`, plain data), exactly as `src/tx/contracts.js` does; a show whose `derived` redeem script, locking bytecode or script hash differs is refused (`worker/lib/shows.js`).
- **Transactions**: the worker's own codec (`worker/lib/tx.js`, CashTokens prefixes included) and settle/refund assembler (`worker/lib/escrow.js`) mirror `src/tx/builders.js`. `test/worker/assemble.test.js` pins them **byte for byte** against `buildSettle` and `buildRefund` over random shows and coin sets (1 to 100 coins, fee-owing and fee-free coins, ECDSA `'R'` and Schnorr `'C'` notices), runs the results through the libauth 2026 VM in standard and consensus mode, and pins the codec against libauth's on genesis, buy, hand-back, check-in, settle and refund.
- **The check before broadcast**: every settle or refund passes `worker/lib/rules.js` `checkEscrowSpend`, the Escrow contract's settle and refund rules written out again against coins the worker looked up itself: every input is a marker coin of that show at its Escrow, unlocked with that show's redeem script; each payout goes to its own coin's buyer at the coin's index, within the network-fee cap; a no-show fee is exactly the posted fee to the organiser at `k + i`; there is no other output; a settle's locktime is reached; each refund notice verifies for that show and seat. In Node the libauth VM runs as well (`worker/node/vm.js`). In workerd there is no VM; the rule check guards the worker's own assembler, and the BCHN node behind Fulcrum runs the real VM on broadcast (a transaction that fails it is refused, and nothing is lost).

`npm run worker:workerd-check` reruns the positive half on this machine: it starts a simnet with a studio catalogue (samples A and B and one real show), runs the real Pages Functions route with `wrangler pages dev` (with a local `DOOR_CLAIMS` KV namespace) and the real cron Worker with `wrangler dev --test-scheduled`, both in local workerd, and checks that `/api/health` lists no real show under the worker's key, that a sample B seat gets a notice that `src/tx` verifies and whose refund the simnet accepts, that a notice for sample A is refused, that the door gives the real show's link for a check-in on the simnet (again to the same caller) and refuses a hand-back, that a check-in reserved before it was sent is refused to an observer and answered to the reserving claim, and that one scheduled run refunds another B seat and settles a sample A ticket past its start plus grace. Result on 11/16 (rerun after the door's reservation): all six steps passed (notice answered in 15 ms wall time, door in 10 ms, reservation in 3 ms; the cron run sent 2 transactions). It kills every wrangler and workerd process at the end.

## 2. API (for the app)

Errors are `{ "error": { "code", "message", "retryable" }, "message" }` (the top-level `message` repeats `error.message` for clients that read only that). Every response has `cache-control: no-store`. Bodies are JSON, at most 2 KB.

### `POST /api/notice` (sample show B only)

Request: `{ "category": "<64 hex, display order>", "seat": "<6 hex>", "txid": "<64 hex, optional: the buy>" }`. Send the buy's `txid` when you have it: the signer then reads the buy straight from the network and answers at once (without it, it looks for the marker among the Escrow's unspent coins, which a server lists a moment after it sees the buy; the Pages adapter waits up to 4 s for that, under the page's 6 s request timeout, then answers a retryable 404).

200: `{ "scope": "R", "show", "category", "seat", "seatLabel": "B-0-12", "signature": "<hex DER>", "marker": { "txid", "vout", "height" } }`. Feed it to `addNotices(show, [{ scope: 'R', seat, signature }])` and `buildRefund` (src/shows, src/tx), check with `checkSignatureFree`, broadcast. Same request, same signature.

| Status | code | Meaning for the page |
|---|---|---|
| 400 | `bad-request`, `seat-notices-only` | a bug in the request; `scope` other than `R` is refused |
| 403 | `not-a-refund-seat-show` | the category is a show that is not sample B |
| 404 | `unknown-show` | not in shows.json |
| 404 | `no-live-marker` (retryable) | the network knows no buy of this seat (by `txid`), or, without a `txid`, no marker for it is unspent at the Escrow yet (or any more); retry a few times, then say "the keeper will refund it within minutes" |
| 413 | `too-large` | |
| 429 | `rate-limited` (retryable) | 30 per minute per IP; `retry-after` header |
| 503 | `signer-not-configured` (retryable), `signer-key-mismatch` | deployment problem; the keeper is the backup |

### `POST /api/door` (real shows only)

Two calls per walk-in, with the same `claim`: a random secret the page makes for this check-in and keeps with the ticket in local storage (the page sends 64 hex; the door takes 32 to 128).

**1. Reserve, before sending the check-in.** Request: `{ "category": "<64 hex>", "txid": "<the check-in's txid>", "claim": "<64 hex>", "reserve": true }`, sent once the wallet's signed check-in passed the page's checks (the page knows the txid; nobody else does yet) and before the page broadcasts it. No chain lookup. If the door has no record for this show and txid, it stores a hash of the claim (a reservation, which expires after 3 hours unless answered) and answers `200 { "reserved": true, "again": false }`; the same claim again gets `200 { "reserved": true, "again": true }`; any other claim gets `409 already-answered`. A page treats any failure here as non-fatal: it logs it and sends the check-in anyway (the door then falls back to "first caller wins").

**2. Ask, after sending it.** Request: `{ "category": "<64 hex>", "txid": "<the check-in's txid>", "claim": "<optional: 32 to 128 hex>" }`.

200: `{ "show", "seat", "seatLabel", "txid", "confirmed": false|true, "again": false|true, "link": "https://..." }`. **One claimant per check-in:** the claim that reserved it gets the link once the chain checks below pass (`again: false` the first time, `true` after). Without a reservation, the first caller gets it, and so does every later call from the same claimant: the same `claim` secret if the first call sent one, otherwise the same client IP. So a page that retries after a lost answer, or reopens later with its stored secret, still gets in. Anyone else (someone who only saw the txid, with another claim or none) gets `409 already-answered`, which a page should not retry.

Refusals (both calls): `400 bad-request` (`reserve` that is not `true` or `false`, a reservation without a `claim`, a malformed field), `404 unknown-show`, `403 not-a-real-show`, `404 no-door`, `409 already-answered`, `429` (20 per minute per IP, both calls counted together). The ask alone: `404 not-on-chain` (retryable: the network does not know the transaction yet), `422` with the rule that failed (`not-a-check-in`, `not-escrow` for a check-in of another show, `no-ticket`, `ticket-mismatch`, `ticket-moved`, `wrong-payee`, `short-payout`, `no-keepsake`, `fat-keepsake`, `missing-source`, `vm-invalid` in Node), `503 door-not-configured`.

### `GET /api/health`

`{ ok, service, api, network, runtime: "workerd"|"node", vm, config: { errors }, shows: { loaded, rejected }, signer: { configured, shows: [{ id, keyMatches }], alsoKeyOf: [real show ids whose data key is this key] }, door: { shows: [{ id, configured }] }, chain: { tip } }`. `alsoKeyOf` is empty for a catalogue the studio planned: real shows get the studio's second data key, which the worker never holds. It opens one Fulcrum connection (60 per minute per IP).

## 3. Keeper

`runKeeper({ shows, chain, dataKey, vmCheck, dryRun })` (`worker/lib/keeper.js`), one pass over every show in shows.json, from the chain tip and each show's live marker coins (`listunspent` at its Escrow, mempool counted; only immutable NFTs of the show's own category with an `'E'` commitment and at least `price + 1,000` sats; look-alikes and plain coins sent there are ignored, no path can spend them):

1. A valid `'C'` notice in shows.json: refund every coin under it.
2. `tip >= startHeight + graceBlocks`: settle every coin back to its buyer (locktime `startHeight + graceBlocks`, so it can be mined in the next block).
3. Kind `sample-refund-seat` before that: refund every coin with a fresh `'R'` notice (needs the data key).
4. Otherwise wait (`sales-open` or `grace`).

The keeper lists every show's coins first, six `listunspent` requests in flight over the same sockets (a catalogue of about 50 sample instances costs a few round trips). Batches hold at most 100 coins, coins that owe a no-show fee first. Every transaction spends only that show's marker coins (rule check), is VM-checked where the runtime can, then goes to two Fulcrum servers of different operators ("already known" counts as sent). Spent coins (also in the mempool) are not listed, so a second pass does nothing; a race with the page, the holder or another keeper ends as `conflict` and is fine. For sample B the page and the keeper build the very same refund (the notice signature is deterministic and the assembler matches `buildRefund` byte for byte), so whichever sends second is a no-op. `test/worker/keeper.test.js` pins all of this on simnet, including 130 coins settled in two batches with 26 exact fee outputs, nothing before `startHeight + graceBlocks`, a second pass that sends nothing, a race lost to a hand-back, and the page's refund equal to the keeper's.

## 4. Configuration and commands

Environment (Cloudflare `env`, `.dev.vars` locally; both gitignored where they hold values):

| Name | Where | Value |
|---|---|---|
| `STUDIO_DATA_KEY` | secret, Pages and cron | 64 hex: `data.privateKey` of `.secrets/studio.json` (the samples' data key). Never `realData`: that key is the real shows' and stays in the studio. |
| `DOOR_LINKS` | secret, Pages | JSON `{ "<show id>": "https://..." }`; `{seat}` and `{txid}` are filled in |
| `DOOR_CLAIMS` | KV binding, Pages (required before a real show sells) | the door's record (reservations and answers) across Cloudflare isolates; without it each isolate keeps its own record in memory. If KV fails (down, or over its write quota) the door falls back to that memory record and logs it |
| `SHOWS_URL` | var, cron | `https://<site>/shows.json` (`worker/wrangler.toml`) |
| `DOORSTUB_NETWORK`, `DOORSTUB_FULCRUM` | local tests only | `simnet` and its `ws://` URL. Unset means mainnet, which always uses the fixed server list in `src/chain/servers.js` and ignores `DOORSTUB_FULCRUM`. |

No request can change the network, the servers, the keys or the catalogue. Pages Functions read shows.json from the same deployment (`env.ASSETS`), so the API and the page always agree.

Local commands (simnet; nothing here touches mainnet):

```
npm run simnet -- --port 50021
npm run studio -- simnet-bootstrap --server ws://127.0.0.1:50021 --dir .cache/simnet-studio
npm run worker:dev -- --fulcrum ws://127.0.0.1:50021 --shows .cache/simnet-studio/public/shows.json --studio .cache/simnet-studio/studio.json --port 8788
npm run keeper -- --fulcrum ws://127.0.0.1:50021 --shows .cache/simnet-studio/public/shows.json --studio .cache/simnet-studio/studio.json --once
npm run worker:workerd-check
```

`worker:dev` serves `/api/*` (point the app's Vite `/api` proxy at it). With `--static app/dist` it also serves the built site and `/shows.json` (from `--shows`) on the same origin, as a Pages deployment does, which is what the simnet E2E wants; `--cors` lets a dev server on another port call it directly. In code: `startWorkerServer({ env, showsPath, port: 0, staticRoot, cors, htmlHeaders })` from `worker/node/server.js` returns `{ url, port, close }`; `createNodeWorker({ env, showsPath | showsText })` from `worker/node/handler.js` gives the same handlers in process, with a fetch-compatible `fetch(url, init)` for an API client under test. `env` is `{ DOORSTUB_NETWORK: 'simnet', DOORSTUB_FULCRUM: <simnet ws url>, STUDIO_DATA_KEY: <studio.json data.privateKey>, DOOR_LINKS: '{"<show id>":"https://..."}' }`; note `DOOR_LINKS` is keyed by show id. Both wait up to 4 s for a just-sent buy's marker (`markerWaitMs`; tests pass 0). `keeper` runs one pass (`--interval 300` to repeat, `--dry-run` to build and check only, `--json` for the full report). On `--network mainnet` the keeper CLI is a dry run unless given `--mainnet-broadcast`.

Deploying is the organiser's step, never an agent's. The checklist, from the repo root:

1. Pages project `doorstub`: `wrangler pages deploy app/dist --project-name doorstub` (run from the repo root, so `functions/` is bundled with the built site and `/api/*` goes to the worker). Secrets: `wrangler pages secret put STUDIO_DATA_KEY --project-name doorstub` (the `data.privateKey`, never `realData.privateKey`) and, once a real show sells, `DOOR_LINKS`. Before a real show sells, create a KV namespace (`wrangler kv namespace create DOOR_CLAIMS`) and bind it to the Pages project as `DOOR_CLAIMS` in the dashboard (Settings, Functions, KV namespace bindings).
2. Check `https://doorstub.pages.dev/api/health`: `network` mainnet, `config.errors` empty, `signer.shows[].keyMatches` true for sample B, `signer.alsoKeyOf` empty, `door.shows[].configured` true for each real show, a `chain.tip`.
3. Cron Worker: `wrangler deploy --config worker/wrangler.toml`, then `wrangler secret put STUDIO_DATA_KEY --config worker/wrangler.toml`. It has no URL; `wrangler tail --config worker/wrangler.toml` shows each run's one-line report.
4. Before relying on the cron, `npm run keeper -- --network mainnet --shows app/public/shows.json --studio .secrets/studio.json --once` is a dry run against mainnet (reads only; it builds and checks what the keeper would send).

Measured CPU on this Mac (Node, warm): parsing a 50-show shows.json about 2.6 ms (once per change per isolate), signing a notice 0.2 ms, verifying one 0.8 ms; the curve table (about 12 ms) is built when the module loads, not in a request. Check real numbers with `wrangler tail` after deploying; if a free-plan CPU limit is hit, a paid Workers plan raises it.

## 5. Abuse review

**What can anyone make the signer sign?** Only `'R' | category | seat` (36 bytes), only for the category of a show of kind `sample-refund-seat` in our own shows.json, only when the configured key is that show's `organiserDataPk`, and only for a seat whose buy the network knows: either the caller names the buy's `txid` and the signer reads that transaction from the network and finds the seat's marker output in it, or the marker is unspent at the Escrow (mempool counted). The `txid` path does not check that the marker is still unspent, so it also signs for a seat that was already handed back or refunded (`test/worker/notice.test.js` pins this); that notice opens nothing, since the coin is gone and seat numbers never repeat. It never signs `'C'`, never a message for another show, and never caller-supplied bytes. Why that is harmless:

- An `'R'` notice can only make `Escrow.refund` pay that one seat's coin to the buyer recorded in its marker, minus at most `minerFeeCap` of network fee that nobody can keep (SPEC 3.2, C6). It cannot redirect money, and sample show B's organiser refunds every seat anyway: that is the sample's whole promise.
- The category is inside the signed message, so the notice cannot open a coin of any other show, even though every sample show shares the same data key (pinned: `test/worker/notice.test.js` tries another seat's notice on a coin and the VM refuses). Real shows do not share it at all (below, "The data keys").
- Seats that were never sold get no notice (no marker), so nothing can be pre-signed. A notice for a seat whose coin is already refunded opens nothing.
- Signatures are deterministic (RFC 6979), so repeated requests give the same bytes and leak nothing new; there is no nonce to get wrong.
- A stranger who buys a sample B seat is refunded to their own address, as the card says.

**The door.** A check-in's txid is public once it is relayed: anyone watching a real show's Escrow (its script hash is in shows.json) sees it in the mempool. So the door gives the link to one claimant per check-in, and the holder's page claims it before anyone else can know the txid: once the wallet's signed check-in passed the page's checks, the page reserves that txid with its `claim` secret, and only then sends it. The reservation needs no chain lookup and holds only a hash of the claim. After sending, the page asks with the same claim and gets the link once the chain checks pass; an observer who asks with another claim, or none, gets `409` (`test/worker/door.test.js` reads the txid from the simnet's mempool as an observer would). A reservation the door never answers expires after 3 hours, so one made for a check-in that was never sent does not stay; an answered one is kept 120 days, so the holder can come back for the link. A page whose reservation failed still sends; the door then gives the link to the first caller, as before reservations, and later calls from that caller (its `claim`, or without one its IP) get it again.

What this guarantees, and what it does not:

- The record is per isolate in memory, or across Cloudflare in the `DOOR_CLAIMS` KV namespace when bound. Bind it before a real show sells: without it, an observer whose request lands on another isolate does not see the holder's reservation. KV is eventually consistent: a write is visible at once where it was made and usually within seconds elsewhere, but Cloudflare promises only "up to 60 seconds or more", so an observer at another Cloudflare location who asks within that time could still win. If KV fails, the door uses the isolate's memory record (logged) rather than stop answering.
- The door trusts nothing the caller sends besides the txid and the claim: the check-in and the coins it spends are read from the network and hash-checked, and must satisfy the Escrow check-in rules for this show. In Node the libauth VM checks the holder's signature too (`test/worker/door.test.js` serves a check-in with a broken signature from a lying chain: Node refuses it as `vm-invalid`; rules alone pass it). In workerd there is no VM, so the door relies on the network having accepted the check-in (it is in the mempool or a block, which means BCHN ran every script).
- It reads that from one Fulcrum server of the fixed list and accepts a check-in that is not confirmed yet. So a holder who sends a check-in to one server and a conflicting hand-back to the rest of the network could get the link and, if the hand-back is mined, the refund too; and a malicious server in the list could invent a check-in (its bytes would hash to the txid it invents) and open the door for a seat that never walked in. Either costs nobody money (the contracts are untouched; only the event link leaks). Requiring a confirmation, or the same answer from two servers of different operators, would narrow this at the price of slower or flakier walk-ins; for an event link we chose not to, and `CLAIMS.md` limit 17 says so.
- Per-seat links (`{seat}`, `{txid}`) let the organiser's event platform admit each seat once. It never broadcasts.

**The keeper** builds only settle and refund, which need no key except the data key for `'R'` notices of sample B. It spends only marker coins of each show's Escrow (rule check; pinned on simnet by reading every input back), so a griefer who sends look-alike tokens or plain coins to an Escrow changes nothing: they are ignored and stay stuck (SPEC 8). Anyone can push the same settles and refunds; a race costs nothing.

**Denial of service.** Per-IP limits (notice 30, door 20, health 60 per minute) are per isolate on Cloudflare; Cloudflare's rate-limiting rules can back them. Every request opens at most two Fulcrum connections and closes them at the end (a reservation opens none). A down signer costs only speed: the keeper refunds B seats on its next run (within about 5 minutes). A reservation is a KV write that needs no check-in, so someone with many IPs could use up a free KV plan's daily writes (1,000 a day); the door then falls back to each isolate's memory record (weaker, as without KV) until the quota resets. A paid Workers plan raises the quota.

**Configuration.** Requests cannot change the network, Fulcrum servers, keys or catalogue. A mainnet worker always uses the fixed server list; before any broadcast it asks each server for its chain's genesis hash and refuses a server that does not serve BCH mainnet (and a simnet worker refuses one that does). shows.json is refused when it is for another network, and any show whose posted `derived` scripts differ from the recomputed ones is dropped.

**The data keys.** `STUDIO_DATA_KEY` sits in the Pages and cron environments. It is the samples' data key: if it leaked, its holder could sign `'C'` notices for the sample shows and refund their unused tickets to their buyers, which moves money only back to buyers and is what the samples do anyway. Real shows use a second data key (`realData` in `.secrets/studio.json`), which `keygen` makes and `plan` uses for kind `real`, and which no worker ever holds, so a leaked worker secret cannot refund a real show's unused tickets and cost its organiser the payments of guests who have not walked in yet. `/api/health` lists any real show whose data key is the worker's (`signer.alsoKeyOf`); for a catalogue the studio planned it is empty (`test/worker/notice.test.js`, `adapters.test.js`, `npm run worker:workerd-check`). The worker needs no key for real shows at all: their unused tickets refund by settle, and a cancel would be a `'C'` notice signed with the real-show data key and added to shows.json (the studio has no command for that yet).
