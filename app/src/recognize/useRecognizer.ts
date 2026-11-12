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
 * Starts the recognition worker and loads the name list and OCR engine into
 * it. Mounted only while the scanner is shown, so the OCR download (about
 * 3 MB, once) happens only for people who scan.
 */
export function useRecognizer(game: GameId, lockSets: readonly string[] = []) {
  const [status, setStatus] = useState<RecognizerStatus>('loading');
  const [attempt, setAttempt] = useState(0);
  const remoteRef = useRef<Remote<RecognizeWorker> | null>(null);

  useEffect(() => {
    const worker = new Worker(new URL('./recognize.worker.ts', import.meta.url), { type: 'module' });
    const remote = wrap<RecognizeWorker>(worker);
    let cancelled = false;
    setStatus('loading');
    remote.load(game).then(
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
      worker.terminate();
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

  // The batch's set lock, sent again whenever the worker (re)starts.
  const lockKey = lockSets.join(',');
  useEffect(() => {
    if (status === 'ready') void remoteRef.current?.setLock(lockKey ? lockKey.split(',') : []);
  }, [status, lockKey]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  return { status, live, photo, again, retry };
}
