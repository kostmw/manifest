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

export async function getReview(id: string): Promise<ReviewItem | undefined> {
  return db.reviews.get(id);
}

export async function discardReview(id: string): Promise<void> {
  await db.reviews.delete(id);
}

export async function updateReview(id: string, changes: Partial<Pick<ReviewItem, 'foil' | 'qty' | 'chosen' | 'markedWrong'>>): Promise<void> {
  await db.reviews.update(id, changes);
}

export interface Resolution {
  printing: Printing;
  finish: string;
  qty: number;
}

/** A group of reviews accepted together, and the batch rows they went into, so the group can be undone. */
export interface AcceptedGroup {
  batchId: string;
  /** Each review, the batch row its cards went into, how many, and that row's merge key then (printing, finish, language, condition). */
  entries: { review: ReviewItem; itemId: string; qty: number; mergeKey: string }[];
}

/**
 * Accepts reviews as the given printing: each adds its cards to the batch (in
 * the language and condition it was scanned with) and leaves the queue, all or
 * nothing. Returns what each became, for undoing the group.
 */
export async function acceptReviewGroup(batch: Batch, resolutions: readonly { review: ReviewItem; resolution: Resolution }[]): Promise<AcceptedGroup> {
  return db.transaction('rw', db.items, db.reviews, async () => {
    const entries: AcceptedGroup['entries'] = [];
    for (const { review, resolution } of resolutions) {
      if (!(await db.reviews.get(review.id))) continue; // Already handled, in another tab say.
      const { printing, finish, qty } = resolution;
      const lang = printing.lang !== 'en' ? printing.lang : review.lang;
      const mergeKey = mergeKeyFor(printing.id, finish, lang, review.condition);
      const existing = await db.items.where({ batchId: batch.id, mergeKey }).first();
      let itemId: string;
      if (existing) {
        const scanIds = withScan(existing.scanIds, review.scanId);
        await db.items.update(existing.id, { qty: existing.qty + qty, ...(scanIds ? { scanIds } : {}) });
        itemId = existing.id;
      } else {
        itemId = crypto.randomUUID();
        await db.items.add({
          ...(review.scanId ? { scanIds: [review.scanId] } : {}),
          id: itemId,
          batchId: batch.id,
          printing,
          finish,
          lang,
          condition: review.condition,
          qty,
          addedAt: review.createdAt,
          mergeKey,
        });
      }
      await db.reviews.delete(review.id);
      entries.push({ review, itemId, qty, mergeKey });
    }
    return { batchId: batch.id, entries };
  });
}

/** Accepts reviews as the given printing (see acceptReviewGroup). Returns the ids of the batch rows that hold them. */
export async function acceptReviews(batch: Batch, resolutions: readonly { review: ReviewItem; resolution: Resolution }[]): Promise<string[]> {
  return (await acceptReviewGroup(batch, resolutions)).entries.map((entry) => entry.itemId);
}

/**
 * Undoes a group accepted together: each review's cards come out of their
 * batch row again (a row left empty goes) and the review waits again, as it
 * was. A row that no longer holds them as they were added (its printing was
 * changed, it was merged into another row or removed, or fewer are left) keeps
 * what it has, and that review isn't queued again: the card would count twice
 * (QA M3). Returns how many came back.
 */
export async function undoAcceptedGroup(group: AcceptedGroup): Promise<number> {
  return db.transaction('rw', db.items, db.reviews, async () => {
    let restored = 0;
    for (const { review, itemId, qty, mergeKey } of group.entries) {
      // Already waiting again (undone before): leave it, and its batch row, alone.
      if (await db.reviews.get(review.id)) continue;
      const item = await db.items.get(itemId);
      if (!item || item.mergeKey !== mergeKey || item.qty < qty) continue;
      const left = item.qty - qty;
      const scanIds = item.scanIds?.filter((id) => id !== review.scanId);
      if (left > 0) await db.items.update(itemId, { qty: left, ...(scanIds ? { scanIds } : {}) });
      else await db.items.delete(itemId);
      await db.reviews.add(review);
      restored += 1;
    }
    return restored;
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
