// What the room shows for a controller state: plain data, no DOM, so the
// state machine is tested in Node (test-room/room-page.test.js).
import { clockText, shortId } from '../lib/format.js';
import { ROOM_LABELS, ROOM_SENTENCES, say } from './copy.js';
import { REHEARSAL_SHOW, countdownText } from './state.js';

/**
 * @param {object} s the controller's state (controller.js)
 * @param {{ timeZone?: string }} [options]
 * @returns {{
 *   title: string, lines: string[], receipt: string[], countdown: string|null,
 *   screen: 'blank'|'countdown'|'film'|'tap'|'replay'|'missing',
 *   enter: boolean, preview: boolean, replay: boolean, controls: boolean,
 *   chat: 'none'|'connecting'|'open'|'closed', label: string, copy: boolean
 * }}
 */
export const roomView = (s, { timeZone } = {}) => {
  const out = {
    title: s.title || ROOM_LABELS.room,
    lines: [],
    receipt: [],
    countdown: null,
    screen: 'blank',
    enter: false,
    preview: false,
    replay: false,
    controls: false,
    chat: 'none',
    label: s.anyAi ? ROOM_SENTENCES.labelAi : ROOM_SENTENCES.labelMatch,
    copy: false,
  };
  if (s.stage === 'invalid') {
    out.title = ROOM_LABELS.room;
    out.lines = [say('badLink')];
    return out;
  }
  out.copy = true;
  // The chat runs in the page (worker/lib/room-match.js), so it opens once enter has answered anything but a
  // bad pass: a verified enter, or one being retried because the Functions are down (SPEC-ROOM A1).
  out.chat = s.verified || s.retrying ? (s.phase === 'ended' ? 'closed' : 'open') : 'connecting';
  // Seat and receipt only after /api/room/enter checked the pass: a crafted link cannot put words on this page.
  // Never for the operator's rehearsal: it has no ticket and no check-in (its txid is made up).
  const walkedIn = s.verified && s.show !== REHEARSAL_SHOW;
  if (walkedIn) out.receipt = [say('receipt', { seat: s.seatLabel, txid: shortId(s.txid) }), say('paid')];
  if (s.stage !== 'ready' || s.phase === null) {
    out.lines = [say('connecting')];
    return out;
  }

  const playing = s.mode === 'sync' || s.mode === 'free-film' || s.mode === 'free-preview';
  const filmGone = s.media?.film === null || (s.media === null && s.mediaFailed) || (s.playerFailed && s.mode === 'sync');
  out.controls = playing && !s.needsTap;

  if (s.phase === 'before') {
    const time = clockText(new Date(s.eventAtMs), { timeZone });
    const countdown = countdownText(s.eventAtMs - s.serverNow);
    out.lines = [say('startsAt', { time, countdown })];
    out.countdown = countdown;
    out.preview = s.media?.preview != null && s.mode !== 'free-preview';
    out.enter = !s.entered;
    out.screen = s.mode === 'free-preview' ? 'film' : 'countdown';
    return out;
  }

  if (s.phase === 'running') {
    if (s.mode === 'sync' && s.needsTap) out.screen = 'tap';
    else if (filmGone) out.screen = 'missing';
    else out.screen = playing ? 'film' : 'blank';
    if (filmGone) out.lines = [say('filmMissing')];
    return out;
  }

  // After the film: questions open, then closed. "Watch from the start" while the replay window lasts;
  // a free play that is already running is never stopped.
  const opensUntil = s.closesAtMs ?? s.opensUntilMs ?? null;
  if (s.phase === 'after') out.lines = [say('filmFinished', { time: opensUntil === null ? '' : clockText(new Date(opensUntil), { timeZone }) })];
  else out.lines = walkedIn ? [say('ended'), say('thanks')] : [say('ended')];
  out.replay = s.replay && s.mode !== 'free-film';
  if (playing) out.screen = 'film';
  else if (out.replay) out.screen = 'replay';
  else out.screen = 'blank';
  return out;
};
