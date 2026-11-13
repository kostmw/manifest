/** The review queue: scanned cards the recognizer wasn't sure enough to add on its own. */
import { getGame } from '../games/registry';
import type { Printing } from '../games/types';
import { mergeKeyFor, withScan } from './batches';
import { db } from './db';
import type { Batch, ReviewItem } from './types';

export type NewReview = Omit<ReviewItem, 'id' | 'createdAt'>;

export async function queueReview(review: NewReview): Promise<ReviewItem> {
  const stored: ReviewItem = { ...review, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
  await db.reviews.add(stored);
  return stored;
}

/** Oldest first: the order the cards were scanned in. */
export async function getReviews(batchId: string): Promise<ReviewItem[]> {
  return db.reviews.where('batchId').equals(batchId).sortBy('createdAt');
}

export async function discardReview(id: string): Promise<void> {
  await db.reviews.delete(id);
}

export async function updateReview(id: string, changes: Partial<Pick<ReviewItem, 'foil' | 'qty'>>): Promise<void> {
  await db.reviews.update(id, changes);
}

export interface Resolution {
  printing: Printing;
  finish: string;
  qty: number;
}

/**
 * Accepts reviews as the given printing: each adds its cards to the batch (in
 * the language and condition it was scanned with) and leaves the queue, all or
 * nothing. Returns the ids of the batch rows that hold them.
 */
export async function acceptReviews(batch: Batch, resolutions: readonly { review: ReviewItem; resolution: Resolution }[]): Promise<string[]> {
  return db.transaction('rw', db.items, db.reviews, async () => {
    const ids: string[] = [];
    for (const { review, resolution } of resolutions) {
      if (!(await db.reviews.get(review.id))) continue; // Already handled, in another tab say.
      const { printing, finish, qty } = resolution;
      const lang = printing.lang !== 'en' ? printing.lang : review.lang;
      const mergeKey = mergeKeyFor(printing.id, finish, lang, review.condition);
      const existing = await db.items.where({ batchId: batch.id, mergeKey }).first();
      if (existing) {
        const scanIds = withScan(existing.scanIds, review.scanId);
        await db.items.update(existing.id, { qty: existing.qty + qty, ...(scanIds ? { scanIds } : {}) });
        ids.push(existing.id);
      } else {
        const id = crypto.randomUUID();
        await db.items.add({
          ...(review.scanId ? { scanIds: [review.scanId] } : {}),
          id,
          batchId: batch.id,
          printing,
          finish,
          lang,
          condition: review.condition,
          qty,
          addedAt: review.createdAt,
          mergeKey,
        });
        ids.push(id);
      }
      await db.reviews.delete(review.id);
    }
    return ids;
  });
}

export function acceptReview(batch: Batch, review: ReviewItem, resolution: Resolution): Promise<string[]> {
  return acceptReviews(batch, [{ review, resolution }]);
}

/**
 * Other waiting reviews that are probably the same card as `name`, for "apply
 * to all similar": those whose best guess is that name. Basic lands are the
 * usual case: the name reads fine and only the set needs choosing.
 */
export function similarReviews(reviews: readonly ReviewItem[], review: ReviewItem, name: string): ReviewItem[] {
  return reviews.filter((other) => other.id !== review.id && other.names[0] === name);
}

/** The finish a review would be accepted with as a given printing. */
export function reviewFinish(batch: Batch, review: Pick<ReviewItem, 'foil'>, printing: Printing): string {
  return getGame(batch.game).defaultFinish(printing, review.foil);
}
