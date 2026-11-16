# simnet

A local test chain that speaks Fulcrum's Electrum Cash protocol over WebSocket, so the app, the worker, the studio and the tests can run every Doorstub path without touching mainnet.

```
npm run simnet                       # ws://127.0.0.1:50021, height 977,600, seed "doorstub-simnet"
npm run simnet -- --port 50121 --height 500000 --seed demo --auto-mine-seconds 30
```

In code: `const sim = await startSimnet({ port: 0, seed, height, time })` gives `{ url, port, chain, close() }`. `connectRpc(url)` (in `simnet/rpc.js`) is a small Node client that negotiates protocol 1.5.

## What it checks on broadcast

As a BCHN node behind Fulcrum would, against the next block (tip + 1) and the tip's median time past:

- the hex decodes; the transaction is not already confirmed (already in the mempool returns the txid, as BCHN does);
- every input exists and is unspent, counting the mempool (0-conf chains work); a mempool spend is `txn-mempool-conflict`, a confirmed spend or an unknown coin is `Missing inputs`; no duplicate inputs;
- locktime finality (`non-final`) and BIP68 sequence locks (`non-BIP68-final`);
- inputs cover outputs, fee at least 1 sat/byte (`min relay fee not met`), fee not absurd;
- the libauth 2026 VM in **standard** mode with the real source outputs: every input, token rules, dust, sizes. A script failure that consensus also refuses is `mandatory-script-verify-flag-failed (<libauth text>)`; standard-only is `non-mandatory-script-verify-flag (...)`; transaction-level failures are `bad-txns-consensus (...)` or `non-standard (...)`.

Every refusal is Fulcrum's broadcast error: code 1, message `the transaction was rejected by network rules.\n\n<reason>\n`.

## Methods

Electrum Cash protocol (Fulcrum shapes, sorted JSON keys, pinned in `test/simnet/protocol.test.js` against `test/fixtures/fulcrum-live/`):
`server.version`, `server.features`, `server.ping`, `server.banner`, `blockchain.headers.subscribe` / `unsubscribe`, `blockchain.block.header`, `blockchain.block.headers`, `blockchain.estimatefee`, `blockchain.relayfee`, `blockchain.transaction.get` (raw, or BCHN-style verbose), `blockchain.transaction.get_height`, `blockchain.transaction.subscribe` / `unsubscribe`, `blockchain.transaction.broadcast`, and for both `blockchain.address.*` and `blockchain.scripthash.*`: `listunspent [x, token_filter]`, `get_history [x, from_height, to_height]`, `get_mempool`, `get_balance [x, token_filter]`, `subscribe`, `unsubscribe`; `blockchain.address.get_scripthash`.

Behaviour copied from live Fulcrum 2.1.4:

- Until `server.version` negotiates `1.5`, the connection is protocol 1.4 and token coins are **hidden** from `listunspent` and `get_balance` by default. Always send `server.version [name, "1.5"]` or pass `"include_tokens"`.
- `listunspent`: confirmed coins by height, then mempool coins at `height: 0`; `token_data` is `{ amount: "<decimal string>", category, nft?: { capability, commitment } }`.
- `get_history`: confirmed by height and block position, then mempool entries with `fee`, `height: 0` (all inputs confirmed) or `-1` (an unconfirmed parent). `to_height` is exclusive; mempool entries appear only when `to_height` is `-1` (the default).
- Status hash: `sha256` of `"tx_hash:height:"` over the whole history (checked on live data), `null` when there is none.
- One subscription per script hash per connection: the last `subscribe` call (by address, in the client's spelling, or by script hash) decides which notification it gets.
- Errors: `Invalid address: <x>`, `Height <n> is out of range`, `Invalid tx hash` (code 1); unknown transaction is code 2 with BCHN's `No such mempool or blockchain transaction` text; unknown method is code -32601 `Unsupported request: <method>`.
- `server.features.genesis_hash` is simnet's own base block hash, never mainnet's; clients and the studio use it to tell the chains apart.

Control methods (params as an object or `[object]`):

| Method | Params | Result |
|---|---|---|
| `simnet.fund` | `{ address \| lockingBytecode (hex), sats, token?: { category, amount, nft?: { capability, commitment } }, mine?: false }` | `{ txid, vout: 0, sats, scripthash, height }`: a new coin at output 0 of a made-up faucet transaction, in the mempool unless `mine` |
| `simnet.mine` | `{ blocks: 1 }` | `{ height, hash, mined: [txids] }`; the first block takes the whole mempool; 600 s per block |
| `simnet.reset` | `{ seed?, height?, time? }` | back to the start (the same seed gives the same txids and headers) |
| `simnet.info` | | `{ network: "simnet", seed, height, tipHash, mempool, genesisHash }` |

Headers below the starting height are deterministic filler (not hash-linked); from the start on, every header links to the one before and commits to its transactions' merkle root.

## Refreshing the fixtures (read-only)

`npm run fixtures:fulcrum` re-captures `test/fixtures/fulcrum-live/` from a public mainnet Fulcrum server using read-only methods only (it refuses anything else, including broadcast). `node simnet/scripts/capture-notifications.js` waits for live header and address notifications.
