# Doorstub: public claims (draft)

Draft of 11/16. This file is the source for every public sentence about Doorstub: the site, the README, the deck and the video. Each claim names the rule that makes it true (see `SPEC.md`) and the tests that pin it. If a sentence is not here, do not publish it.

**Status today.** The contracts, the transaction builders, the attack suite, the sign-only wallet probe, the client libraries (chain, wallet, shows), a local test chain (simnet), the organiser's studio CLI, the worker (refund-notice signer, door, settle keeper; `worker/RUNTIME.md`) and the site (`app/`) exist, and the whole judge path runs end to end on simnet in a real browser with the real worker and keeper (`npm run e2e`, `ARCHITECTURE.md`), including a real show's walk-in raced by a front-runner who watches the mempool (limit 17). Nothing is on mainnet and nothing is deployed: no show has been created on mainnet, and the two real shows (online screenings, section 6) are planned, not created. Before the site goes live, the banner needs its presentation link and donation address (the production build refuses to build while either is empty), and the door needs its `DOOR_CLAIMS` KV namespace before a real show sells (`worker/RUNTIME.md`). A claim marked *(not built yet)* or *(not deployed yet)* must not be published in the present tense until it ships.

## 1. Headline

> Tickets that refund themselves. The organiser is paid for each guest who walks in. Every other ticket refunds.

It is true as written because of three contract rules:

1. The organiser receives a ticket's price only through `checkIn`, and only the ticket holder's own wallet can sign a check-in (`SPEC.md` 3.2).
2. After the show plus a grace period, `settle` pays every coin that was not checked in back to its buyer. Anyone can send that transaction; it needs no key.
3. There is no "organiser collects after the start" path. A show that never happens has no check-ins, so every ticket refunds.

Small print that must sit next to the headline wherever there is room:

