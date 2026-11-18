import { transfer, wrap, type Remote } from 'comlink';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GameId } from '../games/types';
import type { FrameOutcome, RecognizeWorker } from './recognize.worker';

export type RecognizerStatus = 'loading' | 'ready' | 'error';

/** Adds what the main thread spent: getting the pixels (`capture`), and the whole round trip (`wall`). */
function withMainThreadTimings(outcome: FrameOutcome, capture: number, started: number): FrameOutcome {
  return { ...outcome, timings: { capture, ...outcome.timings, wall: performance.now() - started } };
}

/**
 * The recognition worker, started the first time the scanner opens (so the
 * OCR download, about 3 MB once, happens only for people who scan) and then
 * kept while the app runs: its live session remembers the card read last, so
 * leaving the Scan tab and coming back doesn't count the card still lying
 * there again (QA H1). Leaving the tab still turns the camera off. A worker
 * that failed to load is dropped, so trying again starts a new one.
 */
let shared: { game: GameId; worker: Worker; remote: Remote<RecognizeWorker>; ready: Promise<void> } | null = null;

function sharedWorker(game: GameId): NonNullable<typeof shared> {
  if (shared && shared.game !== game) {
    shared.worker.terminate();
    shared = null;
  }
  if (!shared) {
    const worker = new Worker(new URL('./recognize.worker.ts', import.meta.url), { type: 'module' });
    const remote = wrap<RecognizeWorker>(worker);
    const ready = remote.load(game);
    const entry = { game, worker, remote, ready };
    ready.catch(() => {
      if (shared === entry) {
        worker.terminate();
        shared = null;
      }
    });
    shared = entry;
  }
  return shared;
}

/**
 * The shared recognition worker once it has loaded, for work that outlives
 * the Scan tab (bulk import). Rejects if it fails to load.
 */
export async function loadedRecognizer(game: GameId): Promise<Remote<RecognizeWorker>> {
  const entry = sharedWorker(game);
  await entry.ready;
  return entry.remote;
}

/** Loads the name list and OCR engine into the shared recognition worker (see sharedWorker). */
export function useRecognizer(game: GameId, lockSets: readonly string[] = [], countCopies = false) {
  const [status, setStatus] = useState<RecognizerStatus>('loading');
  const [attempt, setAttempt] = useState(0);
  const remoteRef = useRef<Remote<RecognizeWorker> | null>(null);

  useEffect(() => {
    const { remote, ready } = sharedWorker(game);
    let cancelled = false;
    setStatus('loading');
    ready.then(
      () => {
        if (cancelled) return;
        remoteRef.current = remote;
        setStatus('ready');
      },
      () => {
        if (!cancelled) setStatus('error');
      },
    );
    return () => {
      cancelled = true;
      remoteRef.current = null;
    };
  }, [game, attempt]);

  /** One live frame. Null when the recognizer isn't ready. */
  const live = useCallback(async (video: HTMLVideoElement): Promise<FrameOutcome | null> => {
    const remote = remoteRef.current;
    if (!remote || video.readyState < 2 || video.videoWidth === 0) return null;
    const started = performance.now();
    const bitmap = await createImageBitmap(video);
    const capture = performance.now() - started;
    return withMainThreadTimings(await remote.live(transfer(bitmap, [bitmap])), capture, started);
  }, []);

  const photo = useCallback(async (file: Blob): Promise<FrameOutcome | null> => {
    const remote = remoteRef.current;
    if (!remote) return null;
    const started = performance.now();
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const decode = performance.now() - started;
    return withMainThreadTimings(await remote.photo(transfer(bitmap, [bitmap])), decode, started);
  }, []);

  const again = useCallback(() => {
    void remoteRef.current?.again();
  }, []);

  /** The flashlight is switching: live mode holds the card read last while the camera re-exposes. */
  const cameraChanged = useCallback(() => {
    void remoteRef.current?.cameraChanged();
  }, []);

  // The batch's set lock, sent again whenever the worker (re)starts.
  const lockKey = lockSets.join(',');
  useEffect(() => {
    if (status === 'ready') void remoteRef.current?.setLock(lockKey ? lockKey.split(',') : []);
  }, [status, lockKey]);

  // Counting copies put on top, also sent again whenever the worker (re)starts.
  useEffect(() => {
    if (status === 'ready') void remoteRef.current?.setCountCopies(countCopies);
  }, [status, countCopies]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  return { status, live, photo, again, cameraChanged, retry };
}
