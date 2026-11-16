# Live Fulcrum fixtures

Real answers from a public mainnet Fulcrum server (Fulcrum 2.1.4), captured read-only on 11/16 by `npm run fixtures:fulcrum` (`simnet/scripts/capture-fulcrum.js`) and `simnet/scripts/capture-notifications.js`. Each file is `{ method, params, server, capturedAt, note?, trimmedFrom?, message }`; `message` is the JSON envelope exactly as the server sent it (long result lists are cut to 6 items, `trimmedFrom` says how many there were). The addresses and transactions are whatever was active on mainnet at the time.

What they pin (simnet copies all of it; the chain client should too):

- Every object has **sorted keys**: `{"id","jsonrpc","result"}`, `{"error":{"code","message"},"id","jsonrpc"}`, `{"jsonrpc","method","params"}`.
- `listunspent` items: `{ height, token_data?, tx_hash, tx_pos, value }`; `token_data` is `{ amount: "<decimal string>", category, nft?: { capability, commitment } }`; mempool coins have `height: 0` and come last.
- **Token coins are hidden by default until `server.version` negotiates `1.5`** (`listunspent.fungible-default` vs `listunspent.fungible-default-protocol-1.4`): before that, the default filter is `exclude_tokens`; after it, `include_tokens`. `get_balance` follows the same default.
- `get_history`: `{ height, tx_hash }`, plus `fee` on mempool entries (`get_history.with-mempool`, `get_mempool`); `from_height` / `to_height` work (`get_history.range`).
- Status (`*.subscribe`): sha256 of `"tx_hash:height:"` over the history; `test/simnet/protocol.test.js` checks it on these files.
- Errors: `Invalid address: <x>`, `Height <n> is out of range`, `Invalid tx hash`, `No transaction matching the requested hash was found` (code 1); unknown transaction in `transaction.get` is code 2, `daemon error: DaemonError({'code': -5, ...})`; unknown method is code -32601 `Unsupported request: <method>`.
- Broadcast refusals (from Fulcrum's source, not captured: nothing is ever broadcast to mainnet): code 1, `the transaction was rejected by network rules.\n\n<node's reason>\n`.
- Notifications: headers `{"jsonrpc":"2.0","method":"blockchain.headers.subscribe","params":[{"height","hex"}]}`; address status `params: [<address as subscribed>, <status>]`. A script hash subscribed both by script hash and then by address got only the address notification in 20 minutes: one subscription per script hash per connection, the last call wins.
- `server.features.genesis_hash` is mainnet's `000000000019d6...e26f`; a client can refuse any server that reports something else.
