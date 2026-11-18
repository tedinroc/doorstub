// The film player: native HLS on Apple WebKit, otherwise hls.js (the light
// build, loaded only when the room needs it, with enableWorker: false so the
// page's CSP needs no worker-src). One <video playsinline> element; the
// controller decides what plays and when.
import { choosePlayer } from './state.js';

/** 'native' | 'hls' | 'none' for this browser (state.js choosePlayer). */
export const playerKindFor = (video, nav = globalThis.navigator, win = globalThis) =>
  choosePlayer({
    vendor: nav?.vendor ?? '',
    userAgent: nav?.userAgent ?? '',
    canPlayHls: video.canPlayType('application/vnd.apple.mpegurl'),
    mse: typeof (win.ManagedMediaSource ?? win.MediaSource) === 'function',
  });

/**
 * @param {object} o
 * @param {HTMLVideoElement} o.video
 * @param {'native'|'hls'|'none'} o.kind
 * @param {(reason: string) => void} o.onFatal the source cannot play (the controller retries)
 */
export const createPlayer = ({ video, kind, onFatal = () => {} }) => {
  let hls = null;
  let src = null;
  let token = 0;

  const unload = () => {
    token += 1;
    if (hls !== null) {
      hls.destroy();
      hls = null;
    }
    if (video.getAttribute('src') !== null) {
      video.removeAttribute('src');
      video.load();
    }
    src = null;
  };

  /** Seek once the player knows the media's length. */
  const seekWhenReady = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    if (video.readyState >= 1) {
      video.currentTime = seconds;
      return;
    }
    video.addEventListener(
      'loadedmetadata',
      () => {
        video.currentTime = seconds;
      },
      { once: true },
    );
  };

  /** Play `url` from `startAt` seconds. The same url again only seeks. */
  const load = async (url, startAt = 0) => {
    if (src === url) {
      seekWhenReady(startAt);
      return;
    }
    unload();
    src = url;
    const mine = token;
    if (kind === 'native') {
      video.src = url;
      seekWhenReady(startAt);
      return;
    }
    if (kind !== 'hls') {
      onFatal('no-player');
      return;
    }
    const { default: Hls } = await import('hls.js/light');
    if (mine !== token) return;
    if (!Hls.isSupported()) {
      onFatal('no-player');
      return;
    }
    let recoveries = 0;
    hls = new Hls({ enableWorker: false, startPosition: startAt > 0 ? startAt : -1, capLevelToPlayerSize: true, maxBufferLength: 30, backBufferLength: 30 });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data?.fatal) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && recoveries < 3) {
        recoveries += 1;
        hls.recoverMediaError();
        return;
      }
      onFatal(String(data.details ?? data.type ?? 'error'));
    });
    hls.loadSource(url);
    hls.attachMedia(video);
  };

  return {
    kind,
    load,
    unload,
    get src() {
      return src;
    },
  };
};
