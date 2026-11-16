// Node only, tests only. nostr-tools (under WizardConnect) closes a relay
// socket that is still connecting when its connect timeout fires; the `ws`
// package then emits an 'error' that nobody listens to, which crashes a Node
// process (a browser WebSocket just closes). This makes such a close quiet.
// It changes nothing for sockets that are open.
import WebSocket from 'ws';

let installed = false;

export const installWsCloseGuard = () => {
  if (installed) return;
  installed = true;
  const close = WebSocket.prototype.close;
  WebSocket.prototype.close = function guardedClose(...args) {
    if (this.readyState === WebSocket.CONNECTING) this.on('error', () => {});
    return close.apply(this, args);
  };
};