- "Refunds return the same BCH, minus a network fee of at most N sats and any fee the organiser posted on the show page." (N is the show's `minerFeeCap`, 1,200 to 2,000 sats; the samples use 1,500.)
- "Someone has to send the refund transaction. Anyone can, without a key, and Doorstub's keeper does it for you." *(Keeper built and tested on simnet and in local workerd, `test/worker/keeper.test.js` and `npm run worker:workerd-check`; not deployed yet.)*

## 2. Claims we make

| # | Claim (exact public wording) | Why it is true | Pinned by |
|---|---|---|---|
| C1 | Your ticket money waits in a contract, not with the organiser. | `buy` must send `price + 1,000` sats to the show's Escrow address with a marker for your seat. No Escrow path pays the organiser except `checkIn` and the posted fees: every Escrow transaction may hold only its pinned payout and fee outputs (`SPEC.md` 3.2, slot rule), and a fee output must equal the posted fee. | `attacks-boxoffice`: escrow short by 1 sat, marker coin kept by the buyer or sent elsewhere; `attacks-escrow`: organiser cancels and pays himself, fee output padded above the posted fee |
| C2 | The organiser is paid when you check in, and your own wallet signs the check-in. | `checkIn` requires the ticket as an input at your own address, so your key must sign it. The organiser cannot check you in. | `attacks-escrow`: check-in by a non-holder, forced by the organiser without the holder's key, payout redirected |
| C3 | If you do not use your ticket, it refunds after the show. | `settle` opens at block `startHeight + graceBlocks + 1` and pays your address. Anyone can push it. | `happy`: settle batch; `attacks-escrow`: settle one block early, payout to the pusher |
| C4 | Until you walk in or the show settles, you can hand your ticket back for your money, minus the hand-back fee shown on the show page. | `handBack` burns your ticket and its marker and pays your address. | `attacks-escrow`: hand-back by a non-holder, fee above the posted rate, refund redirected |
| C5 | If the organiser cancels, anyone can push the refunds, up to 100 tickets per transaction. | `refund` with the organiser's signed `'C' + category` notice pays every buyer; refunds batch, and the builder caps a batch at 100 coins (about 88,500 bytes, under the 100,000-byte relay limit). | `happy`: refund C batch; `attacks-escrow`: wrong scope, another show, another seat; `limits`: 100-coin refund |
| C6 | The organiser's key can refund your money. It can never send it anywhere else; at most N sats of your ticket can go to the network fee. | A refund takes only escrow coins and may have no output but each coin's payout to `P2PKH(buyerPkh)` at its own index, at most `minerFeeCap` below the coin's value. The rest can only be miner fee. | `attacks-escrow`: refund to the pusher, organiser cancels and pays himself, extra output, an outside coin added, organiser-buyer's payout above his coin, double satisfaction |
| C7 | A refund goes only to the address that bought the ticket. | The marker records the buyer's key hash at purchase; a refund or settle may have no output but each coin's payout to that address (and, in a settle, the posted no-show fee). | `attacks-escrow`: refund or settle paid to the pusher, extra outputs; ticket moved away still refunds its buyer (LIMIT pin) |
| C8 | Your ticket is an NFT in your own wallet. After check-in it stays there as a keepsake stub with no money behind it. | `checkIn` returns the ticket's exact commitment to your address and burns the marker. | `attacks-escrow`: keepsake missing, sent elsewhere, re-labelled |
| C9 | Every contract path and 143 attack tests run in the 2026 BCH virtual machine, in standard and consensus mode, and the virtual machine refuses every attack in them. | `npm test`: 414 tests at this commit, 411 passed and 0 failed; the 3 skipped need the internet (`DOORSTUB_NET=1`). The 143 are the attack tests whose transactions the VM must refuse in both modes (`attacks-boxoffice` 47, `attacks-escrow` 93, `genesis` 3). Not counted in the 143: 13 attacks refused before the VM (12 by `verifyGenesis`, 1 by the commitment encoder), 11 honest controls, 7 `LIMIT` pins accepted on purpose and 1 kit self-check in the same files; 11 happy paths; 3 sanity checks; 11 policy tests; 5 limit measurements; 20 probe tests; 2 genesis identity-output tests; 92 client-library tests (`test/chain` 36, `test/wallet` 34, `test/shows` 22); 23 simnet tests; 9 studio tests (7 for keys, plans, the BCMR parse and genesis on simnet, and 2 that keep the studio's card texts and BCMR wording equal to this file); 2 simnet integration tests (studio catalogue to wallet buy, hand-back, settle and notice refund; the site's controller with the real worker: notice signer, the door's reservation before the check-in and one claimant per check-in, one keeper pass); 31 site tests (`test/app`: the controller on simnet, view models, worker client, runtime switches, CSP, wording); 30 worker tests (`test/worker`: the worker's settle and refund byte-equal to `src/tx` and valid in the VM, its signatures against libauth, its shows.json loader against `src/shows`, the notice signer, the door's reservation and answer and the keeper on simnet, the Cloudflare adapters and the Node adapter's single origin). Update the numbers whenever the tests change. Not in `npm test`: `npm run e2e` (headless Chrome through the judge path on simnet, 139 checks, among them a front-runner that polls the real show's Escrow mempool and asks the door the moment the check-in appears). | `test/`, `probe/test/` |
| C10 | Works with your own wallet over WizardConnect. Doorstub never holds your money or your keys. | The site only asks the wallet to sign; contracts hold the money. | Name a wallet only after the probe passes on it (`PROBE.md`). The 11/16 sign-only probe passed buy, hand-back and check-in on Selene, Paytaca and Cashonize (Schnorr, sighash `0x61`); OPTN is untested. The site itself has not been used with a real wallet on mainnet yet *(not deployed yet)*. |

## 3. Words we do not use

- **"First", "new", "the only", "never been done".** False. See section 5.
- **"Before the show."** BCH cannot enforce a deadline. Say "until you walk in or the show settles".
- **"Full refund"** on its own. Always add "minus the network fee and any posted fee".
- **Dollar amounts as a promise.** Prices are in BCH. A dollar figure is today's rate only.
- **"Your seat goes back on sale"** after a hand-back. False: the seat counter only grows.
- **"Automatic"** without saying who sends the transaction.
- **"Trustless entry"** or anything that promises you will get in. The contract pays the organiser when you check in; whether the door then lets you in is between you and the organiser.

## 4. Limits we state

These go on the show page, in the README and in the deck, in plain words.

1. **Prices are in BCH.** A refund returns the same BCH, not the same dollars.
2. **"Before the show" cannot be enforced.** Hand-back and check-in work for as long as the ticket's money is still in the contract, even after the start. After `startHeight + graceBlocks`, whoever moves first (the holder, or anyone settling) decides the path.
3. **Hand-backs do not free a seat.** v1 shows have no seat cap, so this cannot lock a show up.
4. **The organiser key can refund money but never redirect it.** A per-seat (`'R'`) or whole-show (`'C'`) notice sends money back to buyers only. Up to N sats of each ticket may go to the network fee; whoever sends the refund decides how much of that allowance to use, and nobody can keep it. A `'C'` notice also refunds seats sold after it was signed.
5. **A ticket moved away from the buyer's address** can no longer check in or hand back. Settle still refunds the original buyer, so a gifted ticket's refund goes to the giver.
6. **The network-fee allowance can be burned, not kept.** Whoever sends a settle or refund (anyone), and the holder in a hand-back or check-in, sets the network fee, up to `minerFeeCap` of each ticket. No path allows an output that could take the rest, so a griefer can burn the allowance but cannot pocket it; a sender who mines the block, or gets a rebate from a miner, could collect it. The app accepts a cap of 1,200 to 2,000 sats and at most 20% of the price (a check-in, the largest transaction, is about 1,066 bytes); the samples use 1,500. The show page must state the cap.
7. **Posted fees.** The organiser may post a hand-back fee and a no-show fee, in basis points of the coin's value (0 on the samples). Fees under 546 sats are waived; a fee that is due is paid exactly. The app refuses a show with either fee over 10% (1,000 bps). The contract does not range-check them (a show deployed by hand could post more), so the app must show both fees.
8. **Check-in is final.** Once you check in, the organiser has the money.
9. **Buyers need BCH already.** There is no card or cash door.
10. **The app must verify the show's genesis transaction** (`verifyGenesis`), taken from its own node rather than the show page and confirmed on chain. The box office only sells tickets of the show's own token, so no genesis and no stranger can lock or take a buyer's money; a malformed genesis can still repeat seat numbers, so the app refuses a show whose genesis fails the check, or whose fees or network-fee cap are outside the bounds in 6 and 7.
11. **Your wallet must sign with `SIGHASH_ALL`** (0x41 or 0x61). The app must check every wallet signature and refuse anything else (the probe already does). That only helps because the app asks the wallet not to broadcast and sends the checked transaction itself; the probe never broadcasts at all.
12. **A check-in is a transaction of its own** (your ticket and its money in, the payout and your keepsake out), and two buyers on the same box-office shard at once means one of them signs again.
13. **Coins sent straight to a contract address without the right token are stuck for good.** Only use the app.
14. **Sales end in the app, not on chain.** BCH cannot stop a sale after the start. The app refuses to sell at or after the start or after a cancel (and a real show's tickets once its call ends, by the reader's clock), and the organiser's app closes every box-office shard at the start. Someone who buys late with other software can be settled at once and loses the no-show fee plus up to N sats of network fee (up to N sats after a cancel).
15. **Batches.** Anyone can settle or refund up to 100 tickets per transaction; a bigger show takes several. A buy takes at most 50 of your coins.
16. **Network fees are paid from each ticket's allowance.** Hand-back, check-in, settle and refund transactions cannot take a coin from anyone else to pay the network fee. If network fees ever rose above about 1.1 sat per byte (the exact level depends on the show's cap), those transactions would wait until fees fell.
17. **The event link of a real show is off chain.** The contract pays the organiser when your wallet checks in; the link to the call comes from Doorstub's door. Before your page sends the check-in, it reserves that check-in at the door with a secret it keeps. After sending, it asks with the same secret, and the door gives the link once it has read your check-in from the network. Someone who sees your check-in in the mempool and asks the door gets nothing: one claimant per check-in (`SPEC.md` section 12; `test/worker/door.test.js` with an observer that reads the mempool, and `npm run e2e` with a front-runner that polls the show's Escrow mempool and asks before the page does). The reservation is kept 120 days, so it does not lapse while the door cannot answer yet. The limits: this protection depends on the page's one reservation try, which is not fatal: if it fails, the page still sends the check-in, and the door then gives the link to the first caller. The free Cloudflare KV plan caps writes at 1,000 a day and a reservation needs no ticket, so someone with many IPs could use them up; the door's record then falls back to each Cloudflare isolate's memory for the rest of that day (a paid plan bills writes instead; `worker/RUNTIME.md` section 5). Also, the door's record is in Cloudflare KV, which is eventually consistent, so two Cloudflare locations can disagree for a short time. The door reads one Fulcrum server and accepts a check-in that is not confirmed yet, so a holder who races a conflicting hand-back past it, or a dishonest server in the pinned list, could get the link without the organiser being paid. Only the link leaks that way; no money moves. Whether the call then lets you in is between you and the organiser (section 3, "Trustless entry").
18. **What the page reads from the chain is one server's word.** The page checks every transaction it fetches against its txid, but confirmations, address history and the proof-strip counts come from whichever pinned Fulcrum server answers, with no merkle proof. A dishonest server could show a made-up history or call a genesis confirmed when it is not. It cannot move money: every transaction the page sends is checked in the 2026 VM first, and the network runs the scripts again.

