// In-memory Bitcoin Cash chain for simnet: a UTXO set, a mempool with 0-conf
// chaining, synthetic block headers, and a broadcast check that mirrors a BCHN
// node behind Fulcrum (inputs exist and are unspent, no mempool conflict,
// locktime and BIP68 sequence locks against the next block, relay fee, and
// every input evaluated in the libauth 2026 VM in standard mode with the real
// source outputs). Nothing here touches the network.
import {
  base58AddressToLockingBytecode,
  binToHex,
  cashAddressToLockingBytecode,
  createVirtualMachineBch2026,
  decodeTransaction,
  encodeDataPush,
  encodeTransaction,
  flattenBinArray,
  hash256,
  hashTransactionUiOrder,
  hexToBin,
  isHex,
  numberToBinUint32LE,
  sha256,
  utf8ToBin,
} from '@bitauth/libauth';

const VM = {
  standard: createVirtualMachineBch2026(true),
  consensus: createVirtualMachineBch2026(false),
};

/** Seconds between synthetic blocks. */
export const BLOCK_INTERVAL_SECONDS = 600;
/** Default tip height: near mainnet in November 2026, so UI estimates look real. */
export const DEFAULT_HEIGHT = 977_600;
/** Default tip time (2026-11-16T00:00:00Z). */
export const DEFAULT_TIME = 1_794_787_200;
export const DEFAULT_SEED = 'doorstub-simnet';

const LOCKTIME_THRESHOLD = 500_000_000;
const SEQUENCE_FINAL = 0xffffffff;
const SEQUENCE_DISABLE_FLAG = 0x80000000;
const SEQUENCE_TYPE_FLAG = 0x00400000;
const SEQUENCE_MASK = 0x0000ffff;
const MIN_RELAY_SATS_PER_BYTE = 1n;
const MAX_FEE_SATS_PER_BYTE = 10_000n; // BCHN sendrawtransaction maxfeerate default (0.1 BCH/kB)

/** A refusal the simnet server reports in Fulcrum's error shape. */
export class SimnetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SimnetError';
    this.code = code;
  }
}

/** Fulcrum code 1 (Code_App_BadRequest); broadcast refusals use this wording. */
const rejected = (reason) =>
  new SimnetError(1, `the transaction was rejected by network rules.\n\n${reason}\n`);

/** Electrum script hash: sha256 of the locking bytecode, byte-reversed, as hex. */
export const scripthashOf = (lockingBytecode) => binToHex(sha256.hash(lockingBytecode).slice().reverse());

/**
 * Locking bytecode of a cashaddr (with or without prefix, token-aware or not)
 * or a legacy base58 address; throws SimnetError(1, 'Invalid address: ...').
 */
export const lockingBytecodeOfAddress = (address) => {
  if (typeof address === 'string' && address.length > 0) {
    const attempts = address.includes(':')
      ? [address]
      : ['bitcoincash', 'bchtest', 'bchreg'].map((prefix) => `${prefix}:${address}`);
    for (const candidate of attempts) {
      const decoded = cashAddressToLockingBytecode(candidate.toLowerCase());
      if (typeof decoded !== 'string') return decoded.bytecode;
    }
    const legacy = base58AddressToLockingBytecode(address);
    if (typeof legacy !== 'string') return legacy.bytecode;
  }
  throw new SimnetError(1, `Invalid address: ${address}`);
};

const outpointKey = (txid, vout) => `${txid}:${vout}`;

const deterministicBytes = (seed, ...parts) => hash256(utf8ToBin([seed, ...parts].join('|')));

const merkleRoot = (txids) => {
  // txids in display order (hex); the tree hashes internal (reversed) order.
  if (txids.length === 0) return new Uint8Array(32);
  let level = txids.map((txid) => hexToBin(txid).reverse());
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const right = level[i + 1] ?? level[i];
      next.push(hash256(flattenBinArray([level[i], right])));
    }
    level = next;
  }
  return level[0];
};

