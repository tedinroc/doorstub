# Doorstub studio

The organiser's command line. It makes the studio keys, plans the shows, sends each show's genesis, closes sales and reports what happened on chain. It writes `app/public/shows.json` (the app's list of shows) and `app/public/bcmr/<category>.json` (wallet metadata).

```
npm run studio -- <command> [options]      # npm run studio -- help
```

**Nothing is sent without `--broadcast`.** On mainnet, `--broadcast` prints every show, every transaction and the total cost, and sends only after you type `BROADCAST` in an interactive terminal. `--network` defaults to `simnet`.

## Keys

`keygen` writes `.secrets/studio.json` (gitignored, mode 600) and refuses to overwrite it. Back it up. Three keys:

- **sales**: the organiser key in every show (`organiserPk`); signs `closeSales`; its address is the studio's funding address.
- **data**: signs refund notices (`organiserDataPk`). The worker gets a copy as `STUDIO_DATA_KEY` (`data.privateKey`). It can refund buyers, never redirect money.
- **identity**: holds each show's BCMR identity output (genesis output 0). Never spend those coins: they keep each show's wallet metadata in place.

## Mainnet, step by step (the user runs these)

1. `npm run studio -- keygen` and send some BCH to the printed funding address. Each show costs about 5,900 sats (4 shards and the identity output at 1,000 sats each, plus about 900 sats of miner fees for its prep and genesis).
2. `npm run studio -- plan --network mainnet --payee <your P2PKH address> --first-start <height> --count <n>`. Default catalogue: `n` "Sample show A" instances every 36 blocks (price 100,000 sats, grace 2 blocks, no fees, `minerFeeCap` 1,500, 4 shards) and one "Sample show B" about 45 days out (`--refund-seat-start`, or `--no-refund-seat`). Real shows: `--schedule shows.json` with `[{ id, title, card, startHeight, price, ... }]`. Heights may be `+blocks` from the tip. `studio/screenings.example.json` holds the two planned screenings (card text in `CLAIMS.md` section 6); their `startHeight` is about the end of each call plus 6 blocks, estimated from block 977,577 at 06:28 UTC on 16 Nov at ten minutes a block, so recompute it from the tip on the day you plan. The worker needs each screening's call link in `DOOR_LINKS` under its `id` (`worker/RUNTIME.md` section 4).
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

`shows.json` entries carry `params` (hex keys, `category` in display order, integers), `genesisTxid`, and `derived` (both contracts' addresses, token addresses, locking bytecode, redeem scripts and Electrum script hashes). `derived` is a convenience for runtimes without libauth; anything that can must recompute it from `params` (`validateShowsJson` does).