## 5. Prior art

Doorstub is not a new idea, and we say so. These projects did it first or did parts of it, and we credit them by name:

- **Turnout** (Arc, mainnet according to its README): dollar tickets held in escrow and released to the host per ticket at the door, holder-signed check-in, refunds for cancelled events and unscanned tickets.
- **Firstrow** (Monad testnet, Monad Metropolis 2026): money held in escrow until the fan walks in; fans refund themselves.
- **Curtain** (Monad testnet, Monad Metropolis 2026): pay-on-entry ticket escrow; an on-chain check-in pays the organiser; refunds without anyone approving them.
- **TixPact** (NEAR testnet, NEAR Hackathon 2026): event tickets whose refund does not depend on the seller.
- **FundMe and its CashStarter contracts** (Bitcoin Cash): refund a pledge by burning its receipt NFT, with refunds still open after a creator cancels. Doorstub's hand-back burns the ticket the same way.
- **Dance.cash** (a 2025 Bitcoin Cash hackathon entry): class tickets sold as NFTs on Bitcoin Cash.
- **The ShowUp spec** (Bitcoin Cash, published as a concept and withdrawn before BCH BLAZE 2026): deposits held in a covenant, released at check-in, refunded by default.
- **Waybill** (a BCH BLAZE 2026 entry): a similar release-at-the-door covenant for parcels; the seller is paid when the buyer's code is scanned at handoff, with a refund after a deadline.

What Doorstub adds on Bitcoin Cash, stated modestly: one escrow coin per ticket identified by a marker NFT, a check-in that the holder's own wallet signs and that leaves the ticket as a keepsake, a no-show settle that anyone can push, per-seat and whole-show refund notices, and parallel box-office shards so many buyers can buy at once.

