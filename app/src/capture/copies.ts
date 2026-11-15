/**
 * Whether live mode counts an identical copy put straight on top of the card
 * read last (see liveSession.ts, COPY_MOVED). Off by default: a nudge looks
 * much the same, and it isn't tuned on a phone yet. Remembered on this device.
 */
const KEY = 'manifest-count-copies';

export function countCopiesEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function setCountCopiesEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    // Storage blocked: the switch lasts until the page closes.
  }
}
