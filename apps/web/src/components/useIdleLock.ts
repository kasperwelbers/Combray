import { useEffect } from 'react';

const EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

/** Call `onIdle` after `minutes` without user activity. */
export function useIdleLock(active: boolean, minutes: number, onIdle: () => void) {
  useEffect(() => {
    if (!active) return;
    let timer = window.setTimeout(onIdle, minutes * 60_000);
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(onIdle, minutes * 60_000);
    };
    for (const e of EVENTS) window.addEventListener(e, reset, { passive: true });
    return () => {
      window.clearTimeout(timer);
      for (const e of EVENTS) window.removeEventListener(e, reset);
    };
  }, [active, minutes, onIdle]);
}