## 6. Sample shows

The studio writes these card texts into `shows.json` (`studio/lib/plan.js`, `CARDS`); the app adds the start block and the local time:

- Sample show A (`sample-settle`): "Sample show. Nobody checks in at a sample show, so every ticket refunds itself after it starts." True because nobody holds the organiser's door for a sample: no check-in can happen without the holder's own wallet, and `settle` opens at `startHeight + graceBlocks + 1` (C3). The samples start every 36 blocks with `graceBlocks` 2, so settling opens three blocks (about half an hour) after the start, and the refund follows once the keeper or the page sends it.
- Sample show B (`sample-refund-seat`): "Sample show. Its organiser refunds every seat right after it is sold, so you can watch a refund arrive without doing anything." True while the refund-notice signer and the keeper run: the worker signs an `'R'` notice for each sold seat of this show only (never `'C'`, never another show; `worker/RUNTIME.md` section 5) and anyone can push the refund (C5, C6); the page pushes it at once and the keeper every 5 minutes as a backup. *(Signer and keeper built and tested, `test/worker/notice.test.js`, `keeper.test.js`, `adapters.test.js`, `test/integration/app-worker.test.js`, `npm run worker:workerd-check` and `npm run e2e`; not deployed yet.)*
- Real shows (`real`), planned as two online screenings: titles "Doorstub screening 1" and "Doorstub screening 2", subtitle "Online, 25 minutes", card "Online screening: a 12-minute film on how Doorstub works, then Q&A in the chat. Walk in to get the room link." Each is a 12-minute film, then typed Q&A in the call's chat, about 25 minutes in all, starting 2026-11-24 13:00 UTC and 2026-11-28 13:00 UTC (`eventAt` and `durationMin` in `shows.json`; the site shows the time in the reader's own time zone with the zone named). Their seats are labelled with the letters S and T (`seatPrefix`), so a seat reads `S-0-1`. True once the user hosts the calls and the door holds their links: Walk in is the holder's own check-in (C2), and the door hands the room link to the page that checked in (limit 17). The page sells their tickets and offers Walk in until the call ends by the reader's clock, so a late arrival can still buy and walk in during the call (`src/shows/schedule.js` `salesOpen` with `now`). Their `startHeight`, where sales end on chain, is set well after that: the end of the call plus 24 blocks plus 5% of the blocks until then, because blocks can come early. Replayed over 200 days of mainnet headers and planned 1 to 8 days ahead, a flat 6 blocks closed sales before the call ended about 30% of the time; this margin did so about 2 to 3% of the time (then the card says sales ended at that block, and Walk in stays open until the call ends). Their `graceBlocks` is 144, so settling opens about a day after `startHeight`; in the same replays it never opened before the call ended. The studio computes `startHeight` from `eventAt` and the chain tip when the organiser plans, right before creating the shows (`studio/README.md`, `studio/lib/plan.js`). Their refund notices need a second studio data key that the worker never holds (`SPEC.md` section 12). *(Not created yet.)*

**Walk in on samples:** a "Walk in" button on a sample show would pay the sample organiser (us) the ticket price, which breaks "no tap may pay us for a show that does not happen". The samples therefore offer only "Hand it back"; "Walk in" is shown only on a show that really takes place.

**Wallet metadata (BCMR).** Each show's token carries a BCMR registry (`studio/lib/bcmr.js`): name "Doorstub ticket: <show title>", the headline (section 1) and the show's card text as its description, C1 as the ticket description, and "Escrow marker for one ticket. It stays in the show's contract with the ticket's money." for the marker. Wallets that parse BCMR NFT fields show four fields. The first three are the parts of the seat label the site shows (show letter, box office, seat: `A-0-12`):

- "Show": "The show's letter, the first part of the seat label (A-0-12)."
- "Box office": "The box-office shard that sold this seat (0, 1, 2, ...), the middle part of the seat label (A-0-12)."
- "Seat": "Seat number within its box office, the last part of the seat label (A-0-12). The site shows the label as show letter, box office and seat."
- "Buyer key hash": "HASH160 of the buyer's public key. Refunds go only to this address." (C7)

True because the registry's parse script reads them from the NFT's own commitment, with the show's letter fixed per registry; `test/studio/studio.test.js` runs it in the 2026 VM over a ticket bought on simnet and gets the site's label.

## 7. Wallet prompts

What the app asks the wallet to show on its confirm screen (`userPrompt`, `src/shows/format.js`, pinned by `test/shows/schedule-format.test.js`). `<seat>` is the show letter, shard and seat number (`A-0-12`); `<price>` is the show's price; `<refund>` and `<payout>` are the values of the built transaction's refund and payout outputs (so after the network fee), never estimates.