const encodeHeader = ({ prevHashDisplay, merkle, time, nonce }) =>
  flattenBinArray([
    numberToBinUint32LE(0x20000000),
    hexToBin(prevHashDisplay).reverse(),
    merkle,
    numberToBinUint32LE(time),
    numberToBinUint32LE(0x1d00ffff),
    numberToBinUint32LE(nonce),
  ]);

const headerHash = (header) => binToHex(hash256(header).reverse());

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/** BCHN-style token data as Fulcrum returns it (keys sorted, amount a string). */
export const tokenDataJson = (token) => {
  if (token === undefined) return undefined;
  const data = { amount: token.amount.toString(), category: binToHex(token.category) };
  if (token.nft !== undefined) data.nft = { capability: token.nft.capability, commitment: binToHex(token.nft.commitment) };
  return data;
};

const tokenFromJson = (token) => {
  if (token === undefined || token === null) return undefined;
  if (typeof token.category !== 'string' || token.category.length !== 64 || !isHex(token.category)) {
    throw new SimnetError(-32602, 'token.category must be 64 hex characters (display order)');
  }
  const out = { amount: BigInt(token.amount ?? 0), category: hexToBin(token.category) };
  if (token.nft !== undefined && token.nft !== null) {
    const capability = token.nft.capability ?? 'none';
    if (!['none', 'mutable', 'minting'].includes(capability)) throw new SimnetError(-32602, 'bad nft capability');
    const commitment = token.nft.commitment ?? '';
    if (!isHex(commitment) && commitment !== '') throw new SimnetError(-32602, 'nft.commitment must be hex');
    out.nft = { capability, commitment: hexToBin(commitment) };
  }
  return out;
};

/**
 * The simnet chain. Deterministic for a given { seed, height, time }: fund
 * transactions spend made-up outpoints derived from the seed and a counter.
 *
 * Listeners added with onChange(fn) receive { scripthashes: Set<string>,
 * tip: boolean } after every change, so the server can notify subscribers.
 */
export class SimChain {
  constructor({ seed = DEFAULT_SEED, height = DEFAULT_HEIGHT, time = DEFAULT_TIME } = {}) {
    this.options = { seed: String(seed), height, time };
    this.listeners = new Set();
    this.reset();
  }

  /** Back to the initial state (same seed, height and time unless given). */
  reset(options = {}) {
    this.options = {
      seed: String(options.seed ?? this.options.seed),
      height: Number(options.height ?? this.options.height),
      time: Number(options.time ?? this.options.time),
    };
    const { seed, height, time } = this.options;
    if (!Number.isInteger(height) || height < 11 || height >= LOCKTIME_THRESHOLD) {
      throw new SimnetError(-32602, 'height must be an integer from 11 to 499,999,999');
    }
    this.baseHeight = height;
    this.blocks = new Map();
    this.txs = new Map(); // txid -> { raw, tx, height (null in mempool), fee, size, order, sourceOutputs }
    this.coins = new Map(); // outpoint -> { txid, vout, output, scripthash }
    this.spentBy = new Map(); // outpoint -> txid
    this.byScripthash = new Map(); // scripthash -> Set<txid>
    this.mempool = [];
    this.fundCounter = 0;
    this.order = 0;
    const prevHashDisplay = binToHex(deterministicBytes(seed, 'base-prev', height));
    const header = encodeHeader({ prevHashDisplay, merkle: new Uint8Array(32), time, nonce: 0 });
    this.blocks.set(height, { height, header, hash: headerHash(header), time, txids: [] });
    this.tipHeight = height;
    this.emit(new Set(), true);
    return this.info();
  }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(scripthashes, tip) {
    for (const listener of this.listeners) listener({ scripthashes, tip });
  }

  info() {
    return {
      network: 'simnet',
      seed: this.options.seed,
      height: this.tipHeight,
      tipHash: this.blocks.get(this.tipHeight).hash,
      mempool: [...this.mempool],
      genesisHash: this.blocks.get(this.baseHeight).hash,
    };
  }

