// Keep the WizardConnect relay open for a while after the page is hidden, as
// long as the page is waiting for the wallet.
//
// Why (found 11/19 in the iPhone recordings): "Open Selene" hides this page.
// @wizardconnect/core closes the dapp's relay socket the moment the page is
// hidden (relay-handler.js, onVisibilityChange 'hidden') and opens it again
// only when the page is shown. Selene's first message (its relay key, no xpubs
// yet) then reaches a page that is not listening, and Selene asks "Connect to
// Doorstub?" only after the page has answered (dapp_ready carries the name).
// So the first trip to Selene showed nothing. A phone keeps running a hidden
// page for a while (iOS 26.5 simulator, Safari in the background: 8 s in one
// run, 44 s in another), long enough to answer.
//
// How: the library adds its visibilitychange listener while the relay is
// being created; captureVisibilityListeners() takes that listener instead of
// letting it reach the document, and holdWhileHidden() decides when the
// library hears about a change:
//   - hidden while `waiting()` (pairing, or a sign request out): the library
//     does not hear it, so the socket stays open; still hidden after `holdMs`,
//     it hears 'hidden' and closes the socket as before;
//   - shown again before that: the library runs its own hidden-then-visible
//     cycle at once, so the page reconnects and re-reads what the relay stored,
//     exactly as it does today after every trip to the wallet (first letting a
//     sign request that is still going out finish, up to QUIET_WAIT_MS, so the
//     close never cuts off a request the wallet may already have);
//   - in every other case the library hears each change at once, as before.
// When the library closes the socket after a hold, its replay cutoff (both
// copies the relay client keeps) is put back to the last message the page
// handled, so nothing the wallet sent while the phone had frozen the page, or
// stamped before the return and sent after it, is skipped.
//
// The library itself is not modified.

/** How long a hidden page waiting for the wallet keeps its relay open (ms). */
export const HIDDEN_HOLD_MS = 60_000;
/** Back on the page, how long the reconnect waits for a sign request still going out (ms). */
export const QUIET_WAIT_MS = 3_000;
const QUIET_STEP_MS = 100;

/**
 * Run `create()` and return { value, listeners }: the visibilitychange
 * listeners it added to `doc` are captured instead of added. Without a
 * document (Node), `create()` just runs.
 */
export const captureVisibilityListeners = (doc, create) => {
  if (doc == null || typeof doc.addEventListener !== 'function') return { value: create(), listeners: [] };
  const listeners = [];
  const own = Object.getOwnPropertyDescriptor(doc, 'addEventListener');
  const add = doc.addEventListener;
  doc.addEventListener = function captureVisibility(type, listener, options) {
    if (type === 'visibilitychange' && typeof listener === 'function') {
      listeners.push(listener);
      return undefined;
    }
    return add.call(this, type, listener, options);
  };
  try {
    return { value: create(), listeners };
  } finally {
    if (own !== undefined) Object.defineProperty(doc, 'addEventListener', own);
    else delete doc.addEventListener;
  }
};

/**
 * Decide when the captured `listeners` hear the page's visibility changes
 * (see the top of this file). `client` is the relay client
 * (getLastProcessedTimestamp / setLastProcessedTimestamp); it may be missing.
 * `sending()` is true while a sign request is going out and not yet confirmed.
 * Returns release(): stop listening and drop any hold.
 */
export const holdWhileHidden = ({
  doc,
  listeners,
  client,
  waiting = () => false,
  sending = () => false,
  holdMs = HIDDEN_HOLD_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) => {
  if (doc == null || typeof doc.addEventListener !== 'function' || listeners.length === 0) return () => {};
  let heard = 'visible';
  let hold = null;
  let pending = null; // the reconnect after a hold: waiting for a send to finish, or its second step
  let released = false;

  const clearPending = () => {
    if (pending !== null) clearTimer(pending);
    pending = null;
  };

  /** Let the listeners hear `state` (they read doc.visibilityState, so it reads `state` while they run). */
  const tell = (state) => {
    heard = state;
    const forced = doc.visibilityState !== state;
    const own = forced ? Object.getOwnPropertyDescriptor(doc, 'visibilityState') : undefined;
    if (forced) Object.defineProperty(doc, 'visibilityState', { configurable: true, enumerable: true, get: () => state });
    try {
      for (const listener of listeners) {
        try {
          listener.call(doc, { type: 'visibilitychange', target: doc });
        } catch {
          // the library's handler catches its own errors
        }
      }
    } finally {
      if (forced) {
        if (own !== undefined) Object.defineProperty(doc, 'visibilityState', own);
        else delete doc.visibilityState;
      }
    }
  };

  /**
   * The library closes its socket now; its replay cutoff goes back to the last message handled.
   * RelayClient keeps a second copy per wallet+dapp pair (its static sessionTimestamps, private in
   * the types): disconnect() moves that one to "now" too, and the next "connected" raises the
   * cutoff to it, so a message the wallet stamped before the close and sent after the reconnect
   * would be dropped. It is put back as well.
   */
  const closeAfterHold = () => {
    const cutoff = typeof client?.getLastProcessedTimestamp === 'function' ? client.getLastProcessedTimestamp() : undefined;
    const saved = client?.constructor?.sessionTimestamps instanceof Map ? client.constructor.sessionTimestamps : null;
    const key = saved !== null && typeof client.sessionKey === 'string' ? client.sessionKey : null;
    const had = key !== null && saved.has(key);
    const before = had ? saved.get(key) : undefined;
    tell('hidden');
    if (Number.isFinite(cutoff) && cutoff > 0) client.setLastProcessedTimestamp(cutoff);
    if (key !== null && client.sessionKey === key) {
      if (had) saved.set(key, before);
      else saved.delete(key);
    }
  };

  /** Back after a hold: reconnect and re-read the relay, as after any trip to the wallet. */
  const reconnect = (waited = 0) => {
    pending = null;
    if (released || doc.visibilityState !== 'visible' || heard === 'hidden') return;
    if (sending() && waited < QUIET_WAIT_MS) {
      pending = setTimer(() => reconnect(waited + QUIET_STEP_MS), QUIET_STEP_MS);
      pending?.unref?.();
      return;
    }
    closeAfterHold();
    pending = setTimer(() => {
      pending = null;
      if (!released && doc.visibilityState === 'visible' && heard === 'hidden') tell('visible');
    }, 0);
    pending?.unref?.();
  };

  const onChange = () => {
    if (released) return;
    const state = doc.visibilityState;
    if (state === 'hidden') {
      clearPending();
      if (hold !== null || heard === 'hidden') return;
      if (!waiting()) {
        tell('hidden');
        return;
      }
      hold = setTimer(() => {
        hold = null;
        if (!released && doc.visibilityState === 'hidden') closeAfterHold();
      }, holdMs);
      hold?.unref?.();
    } else if (state === 'visible') {
      if (hold !== null) {
        clearTimer(hold);
        hold = null;
        clearPending();
        reconnect();
        return;
      }
      if (heard === 'hidden') tell('visible');
    }
  };

  doc.addEventListener('visibilitychange', onChange);
  return () => {
    released = true;
    if (hold !== null) clearTimer(hold);
    hold = null;
    clearPending();
    doc.removeEventListener?.('visibilitychange', onChange);
  };
};
