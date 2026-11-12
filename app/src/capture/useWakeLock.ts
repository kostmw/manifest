import { useEffect } from 'react';

interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}

/**
 * Keeps the screen on while `active`: a phone in a stand gets no touches
 * while cards are slid under it, and would otherwise dim and lock mid-stack.
 * The Screen Wake Lock API (Chrome, Safari 16.4+) drops the lock whenever the
 * page is hidden, so it is asked for again when the page comes back.
 * Browsers without it just follow their usual sleep timer.
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    const api = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> } }).wakeLock;
    if (!active || !api) return;
    let sentinel: WakeLockSentinelLike | null = null;
    let stopped = false;
    const acquire = () => {
      if (stopped || sentinel || document.visibilityState !== 'visible') return;
      api.request('screen').then(
        (lock) => {
          if (stopped) {
            void lock.release().catch(() => {});
            return;
          }
          sentinel = lock;
          lock.addEventListener('release', () => {
            sentinel = null;
          });
        },
        () => {
          // Refused (low battery mode, say): the screen just sleeps as usual.
        },
      );
    };
    acquire();
    document.addEventListener('visibilitychange', acquire);
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', acquire);
      void sentinel?.release().catch(() => {});
      sentinel = null;
    };
  }, [active]);
}
