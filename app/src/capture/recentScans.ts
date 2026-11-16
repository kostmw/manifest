/**
 * The last few scanned cards, newest first, for the scanner's strip of
 * thumbnails with one-tap undo. Kept in memory for the page's lifetime, so it
 * survives switching tabs; the cards themselves are already saved (in the
 * batch or the review queue).
 */
import { useSyncExternalStore } from 'react';
import { changeQuantity } from '../session/batches';
import { db } from '../session/db';
import { discardReview, getReview } from '../session/reviews';
import { logEvent } from '../session/testLog';

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
  /** The test log's id of this scan. */
  scanId?: string;
  /** A +1: one more of the card scanned before it, not a scan of its own. */
  copy?: true;
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

/** Frees an entry's picture, unless a copy of it still shows the same one. */
function release(entry: RecentScan, kept: readonly RecentScan[]): void {
  if (entry.thumb && !kept.some((other) => other.thumb === entry.thumb)) URL.revokeObjectURL(entry.thumb);
}

export function pushRecent(entry: Omit<RecentScan, 'id' | 'thumb' | 'at'> & { card: Blob | null }): RecentScan {
  const { card, ...rest } = entry;
  const stored: RecentScan = { ...rest, id: crypto.randomUUID(), thumb: card ? URL.createObjectURL(card) : null, at: performance.now() };
  keep([stored, ...entries]);
  return stored;
}

/** Keeps a few more than are shown, so that switching batches and back keeps them. */
function keep(next: readonly RecentScan[]): void {
  const kept = next.slice(0, RECENT_LIMIT * 4);
  for (const dropped of next.slice(RECENT_LIMIT * 4)) release(dropped, kept);
  emit(kept);
}

/**
 * One more copy of a card just added: an identical copy put straight on top
 * looks like the same card to live mode, so it isn't counted by itself. The
 * batch row gets one more, and the copy shows (and can be undone) like any card.
 */
export async function copyRecent(entry: RecentScan): Promise<RecentScan | null> {
  if (entry.kind !== 'added' || !entry.itemId) return null;
  await changeQuantity(entry.itemId, 1);
  const copy: RecentScan = { ...entry, id: crypto.randomUUID(), at: performance.now(), copy: true };
  keep([copy, ...entries]);
  if (entry.scanId) logEvent({ type: 'copy-added', readIds: [entry.scanId] });
  return copy;
}

export function removeRecent(id: string): void {
  const found = entries.find((entry) => entry.id === id);
  if (!found) return;
  const kept = entries.filter((entry) => entry.id !== id);
  release(found, kept);
  emit(kept);
}

/**
 * Takes a scanned card back out: one fewer in its batch row, or out of the
 * review queue. Returns a function that puts it back ("Removed X · Undo", so
 * a mis-tap on Undo is recoverable), or null when there is nothing to put back.
 */
export async function undoRecent(entry: RecentScan): Promise<(() => Promise<void>) | null> {
  let putBack: (() => Promise<void>) | null = null;
  if (entry.kind === 'added' && entry.itemId) {
    const item = await db.items.get(entry.itemId);
    await changeQuantity(entry.itemId, -1);
    if (item) {
      putBack = async () => {
        const now = await db.items.get(item.id);
        if (now) await db.items.update(item.id, { qty: now.qty + 1 });
        else await db.items.add({ ...item, qty: 1 });
      };
    }
  }
  if (entry.kind === 'review' && entry.reviewId) {
    const review = await getReview(entry.reviewId);
    await discardReview(entry.reviewId);
    if (review) {
      putBack = async () => {
        if (!(await db.reviews.get(review.id))) await db.reviews.add(review);
      };
    }
  }
  removeRecent(entry.id);
  if (entry.scanId) logEvent({ type: 'undo', readIds: [entry.scanId] });
  if (!putBack) return null;
  const restore = putBack;
  return async () => {
    await restore();
    // Its thumbnail was let go with it.
    keep([{ ...entry, id: crypto.randomUUID(), thumb: null, at: performance.now() }, ...entries]);
  };
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