| Path | Exact wording | Why it is true |
|---|---|---|
| Buy | "Doorstub: buy seat `<seat>` for `<price>` BCH. The money waits in the show's contract." | `buy` sends `price + 1,000` sats to the show's Escrow with this seat's marker (C1). |
| Hand back | "Doorstub: hand back seat `<seat>`. `<refund>` BCH comes back to this wallet." | `handBack` pays `P2PKH(buyerPkh)`, and the ticket must sit at that address, so the refund goes to the signing wallet (C4). |
| Check in | "Doorstub: walk in with seat `<seat>`. This pays the organiser `<payout>` BCH; your ticket stays as a keepsake." | `checkIn` pays the organiser payee and returns the ticket (C2, C8). It names who is paid and how much, which also answers section 6's open question for any show with a Walk in button. |

## 8. Credits

AI coding assistance (Claude).

The display face is Barlow Condensed, under the SIL Open Font License 1.1 (`app/public/fonts/OFL.txt`).

## 9. Site wording

Every sentence the site (`app/`) shows, word for word, from `app/src/lib/copy.js` and the page head and no-JavaScript line of `app/index.html` (9.7). `test/app/copy.test.js` fails when a sentence there is missing here or uses a word from section 3, and when the prior-art lines differ from section 5. `{name}` is a value the page fills in: from the chain, from `shows.json` (checked by the shows loader), from the wallet, or from the built transaction. Button words and headings ("Get a ticket", "Hand it back", "Walk in", "My tickets") make no claim and are not listed.

### 9.1 Home, banner and show cards

| Sentence | Why it is true |
|---|---|
| `Tickets that refund themselves.` | Section 1. |
| `The organiser is paid for each guest who walks in. Every other ticket refunds.` | Section 1. |
| `Refunds return the same BCH, minus a network fee of at most {cap} sats and any fee the organiser posted on the show page.` | Section 1 small print; `{cap}` is the show's `minerFeeCap`. |
| `Someone has to send the refund transaction. Anyone can, without a key, and Doorstub's keeper does it for you.` | Section 1 small print. The page itself pushes the settle of any show past its grace (`test/app/controller.test.js`) and the sample B refund; the cron keeper (`worker/lib/keeper.js`, every 5 minutes) is the backup and settles a started show on its own (`test/integration/app-worker.test.js`, `npm run e2e`) *(keeper not deployed yet)*. |
| `Works with your own wallet over WizardConnect. Doorstub never holds your money or your keys.` | C10. |
| `Built from scratch during BCH BLAZE 2026; first commit 16 Nov (UTC); no earlier code.` | The repository's first commit is from 16 Nov 2026 03:21 UTC (`git log --reverse`); nothing older was copied in (the project's hygiene rules, `npm run check:hygiene`). |
| `Block {start}, about {time} ({eta}).` | `startHeight` from the show; the time is the tip plus ten minutes a block, in the reader's own time zone with the zone named. |
| `Buy and walk in until the call ends, {time} ({eta}).` | A real show's call end, `eventAt` plus `durationMin` from `shows.json`, in the reader's own time zone with the zone named. The page offers Get a ticket and Walk in until then by the reader's clock (`salesOpen` with `now`, `src/shows/schedule.js`; `test/app/view.test.js`). Its on-chain end of sales, `startHeight`, is hours later (section 6), so blocks that come early do not close sales first, and a walk-in works until the call ends because a settle can be mined only from `startHeight + graceBlocks + 1` (C3), with `graceBlocks` 144. |
| `Walk in until the call ends, {time} ({eta}).` | Shown after `Sales for this show ended at block {start}.` when the chain reached a real show's `startHeight` before its call ended (blocks came early): sales are over (section 4, limit 14), and a walk-in still works until the call ends because settling opens 145 blocks later (C3). |
| `Sales and walk-in for this show closed when its call ended.` | After a real show's call, by the reader's clock: the page no longer offers Get a ticket or Walk in for it. A ticket still held refunds by the settle (C3) or can be handed back (C4). |
| `{time} ({eta}), for {minutes} minutes.` | A real show's call: `eventAt` and `durationMin` from `shows.json` (the organiser's plan, checked by the shows loader), shown in the reader's own time zone with the zone named; `{eta}` is counted from the reader's clock ("on now" during the call, "over" after it). |
| `about {usd}` | Today's rate from a public price source; hidden when none answers (section 3, "dollar amounts as a promise"). |
| `{sold} sold on {shards} box-office shards` | Seats counted from the markers at the show's Escrow address (`src/chain/ledger.js`). |
| `Settling opens at block {settle}, about {time} ({eta}); the refund follows once the keeper or this page sends it.` | C3: `settle` opens at `startHeight + graceBlocks + 1`. |
| `At block {settle}, about {time}; the refund follows once the keeper or this page sends it.` | The same rule, shown under a held ticket's "Settling opens in" countdown (so the countdown is not said twice). |
| `Hand-back fee {handBack}. No-show fee {noShow}. Network fee cap {cap} sats per ticket.` | Section 4, limits 6 and 7; the values are the posted parameters, recomputed into the Escrow address by the shows loader. |
| `Sales for this show ended at block {start}.` | Section 4, limit 14: `buildBuy` refuses at or after `startHeight`. |
| `Checking every show's genesis transaction on chain.` | Section 4, limit 10 (`verifyShowGenesis`). |
| `No show is on sale right now.` | Status line. |
| `The show list did not load.` | Status line. |
| `Doorstub could not verify this show's genesis on chain, so it is not on sale.` | Section 4, limit 10: the app refuses a show whose genesis fails the check. |

