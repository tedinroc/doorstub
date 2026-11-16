// The site's small modules: the worker client (timeouts, retries, what it
// accepts), the stuck-state sentences (every error the app can meet maps to
// a plain sentence and a next step), the runtime (production cannot be
// pointed anywhere else) and the CSP in app/public/_headers (equal to the
// servers and relays the code uses).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ApiError, createApi } from '../../app/src/lib/api.js';
import { describeError } from '../../app/src/lib/errors.js';
import { PRODUCTION_RUNTIME, resolveTestRuntime } from '../../app/src/lib/runtime.js';
import { PRICE_SOURCES, fetchUsdPerBch, saneRate } from '../../app/src/lib/price.js';
import { say } from '../../app/src/lib/copy.js';
import { MAINNET_SERVERS } from '../../src/chain/servers.js';
import { RELAY_URLS } from '../../src/wallet/session.js';
import { BroadcastError } from '../../src/chain/index.js';
import { DoorstubError } from '../../src/tx/index.js';
import { WalletError } from '../../src/wallet/index.js';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const noSleep = async () => {};

test('api: notice and door answers, checked before use', async () => {
  const calls = [];
  const api = createApi({
    origin: '',
    sleep: noSleep,
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body), method: init.method });
      if (url === '/api/notice') return json(200, { signature: 'AB'.repeat(64) });
      return json(200, { link: 'https://meet.example.org/doorstub' });
    },
  });
  assert.deepEqual(await api.notice({ category: 'aa', seat: '010200' }), { signature: 'ab'.repeat(64) });
  assert.deepEqual(await api.door({ category: 'aa', txid: 'bb' }), { link: 'https://meet.example.org/doorstub' });
  assert.deepEqual(calls.map((c) => [c.method, c.url, c.body]), [
    ['POST', '/api/notice', { category: 'aa', seat: '010200' }],
    ['POST', '/api/door', { category: 'aa', txid: 'bb' }],
  ]);

  const bad = createApi({ sleep: noSleep, fetchImpl: async (url) => (url === '/api/notice' ? json(200, { signature: 'not hex' }) : json(200, { link: 'javascript:alert(1)' })) });
  await assert.rejects(bad.notice({ category: 'aa', seat: '01' }), (e) => e instanceof ApiError && e.code === 'bad-answer');
  await assert.rejects(bad.door({ category: 'aa', txid: 'bb' }), (e) => e instanceof ApiError && e.code === 'bad-answer');
  const http = createApi({ sleep: noSleep, fetchImpl: async () => json(200, { link: 'http://insecure.example.org/' }) });
  await assert.rejects(http.door({ category: 'aa', txid: 'bb' }), /not an https link/);
});

test('api: the optional buy txid (notice) and claim secret (door) go in the body only when given', async () => {
  const bodies = [];
  const api = createApi({
    sleep: noSleep,
    fetchImpl: async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return url.endsWith('/api/notice') ? json(200, { signature: 'ab'.repeat(64) }) : json(200, { link: 'https://meet.example.org/x' });
    },
  });
  await api.notice({ category: 'aa', seat: '010100', txid: 'cc'.repeat(32) });
  await api.door({ category: 'aa', txid: 'bb', claim: 'dd'.repeat(32) });
  await api.door({ category: 'aa', txid: 'bb' });
  assert.deepEqual(bodies, [
    { category: 'aa', seat: '010100', txid: 'cc'.repeat(32) },
    { category: 'aa', txid: 'bb', claim: 'dd'.repeat(32) },
    { category: 'aa', txid: 'bb' },
  ]);
});

test('runtime: the E2E switches (a local relay, the page keeper off) accept only local relays', () => {
  const r = resolveTestRuntime('?fulcrum=ws://127.0.0.1:50021&relay=ws://127.0.0.1:7777&pagekeeper=0');
  assert.deepEqual(r.relayUrls, ['ws://127.0.0.1:7777']);
  assert.equal(r.pageKeeper, false);
  const plain = resolveTestRuntime('?fulcrum=ws://127.0.0.1:50021');
  assert.equal(plain.relayUrls, undefined);
  assert.equal(plain.pageKeeper, undefined);
  assert.throws(() => resolveTestRuntime('?fulcrum=ws://127.0.0.1:50021&relay=wss://relay.example.org:443'), /relay must be a local ws/);
  // Production never reads the query string at all.
  assert.equal(PRODUCTION_RUNTIME.relayUrls, undefined);
  assert.equal(PRODUCTION_RUNTIME.pageKeeper, undefined);
});

test('api: retries "not yet" answers, gives up on refusals, times out', async () => {
  let n = 0;
  const flaky = createApi({ sleep: noSleep, fetchImpl: async () => (++n < 3 ? json(404, { error: 'no marker yet' }) : json(200, { signature: 'cd'.repeat(64) })) });
  assert.equal((await flaky.notice({ category: 'aa', seat: '01' })).signature, 'cd'.repeat(64));
  assert.equal(n, 3);

  let m = 0;
  const refused = createApi({ sleep: noSleep, fetchImpl: async () => (m++, json(403, { error: 'notices are signed only for the sample refund show' })) });
  await assert.rejects(refused.notice({ category: 'aa', seat: '01' }), (e) => e.code === 'http' && e.status === 403 && e.serverMessage.startsWith('notices'));
  assert.equal(m, 1, 'a refusal is not retried');

  let k = 0;
  const down = createApi({ sleep: noSleep, retryDelaysMs: [1, 1], fetchImpl: async () => (k++, json(503, { error: 'down' })) });
  await assert.rejects(down.notice({ category: 'aa', seat: '01' }), (e) => e.status === 503);
  assert.equal(k, 3, 'two retries, then the error');

  const slow = createApi({
    sleep: noSleep,
    retryDelaysMs: [],
    timeoutMs: 20,
    fetchImpl: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))),
  });
  await assert.rejects(slow.door({ category: 'aa', txid: 'bb' }), (e) => e.code === 'timeout');
});

