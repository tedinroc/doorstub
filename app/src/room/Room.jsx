// The screening room page. Renders the controller's state (view.js); every
// word comes from copy.js or the written FAQ (worker/lib/room-faq.js), and
// answers are shown as plain text.
import { useEffect, useRef, useState } from 'preact/hooks';
import { ROOM_LABELS as L, ROOM_SENTENCES, say } from './copy.js';
import { CHIPS } from './controller.js';
import { answerPieces } from './state.js';
import { roomView } from './view.js';

/** The store's state. Re-reads it once subscribed: a change that lands before the effect runs (a fast 403) is not lost. */
const useRoomStore = (store) => {
  const [state, setState] = useState(store.get());
  useEffect(() => {
    const off = store.subscribe(setState);
    setState(store.get());
    return off;
  }, [store]);
  return state;
};

/**
 * What a screen reader is told: the status lines once each time the room's state changes (connecting, the
 * countdown, the film, after it, the end), then cleared, so the countdown's every second is not read out
 * and a reader browsing the page meets the visible lines only.
 */
const useAnnouncement = (key, text) => {
  const [said, setSaid] = useState('');
  useEffect(() => {
    setSaid(text);
    const t = setTimeout(() => setSaid(''), 5_000);
    return () => clearTimeout(t);
  }, [key]);
  return said;
};

const Pieces = ({ text }) =>
  answerPieces(text, { origin: globalThis.location?.origin ?? '' }).map((p, i) =>
    p.href === undefined ? (
      <span key={i}>{p.text}</span>
    ) : (
      <a key={i} href={p.href} target="_blank" rel="noopener noreferrer">
        {p.text}
      </a>
    ),
  );

const Answer = ({ item }) => (
  <li class="room-answer" data-via={item.via}>
    {item.answers.map((a) => (
      <div key={a.id} class="room-faq" data-answer={a.id}>
        <p class="room-faq-q">{say('fromFaq', { q: a.q })}</p>
        <p class="room-faq-a">
          <Pieces text={a.a} />
        </p>
      </div>
    ))}
  </li>
);

/**
 * Keeps the newest answer in view: on each new item, scroll to the bottom, but never past the top of the
 * newest question and answer (a long answer is read from its heading). On a resize (a phone turned, a
 * window narrowed) it does that again, unless the guest has scrolled away to read something older.
 */
const useLatestInView = (listRef, transcript, chat) => {
  const pinned = useRef({ stuck: true, target: 0 });
  const showLatest = () => {
    const el = listRef.current;
    if (el === null) return;
    const items = el.children;
    const last = items[items.length - 1];
    let target = el.scrollHeight - el.clientHeight;
    if (last !== undefined) {
      const start = last.previousElementSibling?.classList.contains('room-question') ? last.previousElementSibling : last;
      const top = el.scrollTop + start.getBoundingClientRect().top - el.getBoundingClientRect().top - el.clientTop - 8;
      target = Math.max(0, Math.min(target, top));
    }
    el.scrollTop = target;
    pinned.current = { stuck: true, target: el.scrollTop };
  };
  useEffect(showLatest, [transcript]);
  useEffect(() => {
    const el = listRef.current;
    if (el === null) return undefined;
    const onScroll = () => {
      const p = pinned.current;
      p.stuck = Math.abs(el.scrollTop - p.target) < 2 || el.scrollHeight - el.scrollTop - el.clientHeight < 2;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    const resized = typeof ResizeObserver === 'function' ? new ResizeObserver(() => pinned.current.stuck && showLatest()) : null;
    resized?.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      resized?.disconnect();
    };
  }, [chat]);
};