  // ------------------------------------------------------------- blocks

  /** Block at `height` (synthetic filler below the simnet base). */
  block(height) {
    if (!Number.isInteger(height) || height < 0 || height > this.tipHeight) {
      throw new SimnetError(1, `Height ${height} is out of range`);
    }
    const known = this.blocks.get(height);
    if (known) return known;
    // Below the base height: deterministic filler headers (not hash-linked).
    const time = this.options.time - (this.baseHeight - height) * BLOCK_INTERVAL_SECONDS;
    const prevHashDisplay = binToHex(deterministicBytes(this.options.seed, 'filler-prev', height));
    const header = encodeHeader({ prevHashDisplay, merkle: new Uint8Array(32), time, nonce: height });
    return { height, header, hash: headerHash(header), time, txids: [] };
  }

  tip() {
    const block = this.blocks.get(this.tipHeight);
    return { height: block.height, hex: binToHex(block.header) };
  }

  /** Median time past of the block at `height` (median of it and the 10 before). */
  medianTimePast(height) {
    const times = [];
    for (let h = Math.max(0, height - 10); h <= height; h += 1) times.push(this.block(h).time);
    return median(times);
  }

  /** Mine `blocks` blocks; the first takes the whole mempool. */
  mine(blocks = 1, { interval = BLOCK_INTERVAL_SECONDS } = {}) {
    if (!Number.isInteger(blocks) || blocks < 1 || blocks > 10_000) throw new SimnetError(-32602, 'blocks must be 1-10,000');
    const touched = new Set();
    const mined = [];
    for (let i = 0; i < blocks; i += 1) {
      const prev = this.blocks.get(this.tipHeight);
      const height = this.tipHeight + 1;
      const txids = i === 0 ? this.mempool.splice(0) : [];
      txids.forEach((txid, position) => {
        const entry = this.txs.get(txid);
        entry.height = height;
        entry.position = position;
        for (const sh of this.scripthashesOfTx(entry)) touched.add(sh);
        mined.push(txid);
      });
      const time = prev.time + interval;
      const header = encodeHeader({ prevHashDisplay: prev.hash, merkle: merkleRoot(txids), time, nonce: height });
      this.blocks.set(height, { height, header, hash: headerHash(header), time, txids });
      this.tipHeight = height;
    }
    this.emit(touched, true);
    return { height: this.tipHeight, hash: this.blocks.get(this.tipHeight).hash, mined };
  }

  // ------------------------------------------------------------- transactions

  scripthashesOfTx(entry) {
    const set = new Set();
    entry.sourceOutputs.forEach((output) => {
      if (output) set.add(scripthashOf(output.lockingBytecode));
    });
    entry.tx.outputs.forEach((output) => set.add(scripthashOf(output.lockingBytecode)));
    return set;
  }

  index(txid, entry) {
    for (const sh of this.scripthashesOfTx(entry)) {
      if (!this.byScripthash.has(sh)) this.byScripthash.set(sh, new Set());
      this.byScripthash.get(sh).add(txid);
    }
  }

  /** Store an accepted transaction in the mempool and update the coin view. */
  accept(raw, tx, sourceOutputs, fee) {
    const txid = binToHex(hashTransactionUiOrder(raw));
    const entry = { raw, tx, height: null, position: null, fee, size: raw.length, order: this.order++, sourceOutputs };
    this.txs.set(txid, entry);
    tx.inputs.forEach((input) => {
      const key = outpointKey(binToHex(input.outpointTransactionHash), input.outpointIndex);
      if (this.coins.has(key)) this.spentBy.set(key, txid);
    });
    tx.outputs.forEach((output, vout) => {
      this.coins.set(outpointKey(txid, vout), { txid, vout, output, scripthash: scripthashOf(output.lockingBytecode) });
    });
    this.index(txid, entry);
    this.mempool.push(txid);
    return { txid, entry };
  }

