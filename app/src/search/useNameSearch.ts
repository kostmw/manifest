import { wrap, type Remote } from 'comlink';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GameId } from '../games/types';
import type { NameHit } from '../recognize/nameSearch';
import type { NameSearchWorker } from './nameSearch.worker';

export type SearchStatus = 'loading' | 'ready' | 'error';

const RESULT_LIMIT = 10;

/**
 * One name-search worker per game, shared by every search box (Add cards,
 * review, changing a printing), so the name list is loaded once.
 */
const workers = new Map<GameId, Promise<Remote<NameSearchWorker>>>();

function nameSearchWorker(game: GameId): Promise<Remote<NameSearchWorker>> {
  let found = workers.get(game);
  if (!found) {
    const worker = new Worker(new URL('./nameSearch.worker.ts', import.meta.url), { type: 'module' });
    const remote = wrap<NameSearchWorker>(worker);
    found = remote.load(game).then(() => remote);
    found.catch(() => {
      workers.delete(game);
      worker.terminate();
    });
    workers.set(game, found);
  }
  return found;
}

export function useNameSearch(game: GameId) {
  const [status, setStatus] = useState<SearchStatus>('loading');
  const [results, setResults] = useState<NameHit[]>([]);
  const [attempt, setAttempt] = useState(0);
  const remoteRef = useRef<Remote<NameSearchWorker> | null>(null);
  const latestQuery = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    nameSearchWorker(game).then(
      (remote) => {
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
