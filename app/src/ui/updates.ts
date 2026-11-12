/**
 * Looking for a new version of the app. A browser checks for a new service
 * worker when a page loads, but a home-screen app on iOS is usually resumed,
 * not reloaded, so it could run an old version for days. This checks again
 * whenever the app comes back into view, and every hour while it stays open.
 */
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
/** Don't check more often than this, however often the app is brought back. */
export const MIN_CHECK_GAP_MS = 30 * 1000;

interface Page {
  visibilityState: DocumentVisibilityState;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

interface Win {
  addEventListener(type: 'pageshow', listener: () => void): void;
  removeEventListener(type: 'pageshow', listener: () => void): void;
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}

/** Starts checking `registration` for updates; returns a function that stops. */
export function watchForUpdates(
  registration: { update(): Promise<unknown> },
  page: Page = document,
  win: Win = window as unknown as Win,
  now: () => number = Date.now,
): () => void {
  let last = Number.NEGATIVE_INFINITY;
  const check = () => {
    if (page.visibilityState !== 'visible' || now() - last < MIN_CHECK_GAP_MS) return;
    last = now();
    // Offline, or the server is unreachable: try again next time.
    registration.update().catch(() => {});
  };
  page.addEventListener('visibilitychange', check);
  win.addEventListener('pageshow', check);
  const timer = win.setInterval(check, UPDATE_CHECK_INTERVAL_MS);
  return () => {
    page.removeEventListener('visibilitychange', check);
    win.removeEventListener('pageshow', check);
    win.clearInterval(timer);
  };
}
