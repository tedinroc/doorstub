# Doorstub architecture

Doorstub is an event box office on Bitcoin Cash: tickets that refund themselves. Ticket money waits in a contract coin per ticket. The organiser is paid only when the holder's own wallet checks in; every other ticket goes back to its buyer. This page is the whole system on one page. Exact rules are in `SPEC.md`; every public sentence and limit is in `CLAIMS.md`.

## Components

| Part | Where | What it does | Holds keys? |
|---|---|---|---|
| Contracts | `contracts/BoxOffice.cash`, `contracts/Escrow.cash` (CashScript 0.14, P2SH32) | BoxOffice sells seats (one minting NFT per shard, several shards per show). Escrow holds each ticket's money as one coin with a marker NFT, and lets it out by exactly four paths. | No |
| Transaction builders | `src/tx/` | Pure functions that build buy, hand back, check in, settle, refund, close sales and genesis, and run them through the 2026 BCH VM. | No |
| Client libraries | `src/chain/`, `src/wallet/`, `src/shows/` | Fulcrum client (8 pinned mainnet servers, failover, broadcast to two), WizardConnect wallet session (sign requests with `broadcast: false`), `shows.json` loader that recomputes every contract address and verifies each show's genesis on chain. | No |
| Site | `app/` (Vite + Preact, Cloudflare Pages) | The judge-facing page: show cards (a real show's call in the reader's own time zone), connect dialog, ticket cards, My tickets, proof strip, For organisers, Check it yourself. Builds every transaction, has the wallet sign it, checks the reply, broadcasts it. Before it sends a check-in it reserves that check-in at the door. | No |
| Worker | `worker/` (Pages Functions on the site's origin, a cron Worker every 5 minutes, a Node adapter for tests) | `/api/notice` signs per-seat refund notices for sample show B only. `/api/door` gives a real show's call link to the page that reserved the check-in before sending it, after it reads that check-in from the network. The keeper settles started shows and refunds sample B seats. | The samples' data key (refund notices) and the call links |
| Studio | `studio/` (organiser's CLI) | Keys, plan, genesis of each show (with BCMR metadata so wallets show "Doorstub ticket: ..." and the seat label), close sales. Writes `shows.json`: each show's parameters, and for a real show its call time, length and seat letter. Nothing is sent without `--broadcast`, and on mainnet only after typing `BROADCAST`. | Sales key, the samples' data key, a second data key for real shows that the worker never holds (in `.secrets/`, never committed) |
| Simnet | `simnet/` | A local Fulcrum-compatible chain that runs every broadcast through the 2026 VM. Every test and `npm run e2e` run on it. | Test keys only |

## Money flow

```
 buyer's wallet ──buy (wallet signs)──► BoxOffice shard (sold + 1)
                                  ├──► ticket NFT 'T'|seat|buyer ──► buyer's address
                                  └──► escrow coin: price + 1,000 sats, marker NFT 'E'|seat|buyer ──► Escrow address
                                                          │
           exactly one of these four spends it:           │
   check in   holder's wallet signs ──────────────────────┼──► organiser (ticket stays as a keepsake)
   hand back  holder's wallet signs ──────────────────────┼──► buyer (ticket burned)
   settle     anyone, from start + grace, no key ─────────┼──► buyer
   refund     anyone, with the organiser's signed notice ─┴──► buyer
```

Each path pays the output at the coin's own input index, so many coins can share one transaction without one output paying for two coins. At most `minerFeeCap` sats of a coin (1,500 on the samples) can go to the network fee; no path allows an output that could keep the rest.

## Who can do what

| Who | Can | Cannot |
|---|---|---|
| Ticket holder | Check in (pays the organiser), hand back (refund) | Take the organiser's payout; check in without the ticket at the buyer's address |
| Organiser | Receive check-in payouts; close sales (sales key); sign refund notices that send money back to buyers (data keys) | Collect after the start; redirect any ticket's money anywhere but its buyer; check anyone in |
| Anyone (the page, the keeper, a stranger) | Push a settle after start + grace; push a refund under a valid notice | Change where the money goes; keep the fee allowance |
| Doorstub worker | Sign `'R'` notices for sample B seats (its code signs nothing else: no whole-show `'C'` notice, no other show); hand out call links; push settles and refunds | Move money anywhere but back to buyers; sign anything for a real show (it does not hold that key) |

## What the chain enforces and what the app enforces

The contracts enforce: where each path's money goes (buyer, or organiser only on check-in); that only the holder's key can check in or hand back; the keepsake on check-in; the settle time lock (`startHeight + graceBlocks`); the refund notice's signer, scope and seat; the fee cap and the exact posted fees; one marker per ticket of the show's own token category; no "organiser collects" path.

The app (and the builders) enforce what the chain cannot: sales end at `startHeight` and after a cancel (a cancelled show offers no walk-in either), and a real show's sales and walk-in when its call ends by the reader's clock (checked again right before the page sends a buy or check-in the wallet approved) (its `startHeight` is set hours later, because blocks can come early); each show's genesis is verified on chain before it is offered; show parameters are within policy (fees at most 10%, fee cap 1,200 to 2,000 sats); a wallet reply is sent only if its outputs are byte-equal to what was asked, contract inputs are untouched, every wallet signature is `SIGHASH_ALL` (0x41 or 0x61) and the whole transaction is valid in the 2026 VM with our own source outputs; the production page talks only to the pinned servers, the two WizardConnect relays, two price APIs (CoinGecko and Coinbase, for the dollar estimate only) and its own origin (no URL can point it elsewhere). What the page reads from the chain is one pinned server's word (no merkle proof), which can mislead the display but not move money (`CLAIMS.md` limit 18). The door's call link is off chain: the page reserves the check-in at the door before sending it, then the worker reads the check-in from the network and gives the link to that page only (`CLAIMS.md` limit 17).

## The judge path

1. Pick Sample show A, B or a real show; Get a ticket; scan the QR or open Selene, Paytaca or Cashonize (WizardConnect).
2. Approve one transaction; the ticket card shows the seat and the contract coin holding the money.
3. Sample A: hand it back, or wait: it settles back after the start. Sample B: the organiser's refund notice arrives and the money comes back with no second approval. A real show (an online screening; its card gives the call's time in the reader's zone, and its seats carry its own letter, `S-0-1` at the first screening): Walk in pays the organiser, the page shows the call link and the ticket stays as a keepsake.
4. The proof strip counts every buy, hand-back, check-in, settle and refund at the shows' contract addresses, read live from the chain.

`npm test` runs the contracts, attacks, libraries, studio, worker and site logic (no browser). `npm run e2e` drives this path in headless Chrome on simnet with the real worker and keeper and checks each step in the page and on the chain; during the walk-in a front-runner polls the real show's Escrow mempool and asks the door the moment the check-in appears, and gets 409 while the page gets the link.