### 9.2 Connecting a wallet

| Sentence | Why it is true |
|---|---|
| `Scan the code with your wallet, or open a wallet on this device.` | The dialog shows the WizardConnect QR code and the Selene and Cashonize links. |
| `Signing tested with Selene, Paytaca and Cashonize.` | C10's rule: the 11/16 sign-only probe passed buy, hand-back and check-in on all three (Schnorr, sighash `0x61`). OPTN is untested and not named. |
| `Paytaca: press Copy link, then paste it in Paytaca's WizardConnect screen. The link stays valid while this page stays open.` | The dialog never regenerates the link on a timer, and the wallet session pairs a wallet that joins after the library's 30 s wait (`test/wallet/late-join.test.js`). |
| `Cashonize: create a wallet first, then press Open in Cashonize again.` | Cashonize drops a `?uri=` link opened before a wallet exists (seen on Cashonize web, 11/16). |
| `Waiting for your wallet to join.` | Status line. |
| `Next: your wallet asks you to approve {price} for {show}.` | Shown when the dialog was opened by "Get a ticket": the buy waits for the wallet and starts by itself once it joins (`pendingBuy`, `test/app/controller.test.js`), and its sign request names the seat and the price (section 7). `{price}` is the show's price, `{show}` its title. |
| `On a phone: connect in your wallet, come back to this page, then open the wallet again to approve.` | On a phone the wallet app takes the screen; the sign request goes out from this page after the wallet joins, and a phone may pause a page left in the background, so the page should be open when it does. |
| `The wallet relay is not answering. Try the other relay.` | Shown after 10 s without a relay connection; the button pairs over the second relay. |
| `This wallet is on {network}. Doorstub runs on Bitcoin Cash mainnet; switch the wallet to mainnet and connect again.` | The wallet session refuses a wallet on another network (`test/wallet`). |
| `Your wallet ended the connection.` | Status line. |
| `Reconnecting to your wallet.` | Shown while the wallet relay reconnects: the page keeps the paired session and waits up to 10 s for it before it acts (a buy starts a new pairing only if the wallet does not come back), and it sends a sign request once more if the relay dropped it (`RECONNECT_WAIT_MS`, `app/src/lib/controller.js`; `test/app/controller.test.js`). |
| `Reading your wallet's coins from the network.` | Status line. |
| `Connected: {name}, {balance}.` | The wallet's own name and its plain-BCH balance read from the chain. |
| `No Doorstub ticket in this wallet yet.` | Status line. |

### 9.3 Buying, approving and stuck states

"Nothing was sent" is true because every request asks the wallet with `broadcast: false` and the page sends only a reply that passed `checkSignedReply` (section 4, limit 11).

| Sentence | Why it is true |
|---|---|
| `Picking a box-office shard and the coins to pay with.` | Status line. |
| `Approve in {wallet}. It shows: “{prompt}”` | `{prompt}` is the exact `userPrompt` sent with the request (section 7). |
| `Checking your wallet's signature, then sending the transaction.` | `checkSignedReply`, then `broadcastChecked`. |
| `Your {price} is held by contract coin {outpoint}.` | C1; `{outpoint}` is the buy's Escrow output. |
| `Someone bought on the same box-office shard at the same moment. Please approve once more.` | Section 4, limit 12; shown when the network refused the buy as a conflict and the shard it used is no longer open on chain; the app reads the wallet's coins again and rebuilds on another shard. |
| `A coin from your wallet was spent elsewhere at the same moment. Please approve once more.` | Shown when the network refused the buy as a conflict while its shard is still open on chain, so the conflicting input was one of the wallet's coins; the app reads the wallet's coins again before it rebuilds. |
| `Another transaction spent this ticket's contract coin first, so the network refused this one. The card shows where the money went.` | Shown when a hand-back or walk-in is refused as a conflict and the show's ledger (`src/chain/ledger.js`) shows the ticket's escrow coin already spent (a settle or refund pushed by anyone, section 4 limit 2); the card then shows that spend from the chain. |
| `You need about {need} for this ticket; your wallet has {have}.` | `{need}` is the price, the two token outputs and the network fee; `{have}` is the wallet's plain coins (coins without tokens). |
| `Send at least {amount} BCH to this address. When it arrives, the buy continues and your wallet asks you to approve.` | Shown with the wallet's first unused receive address (from the scan), a Copy button and a QR code. `{amount}` is what is missing plus 1,000 sats for the extra input's fee, rounded up to 0.0001 BCH. The page watches that address (a Fulcrum subscription, and every new block) and runs the buy again once the wallet's plain coins reach `{need}`; the wallet is asked to approve as usual (`test/app/controller.test.js`). |
| `Watching this address for your coins.` | Status line while the page waits (above). |
| `Your wallet holds only token coins here. A ticket needs plain BCH to pay.` | `buildBuy` takes only coins without tokens. |
| `Your wallet declined: “{reason}”. Nothing was sent.` | `{reason}` is the wallet's own words. |
| `Your wallet could not verify this transaction. Nothing was sent.` | Selene's refusal "Wallet could not verify transaction" in plain words. |
| `Your wallet did not answer in time. Nothing was sent.` | Status line. |
| `Another approval is already waiting in your wallet.` | The session sends one request at a time. |
| `Could not reach your wallet through the relay. Nothing was sent.` | Status line. |
| `Your wallet's reply did not pass Doorstub's checks, so it was not sent.` | `checkSignedReply` refused it. |
| `The network refused the transaction: “{words}”` | `{words}` is the server's own error text. |
| `No Bitcoin Cash server answered. Doorstub keeps trying.` | The pool retries with back-off. |
| `Sales for this show are closed.` | No open box-office shard of the show's category on chain. |
| `Something went wrong: {message}` | Any other error, with its text. |

