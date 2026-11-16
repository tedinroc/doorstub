// Every stuck state gets one plain sentence (a key in copy.js SENTENCES) and
// the next step the person can take (APP-BRIEF section 3).
//
//   describeError(error, context) -> { key, vars, actions: string[], detail? }
//
// Actions are ids the UI turns into buttons: 'retry' (do the same again),
// 'retryDoor', 'retryRefund', 'nextInstance',
// 'reload', 'connect'.
import { formatBch } from '../../../src/shows/format.js';

/** Selene's refusal of a transaction it cannot check (APP-BRIEF section 8). */
const COULD_NOT_VERIFY = /could not verify/i;

const trimWords = (text, max = 240) => {
  const one = String(text ?? '').replace(/^the transaction was rejected by network rules\.\s*/i, '').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/**
 * @param {unknown} error
 * @param {{ wallet?: string, show?: object }} [context]
 */
export const describeError = (error, context = {}) => {
  const e = /** @type {any} */ (error) ?? {};
  const name = e.name;
  const code = e.code;

  if (name === 'FundsError' || code === 'insufficient-funds' || code === 'only-token-coins') {
    if (code === 'only-token-coins') return { key: 'onlyTokens', vars: {}, actions: ['retry'] };
    return { key: 'needMore', vars: { need: formatBch(e.need ?? 0n), have: formatBch(e.have ?? 0n) }, actions: ['retry'] };
  }

  if (name === 'WalletError') {
    switch (code) {
      case 'timeout':
        return { key: 'walletTimeout', vars: {}, actions: ['retry'] };
      case 'busy':
        return { key: 'walletBusy', vars: {}, actions: [] };
      case 'relay':
        return { key: 'walletRelay', vars: {}, actions: ['retry'] };
      case 'not-connected':
        return { key: 'walletGone', vars: {}, actions: ['connect'] };
      case 'cancelled':
        return { key: 'walletDeclined', vars: { reason: 'Cancelled' }, actions: ['retry'] };
      case 'wrong-network':
        return { key: 'walletWrongNetwork', vars: { network: e.network ?? 'another network' }, actions: ['connect'] };
      case 'rejected':
      default:
        if (COULD_NOT_VERIFY.test(e.message ?? '')) return { key: 'walletCouldNotVerify', vars: {}, actions: ['retry'] };
        return { key: 'walletDeclined', vars: { reason: trimWords(e.message || 'No reason given', 160) }, actions: ['retry'] };
    }
  }

  if (name === 'CheckError') return { key: 'replyFailed', vars: {}, actions: ['retry'], detail: e.message };

  if (name === 'BroadcastError') {
    if (e.conflict) return { key: 'shardTaken', vars: {}, actions: ['retry'] };
    if (code === 'wrong-chain' || code === 'broadcast-disabled' || code === 'not-checked') {
      return { key: 'unexpected', vars: { message: e.message }, actions: ['reload'] };
    }
    return { key: 'refused', vars: { words: trimWords(e.message) }, actions: ['retry'] };
  }

  if (name === 'TransportError' || code === 'all-down') return { key: 'chainDown', vars: {}, actions: ['retry'] };

  if (name === 'DoorstubError') {
    if (code === 'sales-ended' || code === 'sales-cancelled') {
      return { key: 'showSalesEnded', vars: { start: Number(context.show?.startHeight ?? 0).toLocaleString('en-US') }, actions: ['nextInstance'] };
    }
    if (code === 'sales-closed' || code === 'shard-full') return { key: 'salesClosed', vars: {}, actions: ['nextInstance'] };
  }

  if (code === 'no-open-shard') return { key: 'salesClosed', vars: {}, actions: ['nextInstance'] };

  return { key: 'unexpected', vars: { message: trimWords(e.message ?? String(error), 200) }, actions: ['retry'] };
};
