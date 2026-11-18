/**
 * When the app looks for a new build of the card index (built nightly). On
 * start-up, when it comes back into view (iOS resumes a home-screen app rather
 * than reloading it), when the connection comes back, and every hour while it
 * stays open. A check that reached the server isn't repeated for a few hours;
 * one that met a deploy half done is retried after a few minutes.
 */
import { checkForIndexUpdate, onStaleBuild } from './indexClient';

/** After a check that reached the server: the index changes once a day. */
export const CHECK_GAP_MS = 3 * 60 * 60 * 1000;
/** After the server returned files from another build than its manifest (a deploy under way, or the CDN catching up). */
export const RETRY_GAP_MS = 10 * 60 * 1000;
/** However often the app comes back into view or online. */
export const MIN_ATTEMPT_GAP_MS = 30 * 1000;
/** After start-up, out of the way of the app's own first requests. */
export const START_DELAY_MS = 3 * 1000;
export const CHECK_INTERVAL_MS = 60 * 60 * 1000;

interface Page {
  visibilityState: DocumentVisibilityState;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

interface Win {
  addEventListener(type: 'online', listener: () => void): void;
  removeEventListener(type: 'online', listener: () => void): void;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}

export interface ScheduleDeps {
  /** Runs one check; resolves with what came of it. */
  check(): Promise<{ kind: string }>;
  /** Called when a thread was served a file from a newer build. */
  onStale(listener: () => void): () => void;
  page: Page;
  win: Win;
  now(): number;
}

/** Starts checking; returns a function that stops. */
export function scheduleIndexUpdates({ check, onStale, page, win, now }: ScheduleDeps): () => void {
  let notBefore = Number.NEGATIVE_INFINITY;
  let lastAttempt = Number.NEGATIVE_INFINITY;
  let running = false;

  const attempt = async () => {
    if (running || page.visibilityState !== 'visible' || now() < notBefore) return;
    running = true;
    lastAttempt = now();
    notBefore = lastAttempt + MIN_ATTEMPT_GAP_MS;
    try {
      const { kind } = await check();
      if (kind === 'mismatch') notBefore = now() + RETRY_GAP_MS;
      else if (kind === 'unavailable') notBefore = Number.POSITIVE_INFINITY; // No Cache Storage here.
      else if (kind !== 'offline' && kind !== 'incomplete' && kind !== 'busy') notBefore = now() + CHECK_GAP_MS;
    } catch {
      // Unexpected: try again at the next chance.
    } finally {
      running = false;
    }
  };

  const stale = () => {
    // A newer build is on the server: look now (a check is one small manifest), unless one was made only just now.
    if (notBefore !== Number.POSITIVE_INFINITY) notBefore = Math.min(notBefore, lastAttempt + MIN_ATTEMPT_GAP_MS);
    void attempt();
  };
  const onEvent = () => void attempt();
  page.addEventListener('visibilitychange', onEvent);
  win.addEventListener('online', onEvent);
  const stopStale = onStale(stale);
  const start = win.setTimeout(onEvent, START_DELAY_MS);
  const timer = win.setInterval(onEvent, CHECK_INTERVAL_MS);
  return () => {
    page.removeEventListener('visibilitychange', onEvent);
    win.removeEventListener('online', onEvent);
    stopStale();
    win.clearTimeout(start);
    win.clearInterval(timer);
  };
}

/** One check at a time across tabs: another tab already checking makes this one skip. */
async function checkOnce(): Promise<{ kind: string }> {
  if (typeof navigator === 'undefined' || !navigator.locks) return checkForIndexUpdate();
  return navigator.locks.request('manifest-index-update', { ifAvailable: true }, async (lock) =>
    lock ? checkForIndexUpdate() : { kind: 'busy' },
  );
}

/** For the app: checks with the real page, window and clock. */
export function startIndexUpdates(): () => void {
  return scheduleIndexUpdates({
    check: checkOnce,
    onStale: onStaleBuild,
    page: document,
    win: window as unknown as Win,
    now: Date.now,
  });
}