### 9.4 Tickets

| Sentence | Why it is true |
|---|---|
| `Your ticket money waits in a contract, not with the organiser.` | C1. |
| `Until you walk in or the show settles, you can hand your ticket back for your money, minus the hand-back fee shown on the show page.` | C4. |
| `Your ticket is an NFT in your own wallet. After check-in it stays there as a keepsake stub with no money behind it.` | C8. |
| `Handed back. {amount} came back to your wallet.` | `{amount}` is the sum of the hand-back's outputs to the buyer's address (C4). |
| `You paid {paid}; {amount} came back; the rest was network fees.` | `{paid}` is the buy's wallet inputs less its change: the price, the 1,000 sats each of the ticket and the marker carry, and the network fee. A hand-back returns both coins' values less its own network fee, so with no posted hand-back fee the difference is the two network fees (the line is left out when the show posts one). This is why more than the price comes back. |
| `You paid {paid}; {amount} came back and {kept} stays with the ticket NFT; the rest was network fees.` | As above; a refund or settle pays the escrow coin's value less its network fee, and the ticket NFT keeps its own 1,000 sats (`{kept}`). Left out for a settle when the show posts a no-show fee. |
| `Refunded by the settle after the show: {amount} to the address that bought it.` | C3, C7; `{amount}` is the settle's output at the coin's index. |
| `Refunded under the organiser's refund notice: {amount} to the address that bought it.` | C6, C7; `{amount}` is the refund's output at the coin's index. |
| `Walked in. Your ticket stays in your wallet as a keepsake stub with no money behind it.` | C8. |
| `The call starts {time} ({eta}).` | On a walked-in ticket of a real show before its call: `eventAt` from `shows.json` in the reader's zone (see 9.1). |
| `The call starts {time}, for {minutes} minutes.` | On a held ticket of a real show, under its "Call starts in" countdown: `eventAt` and `durationMin` from `shows.json`. |
| `The call is on now.` | The reader's clock is between `eventAt` and `eventAt + durationMin`. |
| `The call is over, so Walk in is closed.` | On a held ticket of a real show after its call, by the reader's clock (9.1); the ticket keeps Hand it back and the settle countdown. |
| `Check-in is final. Once you check in, the organiser has the money.` | Section 4, limit 8. |
| `Your check-in is on chain. Asking the door for your event link.` | Shown after the check-in was accepted by a server. |
| `The door answered with your event link.` | The door verifies the check-in on chain before it answers (`SPEC.md` section 12); the page opens only an `https:` link. |
| `Your check-in is on chain. The door did not answer yet; try again in a moment.` | The check-in was accepted; only the door's answer is missing. |
| `The door already gave the event link for this check-in to another page, so it cannot give it here.` | The door gives the link to one claimant per check-in and answers any other claim with `409 already-answered` (`SPEC.md` section 12); the page reserves its claim before it sends the check-in, shows this sentence on a 409 and does not ask again (`app/src/lib/api.js`, `test/app/client.test.js`). |
| `The refund-notice service did not answer. Doorstub's keeper sends this refund within minutes, with no approval from you.` | The cron keeper runs every 5 minutes and refunds every live sample B marker with a fresh notice; a refund needs no key (C5, C6) *(keeper not deployed yet)*. |
| `A ticket moved away from the buyer's address can no longer check in or hand back. Settle still refunds the original buyer.` | Section 4, limit 5. |
| `This ticket's contract coin is not in the show's history yet.` | Status line. |
| `This page sent the settle for {show}: {count} {coins}. Anyone can send it; it needs no key.` | C3: `settle` takes no signature; the page builds it, checks it in the VM and sends it (`app/src/lib/controller.js`). |

### 9.5 How it works, proof strip, check it yourself

