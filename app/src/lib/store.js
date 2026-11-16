// A very small store: one state object, shallow updates, subscribers.
export const createStore = (initial) => {
  let state = initial;
  const listeners = new Set();
  return {
    get: () => state,
    /** Merge `patch` (or `patch(state)`) into the state and notify. */
    set: (patch) => {
      const next = typeof patch === 'function' ? patch(state) : patch;
      if (next === undefined || next === null) return;
      state = { ...state, ...next };
      for (const fn of [...listeners]) {
        try {
          fn(state);
        } catch {
          // a broken view must not break the controller
        }
      }
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
};
