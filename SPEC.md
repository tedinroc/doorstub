# Doorstub specification

Doorstub is an event box office on Bitcoin Cash. Ticket money waits in a contract. The organiser is paid only for each guest who checks in, and the guest's own wallet signs the check-in. After the show, every unused ticket refunds itself to its buyer. Before then, a holder can hand a ticket back for a full refund minus a posted hand-back fee (0 on the sample shows).

This document describes the contracts in `contracts/` and the transaction builders in `src/tx/`. Where a rule is enforced by the contract, it says "enforced". Where only the builders or the app check it, it says "builder". Section 8 lists every limit.

## 1. Conventions

- All contracts are CashScript 0.14 (`cashc 0.14.0`), deployed as P2SH32 (`OP_HASH256 <hash256(redeemScript)> OP_EQUAL`).
- The VM is BCH 2026 (libauth `createVirtualMachineBch2026`). Every transaction in the test suite is evaluated in standard mode and in consensus (non-standard) mode.
- Byte strings are written `a | b` for concatenation. `LE` means little-endian.
- `P2PKH(pkh)` is `OP_DUP OP_HASH160 <pkh> OP_EQUALVERIFY OP_CHECKSIG` (25 bytes).
- **Category byte order.** libauth, explorers and wallets show a token category in display order, which is the genesis input's txid as usually printed. The VM opcodes `OP_UTXOTOKENCATEGORY` and `OP_OUTPUTTOKENCATEGORY` push the reverse (wire order). Escrow's `category` constructor argument and the refund notice messages use **wire order**. `categoryToVmOrder()` converts.
- Amounts are satoshis (sats). 1 BCH = 100,000,000 sats.

## 2. Tokens and commitments

One token category per show. It is created by the genesis transaction (section 5.1), so the category id is the txid of the coin spent by genesis input 0. No fungible tokens are ever created. Every commitment is at most 40 bytes, because Selene refuses any input whose NFT commitment is longer.

| Token | Capability | Commitment | Length | Lives at |
|---|---|---|---|---|
| BoxOffice shard | minting | `state(1) \| shard(1) \| sold(2, LE)` | 4 | BoxOffice |
| Ticket | immutable | `0x54 'T' \| seat(3) \| buyerPkh(20)` | 24 | `P2PKH(buyerPkh)` |
| Escrow marker | immutable | `0x45 'E' \| seat(3) \| buyerPkh(20)` | 24 | Escrow |
| Keepsake stub | immutable | same bytes as the ticket | 24 | `P2PKH(buyerPkh)` |

- `state` is `0x01` (sales open) or `0x00` (sales closed).
- `shard` is a number 0-255 fixed at genesis. Genesis gives shards `0, 1, ..., N-1`.
- `sold` is how many seats this shard has sold, as an unsigned 16-bit LE number, at most 32,767 (section 8).
- **Seat id**, 3 bytes: `shard | sold(2, LE)`, where `sold` is the count *after* the sale. The first seat a shard sells is `sold = 1`. Because the shard byte never changes after genesis and `sold` only grows, seat ids never repeat, within or across shards (given a well-formed genesis, section 7).
- `buyerPkh` is the HASH160 of the buyer's public key, taken from the buyer's wallet address.
- Every token output carries 1,000 sats. The BCHN dust threshold of a P2PKH output with a 24-byte commitment is 723 sats; of the P2SH32 Escrow output with a marker, 753 sats.
- A ticket is genuine for a seat while an Escrow coin with the matching marker exists. After check-in, the ticket remains as a keepsake stub with no money behind it. After a hand-back, settle or refund, the ticket (if still held) is burned or has no matching marker.

## 3. Contracts

### 3.1 BoxOffice

