// The worker's data signatures (noble) against libauth: ECDSA signing as
// OP_CHECKDATASIG and src/tx accept it, and BCH Schnorr verification (not
// BIP-340) agreeing with libauth on honest and tampered signatures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, secp256k1 as lib, sha256 as libSha256 } from '@bitauth/libauth';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes } from '../../worker/lib/bytes.js';
import { DER_LENGTHS, publicKeyOf, sha256, signDataEcdsa, verifyDataEcdsa, verifyDataSignature, verifySchnorrBch } from '../../worker/lib/crypto.js';

const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

test('signDataEcdsa: deterministic, low-S strict DER of a length src/tx accepts, verified by libauth', () => {
  for (let i = 0; i < 40; i += 1) {
    const key = generatePrivateKey();
    const message = randomBytes(36);
    const a = signDataEcdsa(key, message);
    const b = signDataEcdsa(key, message);
    assert.equal(bytesToHex(a), bytesToHex(b), 'same notice, same signature');
    assert.ok(DER_LENGTHS.includes(a.length));
    assert.equal(lib.verifySignatureDERLowS(a, lib.derivePublicKeyCompressed(key), libSha256.hash(message)), true);
    assert.equal(verifyDataSignature(a, publicKeyOf(key), message), true);
    assert.equal(bytesToHex(publicKeyOf(key)), bytesToHex(lib.derivePublicKeyCompressed(key)));
  }
});

test('signDataEcdsa re-signs (deterministically) when the first DER signature would be shorter than 70 bytes', () => {
  const key = hexToBytes('11'.repeat(32));
  let found = null;
  for (let i = 0; i < 5_000 && found === null; i += 1) {
    const message = Uint8Array.of(0x52, ...new Uint8Array(32).fill(i & 0xff), i >> 8, i & 0xff, 0);
    const plain = secp256k1.sign(sha256(message), key, { lowS: true }).toDERRawBytes();
    if (plain.length < 70) found = message;
  }
  assert.notEqual(found, null, 'some message gives a short DER signature');
  const sig = signDataEcdsa(key, found);
  assert.ok(sig.length >= 70);
  assert.equal(bytesToHex(signDataEcdsa(key, found)), bytesToHex(sig));
  assert.equal(lib.verifySignatureDERLowS(sig, lib.derivePublicKeyCompressed(key), libSha256.hash(found)), true);
});

test('verifySchnorrBch agrees with libauth on honest and tampered BCH Schnorr signatures', () => {
  for (let i = 0; i < 40; i += 1) {
    const key = generatePrivateKey();
    const pk = lib.derivePublicKeyCompressed(key);
    const hash = randomBytes(32);
    const sig = lib.signMessageHashSchnorr(key, hash);
    assert.equal(verifySchnorrBch(sig, pk, hash), true);
    const flipped = sig.slice();
    flipped[i % 64] ^= 1 << (i % 8);
    const otherHash = hash.slice();
    otherHash[0] ^= 1;
    const otherPk = lib.derivePublicKeyCompressed(generatePrivateKey());
    for (const [s, p, h] of [[flipped, pk, hash], [sig, pk, otherHash], [sig, otherPk, hash]]) {
      assert.equal(verifySchnorrBch(s, p, h), lib.verifySignatureSchnorr(s, p, h));
      assert.equal(verifySchnorrBch(s, p, h), false);
    }
    // An uncompressed public key verifies the same signature (the challenge uses the compressed form).
    assert.equal(verifySchnorrBch(sig, lib.derivePublicKeyUncompressed(key), hash), lib.verifySignatureSchnorr(sig, lib.derivePublicKeyUncompressed(key), hash));
  }
  // BIP-340 signatures are not BCH Schnorr signatures.
  const key = generatePrivateKey();
  const hash = randomBytes(32);
  assert.equal(verifySchnorrBch(Uint8Array.from(secp256k1.sign(hash, key).toCompactRawBytes()), lib.derivePublicKeyCompressed(key), hash), false);
});

test('verifySchnorrBch refuses a signature whose R has a non-square y (the BCH rule BIP-340 does not have)', () => {
  const { n, p, Fp } = secp256k1.CURVE;
  const toBig = (bytes) => BigInt(`0x${bytesToHex(bytes) || '0'}`);
  const to32 = (v) => hexToBytes(v.toString(16).padStart(64, '0'));
  const key = generatePrivateKey();
  const d = toBig(key);
  const pk = lib.derivePublicKeyCompressed(key);
  const hash = randomBytes(32);
  const sign = (k) => {
    const R = secp256k1.ProjectivePoint.BASE.multiply(k).toAffine();
    const e = toBig(sha256(Uint8Array.of(...to32(R.x), ...pk, ...hash))) % n;
    return { sig: Uint8Array.of(...to32(R.x), ...to32((k + e * d) % n)), square: Fp.pow(R.y, (p - 1n) / 2n) === 1n };
  };
  let seenSquare = false;
  let seenNonSquare = false;
  for (let i = 0; i < 64 && !(seenSquare && seenNonSquare); i += 1) {
    const k = (toBig(randomBytes(32)) % (n - 1n)) + 1n;
    const { sig, square } = sign(k);
    assert.equal(lib.verifySignatureSchnorr(sig, pk, hash), square, 'libauth accepts exactly the square-y nonces');
    assert.equal(verifySchnorrBch(sig, pk, hash), square, 'and so does the worker');
    if (square) seenSquare = true;
    else seenNonSquare = true;
  }
  assert.ok(seenSquare && seenNonSquare);
});

test('verifyDataEcdsa refuses high-S and non-strict DER (as the VM does)', () => {
  const key = generatePrivateKey();
  const message = randomBytes(36);
  const sig = secp256k1.sign(sha256(message), key, { lowS: true });
  const high = new secp256k1.Signature(sig.r, secp256k1.CURVE.n - sig.s).toDERRawBytes();
  assert.equal(verifyDataEcdsa(high, publicKeyOf(key), message), false);
  assert.equal(lib.verifySignatureDERLowS(high, publicKeyOf(key), libSha256.hash(message)), false);
  const der = sig.toDERRawBytes();
  const padded = Uint8Array.of(0x30, der[1] + 1, 0x02, der[3] + 1, 0x00, ...der.slice(4));
  assert.equal(verifyDataEcdsa(padded, publicKeyOf(key), message), false);
  assert.equal(verifyDataEcdsa(der, publicKeyOf(key), message), true);
});