  /**
   * Fund a locking bytecode or address with a new coin at output 0 of a
   * made-up "faucet" transaction (its input is not checked). The transaction
   * goes to the mempool; pass mine: true to mine one block right after.
   */
  fund({ address, lockingBytecode, sats, token, mine = false } = {}) {
    const bytecode =
      lockingBytecode !== undefined
        ? lockingBytecode instanceof Uint8Array
          ? lockingBytecode
          : hexToBin(String(lockingBytecode))
        : lockingBytecodeOfAddress(address);
    const value = BigInt(sats ?? 0);
    if (value <= 0n || value > 2_100_000_000_000_000n) throw new SimnetError(-32602, 'sats must be a positive number of satoshis');
    this.fundCounter += 1;
    const tx = {
      version: 2,
      inputs: [
        {
          outpointTransactionHash: deterministicBytes(this.options.seed, 'faucet', this.fundCounter),
          outpointIndex: 0,
          sequenceNumber: SEQUENCE_FINAL,
          unlockingBytecode: encodeDataPush(utf8ToBin(`simnet faucet ${this.fundCounter}`)),
        },
      ],
      outputs: [{ lockingBytecode: bytecode, valueSatoshis: value, token: tokenFromJson(token) }],
      locktime: 0,
    };
    const raw = encodeTransaction(tx);
    const { txid } = this.accept(raw, decodeTransaction(raw), [undefined], 0n);
    const scripthash = scripthashOf(bytecode);
    if (mine) this.mine(1);
    else this.emit(new Set([scripthash]), false);
    return { txid, vout: 0, sats: Number(value), scripthash, height: this.txs.get(txid).height ?? 0 };
  }

  /**
   * Check a raw transaction as BCHN would for mempool acceptance and accept
   * it. Returns the txid; throws SimnetError in Fulcrum's broadcast shape.
   */
  broadcast(rawHex) {
    if (typeof rawHex !== 'string' || rawHex.length === 0 || rawHex.length % 2 !== 0 || !isHex(rawHex)) {
      throw rejected('TX decode failed');
    }
    const raw = hexToBin(rawHex);
    const tx = decodeTransaction(raw);
    if (typeof tx === 'string') throw rejected('TX decode failed');
    const txid = binToHex(hashTransactionUiOrder(raw));
    const known = this.txs.get(txid);
    if (known !== undefined) {
      if (known.height === null) return txid; // already in the mempool: BCHN reports success
      throw rejected('Transaction already in block chain');
    }
    if (tx.inputs.length === 0) throw rejected('bad-txns-vin-empty');
    if (tx.outputs.length === 0) throw rejected('bad-txns-vout-empty');

    const seen = new Set();
    const sourceOutputs = tx.inputs.map((input) => {
      const key = outpointKey(binToHex(input.outpointTransactionHash), input.outpointIndex);
      if (seen.has(key)) throw rejected('bad-txns-inputs-duplicate');
      seen.add(key);
      const coin = this.coins.get(key);
      if (coin === undefined) throw rejected('Missing inputs');
      const spender = this.spentBy.get(key);
      if (spender !== undefined) {
        if (this.txs.get(spender).height === null) throw rejected('txn-mempool-conflict');
        throw rejected('Missing inputs');
      }
      return coin.output;
    });

    const nextHeight = this.tipHeight + 1;
    const tipMtp = this.medianTimePast(this.tipHeight);
    if (!this.isFinal(tx, nextHeight, tipMtp)) throw rejected('non-final');
    if (!this.sequenceLocksPass(tx, nextHeight, tipMtp)) throw rejected('non-BIP68-final');

    const inValue = sourceOutputs.reduce((a, o) => a + o.valueSatoshis, 0n);
    const outValue = tx.outputs.reduce((a, o) => a + o.valueSatoshis, 0n);
    if (outValue > inValue) throw rejected(`bad-txns-in-belowout, value in (${inValue}) < value out (${outValue})`);
    const fee = inValue - outValue;
    const minFee = BigInt(raw.length) * MIN_RELAY_SATS_PER_BYTE;
    if (fee < minFee) throw rejected(`min relay fee not met, ${fee} < ${minFee}`);
    if (fee > BigInt(raw.length) * MAX_FEE_SATS_PER_BYTE) {
      throw rejected('Fee exceeds maximum configured by user (e.g. -maxtxfee, maxfeerate)');
    }

    const resolved = { transaction: tx, sourceOutputs };
    const standard = VM.standard.verify(resolved);
    if (standard !== true) {
      const consensus = VM.consensus.verify(resolved);
      const scriptError = /evaluating input index/.test(standard);
      if (consensus !== true) {
        throw rejected(`${scriptError ? 'mandatory-script-verify-flag-failed' : 'bad-txns-consensus'} (${consensus})`);
      }
      throw rejected(`${scriptError ? 'non-mandatory-script-verify-flag' : 'non-standard'} (${standard})`);
    }

    const { entry } = this.accept(raw, tx, sourceOutputs, fee);
    this.emit(this.scripthashesOfTx(entry), false);
    return txid;
  }

