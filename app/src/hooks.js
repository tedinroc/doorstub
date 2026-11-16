import { useEffect, useRef, useState } from 'preact/hooks';

/** The store's state, re-rendering on every change. */
export const useStore = (store) => {
  const [state, setState] = useState(store.get());
  useEffect(() => store.subscribe(setState), [store]);
  return state;
};

/** Date.now(), refreshed every `ms` (for countdowns). */
export const useNow = (ms = 30_000) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
};

/** The previous value of `value` (undefined on the first render). */
export const usePrevious = (value) => {
  const ref = useRef();
  useEffect(() => {
    ref.current = value;
  });
  return ref.current;
};

export const reducedMotion = () => {
  try {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
};

/** A phone (coarse pointer, small screen): Open Selene becomes the main button. */
export const isPhone = () => {
  try {
    return globalThis.matchMedia?.('(pointer: coarse)').matches === true && Math.min(globalThis.screen?.width ?? 1000, globalThis.screen?.height ?? 1000) < 820;
  } catch {
    return false;
  }
};

/**
 * A coin flies from one element to another along an arc (money coming back
 * to the wallet). Skipped with reduced motion.
 */
export const flyCoin = (from, to, { delay = 0 } = {}) => {
  if (!from || !to || reducedMotion() || typeof document === 'undefined') {
    to?.classList.remove('pulse');
    void to?.offsetWidth;
    to?.classList.add('pulse');
    return;
  }
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  const coin = document.createElement('div');
  coin.className = 'flying-coin';
  coin.setAttribute('aria-hidden', 'true');
  coin.textContent = 'BCH';
  document.body.append(coin);
  const x0 = a.left + a.width / 2 - 15;
  const y0 = a.top + a.height / 2 - 15;
  const x1 = b.left + b.width / 2 - 15;
  const y1 = b.top + b.height / 2 - 15;
  const lift = Math.min(160, Math.abs(y1 - y0) * 0.35 + 60);
  const animation = coin.animate(
    [
      { transform: `translate(${x0}px, ${y0}px) scale(0.6)`, opacity: 0 },
      { transform: `translate(${x0}px, ${y0 - 24}px) scale(1.15)`, opacity: 1, offset: 0.15 },
      { transform: `translate(${(x0 + x1) / 2}px, ${Math.min(y0, y1) - lift}px) scale(1) rotate(200deg)`, offset: 0.55 },
      { transform: `translate(${x1}px, ${y1}px) scale(0.55) rotate(360deg)`, opacity: 0.9 },
    ],
    { duration: 1100, delay, easing: 'cubic-bezier(.5,0,.3,1)', fill: 'both' },
  );
  animation.onfinish = () => {
    coin.remove();
    to.classList.remove('pulse');
    void to.offsetWidth;
    to.classList.add('pulse');
  };
};

/** Copy text; resolves true when it worked. */
export const copyText = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
};