Constructor (declaration order): `price` (int, sats), `organiserPk` (33-byte public key), `escrowLockingBytecode` (the show's Escrow P2SH32 locking bytecode, 35 bytes).

All shards of a show share one BoxOffice address; the shard number lives in the commitment.

**`buy(bytes20 buyerPkh)`**. No signature. All enforced:
1. This input is input 0.
2. Input 0's token is a minting NFT (`tokenCategory` is 33 bytes ending in `0x02`).
3. Its commitment is 4 bytes with `state = 0x01`.
4. `seat = shard | toPaddedBytes(sold + 1, 2)`.
5. At most 6 outputs. No output at index 3 or higher carries this category.
6. No input other than input 0 is a minting NFT of this category (so two shards cannot be spent in one buy).
7. Output 0: same locking bytecode as input 0, same category with minting capability, commitment `0x01 | seat` (that is, state open, same shard, `sold + 1`), value at least input 0's value.
8. Output 1: `P2PKH(buyerPkh)`, immutable NFT of this category, commitment `'T' | seat | buyerPkh`, value at least 1,000.
9. Output 2: `escrowLockingBytecode`, immutable NFT of this category, commitment `'E' | seat | buyerPkh`, value at least `price + 1,000`.

There is no seat cap (K3) beyond the 16-bit limit in section 8.

**`closeSales(sig organiserSig)`**. Enforced:
1. `checkSig(organiserSig, organiserPk)`.
2. Let `idx = this.activeInputIndex`. Output `idx` has the same locking bytecode, the same category and capability as input `idx`, commitment `0x00 | (input idx's commitment without its first byte)`, and value at least input `idx`'s value.
3. Every output that carries this category is at this BoxOffice's locking bytecode with a commitment whose first byte is `0x00`.

So minting capability can never leave the BoxOffice, and a closed shard can never reopen. Several shards can be closed in one transaction (shard `i` at input `i` comes back at output `i`). With one shard at input 0 this is exactly "output 0 = the same contract, state 0x00". It is used by "cancel also closes sales".

There is no other BoxOffice path.

### 3.2 Escrow

Constructor (declaration order):

| Name | Type | Meaning |
|---|---|---|
| `category` | bytes32 | the show's category, **wire order** |
| `organiserPkh` | bytes20 | the organiser's payee; check-ins and fees pay `P2PKH(organiserPkh)` |
| `organiserDataPk` | pubkey | signs refund notices (may equal the organiser key) |
| `startHeight` | int | block height when the show starts |
| `graceBlocks` | int | blocks after `startHeight` before unused tickets settle |
| `handBackFeeBps` | int | hand-back fee, basis points of the coin's value |
| `noShowFeeBps` | int | no-show fee, basis points of the coin's value |
| `minerFeeCap` | int | the most sats a coin can lose to whoever builds the spending transaction |

One Escrow address per show. Each ticket's money is one coin here, identified by its marker.

Every path starts the same way (enforced): let `idx = this.activeInputIndex`; input `idx` carries an immutable NFT of `category` whose commitment is `'E' | body` with `body` 23 bytes; `seat` is the first 3 bytes of `body` and `buyerPkh` the last 20. `value` is input `idx`'s value.

**Index rule (enforced, all paths).** The coin's money goes to output `idx`. A fee, when one is due, goes to output `idx + tx.inputs.length`. Both indexes are different for every input, so one output can never be counted by two escrow coins (no double satisfaction, in any mix of paths), and fee indexes never collide with payout indexes.

**Fee rule (enforced, handBack and settle).** `fee = floor(value * bps / 10000)`. If `fee < 546`, it is set to 0 and no fee output is required (a smaller output would be dust and non-standard). If `fee > 0`, output `idx + tx.inputs.length` must be `P2PKH(organiserPkh)` with value at least `fee`.

**Burn rule.** "No output carries this category" means: for every output, if its token category field is non-empty, its first 32 bytes differ from `category`. This is checked over all outputs with a loop, so no output count cap is needed in Escrow.

**`handBack(int ticketInputIndex)`**. The holder hands the ticket back. Enforced:
1. Input `ticketInputIndex` carries an immutable NFT of `category` with commitment `'T' | body` (same seat and buyerPkh as this coin's marker) and its locking bytecode is `P2PKH(buyerPkh)`. So the buyer's own wallet must sign that input.
2. Fee rule with `handBackFeeBps`.
3. Output `idx` is `P2PKH(buyerPkh)` with value at least `value - fee - minerFeeCap`.
4. No output carries this category (ticket and marker are burned).

"Before the show" is **not** enforced (section 8): hand-back works as long as the escrow coin exists.

**`checkIn(int ticketInputIndex)`** (K1). Enforced:
1. The same ticket-input checks as `handBack` (so only the holder can check in).
2. Output `idx` is `P2PKH(organiserPkh)` with value at least `value - minerFeeCap`.
3. Output `ticketInputIndex` is `P2PKH(buyerPkh)` with an immutable NFT of `category` and the ticket's exact commitment: the keepsake stub.
4. No other output carries this category (the marker is burned).

**`settle()`** (K2). Anyone can push. Enforced:
1. `tx.time >= startHeight + graceBlocks` (`OP_CHECKLOCKTIMEVERIFY`, block height). The transaction's locktime must be at least that height, and the input's sequence number below `0xffffffff`. A transaction with locktime `L` can be mined from block `L + 1`, so settling opens at block `startHeight + graceBlocks + 1`.
2. Fee rule with `noShowFeeBps`.
3. Output `idx` is `P2PKH(buyerPkh)` with value at least `value - fee - minerFeeCap`.
4. No output carries this category.

**`refund(datasig organiserDataSig, bytes1 scope)`** (K5). Anyone can push. Enforced:
1. `scope` is `0x43` ('C') or `0x52` ('R').
2. The message is `'C' | category` (33 bytes, whole show) or `'R' | category | seat` (36 bytes, this seat only), with `category` in wire order.
3. `checkDataSig(organiserDataSig, message, organiserDataPk)`. A data signature is a 64-byte Schnorr (or DER ECDSA) signature over `sha256(message)`.
4. Output `idx` is `P2PKH(buyerPkh)` with value at least `value - minerFeeCap`.
5. No output carries this category.

The organiser key can refund money to buyers; it can never redirect it.

There is no other Escrow path. In particular there is no "organiser collects after the start" path: the organiser is paid only through `checkIn`, and through posted fees.

## 4. Unlocking bytecode

As CashScript encodes it (the test suite checks byte equality against the CashScript SDK):

- Redeem script: constructor arguments pushed in **reverse** declaration order, then the compiled bytecode. Integers are minimal VM numbers; all pushes are minimal.
- Unlocking bytecode: function arguments pushed in reverse order, then the function selector (BoxOffice: `buy` 0, `closeSales` 1; Escrow: `handBack` 0, `checkIn` 1, `settle` 2, `refund` 3), then the redeem script.
- Examples: `buy` unlocks with `<buyerPkh> OP_0 <redeemScript>`; `checkIn` with ticket at input 1 unlocks with `OP_1 OP_1 <redeemScript>`; `refund` unlocks with `<scope> <datasig> OP_3 <redeemScript>`.

Contract inputs need no signature except `closeSales` (organiser's transaction signature, SIGHASH_ALL | UTXOS | FORKID = `0x61` in the builders, any valid type accepted by the contract).

## 5. Transaction shapes (builders)

All builders are pure functions in `src/tx/builders.js`. A UTXO is `{ txid, vout, output }`, with `txid` in display order and `output` a libauth `Output`. Each builder returns `{ kind, transaction, sourceOutputs, walletInputIndexes, fee, ... }`. Contract inputs carry final unlocking bytecode. Inputs in `walletInputIndexes` are P2PKH coins with empty unlocking bytecode, for the owner's wallet to sign. Transactions are version 2.

Sizes below are measured on a sample show with Schnorr signatures (`npm test` builds all of them).

### 5.1 Genesis (`buildGenesis`), offline

| | Inputs | Outputs |
|---|---|---|
| 0 | organiser coin; must be output 0 of its transaction; its txid becomes the category | shard 0: BoxOffice, 1,000 sats, minting NFT `01 \| 00 \| 0000` |
| 1..N-1 | more organiser coins (optional) | shard i: BoxOffice, 1,000 sats, minting NFT `01 \| i \| 0000` |
| next | | optional data output (for example a BCMR OP_RETURN), 0 sats |
| last | | change to the organiser, if at least dust |

Returns an **unsigned** template plus the derived show parameters and contracts. It never signs. About 517 bytes with 4 shards.

### 5.2 Buy (`buildBuy`)

| | Inputs | Outputs |
|---|---|---|
| 0 | BoxOffice shard (unlock `buy(buyerPkh)`) | shard, same value, `sold + 1` |
| 1 | buyer coin (wallet signs) | ticket to `P2PKH(buyerPkh)`, 1,000 sats |
| 2 | more buyer coins (optional, wallet signs) | Escrow coin with marker, `price + 1,000` sats |
| 3 | | change to the buyer, if at least dust |

Funding coins must carry no tokens (builder). The buyer pays `price + 2,000` sats plus the miner fee. About 899 bytes with one buyer coin.

### 5.3 Close sales (`buildCloseSales`)

Inputs `0..k-1`: shards (unlock `closeSales(sig)`); then organiser coins (wallet signs). Outputs `0..k-1`: the same shards, closed; then change. The organiser's signature comes from a caller-supplied callback `signShard({ digest, inputIndex })`; the builder holds no key. About 748 bytes for one shard.

### 5.4 Hand back (`buildHandBack`)

| | Inputs | Outputs (fee 0) | Outputs (fee > 0) |
|---|---|---|---|
| 0 | Escrow coin (unlock `handBack(1)`) | refund to `P2PKH(buyerPkh)`: `value + 1,000 - minerFee` | refund: `value - fee - minerFee` |
| 1 | ticket at `P2PKH(buyerPkh)` (wallet signs) | | the ticket's 1,000 sats back to the buyer |
| 2 | | | fee to `P2PKH(organiserPkh)` (index 0 + 2 inputs) |

About 914 bytes.

### 5.5 Check in (`buildCheckIn`)

| | Inputs | Outputs |
|---|---|---|
| 0 | Escrow coin (unlock `checkIn(1)`) | payout to `P2PKH(organiserPkh)`: `value - minerFee` |
| 1 | ticket at `P2PKH(buyerPkh)` (wallet signs) | keepsake stub: same ticket NFT, its 1,000 sats, back to `P2PKH(buyerPkh)` |

About 1,007 bytes.

### 5.6 Settle (`buildSettle`), anyone

Inputs `0..k-1`: Escrow coins (unlock `settle()`), sequence `0xfffffffe`; coins that owe a no-show fee come first. Locktime defaults to `startHeight + graceBlocks`. Outputs `0..k-1`: refund `value_i - fee_i - share_i` to each coin's buyer. Outputs `k..`: the fee of coin `i` at index `k + i`, for coins that owe one. The miner fee is split evenly across coins (`share_i`). About 772 bytes for one coin, plus about 760 per extra coin.

### 5.7 Refund (`buildRefund`), anyone

Inputs `0..k-1`: Escrow coins (unlock `refund(sig, scope)`). Each coin uses an 'R' notice for its seat if one is given, otherwise the 'C' notice. Outputs `0..k-1`: refund `value_i - share_i` to each buyer. About 839 bytes for one coin, plus about 830 per extra coin.

## 6. Fees and dust

- Miner fee rate: 1 sat per byte by default (`DEFAULT_FEE_RATE`). Builders size P2PKH unlocks at the 108-byte maximum (ECDSA) so the real fee rate is never below the target.
- Change below the dust threshold is left to the miner.
- Every token output: 1,000 sats.
- Escrow paths pay the miner fee out of the coin. The builder refuses (`miner-fee-cap`) if a coin would give up more than `minerFeeCap`. The samples use `minerFeeCap = 5,000` sats; measured single-coin fees are 772-1,007 sats.
- Hand-back and no-show fees are basis points of the coin's value (`price + 1,000` for coins made by `buy`), rounded down, and waived when under 546 sats.

## 7. What a client must verify

- **Genesis.** The category's genesis transaction must create exactly N minting NFTs, all at the show's BoxOffice address, with commitments `01 | i | 0000` for distinct `i`, and no other token of the category. The contracts cannot see genesis; this check is what makes seat ids unique across shards and rules out pre-minted tickets or markers. A client must also recompute both addresses from the posted show parameters.
- **Ticket.** A ticket is live if an Escrow coin with marker `'E' | seat | buyerPkh` exists. The NFT alone proves nothing.

## 8. Limits

Enforced or inherent:
- **"Before the show" cannot be enforced.** BCH locktime is a lower bound only; there is no expiry. `handBack` and `checkIn` work as long as the escrow coin exists, even after the start. Settle becomes possible at `startHeight + graceBlocks`; after that, whoever moves first (holder or anyone settling) decides the path.
- **Prices are in BCH.** A refund returns the same BCH, not the same dollars.
- **Hand-backs do not free a seat.** The seat counter only grows.
- **Per-shard limit: 32,767 seats.** `toPaddedBytes(sold + 1, 2)` fails at 32,768 (VM numbers are signed). Not a business cap; a show with N shards can sell up to 32,767 x N.
- **Buy allows at most 6 outputs** (shard, ticket, escrow, plus 3 for change or data).
- **A ticket moved away from `P2PKH(buyerPkh)`** can no longer check in or hand back. Settle (and any refund) still pays the original buyer.
- **One check-in per transaction.** Each `checkIn` allows exactly one category output (its own keepsake), so two check-ins in one transaction fail. Hand-backs, settles and refunds can be batched.
- **`minerFeeCap` is what the builder can keep, not only what miners get.** In `settle` and `refund`, which anyone can push, the pusher may send up to `minerFeeCap` of each coin to an output of their own. Keep it small.
- **Fees under 546 sats are waived**, not collected (they would be dust).
- **The organiser key can refund (never redirect) money**, and only the holder's signature can release money to the organiser.
- **Coins sent to the Escrow address without a marker are unspendable.** Every path requires a marker.
- **Fee basis points are not range-checked on chain.** The builders refuse a show with fees over 10,000 bps; the app must show the posted fees.
- **Genesis is trusted to be well formed** (section 7). A malformed genesis (duplicate shard bytes, a `sold` field of `0x8000` or more, extra minted tokens) can only give away the organiser's own money or confuse seat numbering; it cannot take a buyer's money.
- **Contention.** Each buy spends and recreates a shard; two buyers on the same shard at once means one wallet must sign again. Shards spread the load.

## 9. Measured sizes and budgets

| Item | Bytes |
|---|---|
| BoxOffice compiled bytecode (no constructor pushes) | 294 |
| Escrow compiled bytecode (no constructor pushes) | 581 |
| BoxOffice redeem script, sample show | 367 |
| Escrow redeem script, sample show | 681 |

Largest unlocking bytecode: `refund`, 752 bytes, against the 10,000-byte standard limit. Highest operation cost measured: about 89,400 per input (refund, two coins), against a per-input budget of `(41 + unlocking length) x 800`, about 634,000 for that input. Redeem scripts above 520 bytes are valid since the May 2025 upgrade (10,000-byte pushes), and pass standard mode in the 2026 VM.

## 10. Code map

- `contracts/BoxOffice.cash`, `contracts/Escrow.cash`: sources. `contracts/*.json`: CashScript artifacts. `npm run compile` rebuilds both and `src/tx/artifacts.js`.
- `src/tx/encoding.js`: commitments, seats, refund notice messages.
- `src/tx/contracts.js`: redeem scripts, P2SH32 locking bytecode, addresses, unlocking bytecode.
- `src/tx/builders.js`: genesis, buy, closeSales, handBack, checkIn, settle, refund.
- `src/tx/vm.js`: evaluates every input and the whole transaction in the 2026 VM, standard and consensus.
- `src/tx/sign.js`: signing with test keys (tests only; builders never sign).
- `test/`: `npm test` runs everything.