  /** BCH IsFinalTx: locktime below the next height (or MTP), or every sequence final. */
  isFinal(tx, height, mtp) {
    if (tx.locktime === 0) return true;
    const limit = tx.locktime < LOCKTIME_THRESHOLD ? height : mtp;
    if (tx.locktime < limit) return true;
    return tx.inputs.every((input) => input.sequenceNumber === SEQUENCE_FINAL);
  }

  /** BIP68 relative locks (version 2+), with mempool coins counted at the next height. */
  sequenceLocksPass(tx, height, tipMtp) {
    if (tx.version < 2) return true;
    let minHeight = -1;
    let minTime = -1;
    tx.inputs.forEach((input) => {
      const sequence = input.sequenceNumber >>> 0;
      if (sequence & SEQUENCE_DISABLE_FLAG) return;
      const coin = this.coins.get(outpointKey(binToHex(input.outpointTransactionHash), input.outpointIndex));
      const coinHeight = this.txs.get(coin.txid).height ?? height;
      const value = sequence & SEQUENCE_MASK;
      if (sequence & SEQUENCE_TYPE_FLAG) {
        const coinTime = this.medianTimePast(Math.max(coinHeight - 1, 0));
        minTime = Math.max(minTime, coinTime + value * 512 - 1);
      } else {
        minHeight = Math.max(minHeight, coinHeight + value - 1);
      }
    });
    return !(minHeight >= height || minTime >= tipMtp);
  }

  // ------------------------------------------------------------- queries

  transaction(txid) {
    if (typeof txid !== 'string' || txid.length !== 64 || !isHex(txid)) throw new SimnetError(1, 'Invalid tx hash');
    const entry = this.txs.get(txid.toLowerCase());
    if (entry === undefined) {
      throw new SimnetError(
        2,
        "daemon error: DaemonError({'code': -5, 'message': 'No such mempool or blockchain transaction. Use gettransaction for wallet transactions.'})",
      );
    }
    return entry;
  }

  /** Fulcrum get_height: block height, or 0 while in the mempool. */
  transactionHeight(txid) {
    if (typeof txid !== 'string' || txid.length !== 64 || !isHex(txid)) throw new SimnetError(1, 'Invalid tx hash');
    const entry = this.txs.get(txid.toLowerCase());
    if (entry === undefined) throw new SimnetError(1, 'No transaction matching the requested hash was found');
    return entry.height ?? 0;
  }

  /** Mempool height for history: -1 if any input is unconfirmed, else 0. */
  mempoolHeight(entry) {
    const unconfirmedParent = entry.tx.inputs.some((input) => {
      const parent = this.txs.get(binToHex(input.outpointTransactionHash));
      return parent !== undefined && parent.height === null;
    });
    return unconfirmedParent ? -1 : 0;
  }