const Chat = ({ view, state, actions }) => {
  const [text, setText] = useState('');
  const listRef = useRef(null);
  useLatestInView(listRef, state.transcript, view.chat);
  if (view.chat === 'none') return null;
  const open = view.chat === 'open';
  const submit = (e) => {
    e.preventDefault();
    if (actions.ask(text)) setText('');
  };
  return (
    <aside class="room-chat" aria-labelledby="room-chat-title" data-chat={view.chat}>
      <h2 id="room-chat-title" class="room-chat-title display">
        {L.chat}
      </h2>
      {view.chat === 'connecting' ? (
        <p class="room-note" data-chat-connecting>
          {ROOM_SENTENCES.connecting}
        </p>
      ) : (
        <>
          <p class="room-label" data-chat-label>
            {view.label}
          </p>
          {open && (
            <div class="room-chips" role="group" aria-label={L.chat}>
              {CHIPS.map((c) => (
                <button key={c.id} type="button" class="room-chip" data-chip={c.id} onClick={() => actions.chip(c.id)}>
                  {c.q}
                </button>
              ))}
            </div>
          )}
          <ol class="room-transcript" ref={listRef} aria-live="polite" data-transcript>
            {state.transcript.map((item, i) =>
              item.kind === 'question' ? (
                <li key={i} class="room-question">
                  <span class="sr-only">{L.youAsked}: </span>
                  {item.text}
                </li>
              ) : (
                <Answer key={i} item={item} />
              ),
            )}
          </ol>
          {open && (
            <form class="room-ask" onSubmit={submit} data-ask>
              <label class="sr-only" for="room-question">
                {L.askPlaceholder}
              </label>
              <input
                id="room-question"
                type="text"
                maxLength={300}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="send"
                placeholder={L.askPlaceholder}
                value={text}
                onInput={(e) => setText(e.currentTarget.value)}
              />
              <button type="submit" class="room-btn room-btn-primary">
                {L.ask}
              </button>
            </form>
          )}
        </>
      )}
    </aside>
  );
};

const Screen = ({ view, state, actions, videoRef }) => (
  <div class={`room-screen screen-${view.screen}`} data-screen={view.screen}>
    <video ref={videoRef} class="room-video" playsInline preload="metadata" controls={view.controls} data-room-video />
    {view.screen === 'countdown' && (
      <div class="room-overlay">
        <p class="room-countdown display" data-countdown>
          {view.countdown}
        </p>
        <div class="room-overlay-actions">
          {view.enter && (
            <button type="button" class="room-btn room-btn-primary" data-enter onClick={actions.enterRoom}>
              {L.enterRoom}
            </button>
          )}
          {view.preview && (
            <button type="button" class="room-btn" data-preview onClick={actions.watchPreview}>
              {L.watchPreview}
            </button>
          )}
        </div>
      </div>
    )}
    {view.screen === 'tap' && (
      <button type="button" class="room-overlay room-tap" data-tap-sound onClick={actions.tapSound}>
        <span class="room-btn room-btn-primary">{L.tapSound}</span>
      </button>
    )}
    {view.screen === 'replay' && (
      <div class="room-overlay">
        <button type="button" class="room-btn room-btn-primary" data-replay onClick={actions.watchFromStart}>
          {L.watchFromStart}
        </button>
      </div>
    )}
    {view.screen === 'missing' && (
      <div class="room-overlay">
        <p class="room-note">{ROOM_SENTENCES.filmMissing}</p>
      </div>
    )}
    {state.mode !== 'none' && <span class="sr-only">{L.film}</span>}
  </div>
);

export const Room = ({ controller }) => {
  const state = useRoomStore(controller.store);
  const view = roomView(state);
  const announcement = useAnnouncement(`${state.stage}|${state.phase}|${view.screen}|${view.lines.length}`, view.lines.join(' '));
  const videoRef = useRef(null);
  useEffect(() => {
    controller.attachVideo(videoRef.current);
  }, [controller]);
  const { actions } = controller;
  return (
    <div class="room-page">
      <header class="room-top">
        <a class="room-brand display" href="/">
          Doorstub
        </a>
        <span class="room-kicker">{L.room}</span>
      </header>
      <main class="room-main">
        <section class="room-stage" aria-labelledby="room-title">
          <Screen view={view} state={state} actions={actions} videoRef={videoRef} />
          <div class="room-info">
            <h1 id="room-title" class="room-title display" data-room-title>
              {view.title}
            </h1>
            <div data-status>
              {view.lines.map((line) => (
                <p key={line} class="room-line">
                  {line}
                </p>
              ))}
            </div>
            <p class="sr-only" aria-live="polite" data-announce>
              {announcement}
            </p>
            {view.receipt.length > 0 && (
              <div class="room-receipt" data-receipt>
                {view.receipt.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
            )}
            {view.copy && (
              <div class="room-actions">
                <button type="button" class="room-btn" data-copy-link onClick={actions.copyLink}>
                  {state.copied ? L.copied : L.copyLink}
                </button>
              </div>
            )}
          </div>
        </section>
        <Chat view={view} state={state} actions={actions} />
      </main>
      <footer class="room-foot">
        <p>
          {ROOM_SENTENCES.hlsCredit}{' '}
          <a href="/licenses.txt" target="_blank" rel="noopener noreferrer">
            {L.licences}
          </a>
        </p>
      </footer>
    </div>
  );
};
