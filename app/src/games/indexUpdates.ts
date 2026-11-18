/**
 * When the app looks for a new build of the card index (built nightly) and
 * fills in the offline copy. On start-up, when it comes back into view (iOS
 * resumes a home-screen app rather than reloading it), when the connection
 * comes back, and every hour while it stays open. A check that reached the
 * server isn't repeated for a few hours; a download that stopped is resumed
 * after a minute; one that met a deploy half done is retried after a few.
 */

/** After a check that reached the server: the index changes once a day. */
export const CHECK_GAP_MS = 3 * 60 * 60 * 1000;
/** After the server returned files from another build than its manifest (a deploy under way, or the CDN catching up). */
export const RETRY_GAP_MS = 10 * 60 * 1000;
/** After a download stopped (the connection dropped): carry on by itself this soon, while the app is in view. */
export const RESUME_DELAY_MS = 60 * 1000;
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
  /** Runs one check; resolves with what came of it (an UpdateOutcome kind, or `busy`/`unavailable`). */
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
  let staleWhileRunning = false;
  let later: unknown = null;

  /** One attempt when it's allowed, if none is due sooner. */
  const attemptAt = (time: number) => {
    if (later !== null) win.clearTimeout(later);
    later = win.setTimeout(() => {
      later = null;
      void attempt();
    }, Math.max(0, time - now()));
  };

  const attempt = async () => {
    if (running || page.visibilityState !== 'visible' || now() < notBefore) return;
    running = true;
    staleWhileRunning = false;
    lastAttempt = now();
    notBefore = lastAttempt + MIN_ATTEMPT_GAP_MS;
    try {
      const { kind } = await check();
      if (kind === 'mismatch') notBefore = now() + RETRY_GAP_MS;
      else if (kind === 'unavailable') notBefore = Number.POSITIVE_INFINITY; // No Cache Storage here.
      else if (kind === 'incomplete') attemptAt(now() + RESUME_DELAY_MS);
      else if (kind !== 'offline' && kind !== 'busy') notBefore = now() + CHECK_GAP_MS;
    } catch {
      // Unexpected: try again at the next chance.
    } finally {
      running = false;
    }
    if (staleWhileRunning) stale();
  };

  const stale = () => {
    if (running) {
      staleWhileRunning = true;
      return;
    }
    // A newer build is on the server: look now (a check is one small manifest), unless one was made only just now.
    if (notBefore === Number.POSITIVE_INFINITY) return;
    notBefore = Math.min(notBefore, lastAttempt + MIN_ATTEMPT_GAP_MS);
    if (now() < notBefore) attemptAt(notBefore);
    else void attempt();
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
    if (later !== null) win.clearTimeout(later);
    win.clearInterval(timer);
  };
}

/** Runs `run` unless another tab is already updating the index, in which case this one skips (`busy`). */
export async function withUpdateLock<T extends { kind: string }>(run: () => Promise<T>): Promise<T | { kind: 'busy' }> {
  if (typeof navigator === 'undefined' || !navigator.locks) return run();
  return navigator.locks.request('manifest-index-update', { ifAvailable: true }, async (lock) => (lock ? run() : { kind: 'busy' as const }));
}
