/**
 * The last few scanned cards, newest first, for the scanner's strip of
 * thumbnails with one-tap undo. Kept in memory for the page's lifetime, so it
 * survives switching tabs; the cards themselves are already saved (in the
 * batch or the review queue).
 */
import { useSyncExternalStore } from 'react';
import { changeQuantity } from '../session/batches';
import { discardReview } from '../session/reviews';

export const RECENT_LIMIT = 5;

export interface RecentScan {
  id: string;
  batchId: string;
  /** Added to the batch, or waiting for review. */
  kind: 'added' | 'review';
  source: 'live' | 'photo';
  /** Best name, when there is one. */
  name: string | null;
  /** "CMM 410", when a printing was chosen or guessed. */
  code: string | null;
  /** The batch row the card went into. */
  itemId?: string;
  reviewId?: string;
  /** Object URL of the user's crop. */
  thumb: string | null;
  /** performance.now() when it was scanned. */
  at: number;
}

let entries: readonly RecentScan[] = [];
const listeners = new Set<() => void>();

function emit(next: readonly RecentScan[]): void {
  entries = next;
  for (const listener of listeners) listener();
}

function release(entry: RecentScan): void {
  if (entry.thumb) URL.revokeObjectURL(entry.thumb);
}

export function pushRecent(entry: Omit<RecentScan, 'id' | 'thumb' | 'at'> & { card: Blob | null }): RecentScan {
  const { card, ...rest } = entry;
  const stored: RecentScan = { ...rest, id: crypto.randomUUID(), thumb: card ? URL.createObjectURL(card) : null, at: performance.now() };
  const next = [stored, ...entries];
  for (const dropped of next.slice(RECENT_LIMIT * 4)) release(dropped);
  // A few more than are shown, so that switching batches and back keeps them.
  emit(next.slice(0, RECENT_LIMIT * 4));
  return stored;
}

export function removeRecent(id: string): void {
  const found = entries.find((entry) => entry.id === id);
  if (!found) return;
  release(found);
  emit(entries.filter((entry) => entry.id !== id));
}

/** Takes a scanned card back out: one fewer in its batch row, or out of the review queue. */
export async function undoRecent(entry: RecentScan): Promise<void> {
  if (entry.kind === 'added' && entry.itemId) await changeQuantity(entry.itemId, -1);
  if (entry.kind === 'review' && entry.reviewId) await discardReview(entry.reviewId);
  removeRecent(entry.id);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The last few cards scanned into a batch, newest first. */
export function useRecentScans(batchId: string | null): RecentScan[] {
  const all = useSyncExternalStore(subscribe, () => entries);
  return all.filter((entry) => entry.batchId === batchId).slice(0, RECENT_LIMIT);
}
