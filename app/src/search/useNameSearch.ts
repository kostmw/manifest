import { wrap, type Remote } from 'comlink';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GameId } from '../games/types';
import type { NameHit } from '../recognize/nameSearch';
import type { NameSearchWorker } from './nameSearch.worker';

export type SearchStatus = 'loading' | 'ready' | 'error';

const RESULT_LIMIT = 10;

export function useNameSearch(game: GameId) {
  const [status, setStatus] = useState<SearchStatus>('loading');
  const [results, setResults] = useState<NameHit[]>([]);
  const [attempt, setAttempt] = useState(0);
  const remoteRef = useRef<Remote<NameSearchWorker> | null>(null);
  const latestQuery = useRef(0);

  useEffect(() => {
    const worker = new Worker(new URL('./nameSearch.worker.ts', import.meta.url), { type: 'module' });
    const remote = wrap<NameSearchWorker>(worker);
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

  const search = useCallback(async (query: string) => {
    const queryNumber = ++latestQuery.current;
    if (!query.trim() || !remoteRef.current) {
      setResults([]);
      return;
    }
    const hits = await remoteRef.current.search(query, RESULT_LIMIT);
    // Only the latest query may show, however the answers arrive.
    if (queryNumber === latestQuery.current) setResults(hits);
  }, []);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  return { status, results, search, retry };
}