  /** History as Fulcrum orders it: confirmed by (height, block position), then mempool (0 before -1, then tx_hash). */
  history(scripthash, { fromHeight = 0, toHeight = -1 } = {}) {
    const txids = [...(this.byScripthash.get(scripthash) ?? [])];
    const confirmed = [];
    const mempool = [];
    for (const txid of txids) {
      const entry = this.txs.get(txid);
      if (entry.height === null) mempool.push({ fee: Number(entry.fee), height: this.mempoolHeight(entry), tx_hash: txid });
      else confirmed.push({ height: entry.height, position: entry.position, tx_hash: txid });
    }
    confirmed.sort((a, b) => a.height - b.height || a.position - b.position);
    mempool.sort((a, b) => b.height - a.height || (a.tx_hash < b.tx_hash ? -1 : a.tx_hash > b.tx_hash ? 1 : 0));
    const inRange = confirmed
      .filter((item) => item.height >= fromHeight && (toHeight === -1 || item.height < toHeight))
      .map(({ height, tx_hash }) => ({ height, tx_hash }));
    return toHeight === -1 ? [...inRange, ...mempool] : inRange;
  }

  mempoolHistory(scripthash) {
    return this.history(scripthash).filter((item) => item.height <= 0);
  }

  /** Electrum status: sha256 of "tx_hash:height:" over the whole history, or null. */
  status(scripthash) {
    const items = this.history(scripthash);
    if (items.length === 0) return null;
    return binToHex(sha256.hash(utf8ToBin(items.map((item) => `${item.tx_hash}:${item.height}:`).join(''))));
  }

  /** Unspent coins (mempool spends removed, mempool coins at height 0). */
  unspent(scripthash, tokenFilter = 'include_tokens') {
    const items = [];
    for (const txid of this.byScripthash.get(scripthash) ?? []) {
      const entry = this.txs.get(txid);
      entry.tx.outputs.forEach((output, vout) => {
        const key = outpointKey(txid, vout);
        if (this.spentBy.has(key) || scripthashOf(output.lockingBytecode) !== scripthash) return;
        const hasToken = output.token !== undefined;
        if (tokenFilter === 'exclude_tokens' && hasToken) return;
        if (tokenFilter === 'tokens_only' && !hasToken) return;
        const item = { height: entry.height ?? 0, tx_hash: txid, tx_pos: vout, value: Number(output.valueSatoshis) };
        if (hasToken) item.token_data = tokenDataJson(output.token);
        items.push(item);
      });
    }
    const rank = (item) => (item.height === 0 ? Number.MAX_SAFE_INTEGER : item.height);
    items.sort(
      (a, b) =>
        rank(a) - rank(b) || (a.tx_hash < b.tx_hash ? -1 : a.tx_hash > b.tx_hash ? 1 : 0) || a.tx_pos - b.tx_pos,
    );
    return items;
  }

  balance(scripthash, tokenFilter = 'exclude_tokens') {
    let confirmed = 0;
    let unconfirmed = 0;
    for (const item of this.unspent(scripthash, tokenFilter)) {
      if (item.height > 0) confirmed += item.value;
      else unconfirmed += item.value;
    }
    // Coins spent by the mempool count against the unconfirmed balance, as in Fulcrum.
    for (const txid of this.byScripthash.get(scripthash) ?? []) {
      const entry = this.txs.get(txid);
      if (entry.height !== null) continue;
      entry.sourceOutputs.forEach((output, i) => {
        if (output === undefined || scripthashOf(output.lockingBytecode) !== scripthash) return;
        if (tokenFilter === 'exclude_tokens' && output.token !== undefined) return;
        if (tokenFilter === 'tokens_only' && output.token === undefined) return;
        const input = entry.tx.inputs[i];
        const parent = this.txs.get(binToHex(input.outpointTransactionHash));
        if (parent !== undefined && parent.height !== null) {
          unconfirmed -= Number(output.valueSatoshis);
          confirmed += Number(output.valueSatoshis);
        }
      });
    }
    return { confirmed, unconfirmed };
  }
}
