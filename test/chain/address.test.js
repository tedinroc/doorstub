import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hash160 } from '@bitauth/libauth';
import { AddressError, cashAddressOf, decodeCashAddress, p2pkhAddresses, scripthashOf, shortAddress } from '../../src/chain/index.js';
import { freshKey, makeShow } from '../helpers.js';

test('p2pkh addresses: token-aware z..., plain q..., same locking bytecode', () => {
  const key = freshKey();
  const a = p2pkhAddresses(key.pkh);
  assert.match(a.tokenAddress, /^bitcoincash:z/);
  assert.match(a.address, /^bitcoincash:q/);
  assert.deepEqual(decodeCashAddress(a.tokenAddress).lockingBytecode, a.lockingBytecode);
  assert.equal(decodeCashAddress(a.tokenAddress).tokenSupport, true);
  assert.equal(decodeCashAddress(a.address).tokenSupport, false);
  assert.deepEqual(decodeCashAddress(a.address.split(':')[1]).lockingBytecode, a.lockingBytecode, 'prefix optional');
  assert.equal(a.scripthash, scripthashOf(a.lockingBytecode));
  assert.deepEqual(a.pkh, hash160(key.publicKey));
});

test('contract addresses are P2SH32: r... token-aware, p... plain', (t) => {
  const { contracts } = makeShow(assert);
  assert.match(cashAddressOf(contracts.escrow.lockingBytecode), /^bitcoincash:r/);
  assert.match(cashAddressOf(contracts.escrow.lockingBytecode, { tokenSupport: false }), /^bitcoincash:p/);
  assert.equal(cashAddressOf(contracts.boxOffice.lockingBytecode), contracts.boxOffice.address());
});

test('decodeCashAddress refuses other networks and junk', () => {
  assert.throws(() => decodeCashAddress('bchtest:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq5qhm6fcl'), AddressError);
  assert.throws(() => decodeCashAddress('bitcoincash:notanaddress'), AddressError);
  assert.throws(() => decodeCashAddress(''), AddressError);
  assert.throws(() => cashAddressOf(new Uint8Array(25), { network: 'testnet' }), AddressError);
});

test('shortAddress keeps both ends', () => {
  assert.equal(shortAddress('bitcoincash:zq00xmdnsdhtj4dr54s565h75et8svqz5gngkus4g6'), 'zq00x...us4g6');
});
