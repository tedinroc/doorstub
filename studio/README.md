# Doorstub studio

The organiser's command line. It makes the studio keys, plans the shows, sends each show's genesis, closes sales and reports what happened on chain. It writes `app/public/shows.json` (the app's list of shows) and `app/public/bcmr/<category>.json` (wallet metadata).

```
npm run studio -- <command> [options]      # npm run studio -- help
```

**Nothing is sent without `--broadcast`.** On mainnet, `--broadcast` prints every show, every transaction and the total cost, and sends only after you type `BROADCAST` in an interactive terminal. `--network` defaults to `simnet`.

## Keys

`keygen` writes `.secrets/studio.json` (gitignored, mode 600) and refuses to overwrite it. Back it up. Four keys:

- **sales**: the organiser key in every show (`organiserPk`); signs `closeSales`; its address is the studio's funding address.
- **data**: signs refund notices for the sample shows (their `organiserDataPk`). The worker gets a copy as `STUDIO_DATA_KEY` (`data.privateKey`). It can refund buyers, never redirect money.
- **realData**: the `organiserDataPk` of every real show. It never leaves this file: never give it to the worker. If the worker's secret leaked, it could then refund only the samples, not a real show's unused tickets (which would cost the organiser the payments of guests who have not walked in yet). `/api/health` `signer.alsoKeyOf` must be empty. A studio file made before this key existed gets one with `npm run studio -- keygen --add-real-data-key` (the other keys stay).
- **identity**: holds each show's BCMR identity output (genesis output 0). Never spend those coins: they keep each show's wallet metadata in place.

## Mainnet, step by step (the user runs these)

1. `npm run studio -- keygen` and send some BCH to the printed funding address. Each show costs about 5,900 sats (4 shards and the identity output at 1,000 sats each, plus about 900 sats of miner fees for its prep and genesis).
2. `npm run studio -- plan --network mainnet --payee <your P2PKH address> --first-start <height> --count <n>`. Default catalogue: `n` "Sample show A" instances every 36 blocks (price 100,000 sats, grace 2 blocks, no fees, `minerFeeCap` 1,500, 4 shards) and one "Sample show B" about 45 days out (`--refund-seat-start`, or `--no-refund-seat`). Real shows: `--schedule <file>` with `[{ id, title, subtitle, card, eventAt, durationMin, seatPrefix, price, ... }]`. A real show names its event: `eventAt` (when it starts, ISO 8601 UTC ending in `Z`), `durationMin` (1 to 600) and `seatPrefix` (its seat letter: one capital letter, not A or B, one per real show). Heights may be `+blocks` from the tip. `studio/screenings.example.json` holds the two planned screenings (card and subtitle text in `CLAIMS.md` section 6; seat letters S and T).

   **startHeight of a real show.** The page sells a real show's tickets and offers Walk in until its event ends, by the reader's clock. Sales also end at `startHeight` (in the app and the builders; BCH cannot stop a sale on chain, CLAIMS limit 14), so it must come after the event ends even when blocks come early. Leave `startHeight` out of the schedule (as the example does) and `plan` computes it: the tip, plus the minutes from now until the event ends at ten minutes a block (rounded up), plus a margin of 24 blocks and 5% of those blocks (`blocksAfterCall` in an entry sets a fixed margin instead). A real show's `graceBlocks` defaults to 144, so settling opens about a day after `startHeight`. Why: replayed over 200 days of mainnet headers and planned 1 to 8 days ahead, a flat 6-block margin closed sales before the event ended about 30% of the time; this margin about 2 to 3%, and with the 144-block grace settling never opened before the event ended. Blocks still drift, so run `plan` right before `genesis`, as close to the event as you can, and read what it prints for each real show (`call ... ; sales end at block N, about M min after the call ends; settling opens at block K, ...`). If it says `WARNING`, drop `startHeight` from the schedule or raise it (or raise `graceBlocks`). `plan` refuses a real show whose event is already over, with or without `startHeight` (the page would never offer it). By hand: `n = ceil((eventAt + durationMin - now) / 10 min)`, `startHeight = tip + n + 24 + ceil(n / 20)`, with the tip from `npm run studio -- status --network mainnet` or any explorer. The worker needs each screening's event link in `DOOR_LINKS` under its `id` (`worker/RUNTIME.md` section 4). For the screenings that link is the screening room's template, the same string for every show: `https://doorstub.pages.dev/room/#show={show}&seat={seat}&txid={txid}&pass={pass}&m={media}` (`worker/RUNTIME.md` section 2), so `DOOR_LINKS` is `{ "<show id>": "<that template>", ... }` with one entry per screening id. The door fills every `{...}` itself, `{show}` with its own show id; keep the five fragment keys exactly as written, or the worker reports a config error. `{pass}` and `{media}` need `ROOM_KEY`, so set it first (`wrangler pages secret put ROOM_KEY --project-name doorstub`, the 64 hex of `.secrets/room.json`, `{ "ROOM_KEY": "<64 hex>" }`), then `wrangler pages secret put DOOR_LINKS --project-name doorstub`, and deploy again: a secret applies only to a new deployment.
3. `npm run studio -- genesis --network mainnet` (dry run; preview in `.cache/studio/genesis-preview.json`), then `... --broadcast` and type `BROADCAST`. It writes `app/public/shows.json` and the BCMR files only for genesis transactions that were accepted. Run it again with a longer plan to add shows; shows already in `shows.json` are skipped.
4. Wait for one confirmation (`npm run studio -- status --network mainnet`) before publishing: clients refuse an unconfirmed genesis.
5. Deploy the site with the new `shows.json` and `bcmr/` files. The BCMR file must be served byte for byte as written, at `<origin>/bcmr/<category>.json`; the genesis commits to its hash. The registry points wallets at `<origin>/bcmr/icon.png` (`--icon-path` to change), which the site must serve.
6. When a show starts: `npm run studio -- close --network mainnet --started --broadcast` closes every open shard of every started show (the app already stops selling at the start; this makes it final on chain).

## Simnet

```
npm run simnet                                   # in one terminal
npm run studio -- simnet-bootstrap               # keys, funding, plan, genesis, one block, in .cache/simnet-studio/
npm run studio -- status --shows .cache/simnet-studio/public/shows.json
```

In code: `bootstrapSimnet({ server, dir, count, firstStart, refundSeatStart, schedule })` from `studio/index.js` returns `{ secretsPath, planPath, showsPath, studio, plan }`; every command is also a function (`keygen`, `makePlan`, `genesis`, `close`, `status`).

## What genesis builds

Per show: a prep transaction (studio coins to the studio address at output 0, change chained to the next prep), then the genesis spending that output 0 (so the prep's txid is the category): output 0 the identity output, outputs 1-N the open box-office shards, then `OP_RETURN 'BCMR' <sha256 of the registry file> <origin host>/bcmr/<category>.json`. Both are signed with the sales key, both pass the 2026 VM in standard and consensus mode, and the genesis passes `verifyGenesis`. The registry revision is the plan's `createdAt`, so the dry run shows exactly the transactions `--broadcast` sends.

`shows.json` entries carry `params` (hex keys, `category` in display order, integers), `genesisTxid`, `derived` (both contracts' addresses, token addresses, locking bytecode, redeem scripts and Electrum script hashes) and, for a real show, `eventAt`, `durationMin` and `seatPrefix`. `derived` is a convenience for runtimes without libauth; anything that can must recompute it from `params` (`validateShowsJson` does).

The registry's NFT parse script gives four fields a wallet shows: the show's seat letter (fixed per registry: A and B for the samples, `seatPrefix` for a real show), the box office (shard number), the seat number and the buyer key hash. The first three are the site's seat label, `S-0-1`.
