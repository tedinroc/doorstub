# Doorstub specification

Doorstub is an event box office on Bitcoin Cash. Ticket money waits in a contract. The organiser is paid only for each guest who checks in, and the guest's own wallet signs the check-in. After the show, every unused ticket refunds itself to its buyer. Before then, a holder can hand a ticket back for a full refund minus a posted hand-back fee (0 on the sample shows).

This document describes the contracts in `contracts/` and the transaction builders in `src/tx/`. Where a rule is enforced by the contract, it says "enforced". Where only the builders or the app check it, it says "builder". Section 8 lists every limit.

## 1. Conventions

- All contracts are CashScript 0.14 (`cashc 0.14.0`), deployed as P2SH32 (`OP_HASH256 <hash256(redeemScript)> OP_EQUAL`).
- The VM is BCH 2026 (libauth `createVirtualMachineBch2026`). Every transaction in the test suite is evaluated in standard mode and in consensus (non-standard) mode.
- Byte strings are written `a | b` for concatenation. `LE` means little-endian.
- `P2PKH(pkh)` is `OP_DUP OP_HASH160 <pkh> OP_EQUALVERIFY OP_CHECKSIG` (25 bytes).
- **Category byte order.** libauth, explorers and wallets show a token category in display order, which is the genesis input's txid as usually printed. The VM opcodes `OP_UTXOTOKENCATEGORY` and `OP_OUTPUTTOKENCATEGORY` push the reverse (wire order). The `category` constructor argument of both contracts and the refund notice messages use **wire order**. `categoryToVmOrder()` converts.
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
- A ticket is genuine for a seat while a coin at the show's Escrow address carries an immutable NFT **of the show's category** with the matching marker (section 7 gives the full rule). Anyone can mint look-alike tokens of a category of their own with any bytes, and send them to either address, so a check that compares commitment bytes alone proves nothing. After check-in, the ticket remains as a keepsake stub with no money behind it. After a hand-back, settle or refund, the ticket (if still held) is burned or has no matching marker.

## 3. Contracts

### 3.1 BoxOffice

Constructor (declaration order): `category` (bytes32, the show's category in **wire order**), `price` (int, sats), `organiserPk` (33-byte public key), `escrowLockingBytecode` (the show's Escrow P2SH32 locking bytecode, 35 bytes).

All shards of a show share one BoxOffice address; the shard number lives in the commitment. The address commits to the category, so a shard of any other category can never sell here, even one a stranger sends to the address.

**`buy(bytes20 buyerPkh)`**. No signature. All enforced:
1. This input is input 0.
2. Input 0's token category field is exactly `category | 0x02`: a minting NFT of this show's category.
3. Its commitment is 4 bytes with `state = 0x01`.
4. `seat = shard | toPaddedBytes(sold + 1, 2)`.
5. At most 6 outputs. No output at index 3 or higher carries this category.
6. No input other than input 0 is a minting NFT of this category (so two shards cannot be spent in one buy).
7. Output 0: same locking bytecode as input 0, token category field `category | 0x02` (minting), commitment `0x01 | seat` (that is, state open, same shard, `sold + 1`), value at least input 0's value.
8. Output 1: `P2PKH(buyerPkh)`, immutable NFT of `category`, commitment `'T' | seat | buyerPkh`, value at least 1,000.
9. Output 2: `escrowLockingBytecode`, immutable NFT of `category`, commitment `'E' | seat | buyerPkh`, value at least `price + 1,000`.

There is no seat cap (K3) beyond the 16-bit limit in section 8. There is no time check: BCH cannot end sales on chain (section 8).

**`closeSales(sig organiserSig)`**. Enforced:
1. `checkSig(organiserSig, organiserPk)`.
2. Let `idx = this.activeInputIndex`. Input `idx` is a minting NFT of `category`.
3. Output `idx` has the same locking bytecode, the same category and capability as input `idx`, commitment `0x00 | (input idx's commitment without its first byte)`, and value at least input `idx`'s value.
4. Every output that carries this category is at this BoxOffice's locking bytecode with a commitment whose first byte is `0x00`.

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
| `minerFeeCap` | int | the most sats of a coin that may go to the miner fee; whoever builds the spending transaction can burn it but cannot keep it |

One Escrow address per show. Each ticket's money is one coin here, identified by its marker.

Every path starts the same way (enforced): let `idx = this.activeInputIndex` and `n = tx.inputs.length`; input `idx` carries an immutable NFT of `category` whose commitment is `'E' | body` with `body` 23 bytes; `seat` is the first 3 bytes of `body` and `buyerPkh` the last 20. `value` is input `idx`'s value.

**Index rule (enforced, all paths).** The coin's money goes to output `idx`. A fee, when one is due, goes to output `idx + n`. Both indexes are different for every input, so one output can never be counted by two escrow coins (no double satisfaction, in any mix of paths), and fee indexes never collide with payout indexes.

**Fee rule (enforced, handBack and settle).** `fee = floor(value * bps / 10000)`. If `fee < 546`, it is set to 0 and the coin has no fee slot (a smaller output would be dust and non-standard). If `fee > 0`, output `idx + n` must be `P2PKH(organiserPkh)`, carry no token, and hold **exactly** `fee`.

**Slot rule (enforced, all paths).** No path allows an output outside its slots: each coin's payout slot `idx`, its fee slot `idx + n` when it owes a fee, and (hand-back and check-in) the ticket's own slot. A payout may fall short of the coin's due by at most `minerFeeCap`; since no other output can exist, that shortfall can only be miner fee. Whoever builds the transaction chooses how much of the allowance to burn, and nobody can keep any of it (except a builder who mines the block, section 8).

**Token rule (enforced, all paths).** Every payout and fee output carries no token, and so does every other output except the check-in keepsake. So the marker (and in a hand-back the ticket) is always burned, and nobody can attach tokens of another category to a buyer's refund or the organiser's payout.

