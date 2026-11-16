# Doorstub

**Tickets that refund themselves.** The organiser is paid for each guest who walks in. Every other ticket refunds.

Doorstub (say it door-stub, like a ticket stub) is an event box office on Bitcoin Cash. Your ticket money waits in a contract, not with the organiser. The organiser is paid when you check in, and your own wallet signs the check-in. If you do not use your ticket, it refunds after the show.

Built from scratch during BCH BLAZE 2026; first commit 16 Nov (UTC); no earlier code.

## Try it

**https://doorstub.pages.dev**

Works with your own wallet over WizardConnect. Doorstub never holds your money or your keys. Signing tested with Selene, Paytaca and Cashonize.

1. Press **Get a ticket** on a show and connect: scan the code with your wallet, or open a wallet on this device. Paytaca: press Copy link, then paste it in Paytaca's WizardConnect screen.
2. Approve one transaction in your wallet. The ticket card shows your seat and the contract coin that holds your money. If the wallet has too little BCH, the page shows its address with a QR code, watches it, and continues the buy when the coins arrive; your wallet still approves it.
3. Then, depending on the show:
   - **Sample show A.** Nobody checks in at a sample show, so every ticket refunds itself after it starts. Until then you can **Hand it back**.
   - **Sample show B.** Its organiser refunds every seat right after it is sold, so you can watch a refund arrive without doing anything.
   - **The screenings** (planned, not created yet): "Doorstub screening 1" and "Doorstub screening 2", online calls on 24 and 28 Nov at 13:00 UTC, each a 12-minute film on how Doorstub works, then Q&A in the chat, about 25 minutes in all. The card shows the time in your own time zone. You can buy and walk in until the call ends. **Walk in** pays the organiser and shows the room link; your ticket stays in your wallet as a keepsake stub. A ticket nobody walks in with refunds by the settle, which opens about a day after sales end on chain.
4. The "On mainnet" strip counts every buy, hand-back, check-in, settle and refund at the shows' contract addresses, read live from the chain. "Check it yourself" recomputes both contract addresses in your browser and checks each show's genesis on chain.

Prices are in BCH. A refund returns the same BCH, minus a network fee of at most 1,500 sats on the sample shows and any fee the organiser posted on the show page.

## How it works

Each ticket is two NFTs of the show's own token: the ticket in your wallet, and a marker on a contract coin that holds the ticket's price. That coin can leave the contract in exactly four ways:

| Path | Who sends it | Where the money goes |
|---|---|---|
| Check in | your wallet signs | the organiser; your ticket stays as a keepsake |
| Hand back | your wallet signs | you, minus the posted hand-back fee |
| Settle | anyone, without a key, after the start plus a grace period | you, minus the posted no-show fee |
| Refund | anyone, with the organiser's signed refund notice | you |

Each of these transactions pays its network fee out of the ticket's coin, up to the show's posted cap; whoever sends it decides how much of that allowance to use, and nobody can keep it. There is no path for the organiser to collect after the start. Someone has to send the refund transaction. Anyone can, without a key, and Doorstub's keeper does it for you.

More: [ARCHITECTURE.md](ARCHITECTURE.md) (one page: components, money flow, who can do what, what the chain enforces and what the app enforces) and [SPEC.md](SPEC.md) (every rule, transaction shape and limit).

## Claims and limits

Every public sentence about Doorstub, the rule that makes it true and the test that pins it, is in [CLAIMS.md](CLAIMS.md). The limits we state, in short (section 4 there has them all):

- "Before the show" cannot be enforced. Hand-back and check-in work for as long as the ticket's money is still in the contract, even after the start.
- The organiser key can refund money but never redirect it.
- Hand-backs do not free a seat.
- A ticket moved away from the buyer's address can no longer check in or hand back. Settle still refunds the original buyer.
- Check-in is final. Once you check in, the organiser has the money.
- Sales end in the app, not on chain.
- Buyers need BCH already. There is no card or cash door.
- Coins sent straight to a contract address without the right token are stuck for good. Only use the app.
- The event link of a real show is off chain. Your page reserves its check-in at Doorstub's door before sending it, so someone who sees the check-in in the mempool cannot take the link. That depends on the page's one reservation try reaching the door (it sends the check-in anyway if the try fails) and on the door's KV record having writes left; the door reads one server and accepts an unconfirmed check-in (limit 17 there).
- What the page reads from the chain is one server's word. It cannot move money: every transaction the page sends is checked in the 2026 VM first, and the network runs the scripts again.

Every contract path and 143 attack tests run in the 2026 BCH virtual machine, in standard and consensus mode, and the virtual machine refuses every attack in them.

## Run it locally

Node 22. Nothing here touches mainnet: tests and the local site run on simnet, a local test chain.

```
npm install
npm test              # contracts, attacks, libraries, studio, worker, site logic (no browser)
npm run app:sim       # the site on a local simnet with the worker; prints a link to open
npm run e2e           # the whole judge path in headless Chrome on simnet (needs Google Chrome)
npm run e2e -- --screens        # the same, with every step at four sizes, light and dark, in .cache/screens/
npm run worker:workerd-check    # the worker's Cloudflare adapters in local workerd against a simnet
npm run app:build     # production build to app/dist, then checks it has no test overrides and no empty banner value
DOORSTUB_ALLOW_PLACEHOLDERS=1 npm run app:build   # a preview build while the banner links are still empty
```

Layout: `contracts/` (CashScript), `src/tx` (transaction builders), `src/chain`, `src/wallet`, `src/shows` (client libraries), `app/` (the site), `worker/` (refund-notice signer, door, keeper; `worker/RUNTIME.md`), `studio/` (the organiser's CLI; `studio/README.md`), `simnet/` (the local test chain), `test/`.

## Credits

Doorstub is not a new idea, and we say so. Turnout, Firstrow, Curtain, TixPact, FundMe and its CashStarter contracts, Dance.cash, the ShowUp spec and Waybill did it first or did parts of it; [CLAIMS.md section 5](CLAIMS.md#5-prior-art) says what each one did and what Doorstub adds.

Wallet connection by WizardConnect (Whiterun LLC), used under the GNU LGPL 3.0 or later and shipped as its own file. Built with libauth, CashScript, Preact, qrcode and noble, all under the MIT licence. The display face is Barlow Condensed, under the SIL Open Font License 1.1 (`app/public/fonts/OFL.txt`).

AI coding assistance (Claude).

## Licence

The licence for Doorstub's own code is being chosen. The parts listed under Credits keep their own licences (`app/public/licenses.txt`).
