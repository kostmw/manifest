/** The Review tab: the batch's scanned cards that wait for the user's say, one at a time. */
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { getReviews } from '../session/reviews';
import type { Batch } from '../session/types';
import { BUTTON_SECONDARY } from '../ui/styles';
import { ReviewCard } from './ReviewCard';

export function ReviewQueue({ batch, startAt, onScan }: { batch: Batch; startAt?: string | null; onScan: () => void }) {
  const reviews = useLiveQuery(() => getReviews(batch.id), [batch.id]);
  const [currentId, setCurrentId] = useState<string | null>(startAt ?? null);
  const [done, setDone] = useState(0);

  const index = reviews ? Math.max(0, reviews.findIndex((review) => review.id === currentId)) : 0;
  const current = reviews?.[index] ?? null;

  // Left and right arrows step through the queue.
  useEffect(() => {
    if (!reviews || reviews.length < 2) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement | null)?.closest('input, textarea, select')) return;
      if (event.key === 'ArrowRight') setCurrentId(reviews[Math.min(reviews.length - 1, index + 1)]!.id);
      else if (event.key === 'ArrowLeft') setCurrentId(reviews[Math.max(0, index - 1)]!.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [reviews, index]);

  if (!reviews) return <p className="text-sm text-zinc-400">Opening the review queue…</p>;
  if (!current) {
    return (
      <div className="flex flex-col items-start gap-2 rounded-xl bg-zinc-800/40 p-4">
        <p className="text-sm text-zinc-300">{done > 0 ? 'All done: nothing left to review.' : 'Nothing to review.'}</p>
        <p className="text-sm text-zinc-400">Cards the scanner wasn't sure of wait here for you to check.</p>
        <button type="button" onClick={onScan} className={BUTTON_SECONDARY}>
          Scan cards
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-base font-semibold" data-testid="review-position">
          {index + 1} of {reviews.length} to review
        </h2>
        <button
          type="button"
          aria-label="Previous card"
          disabled={index === 0}
          onClick={() => setCurrentId(reviews[index - 1]!.id)}
          className={BUTTON_SECONDARY}
        >
          ‹
        </button>
        <button
          type="button"
          aria-label="Next card"
          disabled={index === reviews.length - 1}
          onClick={() => setCurrentId(reviews[index + 1]!.id)}
          className={BUTTON_SECONDARY}
        >
          ›
        </button>
      </div>
      <ReviewCard
        key={current.id}
        batch={batch}
        review={current}
        pending={reviews}
        onResolved={() => {
          setDone((value) => value + 1);
          // Stay at this place in the queue: the next card slides into it.
          setCurrentId(reviews[index + 1]?.id ?? reviews[index - 1]?.id ?? null);
        }}
      />
      <p className="hidden text-xs text-zinc-500 sm:block">
        Keys: 1–5 pick · Enter add · X discard · F foil · +/− quantity · S search · ←/→ previous and next
      </p>
    </div>
  );
}
