// The screening room's controller: reads the link's fragment, the static
// files (/shows.json, /room/media/<m>/room.json) and /api/room/enter, keeps
// the clock, and drives the film and the chat. Components only render its
// state and call its actions.
//
// Playback works from static files alone, and so does the chat once enter
// has answered anything but a bad pass: a verified enter only shows the seat
// and sharpens the clock. Only 400 and 403 from enter mean a bad
// pass; anything else is retried (state.js retryDelay), and so is a request
// that has not answered after FETCH_TIMEOUT_MS.
//
// The chat runs entirely in the page (worker/lib/room-match.js over
// worker/lib/room-faq.js): a question is never sent anywhere.
import { ROOM_FAQ } from '../../../worker/lib/room-faq.js';
import { chipAnswer, decide, hardSecret, normalise } from '../../../worker/lib/room-match.js';
import { createStore } from '../lib/store.js';
import { createPlayer, playerKindFor } from './player.js';
import {
  FETCH_TIMEOUT_MS,
  REMEASURE_BEFORE_MS,
  REMEASURE_EVERY_MS,
  RESYNC_DRIFT_S,
  RETURN_DRIFT_S,
  createClock,
  enterOutcome,
  filmPosition,
  nudgeRate,
  mediaFromRoomJson,
  opensUntilOf,
  parseFragment,
  phaseAt,
  replayOpen,
  retryDelay,
  showFromList,
  syncDecision,
  toMs,
} from './state.js';

const TICK_MS = 500;
const TRANSCRIPT_MAX = 60;
const ENDED_REJOIN_GAP_MS = 5_000;

export const CHIPS = Object.freeze(ROOM_FAQ.entries.filter((e) => e.chip === true && e.botOk === true).map((e) => ({ id: e.id, q: e.q })));

/**
 * @param {object} [o]
 * @param {Window} [o.win]
 * @param {Function} [o.fetchImpl]
 * @param {() => number} [o.now] local wall clock (Date.now)
 */
