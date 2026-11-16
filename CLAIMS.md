# Doorstub: public claims (draft)

Draft of 11/16. This file is the source for every public sentence about Doorstub: the site, the README, the deck and the video. Each claim names the rule that makes it true (see `SPEC.md`) and the tests that pin it. If a sentence is not here, do not publish it.

**Status today.** The contracts, the transaction builders, the attack suite and the sign-only wallet probe exist. Nothing is on mainnet. The app, the settle keeper, the refund-notice signer and the first real show are not built yet. A claim marked *(not built yet)* must not be published in the present tense until it ships.

## 1. Headline

> Tickets that refund themselves. The organiser is paid for each guest who walks in. Every other ticket refunds.

It is true as written because of three contract rules:

1. The organiser receives a ticket's price only through `checkIn`, and only the ticket holder's own wallet can sign a check-in (`SPEC.md` 3.2).
2. After the show plus a grace period, `settle` pays every coin that was not checked in back to its buyer. Anyone can send that transaction; it needs no key.
3. There is no "organiser collects after the start" path. A show that never happens has no check-ins, so every ticket refunds.

Small print that must sit next to the headline wherever there is room:

- "Refunds return the same BCH, minus a network fee of at most N sats and any fee the organiser posted on the show page." (N is the show's `minerFeeCap`, 1,200 to 2,000 sats; the samples use 1,500.)
- "Someone has to send the refund transaction. Anyone can, without a key, and Doorstub's keeper does it for you." *(Keeper not built yet.)*

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
| C9 | Every contract path and 143 attack tests run in the 2026 BCH virtual machine, in standard and consensus mode, and the virtual machine refuses every attack in them. | `npm test`: 225 tests, 0 failures at this commit. The 143 are the attack tests whose transactions the VM must refuse in both modes (`attacks-boxoffice` 47, `attacks-escrow` 93, `genesis` 3). Not counted in the 143: 13 attacks refused before the VM (12 by `verifyGenesis`, 1 by the commitment encoder), 11 honest controls, 7 `LIMIT` pins accepted on purpose and 1 kit self-check in the same files; 11 happy paths; 3 sanity checks; 11 policy tests; 5 limit measurements; 20 probe tests. Update the numbers whenever the tests change. | `test/`, `probe/test/` |
| C10 | Works with your own wallet over WizardConnect. Doorstub never holds your money or your keys. | The site only asks the wallet to sign; contracts hold the money. | Name a wallet only after the probe passes on it (`PROBE.md`). *(Not tested on a real wallet yet.)* |

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
14. **Sales end in the app, not on chain.** BCH cannot stop a sale after the start. The app refuses to sell at or after the start or after a cancel, and the organiser's app closes every box-office shard at the start. Someone who buys late with other software can be settled at once and loses the no-show fee plus up to N sats of network fee (up to N sats after a cancel).
15. **Batches.** Anyone can settle or refund up to 100 tickets per transaction; a bigger show takes several. A buy takes at most 50 of your coins.
16. **Network fees are paid from each ticket's allowance.** Hand-back, check-in, settle and refund transactions cannot take a coin from anyone else to pay the network fee. If network fees ever rose above about 1.1 sat per byte (the exact level depends on the show's cap), those transactions would wait until fees fell.

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

The sample show card must say: "Sample show. Nobody will check in, so every ticket refunds after it starts (about a day later, after 144 blocks)."

**Open question before the app is built:** a "Walk in" button on a sample show would pay the sample organiser (us) the ticket price, which breaks "no tap may pay us for a show that does not happen". Either the sample show's check-in is labelled with who gets paid and how much, or the sample organiser refunds by notice afterwards, or "Walk in" is shown only on a show that really takes place.

## 7. Wallet prompts

What the app asks the wallet to show on its confirm screen (`userPrompt`, `src/shows/format.js`, pinned by `test/shows/schedule-format.test.js`). `<seat>` is the show letter, shard and seat number (`A-0-12`); `<price>` is the show's price; `<refund>` and `<payout>` are the values of the built transaction's refund and payout outputs (so after the network fee), never estimates.

| Path | Exact wording | Why it is true |
|---|---|---|
| Buy | "Doorstub: buy seat `<seat>` for `<price>` BCH. The money waits in the show's contract." | `buy` sends `price + 1,000` sats to the show's Escrow with this seat's marker (C1). |
| Hand back | "Doorstub: hand back seat `<seat>`. `<refund>` BCH comes back to this wallet." | `handBack` pays `P2PKH(buyerPkh)`, and the ticket must sit at that address, so the refund goes to the signing wallet (C4). |
| Check in | "Doorstub: walk in with seat `<seat>`. This pays the organiser `<payout>` BCH; your ticket stays as a keepsake." | `checkIn` pays the organiser payee and returns the ticket (C2, C8). It names who is paid and how much, which also answers section 6's open question for any show with a Walk in button. |

## 8. Credits

AI coding assistance (Claude).
