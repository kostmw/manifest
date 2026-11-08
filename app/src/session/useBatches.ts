import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback, useEffect, useState } from 'react';
import { ensureBatch, getItems } from './batches';
import { db } from './db';

const STORAGE_KEY = 'manifest.activeBatchId';

function readStoredId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredId(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Private windows may refuse. The app then just opens the newest batch next time.
  }
}

export function useBatches() {
  const [activeId, setActiveId] = useState<string | null>(readStoredId);
  const [storageFailed, setStorageFailed] = useState(false);

  const batches = useLiveQuery(() => db.batches.orderBy('createdAt').reverse().toArray(), []);
  const active = batches?.find((batch) => batch.id === activeId) ?? batches?.[0] ?? null;
  const items = useLiveQuery(() => (active ? getItems(active.id) : []), [active?.id]);

  // Runs on load, and after the last batch is deleted, so there's always one to add to. It also runs
  // before the query answers on purpose: when the database can't open, a live query never answers
  // and never throws, so this write is what reveals blocked storage.
  useEffect(() => {
    if (batches && batches.length > 0) return;
    ensureBatch().catch(() => setStorageFailed(true));
  }, [batches]);

  const selectBatch = useCallback((id: string) => {
    setActiveId(id);
    writeStoredId(id);
  }, []);

  return { batches: batches ?? [], active, items: items ?? [], selectBatch, storageFailed };
}

export type BatchesState = ReturnType<typeof useBatches>;