**`handBack(int ticketInputIndex)`**. The holder hands the ticket back. Enforced:
1. Input `ticketInputIndex` carries an immutable NFT of `category` with commitment `'T' | body` (same seat and buyerPkh as this coin's marker) and its locking bytecode is `P2PKH(buyerPkh)`. So the buyer's own wallet must sign that input.
2. Every input is either at this Escrow's locking bytecode or carries an immutable NFT of `category` (a ticket). No plain coins. The Escrow coins are inputs `0..e-1`, where `e` is how many inputs are at this Escrow (each coin checks `idx < e`).
3. For every input that is not at this Escrow (a ticket), its own output slot, if present, is at that input's locking bytecode and carries no token: a ticket's sats can only go back to where the ticket was.
4. Fee rule with `handBackFeeBps`.
5. Output `idx` is `P2PKH(buyerPkh)`, no token, value at least `value - fee - minerFeeCap`.
6. If a fee is due, at most `n + e` outputs; if not, at most `n + idx` outputs (coins that owe a fee come first, and a fee-free coin's fee slot cannot exist).

"Before the show" is **not** enforced (section 8): hand-back works as long as the escrow coin exists.

**`checkIn(int ticketInputIndex)`** (K1). Enforced:
1. The same ticket-input checks as `handBack` (so only the holder can check in).
2. Exactly two inputs (this coin and the ticket) and exactly two outputs.
3. Output `idx` is `P2PKH(organiserPkh)`, no token, value at least `value - minerFeeCap`.
4. Output `ticketInputIndex` is `P2PKH(buyerPkh)` with an immutable NFT of `category`, the ticket's exact commitment, and a value no more than the ticket input's: the keepsake stub.

With both outputs pinned, the marker is burned and the holder cannot keep any of the organiser's payout.

**`settle()`** (K2). Anyone can push. Enforced:
1. `tx.time >= startHeight + graceBlocks` (`OP_CHECKLOCKTIMEVERIFY`, block height). The transaction's locktime must be at least that height, and the input's sequence number below `0xffffffff`. A transaction with locktime `L` can be mined from block `L + 1`, so settling opens at block `startHeight + graceBlocks + 1`.
2. Every input is a coin at this Escrow's locking bytecode.
3. Fee rule with `noShowFeeBps`.
4. Output `idx` is `P2PKH(buyerPkh)`, no token, value at least `value - fee - minerFeeCap` and at most `value - fee`.
5. If a fee is due, at most `2n` outputs; if not, at most `n + idx` outputs (coins that owe a fee come first).

**`refund(datasig organiserDataSig, bytes1 scope)`** (K5). Anyone can push. Enforced:
1. `scope` is `0x43` ('C') or `0x52` ('R').
2. The message is `'C' | category` (33 bytes, whole show) or `'R' | category | seat` (36 bytes, this seat only), with `category` in wire order.
3. `checkDataSig(organiserDataSig, message, organiserDataPk)`. A data signature is a 64-byte Schnorr (or DER ECDSA) signature over `sha256(message)`.
4. Every input is a coin at this Escrow's locking bytecode, and there are at most `n` outputs.
5. Output `idx` is `P2PKH(buyerPkh)`, no token, value at least `value - minerFeeCap` and at most `value`.

The organiser key can refund money to buyers; it can never redirect it: every output of a refund is a payout to its own coin's buyer.

**Why every output is accounted for.** `handBack` and `checkIn` each need a ticket input at a P2PKH address, so in a transaction whose inputs are all Escrow coins every input runs `settle` or `refund`; each pins its payout slot, a fee-owing settle pins its fee slot, a fee-free settle forbids its fee slot and everything after it, and refund forbids fee slots. In a hand-back, Escrow coins come first and pin their payout and fee slots, every other input is a ticket whose slot returns to it, and no output lies beyond the last fee slot. A check-in has two outputs, both pinned. The test suite pins each case (section 11).

There is no other Escrow path. In particular there is no "organiser collects after the start" path: the organiser is paid only through `checkIn`, and through posted fees.

## 4. Unlocking bytecode

As CashScript encodes it (the test suite checks byte equality against the CashScript SDK):

- Redeem script: constructor arguments pushed in **reverse** declaration order, then the compiled bytecode. Integers are minimal VM numbers; all pushes are minimal.
- Unlocking bytecode: function arguments pushed in reverse order, then the function selector (BoxOffice: `buy` 0, `closeSales` 1; Escrow: `handBack` 0, `checkIn` 1, `settle` 2, `refund` 3), then the redeem script.
- Examples: `buy` unlocks with `<buyerPkh> OP_0 <redeemScript>`; `checkIn` with ticket at input 1 unlocks with `OP_1 OP_1 <redeemScript>`; `refund` unlocks with `<scope> <datasig> OP_3 <redeemScript>`.

Contract inputs need no signature except `closeSales` (organiser's transaction signature, SIGHASH_ALL | UTXOS | FORKID = `0x61` in the builders, any valid type accepted by the contract).

## 5. Transaction shapes (builders)

All builders are pure functions in `src/tx/builders.js`. A UTXO is `{ txid, vout, output }`, with `txid` in display order and `output` a libauth `Output`. Each builder returns `{ kind, transaction, sourceOutputs, walletInputIndexes, fee, ... }`. Contract inputs carry final unlocking bytecode. Inputs in `walletInputIndexes` are P2PKH coins with empty unlocking bytecode, for the owner's wallet to sign. Transactions are version 2.

Every builder refuses (builder) to return a transaction with a negative output (`negative-output`), an output below its dust threshold (`dust-output`; 0 for an OP_RETURN data output), or more than 100,000 bytes with wallet inputs at their largest signed size (`tx-too-large`). Every builder checks the show against the policy (section 6) unless the caller hands it a ready `contracts` object; `buildBuy` always checks it.

Sizes below are measured on a sample show (price 10,000, `minerFeeCap` 1,500) with Schnorr signatures (`npm test` builds all of them).

### 5.1 Genesis (`buildGenesis`), offline

| | Inputs | Outputs |
|---|---|---|
| 0 | organiser coin; must be output 0 of its transaction; its txid becomes the category | shard 0: BoxOffice, 1,000 sats, minting NFT `01 \| 00 \| 0000` |
| 1..N-1 | more organiser coins (optional) | shard i: BoxOffice, 1,000 sats, minting NFT `01 \| i \| 0000` |
| next | | optional data output (for example a BCMR OP_RETURN), 0 sats |
| last | | change to the organiser, if at least dust |

Returns an **unsigned** template plus the derived show parameters and contracts. It never signs. The data output must be `OP_RETURN` followed only by pushes, at most 222 bytes (builder, `bad-data-output`). About 517 bytes with 4 shards.

**Identity output (optional, `identityLockingBytecode`).** When given, output 0 is a plain 1,000-sat coin to that locking bytecode and the shards move to outputs `1..N` (`shardVouts` in the result says where). BCMR wallets follow output 0 from the category's parent transaction (the authbase) and read the token's metadata from the transaction whose output 0 is still unspent (the authhead). Without this output, output 0 is shard 0, which every buy on that shard spends: the metadata would disappear after the first sale on shard 0, and a buyer could add a `BCMR` OP_RETURN to a buy (outputs 3 to 5 are free) and publish their own name and icon for the show's tickets. The studio always passes its identity key here and never spends that coin, so the genesis stays the authhead. The contracts and `verifyGenesis` do not depend on where the shards sit.

**Studio genesis (`studio/`, section 10).** For each show the studio first sends a prep transaction (studio coins to the studio address at output 0, change at output 1 funding the next prep), so the genesis input is output 0 of a known transaction; its txid is the category. The genesis carries `OP_RETURN 'BCMR' <sha256 of the registry file> <uri>`, with the uri `<origin host>/bcmr/<category>.json` (no `https://`, which BCMR assumes), and the registry parses each NFT into its type (`'T'` ticket or `'E'` marker), the show's seat letter (fixed per registry), box-office number, seat number and buyer key hash; the letter, box office and seat are the site's seat label `<letter>-<box office>-<seat>`.

### 5.2 Buy (`buildBuy`)

| | Inputs | Outputs |
|---|---|---|
| 0 | BoxOffice shard (unlock `buy(buyerPkh)`) | shard, same value, `sold + 1` |
| 1 | buyer coin (wallet signs) | ticket to `P2PKH(buyerPkh)`, 1,000 sats |
| 2 | more buyer coins (optional, wallet signs) | Escrow coin with marker, `price + 1,000` sats |
| 3 | | change to the buyer, if at least dust |

Funding coins must carry no tokens, and there are at most 50 of them (builder, `too-many-inputs`; `BoxOffice.buy` loops over every input, and 50 coins use about a third of its operation-cost budget). The buyer pays `price + 2,000` sats plus the miner fee.

Sales end (builder): `buildBuy` requires `currentHeight`, the chain tip (`no-height`), and refuses when `currentHeight >= startHeight` (`sales-ended`). It also takes the `notices` the app knows of and refuses once a valid `'C'` notice exists (`sales-cancelled`; a notice whose signature does not verify against `organiserDataPk` is `bad-notice`). The chain cannot enforce either rule (section 8). About 923 bytes with one buyer coin.

### 5.3 Close sales (`buildCloseSales`)

Inputs `0..k-1`: shards (unlock `closeSales(sig)`); then organiser coins (wallet signs). Outputs `0..k-1`: the same shards, closed; then change. The organiser's signature comes from a caller-supplied callback `signShard({ digest, inputIndex })`; the builder holds no key. About 772 bytes for one shard.

### 5.4 Hand back (`buildHandBack`)

| | Inputs | Outputs (fee 0) | Outputs (fee > 0) |
|---|---|---|---|
| 0 | Escrow coin (unlock `handBack(1)`) | refund to `P2PKH(buyerPkh)`: `value + 1,000 - minerFee` | refund: `value - fee - minerFee` |
| 1 | ticket at `P2PKH(buyerPkh)` (wallet signs) | | the ticket's 1,000 sats back to the buyer |
| 2 | | | fee to `P2PKH(organiserPkh)`, exactly `fee` (index 0 + 2 inputs) |

About 965 bytes (1,037 with a fee).

### 5.5 Check in (`buildCheckIn`)

| | Inputs | Outputs |
|---|---|---|
| 0 | Escrow coin (unlock `checkIn(1)`) | payout to `P2PKH(organiserPkh)`: `value - minerFee` |
| 1 | ticket at `P2PKH(buyerPkh)` (wallet signs) | keepsake stub: same ticket NFT, its 1,000 sats, back to `P2PKH(buyerPkh)` |

Exactly these two inputs and two outputs (enforced). About 1,058 bytes; its miner fee, counted with a 108-byte signature placeholder, is 1,066 sats at 1 sat/byte.

### 5.6 Settle (`buildSettle`), anyone

Inputs `0..k-1`: Escrow coins (unlock `settle()`), sequence `0xfffffffe`; coins that owe a no-show fee come first (enforced). Locktime defaults to `startHeight + graceBlocks`. Outputs `0..k-1`: refund `value_i - fee_i - share_i` to each coin's buyer. Outputs `k..`: the fee of coin `i` at index `k + i`, exactly, for coins that owe one. The miner fee is split evenly across coins (`share_i`). Nothing else: no outside coin can be added (enforced). At most 100 coins per transaction (builder, `batch-too-large`). About 823 bytes for one coin (861 with a fee), plus about 813 per extra coin.

### 5.7 Refund (`buildRefund`), anyone

Inputs `0..k-1`: Escrow coins (unlock `refund(sig, scope)`). Each coin uses an 'R' notice for its seat if one is given, otherwise the 'C' notice. Outputs `0..k-1`: refund `value_i - share_i` to each buyer, and nothing else (enforced). At most 100 coins per transaction (builder, `batch-too-large`). About 890 bytes for one coin, plus about 880 per extra coin.

## 6. Fees, dust and show policy

- Miner fee rate: 1 sat per byte by default (`DEFAULT_FEE_RATE`). Builders size P2PKH unlocks at the 108-byte maximum (ECDSA) so the real fee rate is never below the target.
- Change below the dust threshold is left to the miner.
- Every token output: 1,000 sats.
- Escrow paths pay the miner fee out of the coin, and settle and refund cannot take a fee coin from anyone else (enforced). The builder refuses (`miner-fee-cap`) if a coin would give up more than `minerFeeCap`.
- Hand-back and no-show fees are basis points of the coin's value (`price + 1,000` for coins made by `buy`), rounded down, and waived when under 546 sats. A fee that is due is paid exactly.

**Show policy (builder).** The contracts take any parameters. `validateShow`, which every builder and `verifyGenesis` call, refuses a show outside these bounds (`bad-show`, constants in `src/tx/constants.js`):

| Parameter | Bound | Why |
|---|---|---|
| `minerFeeCap` | at least 1,200 sats | the largest single-coin Escrow transaction at 1 sat/byte is a check-in, 1,066 sats on the sample show and 1,071 with the largest parameters the policy allows; below this some path could not pay its own fee |
| `minerFeeCap` | at most 2,000 sats and at most 20% of `price` | it is what a sender may burn from each ticket |
| `handBackFeeBps`, `noShowFeeBps` | at most 1,000 (10%) each | the headline says unused tickets refund |
| `price` | at least 6,000 sats | follows from the two cap bounds (1,200 is 20% of 6,000) |
| `startHeight + graceBlocks` | below 500,000,000 | a block height, not a time |

The samples use `minerFeeCap = 1,500`. Measured single-coin miner fees at 1 sat/byte: settle 823, refund 890, hand-back 973 (1,046 with a fee output), check-in 1,066.

With these bounds every honest output is far above the 546-sat dust threshold. The smallest coin holds `price + 1,000 >= 7,000` sats; the smallest posted fee that is due is 546 and the largest is 10% of the coin; the miner fee is at most `minerFeeCap <= 20%` of the price. So a settle or hand-back refund is at least `0.9 x 7,000 - 1,200 = 5,100` sats, a refund at least `7,000 - 1,200 = 5,800`, and a check-in payout at least `7,000 - 1,200 = 5,800` (`test/policy.test.js` builds every path at these edges).

## 7. What a client must verify

- **Genesis.** The category's genesis transaction must create exactly N minting NFTs, all at the show's BoxOffice address, with commitments `01 | i | 0000` for distinct `i`, no other token of the category (no tickets, markers or fungible amounts), and no token of any other category. The contracts cannot see genesis; this check is what makes seat ids unique across shards and rules out pre-minted tickets or markers. A client must also recompute both addresses from the posted show parameters: the BoxOffice address commits to the category and to the Escrow address, which commits to the category too. `BoxOffice.buy` refuses a shard of any other category on chain, so a planted or mis-made shard can never sell. `verifyGenesis({ show, transaction, txid })` in `src/tx/verify.js` does all of this and checks the show against the policy (`test/genesis.test.js`).
- **Which genesis.** `verifyGenesis` checks the transaction it is given and returns its txid. Two different transactions can spend the category's parent outpoint, and only one is ever mined, so a client must take the genesis from a source independent of the show page and the organiser (its own node or indexer), require it to be confirmed on chain, and pass that txid as `txid` (the call refuses any other transaction, `genesis-txid-mismatch`). It takes the decoded transaction or its raw bytes.
- **Shards.** Anyone can send look-alike tokens of their own category to the BoxOffice address. A client that lists coins there must keep only minting NFTs of the show's category. (`buildBuy` refuses any other coin, and `BoxOffice.buy` would fail on it.)
- **Sales end.** BCH cannot end sales on chain. The app passes the chain tip and the cancel notices it knows of to `buildBuy`, which refuses at or after `startHeight` and after a valid `'C'` notice. At the start, or with a cancel, the organiser's app or keeper (it needs the organiser key) closes every shard with `closeSales`, and signs again if a buy spends a shard first.
- **Wallet signatures.** A holder's ticket input must be signed with `SIGHASH_ALL` (`0x41`, or `0x61` with `SIGHASH_UTXOS`). A signature with `SIGHASH_NONE | SIGHASH_ANYONECANPAY` can be lifted into another transaction, for example to turn a hand-back into a check-in (pinned in `test/attacks-escrow.test.js`). A client should check the sighash byte of every wallet signature before sending a transaction. That check only helps if the wallet never broadcasts on its own: the app must ask with `broadcast: false`, check the reply, and send the checked transaction itself. `checkSignedReply` (`src/wallet/check.js`) does this for every builder result with wallet inputs (outputs byte-equal, contract inputs untouched, sighash `0x41`/`0x61` only, each key hashes to its coin's address, whole transaction valid in the 2026 VM with our source outputs), and the pool's `broadcastChecked` sends only a transaction that came out of such a check (`src/chain/checked.js`).
- **Which chain.** Before the first broadcast through a server, the pool asks `server.features` for its `genesis_hash`. A simnet pool refuses a server that reports the BCH mainnet genesis, so a test or E2E run cannot send to mainnet through a wrong URL; a mainnet pool refuses a server that reports any other chain. Either refusal is `BroadcastError` code `wrong-chain`, and nothing is sent to any server (`test/chain/pool.test.js`, `test/integration/simnet-flow.test.js`). The studio applies the same rule when it opens a network (`studio/lib/net.js`).
- **Ticket.** A ticket is live, for a door or an app, only if all of these hold (`src/chain/ledger.js` implements them for the app: the shows loader recomputes the Escrow address, `classifyShowTransaction` keeps only markers of the show's category with at least `price + 1,000` sats, and `myTickets` allows hand-back and check-in only for a ticket at `P2PKH(buyerPkh)`):
  1. The Escrow address is recomputed from the posted show parameters.
  2. A coin at that address carries an immutable NFT of the **show's category** (not just the same bytes) with commitment `'E' | seat | buyerPkh`, and holds at least `price + 1,000` sats. Only `BoxOffice.buy` can put a show-category token at the Escrow, so the category is what rules out look-alikes; the other two conditions are extra guards.
  3. The presented ticket is an immutable NFT of the show's category with commitment `'T' | seat | buyerPkh`. To check in, it must sit at `P2PKH(buyerPkh)`; a ticket moved away keeps a live marker but cannot check in (section 8).

  A door may instead evaluate the holder-signed check-in in the 2026 VM, but only with source outputs from its own UTXO lookup (not from the person at the door), and should count entry only once the network has accepted that check-in, since the same signed transaction can be shown twice before it is sent. The NFT alone proves nothing.

## 8. Limits

Enforced or inherent:
- **"Before the show" cannot be enforced.** BCH locktime is a lower bound only; there is no expiry. `handBack` and `checkIn` work as long as the escrow coin exists, even after the start. Settle becomes possible at `startHeight + graceBlocks`; after that, whoever moves first (holder or anyone settling) decides the path.
- **Sales cannot end on chain.** `buy` has no time check, and a shard sells until it is closed. `buildBuy` refuses at or after `startHeight` and after a valid `'C'` notice, but only for clients that use it; `closeSales` needs the organiser key, so the organiser's app or keeper closes every shard at the start, and a buy already in flight can still land first. A buyer who buys late anyway can be settled at once: in settle mode they lose the posted no-show fee plus up to `minerFeeCap` (burned as miner fee); in refund mode up to `minerFeeCap`. A `'C'` notice also refunds seats sold after it was signed.
- **Prices are in BCH.** A refund returns the same BCH, not the same dollars.
- **Hand-backs do not free a seat.** The seat counter only grows.
- **Per-shard limit: 32,767 seats.** `toPaddedBytes(sold + 1, 2)` fails at 32,768 (VM numbers are signed). Not a business cap; a show with N shards can sell up to 32,767 x N.
- **Buy allows at most 6 outputs** (shard, ticket, escrow, plus 3 for change or data), and `buildBuy` takes at most 50 funding coins.
- **A ticket moved away from `P2PKH(buyerPkh)`** can no longer check in or hand back. Settle (and any refund) still pays the original buyer.
- **A check-in is a transaction of its own**: exactly two inputs and two outputs. Hand-backs can be batched with each other; settles and refunds can be batched together; a hand-back cannot share a transaction with a settle or a refund (settle and refund take only Escrow coins).
- **Batches.** At most 100 coins per settle or refund transaction (builder). At the largest show parameters 100 coins are about 85,200 bytes (settle with a no-show fee) and 88,500 bytes (refund), under the 100,000-byte standard limit, at about 36% of each input's operation-cost budget. A keeper sends several transactions for a bigger show.
- **`minerFeeCap` is a burn allowance, not a skim allowance.** Whoever builds a settle or refund (anyone), or a hand-back or check-in (the holder), sets the miner fee, up to `minerFeeCap` per coin. No path allows an output that could take the rest (pinned in the attack suite), so nobody can keep it, but a griefer can burn it, and a sender who mines the block, or has a rebate from a miner, can collect it. The policy keeps the cap between 1,200 and 2,000 sats and at most 20% of the price; the samples use 1,500.
- **Escrow transactions take no outside coin.** Settle and refund take only Escrow coins, a check-in only its coin and ticket, and a hand-back only coins and tickets, so each coin pays its own miner fee, capped by `minerFeeCap`. If the relay fee rate ever rose above about `minerFeeCap` divided by the transaction size (for a lone check-in, 1,200 / 1,071, about 1.1 sat/byte at the minimum cap; about 1.3 for a lone refund), the builders would refuse and those coins would wait; batching spreads the fixed part of a settle or refund.
- **Fees under 546 sats are waived**, not collected (they would be dust).
- **The organiser key can refund (never redirect) money.** A ticket's price reaches the organiser only through a check-in the holder signs; the only other money the organiser can receive is the posted hand-back and no-show fees (0 on the samples), each exactly as posted.
- **Coins sent to the Escrow address without a marker of the show's category are unspendable.** Every path requires a marker of the show's category; look-alike tokens of another category sent there are stuck for good.
- **Fee basis points are not range-checked on chain.** The policy refuses fees over 1,000 bps (10%), but a show deployed by hand could post more, so the app must show the posted fees.
- **Genesis is trusted to be well formed** (section 7). A malformed genesis (duplicate shard bytes, a `sold` field of `0x8000` or more, extra minted tokens) can give away the organiser's own money or confuse seat numbering. It cannot lock or take a buyer's money: `BoxOffice` commits to the show's category, so a shard of any other category (from a genesis with two categories, or planted later by anyone) can never sell. `verifyGenesis` refuses all of these.
- **closeSales may leave extra closed tokens at the BoxOffice.** Every category output of `closeSales` must sit at the BoxOffice in the closed state, so the organiser can park extra closed minting NFTs there with their own sats. Closed is final: they can never sell, and nothing can move them out.
- **Plain coins sent to the BoxOffice address are unspendable** (both paths need a token of the show's category).
- **Contention.** Each buy spends and recreates a shard; two buyers on the same shard at once means one wallet must sign again. Shards spread the load.

## 9. Measured sizes and budgets

| Item | Bytes |
|---|---|
| BoxOffice compiled bytecode (no constructor pushes) | 285 |
| Escrow compiled bytecode (no constructor pushes) | 632 |
| BoxOffice redeem script, sample show | 391 |
| Escrow redeem script, sample show | 732 |

Largest unlocking bytecode: `refund`, 803 bytes, against the 10,000-byte standard limit. Highest operation cost measured: 247,431 for one input of a 100-coin refund, against that input's budget of `(41 + unlocking length) x 800` = 679,200 (36%); 220,967 of 625,600 for a 100-coin settle with a no-show fee; 125,954 of 366,400 for the BoxOffice input of a buy with 50 funding coins (`test/limits.test.js`). Redeem scripts above 520 bytes are valid since the May 2025 upgrade (10,000-byte pushes), and pass standard mode in the 2026 VM.

## 10. Code map

- `contracts/BoxOffice.cash`, `contracts/Escrow.cash`: sources. `contracts/*.json`: CashScript artifacts. `npm run compile` rebuilds both and `src/tx/artifacts.js`.
- `src/tx/encoding.js`: commitments, seats, refund notice messages.
- `src/tx/contracts.js`: redeem scripts, P2SH32 locking bytecode, addresses, unlocking bytecode.
- `src/tx/builders.js`: genesis, buy, closeSales, handBack, checkIn, settle, refund, and `verifyRefundNotice`.
- `src/tx/constants.js`: layout constants, the show policy bounds (section 6) and the relay and batch limits.
- `src/tx/vm.js`: evaluates every input and the whole transaction in the 2026 VM, standard and consensus.
- `src/tx/sign.js`: signing with test keys (tests only; builders never sign).
- `src/tx/verify.js`: `verifyGenesis`, the client-side genesis check (section 7).
- `src/chain/`: the Fulcrum client for browser and Node. `pool.js` (servers with failover, timeouts, keepalive, header and script-hash subscriptions that survive a failover, read methods only, and `broadcastChecked` to two servers of different operators), `checked.js` (the VM gate that brands a transaction as broadcastable; the pool also checks each server's chain before broadcasting through it, section 7), `tokens.js` (Fulcrum `token_data` and UTXO shapes to libauth and back, pinned by `test/fixtures/fulcrum-mainnet.json`), `address.js` (cashaddr, script hashes), `queries.js` (UTXOs, history, hash-checked transactions), `classify.js` (the path of every contract input, from its unlocking bytecode), `ledger.js` (a show's escrow coins and their states from the Escrow address's history; proof-strip totals; "My tickets").
- `src/wallet/`: `session.js` (WizardConnect dapp session: pairing, remembered pairing, one sign request at a time, cancel, wrong-network refusal, and the late-join nudge: `@wizardconnect/dapp` 0.2.7 stops waiting for the wallet's key exchange 30 s after the relay connects, so when a wallet completes it later the session re-runs the library's "connected" handler, which sends `dapp_ready`; pinned by `test/wallet/late-join.test.js` with a wallet that joins after 45 s), `hd.js` (xpub addresses, gap-limit scan), `coins.js` (smallest plain-coin set), `request.js` (sign requests, always `broadcast: false`), `check.js` (`checkSignedReply`).
- `src/shows/`: `schema.js` (`shows.json` loader: recomputes both contracts and refuses a show whose posted `derived` fields differ; notices), `event.js` (a real show's call: `eventAt` as an ISO UTC time, `durationMin` from 1 to 600, and its own `seatPrefix`, one capital letter other than the samples' A and B and unique in the file; read the same way by the loader, the worker and the studio), `genesis.js` (`verifyShowGenesis`: genesis fetched by txid, hash-checked, verified, confirmed), `schedule.js` (sales windows, next open sample instance), `format.js` (BCH and dollar amounts, seat labels, wallet prompts).
- `simnet/`: a local Fulcrum-compatible JSON-RPC-over-WebSocket server over an in-memory chain (`npm run simnet`). Every broadcast is checked as a BCHN node would (inputs exist and are unspent, mempool conflicts, locktime and BIP68 against the next block, relay fee) and evaluated in the 2026 VM in standard mode with the real source outputs; refusals carry the VM's text in Fulcrum's error shape. Response shapes are pinned against real mainnet answers in `test/fixtures/fulcrum-live/` (`simnet/README.md`).
- `studio/`: the organiser CLI (`npm run studio -- keygen | plan | genesis | close | status | simnet-bootstrap`); writes `shows.json` and the BCMR files; keeps the sales key, the samples' data key, the real shows' data key and the identity key in `.secrets/studio.json`; computes a real show's `startHeight` from its call when the schedule leaves it out (the end of the call plus 6 blocks); nothing is sent without `--broadcast`, and on mainnet only after typing `BROADCAST` (`studio/README.md`).
- `app/`: the public site (Vite + Preact; `npm run app`, `npm run app:sim`, `npm run app:build`). `app/src/lib/controller.js` is the whole flow without a DOM: it loads `shows.json`, verifies each show's genesis, follows the tip, pairs the wallet, and runs buy, hand back, walk in (the wallet signs the check-in; after `assertSignedReply`, when only the page knows its txid, the page reserves its door claim with `POST /api/door {category, txid, claim, reserve: true}` (`api.doorReserve`: one try, 4 s; any failure is logged and the check-in is sent anyway), then sends the check-in and asks `POST /api/door` with the same random claim secret, which it keeps in local storage for that check-in, so a retry or a reload gets the link again; a `409 already-answered` gets its own sentence and is never retried), the sample B refund (`POST /api/notice` naming the buy's txid, the notice checked against the show's data key, `buildRefund`, VM check, broadcast) and the page's own settle push for shows past their grace. A buy refused as a conflict reads the wallet's coins and the open shards again before it asks once more (and says which input lost the race); a hand-back or walk-in refused as a conflict reads the show's ledger and, when another transaction spent the coin first, says so and shows that spend. A buy that finds too little plain BCH shows the wallet's first unused receive address (Copy, a QR with the amount), watches it (a script-hash subscription and every new block) and runs the buy again once the coins arrive; the wallet still approves it. A show whose sales ended stays on the page while the wallet has a ticket to watch there (`listedShows` in `app/src/lib/view.js`), so a ticket does not vanish at the start and its refund arrives on the card. A wallet reply reaches the network only through `assertSignedReply` and `broadcastChecked`; a settle or refund only through `checkSignatureFree`. The sample B refund is paced for reading (`PRINT_MS`, then at least `STEP_MS` for each of held, organiser notice and refund sent; the card keeps "held" until "Money back"). A real show's `eventAt` and `durationMin` give the card a Call row and a held ticket a countdown to the call, in the reader's own zone (`callOf` in `app/src/lib/view.js`); its `startHeight` reads as the end of sales and walk-in. Cards keep `shows.json` order. A finished ticket also says what the buy cost the wallet (its inputs less its change, kept per buy txid). `app/src/lib/runtime.js` pins production to mainnet, `MAINNET_SERVERS`, our own `/api/*` and `/shows.json`; the simnet overrides (`?fulcrum=`, `api=`, `shows=`, `usd=`, and for the E2E `relay=` and `pagekeeper=0`, all local addresses only) exist only behind a build-time flag that is `false` in production, and `scripts/check-app-dist.js` greps `app/dist` to prove it. Every sentence on the site is in `app/src/lib/copy.js` and in `CLAIMS.md` section 9 (`test/app/copy.test.js`). `app/src/config.js` holds the BLAZE banner links and the donation address; `npm run app:build` fails while any of them is empty, unless `DOORSTUB_ALLOW_PLACEHOLDERS=1` (a preview build). The display face (Barlow Condensed 800, OFL) is self-hosted from `app/public/fonts/`. `npm run e2e -- --screens` takes every step at 360x740, 375x667, 390x844 and 1440x900 in light and dark into `.cache/screens/`.
- `worker/`: the server side (section 12). `lib/` is runtime-agnostic and imports no libauth (Cloudflare's workerd refuses WebAssembly compiled from bytes): `api.js` (routes), `notice.js` (the `'R'` notice signer), `door.js`, `keeper.js`, `escrow.js` (settle and refund, byte-equal to `src/tx`), `rules.js` (the check before broadcast), `chain.js` (Fulcrum over `src/chain/electrum.js`), `tx.js`, `script.js`, `crypto.js` (`@noble/*`), `shows.js`, `config.js`, `limits.js`. Adapters: `functions/api/[[route]].js` -> `pages.js` (Pages Functions), `cron.js` + `wrangler.toml` (the cron-only keeper Worker), `node/` (tests, `npm run worker:dev`, which can also serve the built site and `shows.json` on the same origin for the simnet E2E, `npm run keeper`, plus the libauth VM); `npm run worker:workerd-check` runs both Cloudflare adapters in local workerd against a simnet. `worker/RUNTIME.md` has the runtime check, the API and the abuse review.
- `test/`: `npm test` runs everything. `happy.test.js` and `sanity.test.js` cover the honest paths and the harness; `attacks-boxoffice.test.js`, `attacks-escrow.test.js` and `genesis.test.js` are the attack suite (section 11); `policy.test.js` covers the show policy, the sales-end guard and the builders' dust guard; `limits.test.js` measures the fee floor, the batch caps and the operation-cost budgets; `kit.js` builds hand-made attack transactions over made-up coins. `test/chain`, `test/wallet` and `test/shows` cover the client libraries over an in-memory Fulcrum (`test/support/fake-fulcrum.js`), the simulated wallet (`test/support/sim-wallet.js`) and a local Nostr relay (`test/support/local-relay.js`); `test/simnet` and `test/studio` run the simnet and the studio end to end, `test/integration` runs a whole studio-to-ticket flow on simnet with the client libraries and the site's controller against the real worker handlers and one keeper pass, and `test/worker` runs the worker's builders against `src/tx` and its endpoints and keeper on simnet; `test/app` runs the site's controller on simnet with the sim wallet (buy, hand back, the sample B refund, the page's settle, the stuck states) and checks its view models, worker client, CSP and wording; tests that use the internet are skipped unless `DOORSTUB_NET=1`. `npm run e2e` (not in `npm test`) builds the site in simnet mode, serves it from the worker's Node adapter (the real `/api/notice` and `/api/door`) next to an in-process simnet with the studio's genesis, and drives headless Chrome through the judge path with the sim wallet over the public WizardConnect relay (one retry on the other relay, then a local relay, logged): buy, hand back, the sample B refund, walk in and the door link, and a started show settled by one keeper pass, each step checked in the DOM and in the simnet's own state; screenshots at 390x844 and 1440x900 go to `.cache/e2e/screens/`.
- `scripts/`: `compile.js`, `check-app-dist.js` (the production bundle has no test overrides, local addresses, paths or handles), `check-hygiene.js` (`npm run check:hygiene [-- --history]`: tracked files, and with `--history` every commit, are free of local paths, other handles, e-mail addresses and co-author trailers; the words come from `scripts/hygiene-words.js` at run time and the gitignored `.secrets/hygiene-words.txt`), `app-sim.js`, `make-icons.js`.
- `ARCHITECTURE.md`: one page on the components, the money flow, who can do what, and what the chain enforces against what the app enforces.

## 11. Attack suite

Every attack is a hand-built transaction, usually one change away from an honest control that passes. Each case asserts that the 2026 VM rejects it in **both** standard and consensus mode, and names the input that must fail while every other input passes, so the rejection is pinned on that input's own rule rather than on a stale signature or a value error. Attacks stopped by consensus token rules (fungible amounts after genesis) assert the whole-transaction error instead. A few `genesis.test.js` cases are refused by `verifyGenesis` rather than the VM, because the contracts never see genesis. `LIMIT` cases are accepted on purpose: they pin the limits in section 8 so a behaviour change shows up as a failing test.

Counts at this commit: the three attack files hold 175 tests: 143 attacks the VM must refuse in both modes (`attacks-boxoffice` 47, `attacks-escrow` 93, `genesis` 3), 13 attacks refused before the VM (12 by `verifyGenesis`, 1 by the commitment encoder), 11 honest controls, 7 `LIMIT` pins and 1 kit self-check.

Covered (brief K8 list first): extra mint (outputs 3 and 5), minting capability leaked to outputs 1 or 2, wrong category (ticket and marker), seat reuse (counter not advanced, counter rolled back, old seat re-sold, shard byte rewritten; across shards via genesis in `genesis.test.js`), buy not at input 0, two shards in one transaction, a leaked minting input, output-count overflow, double satisfaction in hand-back, check-in, settle, refund and mixed paths, fee drain one satoshi past `minerFeeCap` in every path, a skim inside the cap in every path (an extra output, an outside coin added to open a slot, a fee output padded above the posted fee, a fee-free coin's fee slot, a batch pusher's or organiser-buyer's payout above its own coin, the organiser cancelling and paying himself, a third output or a fat keepsake in a check-in), tokens of another category on any payout or fee output, wrong payout or refund address in every path, ticket-marker mismatch (seat, pkh, category, capability), check-in and hand-back by a non-holder (ticket moved, or wrong key), settle one block early, fees above the posted bps, missing, short, misdirected or double-counted fee outputs, refund notices over the wrong scope, seat, shard, category, byte order or key, and replayed on another show of the same organiser, 41-byte ticket and marker commitments (the 2026 VM allows 128 bytes, so the contracts are what stop them), closeSales without the organiser key, with an empty or replayed signature, reopening, leaking, minting or spawning an open shard, closeSales on a shard of another category, and buy after closeSales. Genesis: a shard of another category at the BoxOffice, a stranger planting one at a live show, a genesis that also mints a second category, and a look-alike genesis against the mined txid. A show deployed by hand with a 1,000,000-sat cap: the organiser cannot take the coin through a cancel, nor a stranger through a settle.

Further: a ticket or marker sent to another pkh than its twin, a marker kept by the buyer or sent to another show's Escrow, ticket and marker swapped, the marker or ticket surviving a payout path, a keepsake sent elsewhere, missing, at the wrong index or re-labelled as a marker, a used keepsake replayed on another seat, two check-ins in one transaction, a check-in mixed with a hand-back or settle, a hand-back batched with a settle and a refund, an escrow coin after its own ticket, a buy that also settles a coin, a settle that also mints, timestamp locktimes and final sequence numbers, wrong argument sizes and unknown function selectors, the per-shard seat limit, a hand-back signature lifted into a check-in, and coins at either address that no path can spend.

## 12. Worker: refund-notice signer, door, keeper

The worker (`worker/`, `worker/RUNTIME.md`) runs as Cloudflare Pages Functions on the site's origin, as a cron-only Worker every 5 minutes, and in Node for tests. It holds the samples' data key (`STUDIO_DATA_KEY`) and, for real shows, the event links (`DOOR_LINKS`). It never holds a sales key, a wallet key or the real shows' data key: the studio plans every `real` show with a second data key (`realData` in `.secrets/studio.json`) that stays in the studio, so `/api/health` `signer.alsoKeyOf` is empty.

- **Runtime.** workerd refuses to compile WebAssembly from bytes, so libauth cannot load there (checked with `wrangler dev`, RUNTIME.md section 1). The worker uses `@noble/hashes` and `@noble/curves`, its own transaction codec and its own settle and refund assembler. Every show's redeem scripts are recomputed from the posted parameters and must equal shows.json's `derived` fields. The assembler's bytes equal `buildSettle` and `buildRefund` (`test/worker/assemble.test.js`, with the libauth VM over every result).
- **Notice signer** (`POST /api/notice`). Signs `'R' | category | seat` (ECDSA, DER, low S, deterministic) only for a show of kind `sample-refund-seat`, only with that show's `organiserDataPk`, and only for a seat whose buy the network knows: the buy the caller names by txid (read from the network, with the seat's marker among its outputs), or a marker of that category unspent at the Escrow (mempool counted). The txid path does not check that the marker is still unspent, so a seat already handed back or refunded can get its notice again; it opens nothing, since seat numbers never repeat. Never `'C'`, never another show, never caller-supplied bytes. An `'R'` notice can only refund that seat's coin to its buyer (section 3.2), so nothing it signs can move money anywhere else.
- **Door** (`POST /api/door`). For a show of kind `real`: reads the check-in by txid from the network (so it is in the mempool or a block, and the network ran its scripts), reads the coins it spends from the network, checks the check-in rules of section 3.2 against this show (input 0 a marker coin at this Escrow with `checkIn(1)`, input 1 the matching ticket at `P2PKH(buyerPkh)`, output 0 to the organiser payee at least the coin's value less `minerFeeCap`, output 1 the ticket's exact NFT back to the buyer), runs the 2026 VM where the runtime has it (Node), and gives the show's link to one claimant per check-in. The page reserves the check-in first: once the wallet's signed check-in passed its checks, and before it sends it, it posts `{ category, txid, claim, reserve: true }`, and the door stores a hash of the claim for that show and txid if nothing is stored yet (no chain lookup; it expires after 3 hours unless answered). The claimant is that claim, or with no reservation the first caller; later calls from it (the same `claim` secret, which the site keeps per check-in in local storage, or else its IP) get the link again, so a page that retries still gets in, and someone who only saw the txid in the mempool gets `409 already-answered` (section 7, "Ticket"; the record is per isolate, or in the `DOOR_CLAIMS` KV namespace across Cloudflare, which is eventually consistent). It reads the check-in from one Fulcrum server and accepts it unconfirmed, so the link is only as safe as that (`CLAIMS.md` limit 17).
- **Keeper** (`runKeeper`). Per show: a valid `'C'` notice refunds every live marker coin; at `tip >= startHeight + graceBlocks` it settles them; a `sample-refund-seat` show before that refunds them with fresh `'R'` notices. Batches of at most 100 coins, fee-owing coins first. Each transaction spends only that show's marker coins and passes the worker's rule check (the Escrow settle and refund rules, `worker/lib/rules.js`) and, in Node, the libauth VM, before it goes to two Fulcrum servers of different operators. Spent coins are not listed, so a second pass does nothing.
- **Configuration.** Requests cannot change the network, the Fulcrum servers, the keys or the catalogue. A mainnet worker always uses the server list in `src/chain/servers.js` and checks each server's genesis hash before broadcasting; the Pages adapter reads shows.json from its own deployment.