| Sentence | Why it is true |
|---|---|
| `The organiser is paid when you check in, and your own wallet signs the check-in.` | C2. |
| `If you do not use your ticket, it refunds after the show.` | C3. |
| `The organiser's key can refund your money. It can never send it anywhere else; at most {cap} sats of your ticket can go to the network fee.` | C6. |
| `A refund goes only to the address that bought the ticket.` | C7. |
| `Each ticket's money is one coin at the show's Escrow contract, marked by an NFT that matches your ticket. It can leave in exactly four ways.` | `buy` sends `price + 1,000` sats to the show's Escrow with the marker `'E' \| seat \| buyerPkh`, the twin of the ticket `'T' \| seat \| buyerPkh` (`SPEC.md` section 2); Escrow has exactly four functions, `checkIn`, `handBack`, `settle` and `refund` (`SPEC.md` 3.2). |
| `Read live from the chain: every transaction at the contract addresses of the shows on this page.` | The proof strip reads the history of each show's Escrow address from Fulcrum and classifies each spend by its path (`src/chain/ledger.js`). |
| `No Doorstub transaction yet.` | Status line. |
| `Both contract addresses below were recomputed in your browser from the show's posted parameters and compared with the ones on this page.` | The shows loader recomputes both contracts and refuses a show whose posted addresses differ (`src/shows/schema.js`). |
| `Genesis {txid} is confirmed at block {height} and passed Doorstub's genesis check.` | `verifyShowGenesis`: fetched by txid, hash-checked, `verifyGenesis`, confirmed. |
| `Every contract path and 143 attack tests run in the 2026 BCH virtual machine, in standard and consensus mode, and the virtual machine refuses every attack in them.` | C9. |
| `Prices are in BCH. A refund returns the same BCH, not the same dollars.` | Section 4, limit 1. |
| `"Before the show" cannot be enforced. Hand-back and check-in work for as long as the ticket's money is still in the contract, even after the start.` | Section 4, limit 2. |
| `Hand-backs do not free a seat.` | Section 4, limit 3. |
| `The organiser key can refund money but never redirect it.` | Section 4, limit 4. |
| `A ticket moved away from the buyer's address can no longer check in or hand back.` | Section 4, limit 5. |
| `Buyers need BCH already. There is no card or cash door.` | Section 4, limit 9. |
| `Coins sent straight to a contract address without the right token are stuck for good. Only use the app.` | Section 4, limit 13. |
| `Sales end in the app, not on chain.` | Section 4, limit 14. |
| `Two buyers on the same box-office shard at once means one of them signs again.` | Section 4, limit 12. |

### 9.5a For organisers

The section answers who Doorstub is for, what an organiser gains and how Doorstub would earn. Doorstub takes no fee today: no contract path pays anyone but the buyer, the organiser payee and the network.

| Sentence | Why it is true |
|---|---|
| `Organisers of paid online calls, classes and meetups, where people book and then do not come.` | Who the product is for (a description, not a claim about the code); the two real shows are online calls (section 6). |
| `You are paid from the contract for each guest who walks in, the moment they check in. Check-in is final, so there is no chargeback.` | C2: `checkIn` pays the organiser payee from the ticket's coin in the same transaction; section 4, limit 8; a Bitcoin Cash payment has no chargeback. |
| `You can post a hand-back fee and a no-show fee of up to 10% each; the contract pays them to you.` | Section 4, limit 7: the fee outputs of `handBack` and `settle` must pay the organiser payee exactly the posted fee, and the app refuses a show with either fee over 10% (1,000 bps). |
| `Plan, not built yet: Doorstub would charge organisers a fee per show for running the keeper and the door. Today the contracts pay Doorstub nothing.` | A plan, marked as one. Neither contract has an output for Doorstub (`SPEC.md` 3.1, 3.2); the keeper and the door run for the shows on this page at no charge. |

### 9.6 Credits

| Sentence | Why it is true |
|---|---|
| `Doorstub is not a new idea, and we say so.` | Section 5. |
| `What Doorstub adds on Bitcoin Cash, stated modestly: one escrow coin per ticket identified by a marker NFT, a check-in that the holder's own wallet signs and that leaves the ticket as a keepsake, a no-show settle that anyone can push, per-seat and whole-show refund notices, and parallel box-office shards so many buyers can buy at once.` | Section 5. |
| `Wallet connection by WizardConnect (Whiterun LLC), used under the GNU LGPL 3.0 or later and shipped as its own file.` | The library's copyright notice; the build puts it in its own `assets/wizardconnect-*.js` with the notice (`scripts/check-app-dist.js`). |
| `Built with libauth, CashScript, Preact, qrcode and noble, all under the MIT licence.` | Their package licences. |
| `AI coding assistance (Claude).` | Section 8. |

### 9.7 Page head and no-JavaScript line

The page title, the description and link-preview texts, and the one line a browser without JavaScript shows (`app/index.html`). `test/app/copy.test.js` reads them from the file and requires each to be made of sentences in this section.

| Sentence | Why it is true |
|---|---|
| `Doorstub: tickets that refund themselves` | The page title and link-preview title: the name and the headline (section 1). |
| `An event box office on Bitcoin Cash.` | What Doorstub is (`ARCHITECTURE.md`); it follows the headline (section 1) in the page description and link previews. |
| `Doorstub needs JavaScript: it builds and checks every transaction in your browser.` | Shown only without JavaScript. The page builds each transaction in the browser, checks the wallet's signed reply before it sends it (`assertSignedReply`, section 4 limit 11) and checks the settles and refunds it pushes in the 2026 VM (`checkSignatureFree`). |
