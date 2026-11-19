// hold-hidden.js on its own: which visibility the WizardConnect library hears,
// and when (the whole stack over a relay is in hidden-page.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QUIET_WAIT_MS, captureVisibilityListeners, holdWhileHidden } from '../../src/wallet/hold-hidden.js';

const fakeDocument = () => {
  const target = new EventTarget();
  let state = 'visible';
  return {
    get visibilityState() {
      return state;
    },
    addEventListener: (...args) => target.addEventListener(...args),
    removeEventListener: (...args) => target.removeEventListener(...args),
    set(next) {
      state = next;
      target.dispatchEvent(new Event('visibilitychange'));
    },
  };
};

/** Timers a test runs by hand. */
const manualTimers = () => {
  const pending = new Map();
  let next = 1;
  return {
    setTimer: (fn, ms) => {
      const id = next++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimer: (id) => pending.delete(id),
    /** Run every pending timer of `ms` (or all). */
    run: (ms) => {
      for (const [id, t] of [...pending]) {
        if (ms !== undefined && t.ms !== ms) continue;
        pending.delete(id);
        t.fn();
      }
    },
    count: () => pending.size,
  };
};

/**
 * The library's side: its listener reads the visibility (as the real one reads
 * document.visibilityState) and, on 'hidden', closes the socket, which moves
 * its replay cutoff to "now" (as RelayClient.disconnect does).
 */
const library = (doc, client) => {
  const heard = [];
  const listener = () => {
    heard.push(doc.visibilityState);
    if (doc.visibilityState === 'hidden') client.setLastProcessedTimestamp(9_999);
  };
  return { heard, listener };
};

const relayClient = (cutoff = 100) => ({
  cutoff,
  getLastProcessedTimestamp() {
    return this.cutoff;
  },
  setLastProcessedTimestamp(t) {
    this.cutoff = t;
  },
});

const setup = ({ waiting = () => true, sending = () => false, holdMs = 60_000 } = {}) => {
  const doc = fakeDocument();
  const client = relayClient();
  const lib = library(doc, client);
  const timers = manualTimers();
  const { listeners } = captureVisibilityListeners(doc, () => doc.addEventListener('visibilitychange', lib.listener));
  const release = holdWhileHidden({ doc, listeners, client, waiting, sending, holdMs, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  return { doc, client, lib, timers, release };
};

test('capture: the library\'s visibilitychange listener is taken, other listeners are added, addEventListener is put back', () => {
  const doc = fakeDocument();
  const own = Object.getOwnPropertyDescriptor(doc, 'addEventListener');
  const other = [];
  const visibility = () => {};
  const { value, listeners } = captureVisibilityListeners(doc, () => {
    doc.addEventListener('visibilitychange', visibility);
    doc.addEventListener('other', () => other.push(1));
    return 'made';
  });
  assert.equal(value, 'made');
  assert.deepEqual(listeners, [visibility]);
  assert.deepEqual(Object.getOwnPropertyDescriptor(doc, 'addEventListener'), own);
  doc.set('hidden');
  assert.equal(listeners.length, 1, 'the captured listener was never added to the document');
  // A document without its own addEventListener (a real browser document) gets nothing left behind.
  const proto = { addEventListener() {} };
  const browserLike = Object.create(proto);
  captureVisibilityListeners(browserLike, () => browserLike.addEventListener('visibilitychange', () => {}));
  assert.equal(Object.hasOwn(browserLike, 'addEventListener'), false);
  // No document (Node): create just runs.
  assert.deepEqual(captureVisibilityListeners(undefined, () => 7), { value: 7, listeners: [] });
});

test('not waiting for the wallet: the library hears hidden and visible at once, as without the hold', () => {
  const { doc, lib, client, timers } = setup({ waiting: () => false });
  doc.set('hidden');
  assert.deepEqual(lib.heard, ['hidden']);
  assert.equal(client.cutoff, 9_999, "the library's own cutoff, unchanged");
  doc.set('visible');
  assert.deepEqual(lib.heard, ['hidden', 'visible']);
  assert.equal(timers.count(), 0);
});

test('waiting and hidden: the socket stays open; still hidden after the hold, the library closes it with the cutoff put back', () => {
  const { doc, lib, client, timers } = setup();
  doc.set('hidden');
  assert.deepEqual(lib.heard, [], 'the library did not hear it: the socket stays open');
  client.cutoff = 150; // a message handled while hidden
  timers.run(60_000);
  assert.deepEqual(lib.heard, ['hidden']);
  assert.equal(client.cutoff, 150, 'messages after the last one handled are replayed later');
  doc.set('visible');
  assert.deepEqual(lib.heard, ['hidden', 'visible'], 'back: the library reconnects as before');
});

test("the close after a hold also puts back RelayClient's per-pair copy of the cutoff (sessionTimestamps), which the next 'connected' raises the cutoff to", () => {
  // The real RelayClient: disconnect() moves the cutoff and its static sessionTimestamps entry to "now".
  class Client {
    static sessionTimestamps = new Map();
    cutoff = 100;
    get sessionKey() {
      return 'dapp:wallet';
    }
    getLastProcessedTimestamp() {
      return this.cutoff;
    }
    setLastProcessedTimestamp(t) {
      this.cutoff = t;
    }
  }
  const run = (before) => {
    Client.sessionTimestamps.clear();
    if (before !== undefined) Client.sessionTimestamps.set('dapp:wallet', before);
    const doc = fakeDocument();
    const client = new Client();
    const timers = manualTimers();
    const listener = () => {
      if (doc.visibilityState !== 'hidden') return;
      client.cutoff = 9_999;
      Client.sessionTimestamps.set('dapp:wallet', 9_999);
    };
    const { listeners } = captureVisibilityListeners(doc, () => doc.addEventListener('visibilitychange', listener));
    holdWhileHidden({ doc, listeners, client, waiting: () => true, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
    doc.set('hidden');
    timers.run(60_000);
    return client;
  };
  assert.equal(run(100).cutoff, 100);
  assert.equal(Client.sessionTimestamps.get('dapp:wallet'), 100, 'the entry the last handled message left');
  run(undefined);
  assert.equal(Client.sessionTimestamps.has('dapp:wallet'), false, 'no entry before the close: none after it');
});

test('waiting and back before the hold ends: the library runs its hidden-then-visible cycle (reconnect and replay), cutoff put back', () => {
  const { doc, lib, client, timers } = setup();
  doc.set('hidden');
  doc.set('visible');
  assert.deepEqual(lib.heard, ['hidden'], 'told hidden while the page is visible again');
  assert.equal(client.cutoff, 100);
  assert.equal(doc.visibilityState, 'visible', 'the real visibility again once the library has heard');
  assert.equal(Object.hasOwn(doc, 'visibilityState'), true, "the fake document's own getter is back");
  timers.run(0);
  assert.deepEqual(lib.heard, ['hidden', 'visible']);
  assert.equal(timers.count(), 0, 'the hold timer is gone');
});

test('back while a sign request is still going out: the reconnect waits until the relay confirmed it (at most QUIET_WAIT_MS)', () => {
  let out = true;
  const { doc, lib, timers } = setup({ sending: () => out });
  doc.set('hidden');
  doc.set('visible');
  assert.deepEqual(lib.heard, [], 'the socket is not closed under a request on its way out');
  timers.run(100);
  timers.run(100);
  assert.deepEqual(lib.heard, []);
  out = false; // the relay confirmed it
  timers.run(100);
  assert.deepEqual(lib.heard, ['hidden']);
  timers.run(0);
  assert.deepEqual(lib.heard, ['hidden', 'visible']);

  // A request that is never confirmed (a frozen socket) does not hold the reconnect back for ever.
  const stuck = setup({ sending: () => true });
  stuck.doc.set('hidden');
  stuck.doc.set('visible');
  for (let waited = 0; waited < QUIET_WAIT_MS; waited += 100) stuck.timers.run(100);
  assert.deepEqual(stuck.lib.heard, ['hidden']);
  // Hidden again while waiting: the reconnect is dropped and the hold starts over.
  const again = setup({ sending: () => true });
  again.doc.set('hidden');
  again.doc.set('visible');
  again.doc.set('hidden');
  again.timers.run(100);
  assert.deepEqual(again.lib.heard, []);
  assert.equal(again.timers.count(), 1, 'only the new hold is pending');
});

test('a hold timer that runs late, after the page is visible again, does nothing', () => {
  const { doc, lib, timers } = setup();
  doc.set('hidden');
  // The phone froze the page; it resumes visible before the hold timer gets to run.
  Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => 'visible' });
  timers.run(60_000);
  assert.deepEqual(lib.heard, [], 'not told hidden while the page is visible');
});

test('release: no more listening, and a pending hold is dropped', () => {
  const { doc, lib, timers, release } = setup();
  doc.set('hidden');
  release();
  assert.equal(timers.count(), 0);
  doc.set('visible');
  doc.set('hidden');
  assert.deepEqual(lib.heard, []);
});
