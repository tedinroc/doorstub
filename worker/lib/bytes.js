// Byte helpers for the worker. The worker runs in Cloudflare's workerd, which
// refuses to compile WebAssembly from bytes, so it cannot load libauth (see
// worker/RUNTIME.md). Everything here is plain JavaScript; @noble/* does the
// hashing and the curve arithmetic.

export class WorkerError extends Error {
  /**
   * @param {string} code machine-readable reason
   * @param {string} message plain sentence for people
   * @param {object} [extra] { status, retryable, details }
   */
  constructor(code, message, { status = 400, retryable = false, details } = {}) {
    super(message);
    this.name = 'WorkerError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    if (details !== undefined) this.details = details;
  }
}

export const fail = (code, message, extra) => {
  throw new WorkerError(code, message, extra);
};

const HEX = /^(?:[0-9a-f]{2})*$/i;

export const isHex = (value, bytes) => typeof value === 'string' && HEX.test(value) && (bytes === undefined || value.length === bytes * 2);

export const hexToBytes = (hex) => {
  if (typeof hex !== 'string' || !HEX.test(hex)) throw new WorkerError('bad-hex', 'expected an even-length hex string');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

export const bytesToHex = (bytes) => {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
};

export const concat = (parts) => {
  const length = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
};

export const equal = (a, b) => {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
};

export const reverse = (bytes) => bytes.slice().reverse();

export const uint32le = (n) => {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new WorkerError('bad-number', `${n} is not a 32-bit unsigned integer`);
  return Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
};

export const uint64le = (value) => {
  let v = BigInt(value);
  if (v < 0n || v > 0xffffffffffffffffn) throw new WorkerError('bad-number', `${value} is not a 64-bit unsigned integer`);
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
};

/** Bitcoin CompactSize ("varint"). */
export const compactSize = (value) => {
  const n = BigInt(value);
  if (n < 0n) throw new WorkerError('bad-number', 'CompactSize must not be negative');
  if (n < 0xfdn) return Uint8Array.of(Number(n));
  if (n <= 0xffffn) return Uint8Array.of(0xfd, Number(n & 0xffn), Number(n >> 8n));
  if (n <= 0xffffffffn) return concat([Uint8Array.of(0xfe), uint32le(Number(n))]);
  return concat([Uint8Array.of(0xff), uint64le(n)]);
};

/** A cursor over bytes, for decoding. Every read refuses to run past the end. */
export const reader = (bytes) => {
  let offset = 0;
  const need = (n) => {
    if (offset + n > bytes.length) throw new WorkerError('bad-encoding', 'unexpected end of data');
  };
  const r = {
    get offset() {
      return offset;
    },
    get done() {
      return offset === bytes.length;
    },
    bytes(n) {
      need(n);
      const out = bytes.slice(offset, offset + n);
      offset += n;
      return out;
    },
    u8() {
      need(1);
      return bytes[offset++];
    },
    u32() {
      const b = r.bytes(4);
      return (b[0] | (b[1] << 8) | (b[2] << 16)) + b[3] * 0x1000000;
    },
    u64() {
      const b = r.bytes(8);
      let v = 0n;
      for (let i = 7; i >= 0; i -= 1) v = (v << 8n) | BigInt(b[i]);
      return v;
    },
    /** CompactSize, refusing non-minimal encodings (as nodes do). */
    compact() {
      const first = r.u8();
      if (first < 0xfd) return BigInt(first);
      if (first === 0xfd) {
        const b = r.bytes(2);
        const v = BigInt(b[0] | (b[1] << 8));
        if (v < 0xfdn) throw new WorkerError('bad-encoding', 'non-minimal CompactSize');
        return v;
      }
      if (first === 0xfe) {
        const v = BigInt(r.u32());
        if (v <= 0xffffn) throw new WorkerError('bad-encoding', 'non-minimal CompactSize');
        return v;
      }
      const v = r.u64();
      if (v <= 0xffffffffn) throw new WorkerError('bad-encoding', 'non-minimal CompactSize');
      return v;
    },
    compactNumber(max = 0xffffffff) {
      const v = r.compact();
      if (v > BigInt(max)) throw new WorkerError('bad-encoding', `length ${v} is too large`);
      return Number(v);
    },
  };
  return r;
};