export const createRoomController = ({ win = globalThis, fetchImpl = (...a) => globalThis.fetch(...a), now = () => Date.now() } = {}) => {
  const fragment = parseFragment(win.location?.hash ?? '');
  const clock = createClock({ now });
  const store = createStore({
    stage: fragment === null ? 'invalid' : 'connecting', // 'invalid' | 'connecting' | 'ready'
    show: fragment?.show ?? '', // the operator's 'rehearsal' shows no receipt (view.js)
    verified: false,
    retrying: false,
    title: '',
    seatLabel: '',
    txid: fragment?.txid ?? '',
    eventAtMs: null,
    durationMin: null,
    opensUntilMs: null, // from enter
    closesAtMs: null, // enter's opensUntil, or eventAt + durationMin + 10 min from shows.json
    media: null, // { film, preview } from room.json
    mediaFailed: false,
    serverNow: now(),
    phase: null,
    replay: false,
    entered: false,
    mode: 'none', // 'none' | 'sync' | 'free-film' | 'free-preview' | 'done'
    muted: false,
    needsTap: false,
    playerFailed: false,
    transcript: [],
    anyAi: false,
    copied: false,
  });

  const base = fragment === null ? '' : `/room/media/${fragment.m}`;
  const filmUrl = `${base}/film.m3u8`;
  const previewUrl = `${base}/preview.m3u8`;

  let video = null;
  let player = null;
  let lastSyncAt = -Infinity;
  let stalled = false;
  let stallEndedAt = -Infinity;
  let seekStartedAt = null;
  let lead = 0;
  let lastMeasureAt = -Infinity;
  let measuredBeforeStart = false;
  let enterAttempt = 0;
  let enterTimer = null;
  let ticker = null;
  let stopped = false;
  let copiedTimer = null;

  const later = (fn, ms) => win.setTimeout(fn, ms);

  // ------------------------------------------------------------------ static files and enter

  /**
   * A fetch that gives up after FETCH_TIMEOUT_MS (a captive portal or a dead phone link can leave one
   * hanging for minutes): the abort lands in the caller's catch as a network error, which is retried.
   * Run `read` on the response inside the same time limit.
   */
  const timedFetch = async (url, init, read) => {
    const abort = typeof win.AbortController === 'function' ? new win.AbortController() : typeof AbortController === 'function' ? new AbortController() : null;
    const timer = abort === null ? null : later(() => abort.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, abort === null ? init : { ...init, signal: abort.signal });
      return await read(response);
    } finally {
      if (timer !== null) win.clearTimeout(timer);
    }
  };

  const readJson = async (response) => {
    try {
      return await response.json();
    } catch {
      return null;
    }
  };

  const getJson = async (url) => {
    const sentAt = now();
    try {
      return await timedFetch(url, { cache: 'no-store', credentials: 'omit' }, async (response) => {
        const receivedAt = now();
        const json = await readJson(response);
        return { status: response.status, json, date: response.headers.get('date'), sentAt, receivedAt };
      });
    } catch {
      return { status: 0, json: null, date: null, sentAt, receivedAt: now() };
    }
  };

  /** /shows.json: the show's start and length (real shows), and the server's Date for the clock. */
  const readShows = async () => {
    const r = await getJson('/shows.json');
    lastMeasureAt = now();
    if (r.date !== null && r.status > 0) clock.fromDate(r.date, r.sentAt, r.receivedAt);
    if (r.status !== 200 || r.json === null) return false;
    const show = showFromList(r.json, fragment.show);
    if (show !== null && !store.get().verified) store.set({ title: show.title, eventAtMs: show.eventAtMs, durationMin: show.durationMin });
    return true;
  };

  const loadShows = async (attempt = 0) => {
    if (stopped) return;
    const ok = await readShows();
    if (!ok) later(() => loadShows(attempt + 1), retryDelay(attempt));
    tick();
  };

  const loadMedia = async (attempt = 0) => {
    if (stopped) return;
    const r = await getJson(`${base}/room.json`);
    if (r.status === 200 && r.json !== null && typeof r.json === 'object') {
      store.set({ media: mediaFromRoomJson(r.json), mediaFailed: false });
    } else {
      store.set({ mediaFailed: true });
      later(() => loadMedia(attempt + 1), retryDelay(attempt));
    }
    tick();
  };

  const enter = async () => {
    if (stopped) return;
    enterTimer = null;
    const sentAt = now();
    let status = 0;
    let json = null;
    try {
      const init = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ show: fragment.show, seat: fragment.seat, txid: fragment.txid, pass: fragment.pass }),
        credentials: 'omit',
        cache: 'no-store',
      };
      ({ status, json } = await timedFetch('/api/room/enter', init, async (response) => ({ status: response.status, json: await readJson(response) })));
    } catch {
      status = 0;
      json = null;
    }
    const receivedAt = now();
    const outcome = enterOutcome({ status, json });
    if (outcome === 'bad-pass') {
      stopPlayback();
      store.set({ stage: 'invalid', retrying: false });
      return;
    }
    if (outcome === 'retry') {
      store.set({ retrying: true });
      enterTimer = later(enter, retryDelay(enterAttempt));
      enterAttempt += 1;
      return;
    }
    const serverNow = toMs(json.now);
    if (serverNow !== null) clock.fromServer(serverNow, sentAt, receivedAt);
    const eventAtMs = toMs(json.eventAt);
    const durationMin = Number(json.durationMin);
    store.set({
      verified: true,
      retrying: false,
      title: typeof json.title === 'string' ? json.title : store.get().title,
      seatLabel: typeof json.seatLabel === 'string' ? json.seatLabel : fragment.seat,
      eventAtMs,
      durationMin: Number.isFinite(durationMin) ? durationMin : store.get().durationMin,
      opensUntilMs: toMs(json.opensUntil),
    });
    tick();
  };

  /** Re-measure the clock (a GET of /shows.json and its Date header). */
  const remeasure = async () => {
    await readShows();
    tick();
  };

  // ------------------------------------------------------------------ the film

  const play = async ({ muted }) => {
    if (video === null) return false;
    video.muted = muted;
    try {
      await video.play();
      return true;
    } catch {
      return false;
    }
  };

  /** Start the film for everyone: seek once to where the screening is, sound on if the guest entered. */
  const startSync = async () => {
    const s = store.get();
    if (video === null || player === null || s.media?.film == null) return;
    const target = syncDecision({ trigger: 'start', position: filmPosition(clock.now(), s.eventAtMs), currentTime: video.currentTime, lead, filmSeconds: s.media.film.seconds });
    store.set({ mode: 'sync', playerFailed: false });
    lastSyncAt = now();
    seekStartedAt = now();
    await player.load(filmUrl, target);
    if (store.get().mode !== 'sync') return;
    // Sound on when the guest entered; otherwise (or when the browser refuses) muted and in step, with a tap for sound.
    const withSound = s.entered && (await play({ muted: false }));
    if (withSound) store.set({ muted: false, needsTap: false });
    else {
      await play({ muted: true });
      store.set({ muted: true, needsTap: true });
    }
  };

  const resync = (trigger) => {
    const s = store.get();
    if (s.mode !== 'sync' || s.phase !== 'running' || video === null || video.paused || s.media?.film == null) return;
    const position = filmPosition(clock.now(), s.eventAtMs);
    const target = syncDecision({
      trigger,
      position,
      currentTime: video.currentTime,
      sinceSyncMs: now() - lastSyncAt,
      sinceStallMs: now() - stallEndedAt,
      stalled,
      lead,
      filmSeconds: s.media.film.seconds,
    });
    if (target === null) {
      // Small drift: play a little faster or slower until it closes.
      const rate = stalled ? 1 : nudgeRate(position - video.currentTime, video.playbackRate);
      if (rate !== video.playbackRate) video.playbackRate = rate;
      return;
    }
    lastSyncAt = now();
    seekStartedAt = now();
    video.playbackRate = 1;
    video.currentTime = target;
  };

  const stopPlayback = () => {
    if (player !== null) player.unload();
    store.set({ mode: 'none', needsTap: false });
  };

  const onFatal = () => {
    const s = store.get();
    store.set({ playerFailed: true });
    if (s.mode === 'sync') {
      // Try again in a few seconds, from where the screening is by then.
      player?.unload();
      later(() => {
        const t = store.get();
        if (t.mode === 'sync' && t.phase === 'running') startSync();
      }, 5_000);
    }
  };

  const wireVideo = (el) => {
    el.addEventListener('waiting', () => {
      stalled = true;
    });
    el.addEventListener('playing', () => {
      if (stalled) stallEndedAt = now();
      stalled = false;
      if (seekStartedAt !== null) {
        lead = Math.min(3, Math.max(0, (now() - seekStartedAt) / 1000));
        seekStartedAt = null;
      }
      store.set({ playerFailed: false });
    });
    el.addEventListener('volumechange', () => {
      if (!el.muted && store.get().needsTap) store.set({ needsTap: false, muted: false, entered: true });
    });
    el.addEventListener('ended', () => {
      const s = store.get();
      // The preview ended (it plays only before the start), or the synced film was sent to its end early with
      // its controls: back to waiting, so the screening starts, or rejoins, where it is (tick). Otherwise the
      // film is over. A rejoin waits ENDED_REJOIN_GAP_MS after the last seek, so media shorter than room.json
      // says cannot make it seek and end over and over.
      const early =
        s.mode === 'sync' &&
        s.phase === 'running' &&
        filmPosition(clock.now(), s.eventAtMs) < (s.media?.film?.seconds ?? 0) - RESYNC_DRIFT_S &&
        now() - lastSyncAt >= ENDED_REJOIN_GAP_MS;
      if (s.mode === 'free-preview' || early) {
        store.set({ mode: 'none' });
        tick();
        return;
      }
      if (s.mode !== 'none') store.set({ mode: 'done' });
    });
    el.addEventListener('error', () => {
      if (store.get().mode !== 'none') onFatal('media');
    });
  };

  // ------------------------------------------------------------------ the clock tick

  const tick = () => {
    if (stopped) return;
    const s = store.get();
    const serverNow = clock.now();
    if (s.stage === 'invalid') return;
    if (s.eventAtMs === null) {
      store.set({ serverNow });
      return;
    }
    const opensUntilMs = s.opensUntilMs ?? opensUntilOf(s.eventAtMs, s.durationMin ?? 0);
    const phase = phaseAt({ now: serverNow, eventAtMs: s.eventAtMs, filmSeconds: s.media?.film?.seconds ?? null, opensUntilMs });
    store.set({ stage: 'ready', serverNow, phase, closesAtMs: opensUntilMs, replay: s.media?.film != null && replayOpen({ now: serverNow, phase, opensUntilMs }) });

    if (phase === 'before') {
      const toStart = s.eventAtMs - serverNow;
      if (now() - lastMeasureAt >= REMEASURE_EVERY_MS) remeasure();
      if (toStart <= REMEASURE_BEFORE_MS && !measuredBeforeStart) {
        measuredBeforeStart = true;
        remeasure();
      }
      // Native HLS: give the element the film now, so Enter the room can unlock it inside the tap.
      if (player?.kind === 'native' && s.mode === 'none' && s.media?.film != null && player.src === null) player.load(filmUrl, 0);
    }
    if (phase === 'running' && s.media?.film != null && video !== null) {
      if (s.mode === 'none' || s.mode === 'free-preview') startSync();
      else if (s.mode === 'sync') resync('tick');
    }
  };

  // ------------------------------------------------------------------ actions (each runs inside the guest's tap)

  /** Enter the room: unlock sound. On iOS the element must play inside the tap; play then pause. */
  const enterRoom = () => {
    store.set({ entered: true });
    if (video !== null && video.getAttribute('src') !== null && store.get().mode === 'none') {
      video.muted = false;
      const p = video.play();
      video.pause();
      p?.catch?.(() => {});
    }
    if (store.get().phase === 'running') tapSound();
  };

  /** Tap to watch with sound: the film is already playing muted and in step. */
  const tapSound = () => {
    store.set({ entered: true });
    const s = store.get();
    if (video === null) return;
    if (s.mode !== 'sync') {
      startSync();
      return;
    }
    // A film that could not even start muted sat still: bring it to where the screening is.
    const position = filmPosition(clock.now(), s.eventAtMs);
    if (s.phase === 'running' && Math.abs(position - video.currentTime) > RETURN_DRIFT_S) {
      lastSyncAt = now();
      seekStartedAt = now();
      video.currentTime = position + lead;
    }
    video.muted = false;
    const p = video.play();
    store.set({ muted: false, needsTap: false });
    p?.catch?.(() => store.set({ muted: true, needsTap: true }));
  };

  /** A free play (Watch from the start, Watch the preview), with sound, inside the guest's tap. */
  const freePlay = (mode, url) => {
    store.set({ mode, entered: true, needsTap: false, muted: false, playerFailed: false });
    video.playbackRate = 1;
    const loading = player.load(url, 0);
    const go = () => {
      video.muted = false;
      video.play().catch(() => {});
    };
    // Native HLS (iOS) must play inside the tap itself; hls.js plays once it is attached.
    if (player.kind === 'native') go();
    else loading.then(go);
  };

  const watchFromStart = () => {
    if (video === null || player === null || store.get().media?.film == null) return;
    freePlay('free-film', filmUrl);
  };

  const watchPreview = () => {
    if (video === null || player === null || store.get().media?.preview == null) return;
    freePlay('free-preview', previewUrl);
  };

  const push = (...items) => {
    store.set((s) => ({ transcript: [...s.transcript, ...items].slice(-TRANSCRIPT_MAX) }));
  };

  const answerItem = (result) => ({ kind: 'answer', via: result.via, answers: result.answers });

  /** A typed question. Checked and matched here; it never leaves the page. */
  /** The chat is open (view.js): enter answered with anything but a bad pass, and questions have not closed. */
  const chatOpen = (s) => (s.verified || s.retrying) && s.stage !== 'invalid' && s.phase !== 'ended';

  const ask = (text) => {
    const s = store.get();
    if (!chatOpen(s)) return false;
    const q = normalise(String(text ?? ''));
    if (q === '') return false;
    const secret = hardSecret(String(text)) === 'refusal-secret';
    const result = decide(String(text), ROOM_FAQ);
    // A pasted secret is never shown back.
    push(...(secret ? [] : [{ kind: 'question', text: q }]), answerItem(result));
    if (result.via === 'ai') store.set({ anyAi: true });
    return true;
  };

  const chip = (id) => {
    if (!chatOpen(store.get())) return;
    const result = chipAnswer(id, ROOM_FAQ);
    if (result === null) return;
    push({ kind: 'question', text: result.answers[0].q }, answerItem(result));
  };

  const copyLink = async () => {
    const href = win.location.href;
    let ok = false;
    try {
      await win.navigator.clipboard.writeText(href);
      ok = true;
    } catch {
      ok = false;
    }
    if (ok) {
      store.set({ copied: true });
      if (copiedTimer !== null) win.clearTimeout(copiedTimer);
      copiedTimer = later(() => store.set({ copied: false }), 2_000);
    }
    return ok;
  };

  // ------------------------------------------------------------------ lifecycle

  const onReturn = () => {
    if (win.document?.visibilityState === 'hidden') return;
    remeasure().then(() => {
      const s = store.get();
      if (s.mode === 'sync' && s.phase === 'running' && video?.paused) {
        play({ muted: s.muted || !s.entered }).then((ok) => {
          if (!ok) store.set({ needsTap: true });
        });
      }
      resync('return');
    });
  };

  const onOnline = () => {
    if (enterTimer !== null && !store.get().verified) {
      win.clearTimeout(enterTimer);
      enter();
    }
    onReturn();
  };

  const start = () => {
    if (fragment === null) return;
    loadShows();
    loadMedia();
    enter();
    ticker = win.setInterval(tick, TICK_MS);
    win.document?.addEventListener?.('visibilitychange', onReturn);
    win.addEventListener?.('pageshow', onReturn);
    win.addEventListener?.('online', onOnline);
    win.addEventListener?.('hashchange', () => win.location.reload());
  };

  const stop = () => {
    stopped = true;
    if (ticker !== null) win.clearInterval(ticker);
    if (enterTimer !== null) win.clearTimeout(enterTimer);
    player?.unload();
  };

  /** The component hands over its <video> element once. */
  const attachVideo = (el) => {
    if (el === null || video === el) return;
    video = el;
    wireVideo(el);
    player = createPlayer({ video: el, kind: playerKindFor(el, win.navigator, win), onFatal });
    el.dataset.player = player.kind;
    tick();
  };

  return {
    store,
    clock,
    fragment,
    start,
    stop,
    attachVideo,
    actions: { enterRoom, tapSound, watchFromStart, watchPreview, ask, chip, copyLink },
  };
};