test('every stuck state has a plain sentence and a next step (APP-BRIEF section 3)', () => {
  const show = { startHeight: 977_637 };
  const cases = [
    [new WalletError('rejected', 'User rejected the request'), 'walletDeclined', ['retry'], 'Your wallet declined: “User rejected the request”. Nothing was sent.'],
    [new WalletError('rejected', 'Wallet could not verify transaction'), 'walletCouldNotVerify', ['retry'], 'Your wallet could not verify this transaction. Nothing was sent.'],
    [new WalletError('timeout', 'no answer'), 'walletTimeout', ['retry'], 'Your wallet did not answer in time. Nothing was sent.'],
    [new WalletError('wrong-network', 'chipnet'), 'walletWrongNetwork', ['connect'], null],
    [new WalletError('relay', 'relay down'), 'walletRelay', ['retry'], null],
    [Object.assign(new Error('x'), { name: 'FundsError', code: 'insufficient-funds', need: 103_000n, have: 50_000n }), 'needMore', ['retry'], 'You need about 0.00103 BCH for this ticket; your wallet has 0.0005 BCH in plain BCH.'],
    [Object.assign(new Error('x'), { name: 'FundsError', code: 'only-token-coins' }), 'onlyTokens', ['retry'], null],
    [Object.assign(new BroadcastError('conflict', 'txn-mempool-conflict'), { conflict: true }), 'shardTaken', ['retry'], null],
    [new BroadcastError('rejected', 'the transaction was rejected by network rules.\n\nmin relay fee not met'), 'refused', ['retry'], 'The network refused the transaction: “min relay fee not met”'],
    [Object.assign(new Error('all servers down'), { name: 'TransportError', code: 'all-down' }), 'chainDown', ['retry'], null],
    [new DoorstubError('sales-ended', 'sales ended'), 'showSalesEnded', ['nextInstance'], 'Sales for this show ended at block 977,637.'],
    [Object.assign(new Error('no open box-office shard'), { code: 'no-open-shard' }), 'salesClosed', ['nextInstance'], null],
    [Object.assign(new Error('outputs differ'), { name: 'CheckError' }), 'replyFailed', ['retry'], null],
  ];
  for (const [error, key, actions, sentence] of cases) {
    const d = describeError(error, { show });
    assert.equal(d.key, key, `${error.message} -> ${d.key}`);
    assert.deepEqual(d.actions, actions, key);
    const text = say(d.key, d.vars);
    assert.doesNotMatch(text, /\{\w+\}/, `${key} has an unfilled slot: ${text}`);
    if (sentence !== null) assert.equal(text, sentence);
  }
});

test('runtime: production is one frozen constant; the test runtime only takes local addresses', () => {
  assert.ok(Object.isFrozen(PRODUCTION_RUNTIME));
  assert.deepEqual({ ...PRODUCTION_RUNTIME }, { network: 'mainnet', servers: undefined, apiOrigin: '', showsUrl: '/shows.json', testHooks: false });
  const local = resolveTestRuntime('?fulcrum=ws://127.0.0.1:50021&api=http://127.0.0.1:50022&usd=208');
  assert.deepEqual(local.servers, ['ws://127.0.0.1:50021']);
  assert.equal(local.network, 'simnet');
  assert.equal(local.showsUrl, 'http://127.0.0.1:50022/shows.json');
  assert.equal(local.usd, 208);
  assert.equal(resolveTestRuntime('').network, 'mainnet');
  assert.throws(() => resolveTestRuntime('?fulcrum=wss://evil.example.org:50004'), /local ws/);
  assert.throws(() => resolveTestRuntime('?fulcrum=ws://127.0.0.1:1&api=https://evil.example.org'), /local http/);
  assert.throws(() => resolveTestRuntime('?fulcrum=ws://127.0.0.1:1&shows=https://evil.example.org/shows.json'), /shows must be a path/);
});

test('_headers CSP allows exactly the pinned Fulcrum servers, the two relays and the price sources', () => {
  const headers = readFileSync(new URL('../../app/public/_headers', import.meta.url), 'utf8');
  const csp = /Content-Security-Policy: (.+)/.exec(headers)[1];
  const connect = /connect-src ([^;]+)/.exec(csp)[1].trim().split(/\s+/);
  const expected = [
    "'self'",
    ...MAINNET_SERVERS.map((s) => s.url),
    ...RELAY_URLS.map((u) => u.replace(/:443$/, '')),
    ...PRICE_SOURCES.map((s) => new URL(s.url).origin),
  ];
  assert.deepEqual([...connect].sort(), [...expected].sort());
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval';/, 'no third-party script');
  assert.match(csp, /font-src 'self'/, 'no third-party font');
  assert.match(csp, /frame-ancestors 'none'/);
});

test('price: the first sane answer wins; no answer hides the dollar figure', async () => {
  assert.equal(saneRate(207.5), 207.5);
  assert.equal(saneRate(0), null);
  assert.equal(saneRate(Number.NaN), null);
  const seen = [];
  const rate = await fetchUsdPerBch({
    fetchImpl: async (url, init) => {
      seen.push([url, init.credentials, init.referrerPolicy]);
      return url.includes('coingecko') ? json(500, {}) : json(200, { data: { amount: '207.12' } });
    },
  });
  assert.equal(rate, 207.12);
  assert.deepEqual(seen.map((s) => s.slice(1)), [['omit', 'no-referrer'], ['omit', 'no-referrer']]);
  assert.equal(await fetchUsdPerBch({ fetchImpl: async () => { throw new Error('offline'); } }), null);
});
